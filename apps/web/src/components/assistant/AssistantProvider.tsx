"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  emptyLiveMessage,
  reduceLiveMessage,
  type LiveMessage,
} from "~/lib/assistant/liveMessage";
import {
  readConversation,
  readOpen,
  writeConversation,
  writeOpen,
} from "~/lib/assistant/panelState";
import { canStartConversationRun } from "~/lib/assistant/conversationRequest";
import { hasPersistedRunOutcome } from "~/lib/assistant/persistedRun";
import { isConversationUnavailable } from "~/lib/assistant/conversationErrors";
import { shouldMarkUnseen } from "~/lib/assistant/unseenCompletion";
import {
  createRunEventSubscription,
  type EventSourceLike,
} from "~/lib/assistant/runEvents";
import { api, usePrincipalId } from "~/trpc/react";

export type LiveRun = { runId: string; conversationId: string };
export type LiveStatus = "streaming" | "ended" | "unavailable" | "error";

type AssistantContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  activeConversationId: string | null;
  setActiveConversationId: (id: string | null) => void;
  liveRun: LiveRun | null;
  startLiveRun: (run: LiveRun) => void;
  isActiveConversation: (id: string | null) => boolean;
  live: LiveMessage | null;
  liveStatus: LiveStatus | null;
  unseenCompletion: boolean;
  markSeen: () => void;
  /** Set by the mounted Composer's textarea; lets the panel focus it on open (spec §10.1). */
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  /**
   * Marks that the next `AssistantConversation` to mount/receive a
   * conversationId should focus its composer once. Lives here (not in
   * AppShell or AssistantPage's own state) because "New conversation" can be
   * requested from either surface and, on the route, the target
   * conversationId is only known after a client-side navigation that may
   * remount the page — this flag survives that the same way
   * `activeConversationId` does.
   */
  requestComposerFocus: () => void;
  /** Reads and clears the flag above; returns whether it was set. */
  consumeComposerFocusRequest: () => boolean;
};

const AssistantContext = createContext<AssistantContextValue | null>(null);

export function AssistantProvider({ children }: { children: React.ReactNode }) {
  const utils = api.useUtils();
  const principalId = usePrincipalId();
  const [open, setOpenState] = useState(false);
  const [activeConversationId, setActiveState] = useState<string | null>(null);
  const [liveRun, setLiveRun] = useState<LiveRun | null>(null);
  const liveRunRef = useRef<LiveRun | null>(null);
  const [live, setLive] = useState<LiveMessage | null>(null);
  const [liveStatus, setLiveStatus] = useState<LiveStatus | null>(null);
  const [unseenCompletion, setUnseen] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingComposerFocusRef = useRef(false);
  const openRef = useRef(open);
  const activeRef = useRef(activeConversationId);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  useEffect(() => {
    activeRef.current = activeConversationId;
  }, [activeConversationId]);

  // Persisted preferences are read after mount so server and client markup agree.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setOpenState(readOpen(window.sessionStorage));
      setActiveState(readConversation(window.sessionStorage, principalId));
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [principalId]);

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    writeOpen(window.sessionStorage, next);
  }, []);
  const toggle = useCallback(() => setOpen(!openRef.current), [setOpen]);
  const setActiveConversationId = useCallback(
    (id: string | null) => {
      activeRef.current = id;
      setActiveState(id);
      writeConversation(window.sessionStorage, id, principalId);
    },
    [principalId],
  );

  const isActiveConversation = useCallback(
    (id: string | null) => activeRef.current === id,
    [],
  );
  const startLiveRun = useCallback((run: LiveRun) => {
    if (!canStartConversationRun(activeRef.current, run.conversationId)) return;
    liveRunRef.current = run;
    setLiveRun(run);
    setLive(emptyLiveMessage());
    setLiveStatus("streaming");
  }, []);

  // One subscription for the one live run; it survives navigation because the
  // provider lives in AppShell.
  useEffect(() => {
    if (!liveRun) return;
    const { runId, conversationId } = liveRun;
    let disposed = false;
    let probing = false;
    const finish = (status: LiveStatus) => {
      if (disposed || liveRunRef.current?.runId !== runId) return;
      setLiveStatus(status);
      void utils.assistant.getConversation.invalidate({ conversationId });
      void utils.assistant.getConversationUsage.invalidate({ conversationId });
      void utils.assistant.listProposals.invalidate({ conversationId });
      void utils.assistant.listCitations.invalidate({ conversationId });
      void utils.assistant.listConversations.invalidate();
      if (
        shouldMarkUnseen({
          open: openRef.current,
          activeConversationId: activeRef.current,
          conversationId,
        })
      )
        setUnseen(true);
    };
    const subscription = createRunEventSubscription({
      runId,
      after: -1,
      EventSourceImpl: EventSource as unknown as new (
        url: string,
      ) => EventSourceLike,
      onEvent: (event) => {
        if (disposed || liveRunRef.current?.runId !== runId) return;
        if (event.event.type === "proposal.created")
          void utils.assistant.listProposals.invalidate({ conversationId });
        setLive((state) =>
          reduceLiveMessage(state ?? emptyLiveMessage(), event),
        );
      },
      onEnd: () => finish("ended"),
      onUnavailable: () => finish("unavailable"),
      onServerError: () => finish("error"),
      onTransportError: () => {
        void (async () => {
          if (disposed || probing) return;
          probing = true;
          try {
            const run = await utils.assistant.getRun.fetch(
              { runId },
              { staleTime: 0 },
            );
            if (["completed", "failed", "cancelled"].includes(run.status)) {
              subscription.close();
              finish("ended");
            }
          } catch (error) {
            if (isConversationUnavailable(error)) {
              subscription.close();
              finish("unavailable");
            }
          } finally {
            probing = false;
          }
        })();
      },
    });
    return () => {
      disposed = true;
      subscription.close();
    };
  }, [liveRun, utils]);

  // A persisted outcome, rather than elapsed time, acknowledges the live text.
  useEffect(() => {
    if (!liveStatus || liveStatus === "streaming" || !liveRun) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      let acknowledged = false;
      try {
        const conversation = await utils.assistant.getConversation.fetch(
          { conversationId: liveRun.conversationId },
          { staleTime: 0 },
        );
        acknowledged = hasPersistedRunOutcome(
          liveRun.runId,
          conversation.messages,
        );
      } catch (error) {
        acknowledged = isConversationUnavailable(error);
      }
      if (disposed || liveRunRef.current?.runId !== liveRun.runId) return;
      if (acknowledged) {
        liveRunRef.current = null;
        setLiveRun(null);
        setLive(null);
        setLiveStatus(null);
      } else {
        timer = setTimeout(() => void refresh(), 1_000);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [liveStatus, liveRun, utils]);

  const markSeen = useCallback(() => setUnseen(false), []);
  const requestComposerFocus = useCallback(() => {
    pendingComposerFocusRef.current = true;
  }, []);
  const consumeComposerFocusRequest = useCallback(() => {
    const pending = pendingComposerFocusRef.current;
    pendingComposerFocusRef.current = false;
    return pending;
  }, []);

  const value = useMemo<AssistantContextValue>(
    () => ({
      open,
      setOpen,
      toggle,
      activeConversationId,
      setActiveConversationId,
      liveRun,
      startLiveRun,
      isActiveConversation,
      live,
      liveStatus,
      unseenCompletion,
      markSeen,
      composerRef,
      requestComposerFocus,
      consumeComposerFocusRequest,
    }),
    [
      open,
      setOpen,
      toggle,
      activeConversationId,
      setActiveConversationId,
      liveRun,
      startLiveRun,
      isActiveConversation,
      live,
      liveStatus,
      unseenCompletion,
      markSeen,
      composerRef,
      requestComposerFocus,
      consumeComposerFocusRequest,
    ],
  );
  return (
    <AssistantContext.Provider value={value}>
      {children}
    </AssistantContext.Provider>
  );
}

export function useAssistant(): AssistantContextValue {
  const value = useContext(AssistantContext);
  if (!value)
    throw new Error("useAssistant must be used inside AssistantProvider");
  return value;
}

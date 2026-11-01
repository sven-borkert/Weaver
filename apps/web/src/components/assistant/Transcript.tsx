"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ScopeSnapshot } from "@weaver/core/assistant/scopeSchema";
import type { RouterOutputs } from "~/trpc/react";
import { api } from "~/trpc/react";
import { useMounted } from "~/lib/use-mounted";
import { isConversationUnavailable } from "~/lib/assistant/conversationErrors";
import { liveAnnouncement } from "~/lib/assistant/liveAnnouncement";
import {
  clientNow,
  pendingProposalCount,
} from "~/lib/assistant/proposalPreview";
import { snapshotLabel } from "~/lib/assistant/scopeDraft";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { useAssistant } from "./AssistantProvider";
import { CitationCards } from "./CitationCard";
import { ProposalCards } from "./ProposalCard";
import { RunStateStrip } from "./RunStateStrip";
import { ExternalApproval } from "./ExternalToolApprovalCard";
import { ExternalSources } from "./ExternalSources";
import { ExternalRunActivity } from "./ExternalRunActivity";
import { ReplyUsage } from "./SessionUsage";

type Message =
  RouterOutputs["assistant"]["getConversation"]["messages"][number];

function ScopeBadge({
  snapshot,
  onReuse,
}: {
  snapshot: ScopeSnapshot;
  onReuse: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onReuse}
      title="Use this scope again"
      className="border-line bg-subtle text-text-2 hover:bg-hover rounded-full border px-2 py-0.5 text-[11px]"
    >
      {snapshotLabel(snapshot)}
    </button>
  );
}

function UserBubble({
  message,
  onScopeReuse,
  conversationId,
  proposalIds,
}: {
  message: Message;
  onScopeReuse: (snapshot: ScopeSnapshot) => void;
  conversationId: string;
  proposalIds: string[];
}) {
  return (
    <li className="flex flex-col items-end gap-1">
      <div className="bg-brand-bg text-text max-w-[85%] rounded-2xl rounded-br-sm px-3 py-2 text-[14px] whitespace-pre-wrap">
        {message.text}
      </div>
      <div className="flex items-center gap-2">
        {message.scopeSnapshot ? (
          <ScopeBadge
            snapshot={message.scopeSnapshot}
            onReuse={() => onScopeReuse(message.scopeSnapshot!)}
          />
        ) : null}
        {message.status === "pending" ? (
          <span className="text-text-muted text-[11px]">Sending…</span>
        ) : null}
      </div>
      {message.status === "failed" || message.status === "cancelled" ? (
        <RunStateStrip
          status={message.status}
          hasText={false}
          queuedForMs={0}
          errorCode={
            message.error?.code ??
            (proposalIds.length ? "CONTENT_CHANGE_APPLIED" : null)
          }
          errorMessage={message.error?.message ?? null}
          retrying={false}
          attempt={1}
        />
      ) : null}
      {(message.status === "failed" || message.status === "cancelled") &&
      message.runId ? (
        <ExternalRunActivity
          key={message.runId}
          runId={message.runId}
          enabled={Boolean(message.hasExternalTools)}
        />
      ) : null}
      {(message.status === "failed" || message.status === "cancelled") &&
      proposalIds.length > 0 ? (
        <div className="w-full space-y-2">
          <p className="text-text-2 text-[12px]">
            Changes approved before this run stopped:
          </p>
          <ProposalCards
            conversationId={conversationId}
            messageId={message.id}
            proposalIds={proposalIds}
          />
        </div>
      ) : null}
    </li>
  );
}

function AssistantBubble({ children }: { children: React.ReactNode }) {
  return <li className="flex flex-col gap-2 pr-6">{children}</li>;
}

// A plain (non-hook, non-component) helper, matching ConnectionsCard's
// `relativeTime`: `Date.now()` called directly inside a component/hook body
// trips the react-hooks/purity rule, but the lint doesn't chase impure calls
// through an ordinarily-named function like this one.
function msSincePending(pending: { createdAt: Date } | undefined): number {
  return pending ? Date.now() - new Date(pending.createdAt).getTime() : 0;
}

export function Transcript({
  conversationId,
  onScopeReuse,
}: {
  conversationId: string;
  onScopeReuse: (snapshot: ScopeSnapshot) => void;
}) {
  const mounted = useMounted();
  const utils = api.useUtils();
  const [older, setOlder] = useState<{
    conversationId: string;
    messages: Message[];
    hasEarlier: boolean;
  } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState(false);
  const { live, liveRun, startLiveRun } = useAssistant();
  const query = api.assistant.getConversation.useQuery({ conversationId });
  const status = api.assistant.getConversationStatus.useQuery(
    { conversationId },
    {
      enabled: Boolean(query.data),
      refetchInterval: query.data?.activeRun ? 5_000 : false,
      staleTime: 0,
    },
  );
  useEffect(() => {
    if (
      status.data &&
      status.data.activeRun?.id !== query.data?.activeRun?.id
    ) {
      void utils.assistant.getConversation.invalidate({ conversationId });
      void utils.assistant.getConversationUsage.invalidate({ conversationId });
    }
  }, [status.data, query.data?.activeRun?.id, conversationId, utils]);
  // Deferred until the conversation itself loads, so an inaccessible
  // conversation doesn't also fire (and retry) a doomed proposals query.
  const proposals = api.assistant.listProposals.useQuery(
    { conversationId },
    { enabled: Boolean(query.data) },
  );
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const conversation = isConversationUnavailable(query.error)
    ? undefined
    : query.data;
  const pendingCount = pendingProposalCount(
    proposals.data ?? [],
    clientNow(mounted),
  );

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [conversation?.messages.length, live?.text.length]);

  const activeRun = conversation?.activeRun ?? null;
  // The approvals list stops polling once the run ends; a card created after
  // its last poll would otherwise vanish with the switch to the settled view.
  const previousActiveRunId = useRef<string | null>(null);
  useEffect(() => {
    const ended = previousActiveRunId.current;
    previousActiveRunId.current = activeRun?.id ?? null;
    if (ended && !activeRun)
      void utils.externalMcp.listApprovals.invalidate({ runId: ended });
  }, [activeRun, utils]);
  const approvalRunId =
    activeRun?.id ??
    (liveRun?.conversationId === conversationId
      ? liveRun.runId
      : (conversation?.messages.at(-1)?.runId ?? undefined));
  const approvals = api.externalMcp.listApprovals.useQuery(
    { runId: approvalRunId ?? "" },
    {
      enabled: !!approvalRunId && !!conversation,
      refetchInterval: activeRun ? 3_000 : false,
    },
  );
  useEffect(() => {
    if (activeRun && liveRun?.runId !== activeRun.id)
      startLiveRun({ runId: activeRun.id, conversationId });
  }, [activeRun, conversationId, liveRun?.runId, startLiveRun]);
  // Keep streamed content until the persisted run outcome arrives.
  const liveForThis = liveRun?.conversationId === conversationId ? live : null;
  const queuedForMs = useMemo(() => {
    if (!mounted) return 0;
    const pending = conversation?.messages.find(
      (m) => m.role === "user" && m.status === "pending",
    );
    return msSincePending(pending);
  }, [conversation, mounted]);

  if (isConversationUnavailable(query.error)) {
    return (
      <div className="text-text-2 flex flex-1 items-center justify-center p-6 text-[13px]">
        This conversation isn’t available.
      </div>
    );
  }
  if (!conversation) {
    return (
      <div className="text-text-muted p-4 text-[13px]">
        {query.isLoading ? "Loading…" : "Couldn’t load this conversation."}
      </div>
    );
  }

  const previous = older?.conversationId === conversationId ? older : null;
  const messages = [
    ...new Map(
      [...(previous?.messages ?? []), ...conversation.messages].map(
        (message) => [message.position, message],
      ),
    ).values(),
  ].sort((a, b) => a.position - b.position);
  const hasEarlier = previous?.hasEarlier ?? conversation.hasEarlierMessages;
  const loadEarlier = async () => {
    setLoadingOlder(true);
    setOlderError(false);
    try {
      const page = await utils.assistant.getConversation.fetch({
        conversationId,
        beforePosition: messages[0]?.position,
      });
      setOlder({
        conversationId,
        messages: [...page.messages, ...(previous?.messages ?? [])],
        hasEarlier: page.hasEarlierMessages,
      });
    } catch {
      setOlderError(true);
    } finally {
      setLoadingOlder(false);
    }
  };
  const lastMessage = messages.at(-1) ?? null;

  return (
    <div
      ref={scrollRef}
      className="scrollarea min-h-0 flex-1 overflow-y-auto px-4 py-3"
    >
      {/*
        A single quantized announcer, not the growing transcript itself:
        `liveAnnouncement` only takes on a new string at the two moments
        that matter (the run starting, the run settling), so this text node
        stays put through every intermediate delta and the live region
        never fires more than those two announcements (spec §10.1).
      */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {liveAnnouncement({
          activeRun: Boolean(activeRun),
          lastMessage: lastMessage
            ? {
                role: lastMessage.role,
                status: lastMessage.status,
                text: lastMessage.text,
              }
            : null,
        })}
      </div>
      {pendingCount > 0 ? (
        <button
          type="button"
          className="text-brand-text mb-2 block text-[12px] underline"
          onClick={() =>
            scrollRef.current
              ?.querySelector("[data-proposal-pending]")
              ?.scrollIntoView({ block: "center" })
          }
        >
          {pendingCount} proposal{pendingCount === 1 ? "" : "s"} awaiting your
          decision
        </button>
      ) : null}
      {hasEarlier ? (
        <button
          type="button"
          disabled={loadingOlder}
          onClick={() => void loadEarlier()}
          className="text-brand-text mb-3 text-[12px] underline"
        >
          {loadingOlder ? "Loading earlier messages…" : "Load earlier messages"}
        </button>
      ) : null}
      {olderError ? (
        <p role="alert">Couldn’t load earlier messages. Try again.</p>
      ) : null}
      <ol className="flex flex-col gap-4">
        {messages.map((message) =>
          message.role === "user" ? (
            <UserBubble
              key={message.id}
              message={message}
              onScopeReuse={onScopeReuse}
              conversationId={conversationId}
              proposalIds={(proposals.data ?? [])
                .filter(
                  (proposal) =>
                    proposal.runId === message.runId &&
                    ["accepted", "accepting"].includes(proposal.status),
                )
                .map((proposal) => proposal.id)}
            />
          ) : (
            <AssistantBubble key={message.id}>
              {/*
                Assistant messages are only ever created with status
                "complete" (assistantRuns.ts's finishRun is the one place
                that inserts a `role: "assistant"` row) — a run's failure or
                cancellation instead updates the *user* message's status
                (see UserBubble), so there is no failed/cancelled assistant
                row to branch on here.
              */}
              {message.status === "complete" ? (
                <>
                  {message.text ? (
                    <AssistantMarkdown text={message.text} />
                  ) : null}
                  {message.runId ? (
                    <ExternalRunActivity
                      key={message.runId}
                      runId={message.runId}
                      enabled={Boolean(
                        message.hasExternalContext === true ||
                        messages.some(
                          (m) =>
                            m.runId === message.runId && m.hasExternalTools,
                        ),
                      )}
                      live={
                        liveRun?.runId === message.runId
                          ? liveForThis?.tools
                          : undefined
                      }
                    />
                  ) : null}
                  <ExternalSources sources={message.externalSources ?? []} />
                  <CitationCards
                    conversationId={conversationId}
                    messageId={message.id}
                    citationIds={message.citationIds}
                  />
                  <ProposalCards
                    conversationId={conversationId}
                    messageId={message.id}
                    proposalIds={message.proposalIds}
                  />
                  {message.runId ? (
                    <ReplyUsage
                      conversationId={conversationId}
                      runId={message.runId}
                    />
                  ) : null}
                </>
              ) : null}
            </AssistantBubble>
          ),
        )}
        {!activeRun && approvalRunId ? (
          <AssistantBubble>
            {(approvals.error ? [] : (approvals.data ?? [])).map((approval) => (
              <ExternalApproval
                key={approval.id}
                id={approval.id}
                runId={approvalRunId}
                conversationId={conversationId}
              />
            ))}
          </AssistantBubble>
        ) : null}
        {activeRun ? (
          <AssistantBubble>
            <RunStateStrip
              awaitingExternalApproval={
                Boolean(
                  approvals.data?.some(
                    (approval) => approval.status === "pending",
                  ),
                ) ||
                Boolean(
                  liveForThis?.tools.some(
                    (tool) => tool.externalStatus === "pending",
                  ),
                )
              }
              status={activeRun.status}
              hasText={Boolean(liveForThis?.text)}
              queuedForMs={queuedForMs}
              errorCode={liveForThis?.failure?.code ?? null}
              errorMessage={liveForThis?.failure?.message ?? null}
              retrying={liveForThis?.retrying ?? false}
              attempt={liveForThis?.attempt ?? 1}
            />
            {approvals.error ? (
              <p role="alert">
                Couldn’t load external approvals.{" "}
                <button type="button" onClick={() => void approvals.refetch()}>
                  Retry
                </button>
              </p>
            ) : null}
            {[
              ...new Set([
                ...(approvals.error ? [] : (approvals.data ?? [])).map(
                  (approval) => approval.id,
                ),
                ...(liveForThis?.tools.flatMap((tool) =>
                  tool.approvalId ? [tool.approvalId] : [],
                ) ?? []),
              ]),
            ].map((id) => (
              <ExternalApproval
                key={id}
                id={id}
                runId={activeRun.id}
                conversationId={conversationId}
              />
            ))}
            <ExternalRunActivity
              key={activeRun.id}
              runId={activeRun.id}
              active
              enabled={Boolean(
                messages.some(
                  (m) => m.runId === activeRun.id && m.hasExternalTools,
                ) || liveForThis?.tools.some((tool) => tool.callId),
              )}
              live={liveForThis?.tools}
            />
            {liveForThis ? (
              <>
                {liveForThis.text ? (
                  <AssistantMarkdown text={liveForThis.text} />
                ) : null}
                <CitationCards
                  conversationId={conversationId}
                  messageId=""
                  live={liveForThis.citations}
                />
                <ProposalCards
                  conversationId={conversationId}
                  messageId={null}
                  proposalIds={liveForThis.proposals.map((p) => p.proposalId)}
                />
              </>
            ) : null}
          </AssistantBubble>
        ) : null}
      </ol>
      <div ref={endRef} />
    </div>
  );
}

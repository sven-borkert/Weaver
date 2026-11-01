"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  humanAssistantError,
  isConversationUnavailable,
  renameTitleFieldError,
} from "~/lib/assistant/conversationErrors";
import { snapshotToRequest } from "~/lib/assistant/scopeDraft";
import { cn } from "~/lib/utils";
import { api } from "~/trpc/react";
import { useAssistant } from "./AssistantProvider";
import { Composer } from "./Composer";
import { AutoApproveChanges } from "./AutoApproveChanges";
import { ConversationMenu } from "./ConversationMenu";
import { ScopeSelector } from "./ScopeSelector";
import { SessionBar } from "./SessionUsage";
import { Transcript } from "./Transcript";
import { useScopeDraft } from "./useScopeDraft";

// Client-side mirror of MAX_CONVERSATION_TITLE_CHARS in
// packages/core/src/services/assistantConversations.ts.
const MAX_TITLE_CHARS = 200;

export function AssistantConversation({
  conversationId,
  onNew,
  onOpenList,
  onDeleted,
  onUnavailable,
  fullPage,
}: {
  conversationId: string;
  onNew: () => void;
  onOpenList: () => void;
  onDeleted: () => void;
  /**
   * Fired once per conversationId when `getConversation` says it is gone or
   * not ours, with the raw error message for `humanAssistantError`.
   */
  onUnavailable: (message: string) => void;
  fullPage: boolean;
}) {
  const utils = api.useUtils();
  const { composerRef, consumeComposerFocusRequest } = useAssistant();
  const conversation = api.assistant.getConversation.useQuery({
    conversationId,
  });
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const [titleError, setTitleError] = useState<string | null>(null);
  const rename = api.assistant.renameConversation.useMutation({
    onSuccess: (_result, variables) => {
      setEditingTitle(null);
      setTitleError(null);
      void utils.assistant.getConversation.invalidate({
        conversationId: variables.conversationId,
      });
      void utils.assistant.listConversations.invalidate();
    },
    onError: (e) => {
      const fieldError = renameTitleFieldError(e);
      if (fieldError) {
        setTitleError(fieldError);
        return;
      }
      toast.error(
        humanAssistantError(e.message, "Couldn't rename the conversation"),
      );
    },
  });
  // Spec §10: an unavailable conversation must not stay the active one —
  // whoever owns `activeConversationId` clears it, so a deleted or foreign id
  // cannot survive in session storage and strand the docked panel. Reported
  // at most once per conversation so a re-rendering parent can't loop.
  const unavailable = isConversationUnavailable(conversation.error);
  const unavailableMessage = conversation.error?.message ?? "";
  const reportedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!unavailable || reportedRef.current === conversationId) return;
    reportedRef.current = conversationId;
    onUnavailable(unavailableMessage);
  }, [unavailable, unavailableMessage, conversationId, onUnavailable]);
  const c = unavailable ? undefined : conversation.data;
  const composerReady = !!c;
  // Keep navigation focus pending until the asynchronous composer mounts.
  useEffect(() => {
    if (!composerReady || !composerRef.current) return;
    if (consumeComposerFocusRequest()) composerRef.current.focus();
  }, [composerReady, conversationId, consumeComposerFocusRequest, composerRef]);
  const lastUserSnapshot =
    [...(c?.messages ?? [])].reverse().find((m) => m.role === "user")
      ?.scopeSnapshot ?? null;
  const scope = useScopeDraft({
    conversationId,
    pinnedProjectId: c?.pinnedProjectId ?? null,
    lastUserSnapshot,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-line flex shrink-0 items-center gap-2 border-b px-3 py-2">
        {editingTitle !== null ? (
          <form
            className="flex flex-1 flex-col gap-0.5"
            onSubmit={(e) => {
              e.preventDefault();
              rename.mutate({ conversationId, title: editingTitle });
            }}
          >
            <input
              aria-label="Conversation title"
              aria-invalid={Boolean(titleError)}
              autoFocus
              maxLength={MAX_TITLE_CHARS}
              disabled={rename.isPending}
              className={cn(
                "text-text flex-1 bg-transparent text-[13px] font-semibold outline-none",
                titleError && "text-danger",
              )}
              value={editingTitle}
              onChange={(e) => {
                setEditingTitle(e.target.value);
                if (titleError) setTitleError(null);
              }}
              onBlur={() => setEditingTitle(null)}
            />
            {titleError ? (
              <p className="text-danger text-[12px]">{titleError}</p>
            ) : null}
          </form>
        ) : (
          <button
            type="button"
            className="text-text flex-1 truncate text-left text-[13px] font-semibold"
            title="Rename"
            onClick={() => {
              if (!c) return;
              setTitleError(null);
              setEditingTitle(c.title);
            }}
          >
            {c?.title ?? "Conversation"}
          </button>
        )}
        {/*
          Rendered even without `c`: spec §10 requires the unavailable state
          to still offer "New conversation", and the menu is the panel's only
          route back to the list.
        */}
        <ConversationMenu
          conversation={c ?? null}
          onNew={onNew}
          onOpenList={onOpenList}
          fullPage={fullPage}
          onDeleted={onDeleted}
        />
      </div>
      <div className="border-line flex shrink-0 flex-wrap items-center gap-3 border-b px-3 py-2">
        <ScopeSelector
          draft={scope.draft}
          onChange={scope.setDraft}
          page={scope.page}
          accessibleProjects={scope.accessibleProjects}
          truncated={lastUserSnapshot?.truncated}
          dropped={scope.dropped}
        />
        {c ? (
          <AutoApproveChanges
            key={conversationId}
            conversationId={conversationId}
            enabled={c.autoApproveChanges}
          />
        ) : null}
        {c ? <SessionBar conversationId={conversationId} /> : null}
      </div>
      <Transcript
        conversationId={conversationId}
        onScopeReuse={(s) => scope.setDraft(snapshotToRequest(s))}
      />
      {c ? (
        <Composer
          key={conversationId}
          conversationId={conversationId}
          scope={scope.draft}
          activeRunId={c.activeRun?.id ?? null}
        />
      ) : null}
    </div>
  );
}

"use client";

import { Send, Square } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { ScopeRequest } from "@weaver/core/assistant/scopeSchema";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { humanAssistantError } from "~/lib/assistant/conversationErrors";
import { api } from "~/trpc/react";
import { useAssistant } from "./AssistantProvider";

const MAX_CHARS = 32_000;
const COUNTER_FROM = 28_000;

export function Composer({
  conversationId,
  scope,
  activeRunId,
}: {
  conversationId: string;
  scope: ScopeRequest;
  activeRunId: string | null;
}) {
  const utils = api.useUtils();
  const { startLiveRun, composerRef } = useAssistant();
  const [text, setText] = useState("");

  const send = api.assistant.sendMessage.useMutation({
    onSuccess: ({ run }, variables) => {
      setText("");
      startLiveRun({ runId: run.id, conversationId: variables.conversationId });
      void utils.assistant.getConversation.invalidate({
        conversationId: variables.conversationId,
      });
      void utils.assistant.listConversations.invalidate();
    },
    onError: (err, variables) => {
      // "a run is already active" means our view is stale, not that the user erred.
      if (err.data?.code === "CONFLICT") {
        void utils.assistant.getConversation.invalidate({
          conversationId: variables.conversationId,
        });
        return;
      }
      toast.error(
        humanAssistantError(err.message, "Couldn't send the message"),
      );
    },
  });
  const cancel = api.assistant.cancelRun.useMutation({
    onSuccess: () =>
      void utils.assistant.getConversation.invalidate({ conversationId }),
    onError: (err) =>
      toast.error(humanAssistantError(err.message, "Couldn't cancel the run")),
  });

  const trimmed = text.trim();
  const busy = Boolean(activeRunId) || send.isPending;
  const submit = () => {
    if (!trimmed || busy || trimmed.length > MAX_CHARS) return;
    send.mutate({ conversationId, text: trimmed, scope });
  };

  return (
    <form
      className="border-line flex shrink-0 flex-col gap-2 border-t p-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Textarea
        ref={composerRef}
        aria-label="Message the assistant"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder={
          activeRunId
            ? "Waiting for the current answer…"
            : "Ask about your projects…"
        }
        disabled={busy}
        maxLength={MAX_CHARS}
        rows={3}
        className="resize-none text-[14px]"
      />
      <div className="flex items-center justify-between">
        <span className="text-text-muted text-[11px]" aria-live="polite">
          {text.length >= COUNTER_FROM
            ? `${text.length.toLocaleString()} / ${MAX_CHARS.toLocaleString()}`
            : ""}
        </span>
        {activeRunId ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => cancel.mutate({ runId: activeRunId })}
            disabled={cancel.isPending}
          >
            <Square className="size-3.5" aria-hidden="true" /> Cancel
          </Button>
        ) : (
          <Button type="submit" size="sm" disabled={!trimmed || busy}>
            <Send className="size-3.5" aria-hidden="true" /> Send
          </Button>
        )}
      </div>
    </form>
  );
}

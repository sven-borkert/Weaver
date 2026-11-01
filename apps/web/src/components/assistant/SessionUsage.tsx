"use client";

import { Cpu } from "lucide-react";
import { replyUsageLine, sessionUsageLine } from "~/lib/assistant/usageFormat";
import { api } from "~/trpc/react";

/** Model and running totals of the conversation, right-aligned in the controls row. */
export function SessionBar({ conversationId }: { conversationId: string }) {
  const usage = api.assistant.getConversationUsage.useQuery({ conversationId });
  if (!usage.data) return null;
  return (
    <p
      aria-label="Session usage"
      className="text-text-3 ml-auto flex min-w-0 items-center gap-1.5 text-[11px]"
    >
      <Cpu className="size-3 shrink-0" aria-hidden="true" />
      <span className="text-text-2 truncate font-medium">
        {usage.data.model ?? "No model"}
      </span>
      <span className="truncate">· {sessionUsageLine(usage.data)}</span>
    </p>
  );
}

/** One line under a settled reply: model, tool calls, tokens, duration. */
export function ReplyUsage({
  conversationId,
  runId,
}: {
  conversationId: string;
  runId: string;
}) {
  const usage = api.assistant.getConversationUsage.useQuery({ conversationId });
  const run = usage.data?.runs[runId];
  const line = run ? replyUsageLine(run) : "";
  if (!line) return null;
  return <p className="text-text-3 mt-2 text-[11px]">{line}</p>;
}

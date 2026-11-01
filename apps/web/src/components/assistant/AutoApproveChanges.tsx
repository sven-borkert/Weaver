"use client";

import { useId } from "react";
import { toast } from "sonner";
import { humanAssistantError } from "~/lib/assistant/conversationErrors";
import { api } from "~/trpc/react";

const DESCRIPTION =
  "New document, table and exam changes in the pinned project, or the single scoped project when unpinned; other projects require review. Write tools of your MCP connections also run without asking.";

export function AutoApproveChanges({
  conversationId,
  enabled,
}: {
  conversationId: string;
  enabled: boolean;
}) {
  const descriptionId = useId();
  const utils = api.useUtils();
  const update = api.assistant.setAutoApproveChanges.useMutation({
    onSuccess: async (_result, variables) => {
      await Promise.all([
        utils.assistant.getConversation.invalidate({
          conversationId: variables.conversationId,
        }),
        utils.assistant.getConversationStatus.invalidate({
          conversationId: variables.conversationId,
        }),
        utils.assistant.listConversations.invalidate(),
      ]);
    },
    onError: (error) =>
      toast.error(
        humanAssistantError(error.message, "Couldn't update auto-approve"),
      ),
  });
  return (
    <div title={DESCRIPTION}>
      <label className="text-text-2 flex items-center gap-2 text-[12px]">
        <input
          type="checkbox"
          autoComplete="off"
          checked={enabled}
          disabled={update.isPending}
          aria-describedby={descriptionId}
          className="accent-brand size-3.5"
          onChange={(event) => {
            if (!update.isPending)
              update.mutate({ conversationId, enabled: event.target.checked });
          }}
        />
        Auto-approve
        {update.isPending ? <span role="status">Saving…</span> : null}
      </label>
      <p id={descriptionId} className="sr-only">
        {DESCRIPTION}
      </p>
    </div>
  );
}

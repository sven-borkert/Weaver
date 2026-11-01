"use client";

import {
  Maximize2,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Trash2,
  List,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import type { RouterOutputs } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { humanAssistantError } from "~/lib/assistant/conversationErrors";
import { usePageContext } from "~/lib/assistant/pageContext";
import { useAssistant } from "./AssistantProvider";
import { api } from "~/trpc/react";

type Conversation = RouterOutputs["assistant"]["getConversation"];

/**
 * `conversation` is null while the conversation itself failed to load (spec
 * §10's "isn't available" state). The menu still renders then, reduced to
 * New/Conversations: without it the panel or the /assistant route would show
 * a dead conversation with no route back to the list or to a new one.
 */
export function ConversationMenu({
  conversation,
  onNew,
  onOpenList,
  fullPage,
  onDeleted,
}: {
  conversation: Conversation | null;
  onNew: () => void;
  onOpenList: () => void;
  fullPage: boolean;
  onDeleted: () => void;
}) {
  const utils = api.useUtils();
  const { isActiveConversation } = useAssistant();
  const page = usePageContext();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const refresh = (_result: unknown, variables: { conversationId: string }) => {
    void utils.assistant.getConversation.invalidate({
      conversationId: variables.conversationId,
    });
    void utils.assistant.listConversations.invalidate();
  };
  const pin = api.assistant.pinConversation.useMutation({
    onSuccess: refresh,
    onError: (e) =>
      toast.error(humanAssistantError(e.message, "Couldn't update the pin")),
  });
  const remove = api.assistant.deleteConversation.useMutation({
    onSuccess: (_result, variables) => {
      toast.success("Conversation deleted");
      void utils.assistant.listConversations.invalidate();
      setConfirmDelete(false);
      if (isActiveConversation(variables.conversationId)) onDeleted();
    },
    onError: (e) =>
      toast.error(
        e.data?.code === "CONFLICT"
          ? "Cancel the run first"
          : humanAssistantError(e.message, "Couldn't delete the conversation"),
      ),
  });
  const activeRun = Boolean(conversation?.activeRun);

  return (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={onNew}>
        <Plus aria-hidden="true" /> New
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={onOpenList}>
        <List aria-hidden="true" /> Conversations
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Conversation menu"
            disabled={!conversation}
          >
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {!conversation ? null : conversation.pinnedProjectId ? (
            <DropdownMenuItem
              onSelect={() =>
                pin.mutate({ conversationId: conversation.id, projectId: null })
              }
            >
              <PinOff aria-hidden="true" /> Unpin
            </DropdownMenuItem>
          ) : page.projectId ? (
            <DropdownMenuItem
              onSelect={() =>
                pin.mutate({
                  conversationId: conversation.id,
                  projectId: page.projectId!,
                })
              }
            >
              <Pin aria-hidden="true" /> Pin to this project
            </DropdownMenuItem>
          ) : null}
          {fullPage || !conversation ? null : (
            <DropdownMenuItem asChild>
              <Link href={`/assistant/${conversation.id}`}>
                <Maximize2 aria-hidden="true" /> Open full page
              </Link>
            </DropdownMenuItem>
          )}
          {conversation ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={activeRun}
                onSelect={() => setConfirmDelete(true)}
                className="text-danger-text"
              >
                <Trash2 aria-hidden="true" /> Delete
                {activeRun ? " (cancel the run first)" : ""}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        open={confirmDelete && Boolean(conversation)}
        onOpenChange={(open) => !remove.isPending && setConfirmDelete(open)}
      >
        <DialogContent aria-busy={remove.isPending}>
          <DialogHeader>
            <DialogTitle>Delete conversation</DialogTitle>
            <DialogDescription>
              “{conversation?.title}” and its proposals will be removed.
              Accepted changes stay in your projects.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={remove.isPending}
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={remove.isPending}
              onClick={() =>
                conversation &&
                remove.mutate({ conversationId: conversation.id })
              }
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

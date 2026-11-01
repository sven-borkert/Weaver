"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AssistantConversation } from "~/components/assistant/AssistantConversation";
import { useAssistant } from "~/components/assistant/AssistantProvider";
import { AssistantUnavailable } from "~/components/assistant/AssistantUnavailable";
import { ConversationList } from "~/components/assistant/ConversationList";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { createConversationRequestGuard } from "~/lib/assistant/conversationRequest";
import { isConversationUnavailable } from "~/lib/assistant/conversationErrors";
import { humanAssistantError } from "~/lib/assistant/conversationErrors";
import { api } from "~/trpc/react";

export function AssistantPage({
  conversationId,
}: {
  conversationId: string | null;
}) {
  const router = useRouter();
  const {
    activeConversationId,
    setActiveConversationId,
    markSeen,
    requestComposerFocus,
    consumeComposerFocusRequest,
  } = useAssistant();
  const utils = api.useUtils();
  const me = api.account.me.useQuery();
  const availability = api.assistant.availability.useQuery(undefined, {
    refetchInterval: 60_000,
  });
  const [listOpen, setListOpen] = useState(false);
  // Shares `AssistantConversation`'s query key, so this is the same request.
  const conversation = api.assistant.getConversation.useQuery(
    { conversationId: conversationId ?? "" },
    { enabled: Boolean(conversationId) },
  );
  const [createRequests] = useState(createConversationRequestGuard);
  useEffect(
    () => () => createRequests.invalidate(),
    [createRequests, conversationId],
  );
  const create = api.assistant.createConversation.useMutation({
    onSuccess: () => void utils.assistant.listConversations.invalidate(),
  });
  const startNew = () => {
    const request = createRequests.begin();
    requestComposerFocus();
    create.mutate(
      {},
      {
        onSuccess: (c) => {
          if (createRequests.isCurrent(request))
            router.push(`/assistant/${c.id}`);
        },
        onError: (e) => {
          if (!createRequests.isCurrent(request)) return;
          consumeComposerFocusRequest();
          toast.error(
            humanAssistantError(e.message, "Couldn't start a new conversation"),
          );
        },
      },
    );
  };

  // The page and the docked panel must never disagree about the active
  // conversation — but only a conversation that actually loaded may become
  // it. /assistant/<deleted-or-foreign-id> must not write that id into
  // session storage, or the docked panel inherits a dead conversation the
  // user can only escape via the address bar (spec §10).
  const loaded =
    !isConversationUnavailable(conversation.error) &&
    conversation.data?.id === conversationId;
  useEffect(() => {
    if (conversationId && loaded) {
      setActiveConversationId(conversationId);
      markSeen();
    }
  }, [conversationId, loaded, setActiveConversationId, markSeen]);

  const select = (id: string) => {
    createRequests.invalidate();
    setListOpen(false);
    router.push(`/assistant/${id}`);
  };
  // A deleted conversation must not linger as the docked panel's active id
  // (the panel's own delete path already clears it — AppShell.tsx).
  const backToIndexAfterDelete = () => {
    setActiveConversationId(null);
    router.push("/assistant");
  };
  const list = (
    <>
      <div className="border-line flex shrink-0 items-center justify-between border-b px-3 py-2">
        <span className="text-text text-[13px] font-semibold">
          Conversations
        </span>
        <Button
          type="button"
          size="sm"
          onClick={startNew}
          disabled={create.isPending}
        >
          <Plus aria-hidden="true" /> New
        </Button>
      </div>
      <ConversationList activeId={conversationId} onSelect={select} />
    </>
  );

  return (
    <section
      aria-label="Assistant"
      tabIndex={-1}
      className="bg-surface border-line grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] overflow-hidden border 2xl:grid-cols-[18rem_minmax(0,1fr)]"
    >
      <aside className="bg-surface-2 border-line hidden min-h-0 flex-col border-r 2xl:flex">
        {list}
      </aside>
      <div className="flex min-h-0 min-w-0 flex-col">
        <div className="border-line flex shrink-0 items-center gap-2 border-b px-3 py-2 2xl:hidden">
          <Dialog open={listOpen} onOpenChange={setListOpen}>
            <DialogTrigger asChild>
              <Button type="button" variant="outline" size="sm">
                Conversations
              </Button>
            </DialogTrigger>
            <DialogContent className="bg-surface top-0 left-0 h-dvh max-h-dvh w-[min(22rem,calc(100vw-2rem))] max-w-none translate-x-0 translate-y-0 grid-rows-[auto_minmax(0,1fr)] gap-0 rounded-none border-y-0 border-l-0 p-0 sm:max-w-none">
              <DialogHeader className="border-line border-b px-4 py-4 pr-12">
                <DialogTitle>Conversations</DialogTitle>
                <DialogDescription className="sr-only">
                  Choose a conversation.
                </DialogDescription>
              </DialogHeader>
              <div className="flex min-h-0 flex-col">{list}</div>
            </DialogContent>
          </Dialog>
        </div>
        {availability.data && !availability.data.ready ? (
          <AssistantUnavailable
            reason={availability.data.reason}
            isAdmin={me.data?.role === "Admin"}
          />
        ) : conversationId ? (
          <AssistantConversation
            key={conversationId}
            conversationId={conversationId}
            fullPage
            onNew={startNew}
            onOpenList={() => setListOpen(true)}
            onDeleted={backToIndexAfterDelete}
            onUnavailable={() => {
              // Only if the panel is already sitting on this same dead id;
              // never clobber a different conversation it has open.
              if (activeConversationId === conversationId)
                setActiveConversationId(null);
            }}
          />
        ) : (
          <p className="text-text-2 p-6 text-[13px]">
            Pick a conversation or start a new one.
          </p>
        )}
      </div>
    </section>
  );
}

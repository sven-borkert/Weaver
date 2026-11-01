export type UnseenCompletionInput = {
  open: boolean;
  activeConversationId: string | null;
  conversationId: string;
};

/**
 * A finished run should raise the unseen-completion dot when the panel isn't
 * showing it live: closed outright, or open on a different conversation.
 */
export function shouldMarkUnseen({
  open,
  activeConversationId,
  conversationId,
}: UnseenCompletionInput): boolean {
  return !open || activeConversationId !== conversationId;
}

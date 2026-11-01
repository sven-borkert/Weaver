export const ASSISTANT_OPEN_KEY = "weaver:assistant:open";
export const ASSISTANT_CONVERSATION_KEY = "weaver:assistant:conversation";

type Reader = Pick<Storage, "getItem">;
type Writer = Pick<Storage, "setItem" | "removeItem">;

export function readOpen(storage: Reader): boolean {
  try {
    return storage.getItem(ASSISTANT_OPEN_KEY) === "open";
  } catch {
    return false;
  }
}

export function writeOpen(storage: Writer, open: boolean): void {
  try {
    storage.setItem(ASSISTANT_OPEN_KEY, open ? "open" : "closed");
  } catch {
    // Storage may be blocked; the panel simply forgets its state.
  }
}

export function readConversation(
  storage: Reader,
  principalId?: string | null,
): string | null {
  try {
    return storage.getItem(
      `${ASSISTANT_CONVERSATION_KEY}:${principalId ?? "anonymous"}`,
    );
  } catch {
    return null;
  }
}

export function writeConversation(
  storage: Writer,
  id: string | null,
  principalId?: string | null,
): void {
  try {
    if (id)
      storage.setItem(
        `${ASSISTANT_CONVERSATION_KEY}:${principalId ?? "anonymous"}`,
        id,
      );
    else
      storage.removeItem(
        `${ASSISTANT_CONVERSATION_KEY}:${principalId ?? "anonymous"}`,
      );
  } catch {
    // Same as writeOpen.
  }
}

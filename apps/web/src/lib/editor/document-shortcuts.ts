export type DocumentShortcutContext =
  "document" | "title" | "source" | "unrelated-input" | "overlay";

export type DocumentShortcutEvent = Pick<
  KeyboardEvent,
  | "key"
  | "ctrlKey"
  | "metaKey"
  | "altKey"
  | "shiftKey"
  | "isComposing"
  | "defaultPrevented"
> &
  Partial<Pick<KeyboardEvent, "code" | "repeat" | "getModifierState">>;

export type DocumentShortcut = "save" | "toggle-source";

export function classifyDocumentShortcut(
  event: DocumentShortcutEvent,
  context: DocumentShortcutContext,
): DocumentShortcut | null {
  if (
    context === "unrelated-input" ||
    context === "overlay" ||
    event.isComposing ||
    event.defaultPrevented ||
    event.repeat ||
    event.shiftKey ||
    !(event.ctrlKey || event.metaKey) ||
    event.getModifierState?.("AltGraph")
  )
    return null;

  if (!event.altKey) return event.key.toLowerCase() === "s" ? "save" : null;
  // Option changes printable keys on macOS, including S becoming ß.
  const code =
    event.code === undefined || event.code === ""
      ? `Key${event.key.toUpperCase()}`
      : event.code;
  if (code === "KeyS") return "toggle-source";
  return null;
}

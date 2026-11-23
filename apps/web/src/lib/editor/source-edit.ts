import type { SourceEdit } from "./generated-markdown";

/** Edits the field as typing would, so its own undo reverts the edit and its change handler runs. */
export function applySourceEdit(
  input: HTMLTextAreaElement,
  { from, to, text }: SourceEdit,
): void {
  const original = input.value;
  const expected = original.slice(0, from) + text + original.slice(to);
  input.focus({ preventScroll: true });
  input.setSelectionRange(from, to);
  try {
    // Deprecated but still the only edit that joins a field's native undo history.
    input.ownerDocument.execCommand("insertText", false, text);
  } catch {
    // Unsupported here; the fallback below applies the edit.
  }
  if (input.value === expected) return;
  if (input.value !== original) return;
  input.setRangeText(text, from, to, "end");
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

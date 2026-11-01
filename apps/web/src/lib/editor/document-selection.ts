import type { Editor } from "@tiptap/core";
import type { SelectionBookmark } from "@tiptap/pm/state";

export function restoreDocumentSelection(
  editor: Editor,
  bookmark: SelectionBookmark | null,
  disabled: boolean,
): boolean {
  if (disabled || !editor.isEditable || editor.isDestroyed) return false;
  if (bookmark) {
    try {
      const selection = bookmark.resolve(editor.state.doc);
      // Re-setting an unchanged cursor would clear pending text formatting.
      if (!selection.eq(editor.state.selection))
        editor.view.dispatch(editor.state.tr.setSelection(selection));
    } catch {
      return false;
    }
  }
  return true;
}

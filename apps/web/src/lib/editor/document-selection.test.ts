import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import { describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/core";
import { restoreDocumentSelection } from "./document-selection";
const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*" },
    text: {},
  },
});
function state(text: string) {
  return EditorState.create({
    doc: schema.node("doc", null, [
      schema.node("paragraph", null, schema.text(text)),
    ]),
  });
}
describe("document selection", () => {
  it("restores a mapped selection and refuses commands after saving or role loss", () => {
    const initial = state("hello");
    const bookmark = TextSelection.create(initial.doc, 2, 4).getBookmark();
    const transaction = initial.tr.insertText("prefix", 1);
    const current = initial.apply(transaction);
    const dispatch = vi.fn<(transaction: Transaction) => void>();
    const editor = {
      state: current,
      view: { dispatch },
      isEditable: true,
      isDestroyed: false,
    };
    const mapped = bookmark.map(transaction.mapping);
    expect(
      restoreDocumentSelection(editor as unknown as Editor, mapped, false),
    ).toBe(true);
    expect(dispatch.mock.calls[0]?.[0].selection.from).toBe(8);
    dispatch.mockClear();
    expect(
      restoreDocumentSelection(editor as unknown as Editor, mapped, true),
    ).toBe(false);
    editor.isEditable = false;
    expect(
      restoreDocumentSelection(editor as unknown as Editor, mapped, false),
    ).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

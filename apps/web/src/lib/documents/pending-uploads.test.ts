import { getSchema } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { documentExtensions } from "@weaver/core/editor/extensions";
import { describe, expect, it } from "vitest";
import { PendingDocumentUploads } from "./pending-uploads";

const schema = getSchema(documentExtensions());
const state = EditorState.create({
  schema,
  doc: schema.nodeFromJSON({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "abc" }] }],
  }),
});

describe("pending document uploads", () => {
  it("revokes every outstanding upload so late completions cannot insert after discard", () => {
    const uploads = new PendingDocumentUploads();
    const first = uploads.add(TextSelection.create(state.doc, 2).getBookmark());
    const second = uploads.add(
      TextSelection.create(state.doc, 3).getBookmark(),
    );
    expect(uploads.size).toBe(2);
    uploads.cancel();
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(uploads.complete(first.id)).toBeNull();
    expect(uploads.size).toBe(0);
  });

  it("maps the insertion point through intervening edits and consumes it once", () => {
    const uploads = new PendingDocumentUploads();
    const pending = uploads.add(
      TextSelection.create(state.doc, 3).getBookmark(),
    );
    const transaction = state.tr.insertText("XX", 1);
    uploads.map(transaction.mapping);
    const bookmark = uploads.complete(pending.id);
    expect(bookmark?.resolve(transaction.doc).from).toBe(5);
    expect(uploads.complete(pending.id)).toBeNull();
    expect(uploads.size).toBe(0);
  });
});

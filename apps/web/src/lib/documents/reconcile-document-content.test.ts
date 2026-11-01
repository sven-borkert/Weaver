import { getSchema } from "@tiptap/core";
import { history, redo, undo } from "@tiptap/pm/history";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import { documentExtensions } from "@weaver/core/editor/extensions";
import { reconcileDocumentContent } from "./reconcile-document-content";

const schema = getSchema(documentExtensions());
const paragraph = (text: string) =>
  schema.node("paragraph", null, schema.text(text));

describe("saved document reconciliation", () => {
  it("keeps body edits undoable across image and reference attribute normalization", () => {
    const initial = schema.node("doc", null, [
      paragraph("Original"),
      schema.node("image", { src: "old.assets/photo.png", alt: "Photo" }),
      schema.node(
        "paragraph",
        null,
        schema.node("crossref", {
          targetId: "11111111-1111-4111-8111-111111111111",
          targetType: "document",
          label: "Old target",
        }),
      ),
    ]);
    let state = EditorState.create({
      schema,
      doc: initial,
      plugins: [history()],
    });
    state = state.apply(state.tr.insertText(" update", 9));
    const normalized = schema.node("doc", null, [
      state.doc.child(0),
      schema.node("image", { src: "renamed.assets/photo.png", alt: "Photo" }),
      schema.node(
        "paragraph",
        null,
        schema.node("crossref", {
          targetId: "11111111-1111-4111-8111-111111111111",
          targetType: "document",
          label: "Current target",
        }),
      ),
    ]);
    state = state.apply(reconcileDocumentContent(state, normalized));
    expect(state.doc.eq(normalized)).toBe(true);
    expect(
      undo(state, (transaction) => {
        state = state.apply(transaction);
      }),
    ).toBe(true);
    expect(state.doc.child(0).textContent).toBe("Original");
    expect(state.doc.child(1).attrs.src).toBe("renamed.assets/photo.png");
    expect(state.doc.child(2).child(0).attrs.label).toBe("Current target");
    expect(
      redo(state, (transaction) => {
        state = state.apply(transaction);
      }),
    ).toBe(true);
    expect(state.doc.eq(normalized)).toBe(true);
  });

  it("maps the selection and preserves unrelated undo steps when normalized structure changes", () => {
    let state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [paragraph("Body"), paragraph("Tail")]),
      plugins: [history()],
    });
    state = state.apply(state.tr.insertText(" edited", 5));
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 15)),
    );
    const normalized = schema.node("doc", null, [
      state.doc.child(0),
      paragraph("New"),
      state.doc.child(1),
    ]);
    const transaction = reconcileDocumentContent(state, normalized);
    expect(transaction.getMeta("addToHistory")).toBe(false);
    state = state.apply(transaction);
    expect(state.doc.eq(normalized)).toBe(true);
    expect(state.selection.from).toBe(20);
    expect(
      undo(state, (update) => {
        state = state.apply(update);
      }),
    ).toBe(true);
    expect(state.doc.child(0).textContent).toBe("Body");
    expect(state.doc.child(1).textContent).toBe("New");
    expect(state.doc.child(2).textContent).toBe("Tail");
  });

  it("reconciles separated nested text, marks, and attributes without losing unchanged siblings", () => {
    const before = schema.node("doc", null, [
      schema.node("blockquote", null, [
        paragraph("Alpha  "),
        paragraph("Beta"),
      ]),
      schema.node("heading", { level: 2 }, schema.text("Title")),
    ]);
    const after = schema.node("doc", null, [
      schema.node("blockquote", null, [
        paragraph("Alpha"),
        schema.node(
          "paragraph",
          null,
          schema.text("Beta!", [schema.mark("bold")]),
        ),
      ]),
      schema.node("heading", { level: 3 }, schema.text("Title")),
    ]);
    const state = EditorState.create({
      schema,
      doc: before,
      plugins: [history()],
    });
    const transaction = reconcileDocumentContent(state, after);
    expect(state.apply(transaction).doc.eq(after)).toBe(true);
    expect(
      reconcileDocumentContent(
        EditorState.create({ schema, doc: after }),
        after,
      ).steps,
    ).toHaveLength(0);
  });
});

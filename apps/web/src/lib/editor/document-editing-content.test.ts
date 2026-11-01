import { Editor, type JSONContent } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { documentExtensions } from "@weaver/core/editor/extensions";
import { describe, expect, it } from "vitest";
import { documentEditingContent } from "./document-editing-content";

describe("persistent document content", () => {
  it.each<JSONContent>([
    { type: "doc", content: [] },
    {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Heading" }],
        },
      ],
    },
    {
      type: "doc",
      content: [{ type: "mermaid", attrs: { source: "graph TD; A-->B" } }],
    },
  ])(
    "normalizes the editable trailing paragraph before focus establishes dirty state: %j",
    (content) => {
      const original = structuredClone(content);
      const editor = new Editor({
        element: null,
        extensions: documentExtensions(),
        content: documentEditingContent(content),
      });
      const state = EditorState.create({
        schema: editor.schema,
        doc: editor.state.doc,
        plugins: editor.extensionManager.plugins,
      });
      const focused = state.applyTransaction(
        state.tr.setMeta("focus", true),
      ).state;
      expect(focused.doc.eq(state.doc)).toBe(true);
      expect(state.doc.lastChild?.type.name).toBe("paragraph");
      expect(content).toEqual(original);
      editor.destroy();
    },
  );

  it("retains authored paragraphs and is idempotent", () => {
    const content = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Body" }] },
      ],
    };
    expect(documentEditingContent(content)).toBe(content);
    const empty = documentEditingContent({ type: "doc", content: [] });
    expect(documentEditingContent(empty)).toBe(empty);
  });
});

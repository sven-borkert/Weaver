import { getSchema, type JSONContent } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { documentExtensions } from "@weaver/core/editor/extensions";
import type { DocumentOutlineEntry } from "~/lib/editor/document-heading-anchors";
import { createDocumentSectionAnchorPlugin } from "~/lib/editor/document-section-anchors";
import { useDocumentOutline } from "./use-document-outline";

const schema = getSchema(documentExtensions());
const heading = (text: string) => ({
  type: "heading",
  attrs: { level: 2 },
  content: [{ type: "text", text }],
});
const saved: JSONContent = { type: "doc", content: [heading("Saved")] };

function fakeEditor(content: JSONContent) {
  const listeners = new Set<() => void>();
  const editor = {
    isDestroyed: false,
    state: EditorState.create({
      doc: schema.nodeFromJSON(content),
      plugins: [createDocumentSectionAnchorPlugin()],
    }),
    on: (_event: string, listener: () => void) => listeners.add(listener),
    off: (_event: string, listener: () => void) => listeners.delete(listener),
    type(text: string, position: number) {
      editor.state = editor.state.apply(
        editor.state.tr.insertText(text, position),
      );
      for (const listener of listeners) listener();
    },
  };
  return editor;
}

afterEach(() => vi.unstubAllGlobals());

it("follows the live editor and falls back to the saved content", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const outlines: DocumentOutlineEntry[][] = [];
  function Harness({ editor }: { editor: Editor | null }) {
    outlines.push(useDocumentOutline(editor, saved));
    return null;
  }
  const editor = fakeEditor({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Body" }] },
      heading("Live"),
    ],
  });
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Harness editor={null} />);
  });
  expect(outlines.at(-1)).toEqual([
    { anchor: "section-saved", level: 2, text: "Saved" },
  ]);
  await act(async () => {
    renderer.update(<Harness editor={editor as unknown as Editor} />);
  });
  expect(outlines.at(-1)).toEqual([
    { anchor: "section-live", level: 2, text: "Live" },
  ]);
  const renders = outlines.length;
  await act(async () => {
    editor.type("More ", 1);
  });
  expect(outlines).toHaveLength(renders);
  await act(async () => {
    editor.type("Still ", 12);
  });
  expect(outlines.at(-1)).toEqual([
    { anchor: "section-still-live", level: 2, text: "Still Live" },
  ]);
  await act(async () => {
    renderer.unmount();
  });
});

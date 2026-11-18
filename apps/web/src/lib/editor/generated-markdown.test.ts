import { Editor } from "@tiptap/core";
import { history, undo } from "@tiptap/pm/history";
import { NodeSelection } from "@tiptap/pm/state";
import { documentExtensions } from "@weaver/core/editor/extensions";
import {
  parseDocumentBody,
  serializeDocumentBody,
} from "@weaver/core/editor/markdown";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  insertGeneratedMarkdown,
  parseGeneratedMarkdown,
} from "./generated-markdown";

const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()));

function editorWith(markdown: string) {
  const editor = new Editor({
    element: null,
    extensions: documentExtensions(),
    content: parseDocumentBody(markdown),
  });
  vi.spyOn(editor, "isDestroyed", "get").mockReturnValue(false);
  editor.view.updateState(editor.state.reconfigure({ plugins: [history()] }));
  editors.push(editor);
  return editor;
}

describe("insertGeneratedMarkdown", () => {
  it("inserts inline math at the end of the captured selection after document edits", () => {
    const editor = editorWith("Keep this here.");
    editor.commands.setTextSelection({ from: 6, to: 10 });
    let bookmark = editor.state.selection.getBookmark();
    const edit = editor.state.tr.insertText("Please ", 1);
    editor.view.dispatch(edit);
    bookmark = bookmark.map(edit.mapping);
    editor.commands.setTextSelection(1);

    expect(insertGeneratedMarkdown(editor, bookmark, String.raw`$\pi$`)).toBe(
      true,
    );
    expect(serializeDocumentBody(editor.getJSON())).toEqual(
      "Please Keep this$\\pi$ here.\n",
    );
    expect(editor.state.selection.from).toBe(18);
    expect(editor.state.selection.empty).toBe(true);
  });

  it("splits a paragraph around blocks and undoes the generated content together", () => {
    const editor = editorWith("**left right**");
    editor.commands.setTextSelection(6);
    editor.view.dispatch(editor.state.tr.insertText("+"));
    const before = editor.state.doc;
    const bookmark = editor.state.selection.getBookmark();
    const markdown = [
      "## Generated",
      "$$",
      String.raw`\sum_{i=1}^n i`,
      "$$",
      "```mermaid",
      "flowchart LR",
      "  A --> B",
      "```",
    ].join("\n");

    expect(insertGeneratedMarkdown(editor, bookmark, markdown)).toBe(true);
    const blocks = editor.getJSON().content;
    expect(blocks?.map((node) => node.type)).toEqual([
      "paragraph",
      "heading",
      "mathBlock",
      "mermaid",
      "paragraph",
    ]);
    expect(blocks?.[0]?.content).toEqual([
      { type: "text", marks: [{ type: "bold" }], text: "left +" },
    ]);
    expect(blocks?.[4]?.content).toEqual([
      { type: "text", marks: [{ type: "bold" }], text: "right" },
    ]);
    expect(editor.state.selection.$from.parent.textContent).toBe("right");
    expect(editor.state.selection.$from.parentOffset).toBe(0);
    const stored = parseDocumentBody(serializeDocumentBody(editor.getJSON()));
    expect(editor.schema.nodeFromJSON(stored).eq(editor.state.doc)).toBe(true);
    expect(undo(editor.state, editor.view.dispatch)).toBe(true);
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(undo(editor.state, editor.view.dispatch)).toBe(true);
    expect(editor.state.doc.textContent).toBe("left right");
  });

  it("keeps an editing cursor after a diagram inserted into an empty document", () => {
    const editor = editorWith("");
    const bookmark = editor.state.selection.getBookmark();

    expect(
      insertGeneratedMarkdown(
        editor,
        bookmark,
        "```mermaid\nflowchart LR\n```",
      ),
    ).toBe(true);
    expect(editor.getJSON().content?.map((node) => node.type)).toEqual([
      "mermaid",
      "paragraph",
    ]);
    expect(editor.state.selection.empty).toBe(true);
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
  });

  it.each([
    ["A1B2", "$x$", "A$x$ 1B2\n"],
    ["text", "**word,**", "t**word,** ext\n"],
    ["text", "~~word,~~", "t~~word,~~ ext\n"],
  ])(
    "preserves inline formatting on save when inserting into %s",
    (body, snippet, expected) => {
      const editor = editorWith(body);
      editor.commands.setTextSelection(2);
      const bookmark = editor.state.selection.getBookmark();

      expect(insertGeneratedMarkdown(editor, bookmark, snippet)).toBe(true);
      expect(serializeDocumentBody(editor.getJSON())).toBe(expected);
      const stored = parseDocumentBody(serializeDocumentBody(editor.getJSON()));
      expect(editor.schema.nodeFromJSON(stored).eq(editor.state.doc)).toBe(
        true,
      );
    },
  );

  it("keeps the bullet list intact when a block cannot survive Markdown serialization", () => {
    const editor = editorWith("- List text");
    editor.commands.setTextSelection(5);
    const before = editor.state.doc;
    const bookmark = editor.state.selection.getBookmark();

    expect(
      insertGeneratedMarkdown(
        editor,
        bookmark,
        "```mermaid\nflowchart LR\nA --> B\n```",
      ),
    ).toBe(false);
    expect(editor.state.doc).toBe(before);
  });

  it("keeps paragraph text separate from an inserted ordered list", () => {
    const editor = editorWith("existing image");
    editor.commands.setTextSelection(9);
    const before = editor.state.doc;
    const bookmark = editor.state.selection.getBookmark();

    expect(
      insertGeneratedMarkdown(editor, bookmark, "2. inserted\n3. list"),
    ).toBe(false);
    expect(editor.state.doc).toBe(before);
  });

  it("keeps adjacent ordered lists from merging when saved", () => {
    const editor = editorWith("1. Original");
    const before = editor.state.doc;
    editor.view.dispatch(
      editor.state.tr.setSelection(NodeSelection.create(before, 0)),
    );
    const bookmark = editor.state.selection.getBookmark();

    expect(
      insertGeneratedMarkdown(editor, bookmark, "2. inserted\n3. list"),
    ).toBe(false);
    expect(editor.state.doc).toBe(before);
  });

  it("inserts a generated list between separate paragraphs when it can be saved", () => {
    const editor = editorWith("Heads up\n\nNext");
    editor.commands.setTextSelection(9);
    const bookmark = editor.state.selection.getBookmark();

    expect(
      insertGeneratedMarkdown(editor, bookmark, "2. inserted\n3. list"),
    ).toBe(true);
    const stored = parseDocumentBody(serializeDocumentBody(editor.getJSON()));
    expect(editor.schema.nodeFromJSON(stored).eq(editor.state.doc)).toBe(true);
  });

  it.each([
    ["- List text", 12],
    ["1. List text", 5],
    ["> [!NOTE]\n> List text", 4],
  ])("preserves supported body structure in %s", (body, position) => {
    const editor = editorWith(body);
    editor.commands.setTextSelection(position);
    const bookmark = editor.state.selection.getBookmark();

    expect(insertGeneratedMarkdown(editor, bookmark, "$$x^2$$")).toBe(true);
    const stored = parseDocumentBody(serializeDocumentBody(editor.getJSON()));
    expect(editor.schema.nodeFromJSON(stored).eq(editor.state.doc)).toBe(true);
  });

  it("refuses blocks that would lose their formatting in a table cell", () => {
    const editor = editorWith("| Cell |\n| --- |\n| Below |");
    const before = editor.state.doc;
    const bookmark = editor.state.selection.getBookmark();

    expect(insertGeneratedMarkdown(editor, bookmark, "$$x^2$$")).toBe(false);
    expect(editor.state.doc).toBe(before);
    expect(insertGeneratedMarkdown(editor, bookmark, "$x^2$")).toBe(true);
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
  });

  it("leaves the document alone when content is empty, invalid, or editing is disabled", () => {
    const editor = editorWith("Existing");
    const before = editor.state.doc;
    const bookmark = editor.state.selection.getBookmark();

    expect(insertGeneratedMarkdown(editor, bookmark, " \n ")).toBe(false);
    expect(
      insertGeneratedMarkdown(editor, bookmark, "![Bad](file:///tmp/file)"),
    ).toBe(false);
    editor.setEditable(false, false);
    expect(insertGeneratedMarkdown(editor, bookmark, "## Locked")).toBe(false);
    expect(editor.state.doc).toBe(before);
  });

  it("rejects an empty Markdown response before rendering a preview", () => {
    expect(() => parseGeneratedMarkdown(editorWith("").schema, "##")).toThrow();
  });

  it("keeps an explicitly empty fenced code block", () => {
    const editor = editorWith("");
    const bookmark = editor.state.selection.getBookmark();

    expect(insertGeneratedMarkdown(editor, bookmark, "```js\n```")).toBe(true);
    expect(editor.state.doc.firstChild?.type.name).toBe("codeBlock");
  });
});

import { Editor } from "@tiptap/core";
import { history, undo } from "@tiptap/pm/history";
import { NodeSelection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import { documentExtensions } from "@weaver/core/editor/extensions";
import {
  parseDocumentBody,
  serializeDocumentBody,
} from "@weaver/core/editor/markdown";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  documentAssistantContext,
  insertGeneratedMarkdown,
  parseGeneratedMarkdown,
  replaceGeneratedMarkdown,
  sourceAssistantContext,
  spliceGeneratedSource,
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
  it("prevents insertion when a generated plot uses an undefined variable", () => {
    const editor = editorWith("Keep this");
    const before = editor.state.doc;
    const plot = [
      "```plot",
      '{"type":"cartesian","expression":"a*x","x":[-3,3]}',
      "```",
    ].join("\n");

    expect(() => parseGeneratedMarkdown(editor.schema, plot)).toThrow(
      "Unknown value",
    );
    expect(
      insertGeneratedMarkdown(
        editor,
        editor.state.selection.getBookmark(),
        plot,
      ),
    ).toBe(false);
    expect(editor.state.doc).toBe(before);
  });

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

const plot = (expression: string) =>
  [
    "```plot",
    `{"type":"cartesian","expression":"${expression}","x":[-3,3]}`,
    "```",
  ].join("\n");

describe("replaceGeneratedMarkdown", () => {
  it("replaces selected text inline and undoes the replacement in one step", () => {
    const editor = editorWith("Keep this here.");
    editor.commands.setTextSelection({ from: 6, to: 10 });
    const before = editor.state.doc;

    expect(
      replaceGeneratedMarkdown(
        editor,
        editor.state.selection.getBookmark(),
        "**that**",
      ),
    ).toBe(true);
    expect(serializeDocumentBody(editor.getJSON())).toBe(
      "Keep **that** here.\n",
    );
    expect(undo(editor.state, editor.view.dispatch)).toBe(true);
    expect(editor.state.doc.eq(before)).toBe(true);
  });

  it("replaces a selected paragraph with blocks without leaving it empty", () => {
    const editor = editorWith("First\n\nSecond\n\nThird");
    editor.commands.setTextSelection({ from: 8, to: 14 });

    expect(
      replaceGeneratedMarkdown(
        editor,
        editor.state.selection.getBookmark(),
        "## Second\n\n- one\n- two",
      ),
    ).toBe(true);
    expect(serializeDocumentBody(editor.getJSON())).toBe(
      "First\n\n## Second\n\n- one\n- two\n\nThird\n",
    );
  });

  it("replaces a selected plot", () => {
    const editor = editorWith(`Intro\n\n${plot("sin(x)")}\n\nOutro`);
    editor.view.dispatch(
      editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 7)),
    );

    expect(
      replaceGeneratedMarkdown(
        editor,
        editor.state.selection.getBookmark(),
        plot("cos(x)"),
      ),
    ).toBe(true);
    const nodes = editor.getJSON().content ?? [];
    expect(nodes.map((node) => node.type)).toEqual([
      "paragraph",
      "mathPlot",
      "paragraph",
    ]);
    expect(String(nodes[1]?.attrs?.source)).toContain("cos(x)");
  });

  it("inserts at a cursor and refuses a table cell selection", () => {
    const editor = editorWith("| A | B |\n| --- | --- |\n| 1 | 2 |\n\nEnd");
    const cells: number[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "tableCell" || node.type.name === "tableHeader")
        cells.push(pos);
    });
    editor.view.dispatch(
      editor.state.tr.setSelection(
        CellSelection.create(editor.state.doc, cells[0]!, cells.at(-1)),
      ),
    );
    const before = editor.state.doc;
    expect(
      replaceGeneratedMarkdown(
        editor,
        editor.state.selection.getBookmark(),
        "Text",
      ),
    ).toBe(false);
    expect(editor.state.doc).toBe(before);

    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    expect(
      replaceGeneratedMarkdown(
        editor,
        editor.state.selection.getBookmark(),
        " here",
      ),
    ).toBe(true);
    expect(editor.state.doc.lastChild?.textContent).toBe("End here");
  });
});

function textPos(editor: Editor, text: string, end = false): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    const index = found < 0 && node.isText ? node.text!.indexOf(text) : -1;
    if (index >= 0) found = pos + index + (end ? text.length : 0);
    return found < 0;
  });
  if (found < 0) throw new Error(`"${text}" not found`);
  return found;
}

/** Selects from the start of `from` to the end of `to`. */
function selectText(editor: Editor, from: string, to = from) {
  editor.commands.setTextSelection({
    from: textPos(editor, from),
    to: textPos(editor, to, true),
  });
  return editor.state.selection.getBookmark();
}

const saved = (editor: Editor) => {
  const markdown = serializeDocumentBody(editor.getJSON());
  const stored = editor.schema.nodeFromJSON(parseDocumentBody(markdown));
  expect(stored.eq(editor.state.doc)).toBe(true);
  return markdown;
};

describe("applying a reply to whole selected blocks", () => {
  const fruit = "- cherry\n- apple\n- banana";

  it.each([
    [
      "a sorted list",
      "- apple\n- banana\n- cherry",
      "- apple\n- banana\n- cherry\n",
    ],
    [
      "plain paragraphs",
      "Apple\n\nBanana\n\nCherry",
      "Apple\n\nBanana\n\nCherry\n",
    ],
    [
      "a task list",
      "- [ ] apple\n- [x] banana\n- [ ] cherry",
      "- [ ] apple\n- [x] banana\n- [ ] cherry\n",
    ],
  ])("replaces three selected list items with %s", (_, reply, expected) => {
    const editor = editorWith(`Intro\n\n${fruit}\n\nOutro`);
    const bookmark = selectText(editor, "cherry", "banana");

    expect(replaceGeneratedMarkdown(editor, bookmark, reply)).toBe(true);
    expect(saved(editor)).toBe(`Intro\n\n${expected}\nOutro\n`);
  });

  it("merges a list reply into the items around the selection", () => {
    const editor = editorWith("- keep\n- cherry\n- apple\n- last");
    const bookmark = selectText(editor, "cherry", "apple");

    expect(
      replaceGeneratedMarkdown(editor, bookmark, "- apple\n- cherry"),
    ).toBe(true);
    expect(saved(editor)).toBe("- keep\n- apple\n- cherry\n- last\n");
  });

  it("splits a list around paragraphs that replace some of its items", () => {
    const editor = editorWith("1. keep\n2. cherry\n3. apple\n4. last");
    const bookmark = selectText(editor, "cherry", "apple");

    expect(replaceGeneratedMarkdown(editor, bookmark, "Apple\n\nCherry")).toBe(
      true,
    );
    expect(saved(editor)).toBe("1. keep\n\nApple\n\nCherry\n\n4. last\n");
  });

  it.each([
    ["inline text", "2"],
    ["a fenced block", "```js\n2\n```"],
  ])("replaces part of a code line with %s", (_, reply) => {
    const editor = editorWith("```js\nconst a = 1;\n```\n\nAfter");
    const bookmark = selectText(editor, "1");

    expect(replaceGeneratedMarkdown(editor, bookmark, reply)).toBe(true);
    expect(saved(editor)).toBe("```js\nconst a = 2;\n```\n\nAfter\n");
  });

  it.each([
    [
      "a paragraph",
      "First para\n\nSecond",
      "First para",
      "First para",
      "Added",
      "First para\n\nAdded\n\nSecond\n",
    ],
    [
      "a heading",
      "## Title\n\nBody",
      "Title",
      "Title",
      "Intro text",
      "## Title\n\nIntro text\n\nBody\n",
    ],
    [
      "a list",
      "- one\n- two\n\nAfter",
      "one",
      "two",
      "Summary",
      "- one\n- two\n\nSummary\n\nAfter\n",
    ],
    [
      "part of a list",
      "- one\n- two\n\nAfter",
      "ne",
      "tw",
      "## Notes",
      "- one\n- two\n\n## Notes\n\nAfter\n",
    ],
  ])(
    "inserts after %s instead of inside it",
    (_, body, from, to, reply, expected) => {
      const editor = editorWith(body);
      const bookmark = selectText(editor, from, to);

      expect(insertGeneratedMarkdown(editor, bookmark, reply)).toBe(true);
      expect(saved(editor)).toBe(expected);
    },
  );
});

describe("documentAssistantContext", () => {
  it("serializes the selection and its surroundings as Markdown", () => {
    const editor = editorWith("Intro with **bold** text.\n\n## Next");
    editor.commands.setTextSelection({ from: 12, to: 16 });
    const { from, to } = editor.state.selection;

    expect(documentAssistantContext(editor.state.doc, from, to)).toEqual({
      before: "Intro with ",
      selection: "**bold**",
      after: " text.\n\n## Next",
    });
    expect(documentAssistantContext(editor.state.doc, 1, 1)).toEqual({
      before: "",
      selection: "",
      after: "Intro with **bold** text.\n\n## Next",
    });
  });

  it("keeps the text nearest the selection when the page is long", () => {
    const long = "a".repeat(25_000);
    const context = sourceAssistantContext(`${long}|${long}`, 25_000, 25_001);
    expect(context.selection).toBe("|");
    expect(context.before).toHaveLength(20_000);
    expect(context.after).toHaveLength(20_000);
  });
});

describe("spliceGeneratedSource", () => {
  const schema = editorWith("").schema;

  it("replaces inline text in place and gives blocks their own lines", () => {
    const value = "Intro text\nmore";
    expect(
      spliceGeneratedSource(
        schema,
        { value, start: 6, end: 10 },
        "**words**",
        "replace",
      ),
    ).toEqual({ from: 6, to: 10, text: "**words**" });
    expect(
      spliceGeneratedSource(
        schema,
        { value, start: 6, end: 10 },
        "\n$$\nx^2\n$$\n",
        "insert",
      ),
    ).toEqual({ from: 10, to: 10, text: "\n\n$$\nx^2\n$$\n" });
    expect(
      spliceGeneratedSource(
        schema,
        { value: "End", start: 3, end: 3 },
        "```js\nx\n```",
        "insert",
      ),
    ).toEqual({ from: 3, to: 3, text: "\n\n```js\nx\n```\n" });
  });

  const apply = (
    value: string,
    start: number,
    end: number,
    reply: string,
    action: "insert" | "replace",
  ) => {
    const edit = spliceGeneratedSource(
      schema,
      { value, start, end },
      reply,
      action,
    );
    return edit && value.slice(0, edit.from) + edit.text + value.slice(edit.to);
  };

  it("gives a reply its own paragraph on the blank line between paragraphs", () => {
    const value = "First\n\nSecond";
    expect(apply(value, 6, 6, "Middle", "insert")).toBe(
      "First\n\nMiddle\n\nSecond",
    );
  });

  it("keeps a reply on the blank line after a list out of the last item", () => {
    const value = "- one\n- two\n\nAfter";
    const result = apply(value, 12, 12, "Summary", "insert");
    expect(result).toBe("- one\n- two\n\nSummary\n\nAfter");
    expect(
      parseDocumentBody(result!).content?.map((node) => node.type),
    ).toEqual(["bulletList", "paragraph", "paragraph"]);
  });

  it("separates a reply that replaces whole lines from the next block", () => {
    const value = "# Title\nText";
    expect(apply(value, 0, 7, "Plain", "replace")).toBe("Plain\n\nText");
  });

  it.each([
    ["a fenced reply", "```js\n2\n```"],
    ["inline text", "2"],
  ])("keeps %s inside a fenced block", (_, reply) => {
    const value = "```js\nconst a = 1;\n```\n\nAfter";
    const at = value.indexOf("1");
    expect(apply(value, at, at + 1, reply, "replace")).toBe(
      "```js\nconst a = 2;\n```\n\nAfter",
    );
  });

  it("refuses a reply that would end the fenced block around it", () => {
    for (const value of [
      "```js\nconst a = 1;\n```\n\nAfter",
      "```js\nconst a = 1;\n```",
    ]) {
      const at = value.indexOf("1");
      expect(
        apply(value, at, at + 1, "````\nx\n```\ny\n````", "replace"),
      ).toBeNull();
      expect(
        apply(value, at, at + 1, "## Heading\n\nText", "replace"),
      ).toBeNull();
    }
  });

  it("keeps a table row on one line with its cells", () => {
    const value = "| A | B |\n| --- | --- |\n| 1 | 2 |\n\nAfter";
    const at = value.indexOf("1");
    expect(apply(value, at, at + 1, "x | y", "replace")).toBe(
      "| A | B |\n| --- | --- |\n| x \\| y | 2 |\n\nAfter",
    );
    expect(apply(value, at, at + 1, "- a\n- b", "replace")).toBeNull();
  });

  it("refuses an edit that merges blocks outside the edited range", () => {
    const value = "First\n\nSecond\n\nThird";
    // A selected paragraph with its line break is replaced as a block.
    expect(apply(value, 7, 14, "Middle", "replace")).toBe(
      "First\n\nMiddle\n\nThird",
    );
    // Replacing the blank lines too would glue the reply to both neighbours.
    expect(apply(value, 5, 15, "Middle", "replace")).toBeNull();
  });

  it("refuses content that cannot be saved", () => {
    expect(
      spliceGeneratedSource(
        schema,
        { value: "Text", start: 0, end: 4 },
        plot("a*x"),
        "replace",
      ),
    ).toBeNull();
  });
});

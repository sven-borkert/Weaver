import { Editor, getSchema, type JSONContent } from "@tiptap/core";
import { documentExtensions } from "@weaver/core/editor/extensions";
import {
  parseDocumentBody,
  serializeDocumentBody,
} from "@weaver/core/editor/markdown";
import { NodeSelection, type Transaction } from "@tiptap/pm/state";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activeCalloutVariant,
  applyCallout,
  canApplyCallout,
  removeCallout,
} from "./callout-commands";

const schema = getSchema(documentExtensions());
const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()));

const text = (value: string): JSONContent => ({ type: "text", text: value });
const p = (value?: string): JSONContent =>
  value ? { type: "paragraph", content: [text(value)] } : { type: "paragraph" };
const item = (...content: JSONContent[]): JSONContent => ({
  type: "listItem",
  content,
});
const callout = (variant: string, ...content: JSONContent[]): JSONContent => ({
  type: "callout",
  attrs: { variant },
  content,
});

function editorWith(...content: JSONContent[]) {
  const editor = new Editor({
    element: null,
    extensions: documentExtensions(),
    content: { type: "doc", content },
  });
  vi.spyOn(editor, "isDestroyed", "get").mockReturnValue(false);
  editors.push(editor);
  return editor;
}

function posOf(editor: Editor, value: string): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text?.includes(value))
      found = pos + node.text.indexOf(value);
    return found < 0;
  });
  if (found < 0) throw new Error(`missing text ${value}`);
  return found;
}

// Headless editors carry no history plugin, so check the single-step contract directly.
function recordChanges(editor: Editor) {
  const changes: Transaction[] = [];
  editor.on("transaction", ({ transaction }) => {
    if (transaction.docChanged) changes.push(transaction);
  });
  return changes;
}

function expectOneUndoStep(changes: Transaction[], before: JSONContent) {
  expect(changes).toHaveLength(1);
  const [change] = changes;
  let doc = change!.doc;
  for (let index = change!.steps.length - 1; index >= 0; index--)
    doc = change!.steps[index]!.invert(change!.docs[index]!).apply(doc).doc!;
  expect(doc.toJSON()).toEqual(before);
}

function blocks(editor: Editor) {
  return editor.getJSON().content;
}

function expectMarkdownRoundTrip(editor: Editor) {
  const json = editor.getJSON();
  const reparsed = parseDocumentBody(serializeDocumentBody(json));
  expect(
    schema.nodeFromJSON(reparsed).eq(schema.nodeFromJSON(json)),
    serializeDocumentBody(json),
  ).toBe(true);
}

describe("applyCallout", () => {
  it("wraps every touched block, keeps the text, and undoes in one step", () => {
    const editor = editorWith(p("Alpha"), p("Beta"), p("Gamma"));
    const before = editor.getJSON();
    editor.commands.setTextSelection({
      from: posOf(editor, "pha"),
      to: posOf(editor, "ta"),
    });
    const changes = recordChanges(editor);
    expect(applyCallout(editor, "TIP")).toBe(true);
    expect(blocks(editor)).toEqual([
      callout("TIP", p("Alpha"), p("Beta")),
      p("Gamma"),
    ]);
    expect(activeCalloutVariant(editor)).toBe("TIP");
    expectMarkdownRoundTrip(editor);
    expectOneUndoStep(changes, before);
  });

  it("wraps the current empty block at a collapsed cursor", () => {
    const editor = editorWith(p("Before"), p(), p("After"));
    editor.commands.setTextSelection(posOf(editor, "Before") + 7 + 1);
    expect(applyCallout(editor, "NOTE")).toBe(true);
    expect(blocks(editor)).toEqual([
      p("Before"),
      callout("NOTE", p()),
      p("After"),
    ]);
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(activeCalloutVariant(editor)).toBe("NOTE");
    expectMarkdownRoundTrip(editor);
  });

  it("wraps the whole list when the cursor is inside a list item", () => {
    const list = {
      type: "bulletList",
      content: [
        item(p("One"), { type: "bulletList", content: [item(p("Nested"))] }),
        item(p("Two")),
      ],
    };
    const editor = editorWith(p("Intro"), list);
    editor.commands.setTextSelection(posOf(editor, "Nested") + 2);
    expect(applyCallout(editor, "WARNING")).toBe(true);
    expect(blocks(editor)).toEqual([p("Intro"), callout("WARNING", list)]);
    expectMarkdownRoundTrip(editor);
  });

  it.each([
    [
      "heading",
      { type: "heading", attrs: { level: 2 }, content: [text("Title")] },
    ],
    [
      "code block",
      {
        type: "codeBlock",
        attrs: { language: "ts" },
        content: [text("Title()")],
      },
    ],
    [
      "task list",
      {
        type: "taskList",
        content: [
          { type: "taskItem", attrs: { checked: true }, content: [p("Title")] },
        ],
      },
    ],
  ])("wraps a %s", (_name, block) => {
    const editor = editorWith(block);
    editor.commands.setTextSelection(posOf(editor, "Title") + 1);
    expect(applyCallout(editor, "IMPORTANT")).toBe(true);
    const [first] = blocks(editor) ?? [];
    expect(first?.type).toBe("callout");
    expect(first?.attrs?.variant).toBe("IMPORTANT");
    expect(editor.state.doc.textContent).toContain("Title");
    expectMarkdownRoundTrip(editor);
  });

  it("wraps the innermost block inside a blockquote", () => {
    const editor = editorWith({ type: "blockquote", content: [p("Quoted")] });
    editor.commands.setTextSelection(posOf(editor, "Quoted") + 1);
    expect(applyCallout(editor, "TIP")).toBe(true);
    expect(blocks(editor)).toEqual([
      { type: "blockquote", content: [callout("TIP", p("Quoted"))] },
    ]);
    expectMarkdownRoundTrip(editor);
  });

  it("wraps a list inside a blockquote without leaving the quote", () => {
    const list = { type: "orderedList", content: [item(p("Quoted item"))] };
    const editor = editorWith({ type: "blockquote", content: [p("Q"), list] });
    editor.commands.setTextSelection(posOf(editor, "Quoted") + 1);
    expect(applyCallout(editor, "TIP")).toBe(true);
    expect(blocks(editor)?.[0]?.content?.[1]?.type).toBe("callout");
    expectMarkdownRoundTrip(editor);
  });

  it("changes the variant of the surrounding callout instead of nesting", () => {
    const editor = editorWith(callout("NOTE", p("Inside"), p("More")));
    editor.commands.setTextSelection(posOf(editor, "Inside") + 2);
    expect(applyCallout(editor, "CAUTION")).toBe(true);
    expect(blocks(editor)).toEqual([
      callout("CAUTION", p("Inside"), p("More")),
    ]);
    expect(activeCalloutVariant(editor)).toBe("CAUTION");
  });

  it("refuses table cells and selections that cross a callout boundary", () => {
    const table = {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [{ type: "tableHeader", content: [p("Cell")] }],
        },
      ],
    };
    const editor = editorWith(table, callout("NOTE", p("Boxed")), p("Out"));
    const before = editor.getJSON();
    editor.commands.setTextSelection(posOf(editor, "Cell") + 1);
    expect(canApplyCallout(editor)).toBe(false);
    expect(applyCallout(editor, "TIP")).toBe(false);
    editor.commands.setTextSelection({
      from: posOf(editor, "Boxed") + 1,
      to: posOf(editor, "Out") + 1,
    });
    expect(canApplyCallout(editor)).toBe(false);
    expect(applyCallout(editor, "TIP")).toBe(false);
    expect(editor.getJSON()).toEqual(before);
  });

  it("changes the type of a callout from a table cell inside it", () => {
    const table = {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [{ type: "tableHeader", content: [p("Cell")] }],
        },
      ],
    };
    const editor = editorWith(callout("NOTE", p("Intro"), table));
    editor.commands.setTextSelection(posOf(editor, "Cell") + 1);
    expect(activeCalloutVariant(editor)).toBe("NOTE");
    expect(canApplyCallout(editor)).toBe(true);
    expect(applyCallout(editor, "TIP")).toBe(true);
    expect(blocks(editor)?.[0]?.attrs?.variant).toBe("TIP");
    expect(editor.state.doc.textContent).toBe("IntroCell");
  });

  it("treats a selected callout node as the surrounding callout", () => {
    const editor = editorWith(p("Before"), callout("NOTE", p("Boxed")));
    const pos = editor.state.doc.firstChild!.nodeSize;
    editor.view.dispatch(
      editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)),
    );
    expect(activeCalloutVariant(editor)).toBe("NOTE");
    expect(canApplyCallout(editor)).toBe(true);
    expect(applyCallout(editor, "WARNING")).toBe(true);
    expect(blocks(editor)?.[1]).toEqual(callout("WARNING", p("Boxed")));
    editor.view.dispatch(
      editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)),
    );
    expect(removeCallout(editor)).toBe(true);
    expect(blocks(editor)).toEqual([p("Before"), p("Boxed")]);
  });

  it("keeps a wrapped whitespace-only paragraph as its own block when saved", () => {
    const editor = editorWith(p("a"), p("  "), p("b"));
    editor.commands.setTextSelection({
      from: posOf(editor, "a") + 1,
      to: posOf(editor, "b") + 1,
    });
    expect(applyCallout(editor, "NOTE")).toBe(true);
    expect(
      parseDocumentBody(serializeDocumentBody(editor.getJSON())).content,
    ).toEqual([callout("NOTE", p("a"), { ...p(), content: [] }, p("b"))]);
  });

  it("does not nest an existing callout inside a new one", () => {
    const editor = editorWith(
      p("Start"),
      callout("NOTE", p("Boxed")),
      p("End"),
    );
    const before = editor.getJSON();
    editor.commands.setTextSelection({
      from: posOf(editor, "Start") + 1,
      to: posOf(editor, "End") + 1,
    });
    expect(canApplyCallout(editor)).toBe(false);
    expect(applyCallout(editor, "TIP")).toBe(false);
    expect(editor.getJSON()).toEqual(before);
  });
});

describe("removeCallout", () => {
  it("unwraps the nearest callout, keeps the cursor in its text, and undoes in one step", () => {
    const editor = editorWith(
      p("Before"),
      callout("WARNING", p("First"), p("Second")),
    );
    const before = editor.getJSON();
    const cursor = posOf(editor, "Second") + 3;
    editor.commands.setTextSelection(cursor);
    const changes = recordChanges(editor);
    expect(removeCallout(editor)).toBe(true);
    expect(blocks(editor)).toEqual([p("Before"), p("First"), p("Second")]);
    expect(editor.state.selection.$from.parent.textContent).toBe("Second");
    expect(editor.state.selection.$from.parentOffset).toBe(3);
    expect(activeCalloutVariant(editor)).toBeNull();
    expectOneUndoStep(changes, before);
  });

  it("does nothing outside a callout", () => {
    const editor = editorWith(p("Plain"));
    editor.commands.setTextSelection(2);
    expect(removeCallout(editor)).toBe(false);
    expect(blocks(editor)).toEqual([p("Plain")]);
  });
});

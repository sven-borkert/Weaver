import type { Editor, JSONContent } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import {
  Fragment,
  type Node,
  type ResolvedPos,
  type Schema,
} from "@tiptap/pm/model";
import {
  EditorState,
  Selection,
  type SelectionBookmark,
  type Transaction,
} from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import { canSplit } from "@tiptap/pm/transform";
import type {
  DocumentAssistantAction,
  DocumentAssistantContext,
} from "@weaver/core/documents/assistantReply";
import {
  MAX_DOCUMENT_ASSISTANT_CONTEXT_CHARS,
  MAX_DOCUMENT_ASSISTANT_SELECTION_CHARS,
} from "@weaver/core/documents/limits";
import {
  parseDocumentBody,
  serializeDocumentBody,
  validateDocumentContent,
} from "@weaver/core/editor/markdown";
import { parsePlotSpec } from "@weaver/core/editor/plot-spec";
import { parseDocumentMarkdown } from "~/lib/documents/document-markdown";

export function parseGeneratedMarkdown(schema: Schema, markdown: string): Node {
  const parsed = parseDocumentBody(markdown);
  validateDocumentContent(parsed);
  const node = schema.nodeFromJSON(parsed);
  node.check();
  node.descendants((child) => {
    if (child.type.name !== "mathPlot") return;
    const result = parsePlotSpec(
      typeof child.attrs.source === "string" ? child.attrs.source : "",
    );
    if (!result.ok) throw new Error(result.error);
  });
  const first = node.firstChild;
  if (
    !first ||
    (node.childCount === 1 &&
      first.isTextblock &&
      !first.type.spec.code &&
      !first.content.size)
  )
    throw new Error("The generated Markdown is empty.");
  return node;
}

function trimTextblockEdges(node: Node): Node {
  if (node.isLeaf) return node;
  if (node.isTextblock && !node.type.spec.code) {
    const first = node.firstChild?.text ?? "";
    const last = node.lastChild?.text ?? "";
    const start = first.length - first.trimStart().length;
    const end = node.content.size - (last.length - last.trimEnd().length);
    return node.cut(start, Math.max(start, end));
  }
  return node.copy(Fragment.fromArray(node.children.map(trimTextblockEdges)));
}

function survivesMarkdownSave(
  schema: Schema,
  content: Node | Fragment,
): boolean {
  const expected = schema.topNodeType.create(null, content);
  const saved = serializeDocumentBody(expected.toJSON() as JSONContent);
  const actual = schema.nodeFromJSON(parseDocumentBody(saved));
  return trimTextblockEdges(expected).eq(trimTextblockEdges(actual));
}

function insertExact(
  tr: Transaction,
  content: Fragment,
  from: number,
  to = from,
): number | null {
  const $from = tr.doc.resolve(from);
  const $to = tr.doc.resolve(to);
  if (
    !$from.sameParent($to) ||
    !$from.parent.canReplace($from.index(), $to.index(), content)
  )
    return null;
  tr.replaceWith(from, to, content);
  return from + content.size;
}

function insertInline(
  state: EditorState,
  $cursor: ResolvedPos,
  content: Fragment,
) {
  const left = $cursor.nodeBefore;
  const right = $cursor.nodeAfter;
  const formattedBoundary = [
    left,
    content.firstChild,
    content.lastChild,
    right,
  ].some((node) => node && (!node.isText || node.marks.length > 0));
  const space = Fragment.from(state.schema.text(" "));
  const prefixes =
    formattedBoundary && left && !/\s$/.test(left.text ?? "")
      ? [Fragment.empty, space]
      : [Fragment.empty];
  const suffixes =
    formattedBoundary && right && !/^\s/.test(right.text ?? "")
      ? [Fragment.empty, space]
      : [Fragment.empty];

  // Markdown delimiters can require padding when they touch existing text.
  for (const prefix of prefixes) {
    for (const suffix of suffixes) {
      const tr = state.tr;
      const end = insertExact(
        tr,
        prefix.append(content).append(suffix),
        $cursor.pos,
      );
      if (
        end !== null &&
        (!formattedBoundary ||
          survivesMarkdownSave(state.schema, tr.doc.resolve(end).parent))
      )
        return { end, tr };
    }
  }
  return null;
}

function insertBlocks(
  tr: Transaction,
  $cursor: ResolvedPos,
  content: Fragment,
  replacing: boolean,
) {
  for (let depth = $cursor.depth; depth > 0; depth--) {
    const type = $cursor.node(depth).type.name;
    // The Markdown serializer flattens blocks inside table cells.
    if (type === "tableCell" || type === "tableHeader") return null;
  }
  const { parent, parentOffset, pos } = $cursor;
  if (!parent.isTextblock) return insertExact(tr, content, pos);
  // A replaced selection can leave any textblock empty; the new blocks take its place.
  if ((replacing || parent.type.name === "paragraph") && !parent.content.size) {
    const end = insertExact(tr, content, $cursor.before(), $cursor.after());
    if (end !== null) return end;
  }
  if (parentOffset === parent.content.size)
    return insertExact(tr, content, $cursor.after());
  if (parentOffset === 0) {
    const end = insertExact(tr, content, $cursor.before());
    if (end !== null) return end;
  }
  if (!canSplit(tr.doc, pos)) return null;
  tr.split(pos);
  return insertExact(tr, content, pos + 1);
}

const listTypes = new Set(["bulletList", "orderedList", "taskList"]);

function preservesLists(
  tr: Transaction,
  $cursor: ResolvedPos,
  inserted: Fragment,
): boolean {
  let affected = false;
  for (let depth = 1; depth <= $cursor.depth && !affected; depth++)
    affected = listTypes.has($cursor.node(depth).type.name);
  if (!affected)
    inserted.descendants((node) => {
      affected ||= listTypes.has(node.type.name);
      return !affected;
    });
  if (!affected) return true;

  const from = tr.mapping.map(
    $cursor.depth ? $cursor.before(1) : $cursor.pos,
    -1,
  );
  const to = tr.mapping.map($cursor.depth ? $cursor.after(1) : $cursor.pos, 1);
  // Neighboring blocks can be parsed as continuations of an adjacent list.
  const start = from - (tr.doc.resolve(from).nodeBefore?.nodeSize ?? 0);
  const end = to + (tr.doc.resolve(to).nodeAfter?.nodeSize ?? 0);
  return survivesMarkdownSave(
    tr.doc.type.schema,
    tr.doc.content.cut(start, end),
  );
}

function insertContent(
  state: EditorState,
  $cursor: ResolvedPos,
  content: Fragment,
  replacing: boolean,
): { tr: Transaction; end: number } | null {
  const { schema } = state;
  const first = content.firstChild!;
  if (
    content.childCount === 1 &&
    first.type === schema.nodes.paragraph &&
    $cursor.parent.inlineContent &&
    !$cursor.parent.type.spec.code
  )
    return insertInline(state, $cursor, first.content);
  const tr = state.tr;
  const end = insertBlocks(tr, $cursor, content, replacing);
  if (end === null || !preservesLists(tr, $cursor, content)) return null;
  return { tr, end };
}

function applyGeneratedMarkdown(
  editor: Editor,
  bookmark: SelectionBookmark,
  markdown: string,
  action: DocumentAssistantAction,
): boolean {
  if (editor.isDestroyed || !editor.isEditable || !markdown.trim())
    return false;
  const state = editor.state;
  const { doc, schema } = state;
  const tr = state.tr;
  try {
    const { content } = parseGeneratedMarkdown(schema, markdown);
    const selection = bookmark.resolve(doc);
    const replacing = action === "replace" && !selection.empty;
    if (replacing && selection instanceof CellSelection) return false;
    if (replacing) tr.delete(selection.from, selection.to);
    // Positions before a deleted range keep their place, so `from` is where the selection was.
    const base = replacing ? EditorState.create({ doc: tr.doc }) : state;
    const inserted = insertContent(
      base,
      base.doc.resolve(replacing ? selection.from : selection.to),
      content,
      replacing,
    );
    if (!inserted) return false;
    for (const step of inserted.tr.steps) tr.step(step);
    const { end } = inserted;
    const paragraph = schema.nodes.paragraph;
    if (
      end === tr.doc.content.size &&
      paragraph &&
      tr.doc.lastChild?.type !== paragraph
    )
      tr.insert(end, paragraph.create());
    validateDocumentContent(tr.doc.toJSON());
    tr.setSelection(Selection.near(tr.doc.resolve(end)));
  } catch {
    return false;
  }
  editor.view.dispatch(closeHistory(tr).scrollIntoView());
  return editor.state.doc !== doc;
}

/** Inserts at the bookmark's cursor, or after its selection, in one undoable step. */
export function insertGeneratedMarkdown(
  editor: Editor,
  bookmark: SelectionBookmark,
  markdown: string,
): boolean {
  return applyGeneratedMarkdown(editor, bookmark, markdown, "insert");
}

/** Replaces the bookmark's selection (or inserts at its cursor) in one undoable step. */
export function replaceGeneratedMarkdown(
  editor: Editor,
  bookmark: SelectionBookmark,
  markdown: string,
): boolean {
  return applyGeneratedMarkdown(editor, bookmark, markdown, "replace");
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

function headOf(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(
    0,
    isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max,
  );
}

function tailOf(text: string, max: number): string {
  if (text.length <= max) return text;
  const start = text.length - max;
  return text.slice(isLowSurrogate(text.charCodeAt(start)) ? start + 1 : start);
}

function markdownBetween(doc: Node, from: number, to: number): string {
  if (from >= to) return "";
  try {
    return serializeDocumentBody(
      doc.cut(from, to).toJSON() as JSONContent,
    ).replace(/\n+$/, "");
  } catch {
    return doc.textBetween(from, to, "\n\n", " ");
  }
}

/** The draft's Markdown inside and around a selection, nearest text first when it is long. */
export function documentAssistantContext(
  doc: Node,
  from: number,
  to: number,
): DocumentAssistantContext {
  return {
    before: tailOf(
      markdownBetween(doc, 0, from),
      MAX_DOCUMENT_ASSISTANT_CONTEXT_CHARS,
    ),
    selection: markdownBetween(doc, from, to),
    after: headOf(
      markdownBetween(doc, to, doc.content.size),
      MAX_DOCUMENT_ASSISTANT_CONTEXT_CHARS,
    ),
  };
}

export function sourceAssistantContext(
  value: string,
  start: number,
  end: number,
): DocumentAssistantContext {
  return {
    before: tailOf(value.slice(0, start), MAX_DOCUMENT_ASSISTANT_CONTEXT_CHARS),
    selection: value.slice(start, end),
    after: headOf(value.slice(end), MAX_DOCUMENT_ASSISTANT_CONTEXT_CHARS),
  };
}

export const isAssistantSelectionTooLong = (
  context: DocumentAssistantContext,
) => context.selection.length > MAX_DOCUMENT_ASSISTANT_SELECTION_CHARS;

export type SourceEdit = { from: number; to: number; text: string };

/** The raw Markdown edit that inserts or replaces generated content, or null when the result cannot be saved. */
export function spliceGeneratedSource(
  schema: Schema,
  source: { value: string; start: number; end: number },
  markdown: string,
  action: DocumentAssistantAction,
): SourceEdit | null {
  let generated: Node;
  try {
    generated = parseGeneratedMarkdown(schema, markdown);
  } catch {
    return null;
  }
  const from = action === "replace" ? source.start : source.end;
  const to = source.end;
  const before = source.value.slice(0, from);
  const after = source.value.slice(to);
  let text = markdown.replace(/^\s*\n/, "").trimEnd();
  const inline =
    generated.childCount === 1 &&
    generated.firstChild!.type === schema.nodes.paragraph;
  if (!inline) {
    // Blocks need blank lines around them, or they would merge with neighbouring text.
    const lead =
      !before || before.endsWith("\n\n")
        ? ""
        : before.endsWith("\n")
          ? "\n"
          : "\n\n";
    const trail = !after
      ? "\n"
      : after.startsWith("\n\n")
        ? ""
        : after.startsWith("\n")
          ? "\n"
          : "\n\n";
    text = lead + text + trail;
  }
  try {
    parseDocumentMarkdown(schema, before + text + after);
  } catch {
    return null;
  }
  return { from, to, text };
}

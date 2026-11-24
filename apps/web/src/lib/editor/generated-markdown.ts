import type { Editor, JSONContent } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import {
  Fragment,
  type Node,
  NodeRange,
  type ResolvedPos,
  type Schema,
} from "@tiptap/pm/model";
import {
  EditorState,
  NodeSelection,
  Selection,
  type SelectionBookmark,
  TextSelection,
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
  markdownBlocks,
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

function inTableCell($pos: ResolvedPos, depth = $pos.depth): boolean {
  for (; depth > 0; depth--) {
    const type = $pos.node(depth).type.name;
    if (type === "tableCell" || type === "tableHeader") return true;
  }
  return false;
}

function insertBlocks(
  tr: Transaction,
  $cursor: ResolvedPos,
  content: Fragment,
  replacing: boolean,
) {
  // The Markdown serializer flattens blocks inside table cells.
  if (inTableCell($cursor)) return null;
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
const listItemTypes = new Set(["listItem", "taskItem"]);

/** `from` and `to` are top-level block boundaries in the document before `tr`. */
function preservesLists(
  tr: Transaction,
  from: number,
  to: number,
  inserted: Fragment,
): boolean {
  let affected = false;
  const isList = (node: Node) => {
    affected ||= listTypes.has(node.type.name);
    return !affected;
  };
  tr.before.nodesBetween(from, to, isList);
  if (!affected) inserted.descendants(isList);
  if (!affected) return true;

  const mappedFrom = tr.mapping.map(from, -1);
  const mappedTo = tr.mapping.map(to, 1);
  // Neighboring blocks can be parsed as continuations of an adjacent list.
  const start =
    mappedFrom - (tr.doc.resolve(mappedFrom).nodeBefore?.nodeSize ?? 0);
  const end = mappedTo + (tr.doc.resolve(mappedTo).nodeAfter?.nodeSize ?? 0);
  return survivesMarkdownSave(
    tr.doc.type.schema,
    tr.doc.content.cut(start, end),
  );
}

const topLevelStart = ($pos: ResolvedPos) =>
  $pos.depth ? $pos.before(1) : $pos.pos;
const topLevelEnd = ($pos: ResolvedPos) =>
  $pos.depth ? $pos.after(1) : $pos.pos;

const isInlineReply = (schema: Schema, content: Fragment) =>
  content.childCount === 1 &&
  content.firstChild!.type === schema.nodes.paragraph;

function insertContent(
  state: EditorState,
  $cursor: ResolvedPos,
  content: Fragment,
  replacing: boolean,
): { tr: Transaction; end: number } | null {
  const first = content.firstChild!;
  const inline = isInlineReply(state.schema, content);
  if ($cursor.parent.type.spec.code) {
    // Code holds plain text: a paragraph or fenced reply goes in as its text.
    if (
      content.childCount === 1 &&
      (inline || first.type === $cursor.parent.type)
    ) {
      const text = first.textContent;
      return {
        tr: state.tr.insertText(text, $cursor.pos),
        end: $cursor.pos + text.length,
      };
    }
  } else if (inline && $cursor.parent.inlineContent) {
    return insertInline(state, $cursor, first.content);
  }
  const tr = state.tr;
  const end = insertBlocks(tr, $cursor, content, replacing);
  if (
    end === null ||
    !preservesLists(tr, topLevelStart($cursor), topLevelEnd($cursor), content)
  )
    return null;
  return { tr, end };
}

/** The whole blocks a selection covers, with fully covered list items standing for their list. */
function selectedBlocks(
  schema: Schema,
  selection: Selection,
  content: Fragment,
): NodeRange | null {
  const { $from, $to } = selection;
  const doc = $from.doc;
  let range: NodeRange | null;
  if (selection instanceof NodeSelection) {
    if (!selection.node.isBlock) return null;
    range = new NodeRange($from, $to, $from.depth);
  } else {
    if (
      !$from.parent.isTextblock ||
      !$to.parent.isTextblock ||
      $from.parentOffset > 0 ||
      $to.parentOffset < $to.parent.content.size
    )
      return null;
    // A whole textblock replaced by one paragraph keeps its type, so a heading is retitled.
    if ($from.sameParent($to) && isInlineReply(schema, content)) return null;
    range = $from.blockRange($to);
    if (
      !range ||
      Selection.findFrom(doc.resolve(range.start), 1, true)?.from !==
        $from.pos ||
      Selection.findFrom(doc.resolve(range.end), -1, true)?.to !== $to.pos
    )
      return null;
  }
  while (
    range.depth > 0 &&
    range.startIndex === 0 &&
    range.endIndex === range.parent.childCount &&
    (listTypes.has(range.parent.type.name) ||
      listItemTypes.has(range.parent.type.name))
  )
    range = new NodeRange(
      doc.resolve(range.$from.before(range.depth)),
      doc.resolve(range.$to.after(range.depth)),
      range.depth - 1,
    );
  return range;
}

function replaceBlocks(
  state: EditorState,
  range: NodeRange,
  content: Fragment,
): { tr: Transaction; end: number } | null {
  if (inTableCell(range.$from, range.depth)) return null;
  const { parent, startIndex, endIndex } = range;
  let from = range.start;
  let to = range.end;
  let replacement = content;
  let end = from + content.size;
  if (listTypes.has(parent.type.name)) {
    // Items around the selection stay in their list.
    from = range.$from.before(range.depth);
    to = range.$from.after(range.depth);
    const before = parent.children.slice(0, startIndex);
    const after = parent.children.slice(endIndex);
    const first = content.firstChild!;
    if (content.childCount === 1 && first.type === parent.type) {
      const items = Fragment.fromArray(before).append(first.content);
      replacement = Fragment.from(
        parent.copy(items.append(Fragment.fromArray(after))),
      );
      end = from + 1 + items.size;
    } else {
      const head = before.length
        ? parent.copy(Fragment.fromArray(before))
        : null;
      // An ordered list's remaining items keep their numbers.
      const start: unknown = parent.attrs.start;
      const tail = after.length
        ? parent.type.create(
            typeof start === "number"
              ? { ...parent.attrs, start: start + endIndex }
              : parent.attrs,
            after,
          )
        : null;
      replacement = content;
      if (head) replacement = Fragment.from(head).append(replacement);
      if (tail) replacement = replacement.addToEnd(tail);
      end = from + (head?.nodeSize ?? 0) + content.size;
    }
  }
  const tr = state.tr;
  if (
    insertExact(tr, replacement, from, to) === null ||
    !preservesLists(
      tr,
      topLevelStart(state.doc.resolve(from)),
      topLevelEnd(state.doc.resolve(to)),
      content,
    )
  )
    return null;
  return { tr, end };
}

function insertAfterBlock(
  state: EditorState,
  selection: Selection,
  content: Fragment,
): { tr: Transaction; end: number } | null {
  const pos = topLevelEnd(selection.$to);
  const tr = state.tr;
  const end = insertExact(tr, content, pos);
  if (
    end === null ||
    !preservesLists(tr, topLevelStart(selection.$from), pos, content)
  )
    return null;
  return { tr, end };
}

/** A selection inside one textblock that leaves some of its text out. */
function isPartialText(selection: Selection): boolean {
  const { $from, $to } = selection;
  return (
    selection instanceof TextSelection &&
    $from.sameParent($to) &&
    !($from.parentOffset === 0 && $to.parentOffset === $to.parent.content.size)
  );
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
    const blocks = replacing
      ? selectedBlocks(schema, selection, content)
      : null;
    let inserted: { tr: Transaction; end: number } | null;
    if (blocks) {
      inserted = replaceBlocks(state, blocks, content);
    } else if (replacing) {
      tr.delete(selection.from, selection.to);
      // Positions before a deleted range keep their place, so `from` is where the selection was.
      const base = EditorState.create({ doc: tr.doc });
      inserted = insertContent(
        base,
        base.doc.resolve(selection.from),
        content,
        true,
      );
    } else if (
      selection.empty ||
      (isPartialText(selection) && isInlineReply(schema, content))
    ) {
      inserted = insertContent(
        state,
        doc.resolve(selection.to),
        content,
        false,
      );
    } else {
      // Inserting after a selection means after the block that holds it, not inside its last line.
      inserted = insertAfterBlock(state, selection, content);
    }
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

type SourceBlock = { type: string; raw: string; start: number; end: number };

/** Top-level blocks with their offsets, or null when they do not line up with the source. */
function sourceBlocks(value: string): SourceBlock[] | null {
  const blocks: SourceBlock[] = [];
  let start = 0;
  for (const { type, raw } of markdownBlocks(value)) {
    if (!value.startsWith(raw, start)) return null;
    blocks.push({ type, raw, start, end: start + raw.length });
    start += raw.length;
  }
  return start === value.length ? blocks : null;
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/** The offsets a caret can take on the code lines of a fenced block. */
function fencedCode(block: SourceBlock): { start: number; end: number } | null {
  const fence = FENCE_RE.exec(block.raw)?.[1];
  const opening = block.raw.indexOf("\n");
  if (block.type !== "code" || !fence || opening < 0) return null;
  const body = block.raw.trimEnd();
  const closing = body.lastIndexOf("\n");
  const last = body.slice(closing + 1).trim();
  const closed =
    last.length >= fence.length && [...last].every((char) => char === fence[0]);
  return {
    start: block.start + opening + 1,
    end: block.start + (closed ? closing : body.length),
  };
}

/** Whether every block outside the edited range comes out of the edit unchanged. */
function keepsSurroundings(
  blocks: SourceBlock[],
  next: SourceBlock[],
  edit: { from: number; to: number; shift: number },
  holder: SourceBlock | null,
): boolean {
  const byStart = new Map(next.map((block) => [block.start, block]));
  const kept = (block: SourceBlock, shift: number) => {
    const found = byStart.get(block.start + shift);
    return (
      found?.type === block.type && found.raw.trimEnd() === block.raw.trimEnd()
    );
  };
  for (const block of blocks) {
    if (block.type === "space" || block === holder) continue;
    if (block.end <= edit.from) {
      if (!kept(block, 0)) return false;
    } else if (block.start >= edit.to && !kept(block, edit.shift)) {
      return false;
    }
  }
  if (!holder) return true;
  // Text spliced into a block must leave it one block of the same kind.
  const found = byStart.get(holder.start);
  return (
    found?.type === holder.type &&
    found.raw.length === holder.raw.length + edit.shift
  );
}

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
  const { value } = source;
  const from = action === "replace" ? source.start : source.end;
  const to = source.end;
  const before = value.slice(0, from);
  const after = value.slice(to);
  const blocks = sourceBlocks(value);
  if (!blocks) return null;
  let text = markdown.replace(/^\s*\n/, "").trimEnd();
  const first = generated.firstChild!;
  const single = generated.childCount === 1;
  const inline = single && first.type === schema.nodes.paragraph;
  // The block that holds the whole range; a range at a line break belongs to the next line.
  const holder =
    blocks.find(
      (block) =>
        block.type !== "space" &&
        block.start <= from &&
        (to < block.end || (to === block.end && !block.raw.endsWith("\n"))),
    ) ?? null;
  const code = holder && fencedCode(holder);
  let separate: boolean;
  if (code && code.start <= from && to <= code.end) {
    // Code takes a reply as plain text; any other block would end the fence.
    if (!single || !(inline || first.type === schema.nodes.codeBlock))
      return null;
    if (!inline) text = first.textContent;
    separate = false;
  } else if (
    holder?.type === "table" &&
    to <= holder.start + holder.raw.trimEnd().length
  ) {
    // A row is one line, and an unescaped pipe would start another cell.
    if (!inline || text.includes("\n")) return null;
    text = text.replace(/(?<!\\)\|/g, "\\|");
    separate = false;
  } else {
    const lineStart = from ? value.lastIndexOf("\n", from - 1) + 1 : 0;
    const lineEnd = value.indexOf("\n", to);
    const blankLine =
      from === to &&
      !value.slice(lineStart, lineEnd < 0 ? undefined : lineEnd).trim();
    const content = blocks.filter((block) => block.type !== "space");
    const last = content.filter((block) => block.start < to).at(-1);
    const lastEnd = last ? last.start + last.raw.trimEnd().length : to + 1;
    const wholeBlocks =
      from < to &&
      content.some((block) => block.start === from) &&
      lastEnd <= to &&
      !value.slice(lastEnd, to).trim();
    separate = !inline || blankLine || wholeBlocks;
  }
  if (separate) {
    // Blocks need blank lines around them, or they would merge with neighbouring text.
    const lead =
      !before || before.endsWith("\n\n")
        ? ""
        : before.endsWith("\n")
          ? "\n"
          : "\n\n";
    const trail = !after
      ? inline
        ? ""
        : "\n"
      : after.startsWith("\n\n")
        ? ""
        : after.startsWith("\n")
          ? "\n"
          : "\n\n";
    text = lead + text + trail;
  }
  const result = before + text + after;
  try {
    parseDocumentMarkdown(schema, result);
  } catch {
    return null;
  }
  const next = sourceBlocks(result);
  const edit = { from, to, shift: text.length - (to - from) };
  if (!next || !keepsSurroundings(blocks, next, edit, separate ? null : holder))
    return null;
  return { from, to, text };
}

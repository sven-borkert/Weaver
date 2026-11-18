import type { Editor, JSONContent } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import {
  Fragment,
  type Node,
  type ResolvedPos,
  type Schema,
} from "@tiptap/pm/model";
import {
  Selection,
  type EditorState,
  type SelectionBookmark,
  type Transaction,
} from "@tiptap/pm/state";
import { canSplit } from "@tiptap/pm/transform";
import {
  parseDocumentBody,
  serializeDocumentBody,
  validateDocumentContent,
} from "@weaver/core/editor/markdown";

export function parseGeneratedMarkdown(schema: Schema, markdown: string): Node {
  const parsed = parseDocumentBody(markdown);
  validateDocumentContent(parsed);
  const node = schema.nodeFromJSON(parsed);
  node.check();
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
) {
  for (let depth = $cursor.depth; depth > 0; depth--) {
    const type = $cursor.node(depth).type.name;
    // The Markdown serializer flattens blocks inside table cells.
    if (type === "tableCell" || type === "tableHeader") return null;
  }
  const { parent, parentOffset, pos } = $cursor;
  if (!parent.isTextblock) return insertExact(tr, content, pos);
  if (parent.type.name === "paragraph" && !parent.content.size) {
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

export function insertGeneratedMarkdown(
  editor: Editor,
  bookmark: SelectionBookmark,
  markdown: string,
): boolean {
  if (editor.isDestroyed || !editor.isEditable || !markdown.trim())
    return false;
  const state = editor.state;
  const { doc, schema } = state;
  let tr = state.tr;
  try {
    const { content } = parseGeneratedMarkdown(schema, markdown);
    const first = content.firstChild!;
    const { $to } = bookmark.resolve(doc);
    const inline =
      content.childCount === 1 &&
      first.type === schema.nodes.paragraph &&
      $to.parent.inlineContent &&
      !$to.parent.type.spec.code;
    let end: number | null;
    if (inline) {
      const inserted = insertInline(state, $to, first.content);
      if (!inserted) return false;
      ({ end, tr } = inserted);
    } else {
      end = insertBlocks(tr, $to, content);
      if (end === null || !preservesLists(tr, $to, content)) return false;
    }
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

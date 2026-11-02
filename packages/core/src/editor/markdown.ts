import { getSchema, type JSONContent } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { classifyImageSrc } from "../documents/images";
import { CANONICAL_UUID_RE } from "../tables/validation";
import { documentExtensions } from "./extensions";
import {
  imageWidth,
  parseImageTag,
  TAG_BLOCK_ATTR,
  TAG_MARK,
  withTagSpacing,
} from "./imageTag";
import {
  flattenTableCells,
  literalAmpersands,
  literalAngleBrackets,
  withInlineCodeFences,
} from "./markdownEscapes";
import { escapeMathInText, MAX_MATH_CHARS } from "./math";

let schema: ReturnType<typeof getSchema> | undefined;

function getDocumentSchema(): ReturnType<typeof getSchema> {
  schema ??= getSchema(documentExtensions());
  return schema;
}

const isInlineType = (type: string): boolean =>
  getDocumentSchema().nodes[type]?.isInline ?? false;

const MAX_CONTENT_BYTES = 2_000_000;
const MAX_CONTENT_VALUES = 200_000;
const MAX_DOCUMENT_NODES = 25_000;
const encoder = new TextEncoder();

function validateContentBounds(json: unknown): void {
  const pending = [{ value: json, depth: 0 }];
  let values = 0;
  let nodes = 0;
  let bytes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++values > MAX_CONTENT_VALUES) throw new Error("document too large");
    if (depth > 100) throw new Error("document too deeply nested");
    if (typeof value === "string") {
      if (value.length > MAX_CONTENT_BYTES)
        throw new Error("document too large");
      bytes += encoder.encode(value).byteLength;
      if (bytes > MAX_CONTENT_BYTES) throw new Error("document too large");
    } else if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      if (typeof object.type === "string" && ++nodes > MAX_DOCUMENT_NODES)
        throw new Error("too many document nodes");
      if (object.type === "crossref") {
        const attrs = object.attrs as Record<string, unknown> | undefined;
        if (
          !attrs ||
          typeof attrs.targetId !== "string" ||
          !CANONICAL_UUID_RE.test(attrs.targetId) ||
          (attrs.targetType !== undefined &&
            attrs.targetType !== "document" &&
            attrs.targetType !== "table") ||
          (attrs.label != null && typeof attrs.label !== "string")
        )
          throw new Error("invalid crossref attributes");
      }
      if (object.type === "image") {
        const attrs = object.attrs as Record<string, unknown> | undefined;
        if (
          !attrs ||
          classifyImageSrc(attrs.src) === null ||
          (attrs.alt != null && typeof attrs.alt !== "string") ||
          (attrs.title != null && typeof attrs.title !== "string") ||
          (attrs.width != null && imageWidth(attrs.width) === null)
        )
          throw new Error("invalid image attributes");
      }
      if (object.type === "inlineMath" || object.type === "mathBlock") {
        const attrs = object.attrs as Record<string, unknown> | undefined;
        if (typeof attrs?.source !== "string")
          throw new Error("invalid math attributes");
        // Longer sources would read back from Markdown as plain text.
        if (attrs.source.length > MAX_MATH_CHARS)
          throw new Error("formula too long");
      }
      if (object.type === "tableCell" || object.type === "tableHeader") {
        const attrs = object.attrs as Record<string, unknown> | undefined;
        if (Number(attrs?.colspan ?? 1) > 1 || Number(attrs?.rowspan ?? 1) > 1)
          throw new Error("merged table cells are not supported");
      }
      const entries = Object.entries(object);
      if (entries.length + pending.length + values > MAX_CONTENT_VALUES)
        throw new Error("document too large");
      for (const [key, child] of entries) {
        bytes += key.length;
        if (bytes > MAX_CONTENT_BYTES) throw new Error("document too large");
        pending.push({ value: child, depth: depth + 1 });
      }
    }
  }
  const serialized = JSON.stringify(json);
  if (
    serialized === undefined ||
    encoder.encode(serialized).byteLength > MAX_CONTENT_BYTES
  )
    throw new Error("document too large");
}

export function validateDocumentContent(
  json: unknown,
): asserts json is JSONContent {
  if (
    !json ||
    typeof json !== "object" ||
    !("type" in json) ||
    json.type !== "doc"
  )
    throw new Error("content must be a document tree");
  validateContentBounds(json);
  const schema = getDocumentSchema();
  const content = json as JSONContent;
  const normalized =
    content.content === undefined || content.content.length === 0
      ? { ...content, content: [{ type: "paragraph" }] }
      : content;
  schema.nodeFromJSON(normalized).check();
}

let manager: MarkdownManager | undefined;

type TextEncoderHook = {
  encodeTextForMarkdown: (...args: unknown[]) => string;
};

function getManager(): MarkdownManager {
  if (!manager) {
    manager = new MarkdownManager({ extensions: documentExtensions() });
    // No public hook exists for text-node encoding; code text bypasses it untouched.
    const hook = manager as unknown as TextEncoderHook;
    const encode = hook.encodeTextForMarkdown.bind(manager);
    hook.encodeTextForMarkdown = (...args) =>
      escapeMathInText(
        literalAmpersands(literalAngleBrackets(encode(...args))),
      );
  }
  return manager;
}

const isBlankInline = (node: JSONContent) =>
  node.type === "hardBreak" ||
  (node.type === "text" && (node.text ?? "").trim() === "");

function trimBlankInline(nodes: JSONContent[]): JSONContent[] {
  let start = 0;
  let end = nodes.length;
  while (start < end && isBlankInline(nodes[start]!)) start++;
  while (end > start && isBlankInline(nodes[end - 1]!)) end--;
  const trimmed = nodes.slice(start, end);
  const edge = (index: number, trim: (text: string) => string) => {
    const node = trimmed[index];
    if (node?.type === "text")
      trimmed[index] = { ...node, text: trim(node.text ?? "") };
  };
  edge(0, (text) => text.trimStart());
  edge(trimmed.length - 1, (text) => text.trimEnd());
  return trimmed;
}

/** Splits a paragraph around its images, keeping the text on either side. */
function splitAroundImages(paragraph: JSONContent): JSONContent[] {
  const inline = paragraph.content ?? [];
  if (!inline.some((node) => node.type === "image")) return [paragraph];
  const blocks: JSONContent[] = [];
  let run: JSONContent[] = [];
  const flush = () => {
    const content = trimBlankInline(run);
    if (content.length) blocks.push({ ...paragraph, content });
    run = [];
  };
  for (const node of inline) {
    if (node.type === "image") {
      flush();
      blocks.push(node);
    } else {
      run.push(node);
    }
  }
  flush();
  return blocks;
}

const isTagText = (node: JSONContent): boolean =>
  node.type === "text" &&
  (node.marks ?? []).some((mark) => mark.type === TAG_MARK);

const sameMarks = (a: JSONContent, b: JSONContent) =>
  JSON.stringify(a.marks ?? []) === JSON.stringify(b.marks ?? []);

/** Inline content with every tag the plain text it was, joined to its neighbours. */
function literalTags(inline: JSONContent[]): JSONContent[] {
  if (!inline.some(isTagText)) return inline;
  const result: JSONContent[] = [];
  for (const node of inline) {
    let next = node;
    if (isTagText(node)) {
      const { marks, ...rest } = node;
      const kept = marks!.filter((mark) => mark.type !== TAG_MARK);
      next = kept.length ? { ...rest, marks: kept } : rest;
    }
    const last = result.at(-1);
    if (last?.type === "text" && next.type === "text" && sameMarks(last, next))
      result[result.length - 1] = {
        ...last,
        text: `${last.text ?? ""}${next.text ?? ""}`,
      };
    else result.push(next);
  }
  return result;
}

/** A node whose tags stay text: what the parser produced before tags were read. */
function withLiteralTags(node: JSONContent): JSONContent {
  const source: unknown = node.attrs?.[TAG_BLOCK_ATTR];
  if (node.type === "paragraph" && typeof source === "string")
    return { type: "paragraph", content: [{ type: "text", text: source }] };
  if (!node.content) return node;
  const content = literalTags(node.content);
  return content === node.content ? node : { ...node, content };
}

/** The paragraph with its tags as image nodes, ready to be lifted. */
function withTagImages(paragraph: JSONContent): JSONContent {
  if (!paragraph.content?.some(isTagText)) return paragraph;
  const content = paragraph.content.map((node) => {
    const attrs = isTagText(node) ? parseImageTag(node.text ?? "") : null;
    if (!attrs) return node;
    const { width, ...rest } = attrs;
    return {
      type: "image",
      attrs: width === null ? rest : { ...rest, width },
    };
  });
  return { type: "paragraph", content };
}

/** Images are blocks here, but Markdown puts an image that shares a line or
 *  paragraph with text or another image inline. Lift such images into their
 *  own blocks wherever the parent allows it; elsewhere (a list item's first
 *  paragraph) leave the content for validation to reject. An `<img>` tag
 *  becomes an image only where it can be lifted, and stays text otherwise. */
function liftInlineImages(node: JSONContent): JSONContent {
  // A paragraph is settled by its parent, which knows whether images fit.
  if (!node.content || node.type === "paragraph") return node;
  const children = node.content.map(liftInlineImages);
  const literal = (): JSONContent => {
    const content = children.map(withLiteralTags);
    return withLiteralTags({ ...node, content });
  };
  // A Markdown cell is one line of inline content, so a tag there is text.
  const cell = node.type === "tableCell" || node.type === "tableHeader";
  const prepared = children.map((child) =>
    child.type !== "paragraph"
      ? child
      : cell
        ? withLiteralTags(child)
        : withTagImages(child),
  );
  const lifted = prepared.flatMap((child) =>
    child.type === "paragraph" ? splitAroundImages(child) : [child],
  );
  if (
    lifted.length === children.length &&
    lifted.every((child, index) => child === children[index])
  )
    return literal();
  const candidate = { ...node, content: lifted };
  try {
    getDocumentSchema().nodeFromJSON(candidate).check();
    return candidate;
  } catch {
    return literal();
  }
}

/** The ordered-list parser leaves an item with no text empty; the schema
 *  and the serializer both need the paragraph the bullet-list parser adds. */
function withItemParagraphs(node: JSONContent): JSONContent {
  if (!node.content) return node;
  const content = node.content.map(withItemParagraphs);
  if (node.type === "listItem" && content.length === 0)
    return { ...node, content: [{ type: "paragraph", content: [] }] };
  // Items must start with a paragraph, so a leading formula stays in the line.
  if (
    (node.type === "listItem" || node.type === "taskItem") &&
    content[0]?.type === "mathBlock"
  )
    content[0] = {
      type: "paragraph",
      content: [{ type: "inlineMath", attrs: content[0].attrs }],
    };
  return { ...node, content };
}

export function parseDocumentBody(markdown: string): JSONContent {
  return liftInlineImages(withItemParagraphs(getManager().parse(markdown)));
}

export function serializeDocumentBody(json: JSONContent): string {
  const markdown = getManager().serialize(
    withTagSpacing(withInlineCodeFences(flattenTableCells(json, isInlineType))),
  );
  return markdown.endsWith("\n") ? markdown : `${markdown}\n`;
}

export function crossrefTargetKey(
  targetType: "document" | "table",
  targetId: string,
): string {
  return `${targetType}:${targetId}`;
}

export function applyCrossrefLabels(
  json: JSONContent,
  titles: ReadonlyMap<string, string>,
): JSONContent {
  const walk = (node: JSONContent): JSONContent => {
    const next: JSONContent = { ...node };

    if (node.type === "crossref") {
      const targetId = node.attrs?.targetId as string | undefined;
      const targetType =
        node.attrs?.targetType === "table" ? "table" : "document";
      const title = targetId
        ? titles.get(crossrefTargetKey(targetType, targetId))
        : undefined;
      next.attrs = {
        ...node.attrs,
        label: title ?? (node.attrs?.label as string | null) ?? null,
      };
    }

    if (node.content) next.content = node.content.map(walk);
    return next;
  };

  return walk(json);
}

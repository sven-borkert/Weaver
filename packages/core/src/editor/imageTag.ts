import { Extension, type JSONContent } from "@tiptap/core";
import { parseImageReference } from "../documents/imageReferences";
import { classifyImageSrc } from "../documents/images";

/** Transient mark on the text of a tag until the parser knows an image can stand there. */
export const TAG_MARK = "imageTagSource";
/** Transient attr holding the source of a paragraph the block tokenizer claimed. */
export const TAG_BLOCK_ATTR = "imageTagBlock";
/** Transient attrs the serializer stamps on a copy to put a blank line before or after a tag. */
export const TAG_LEAD_ATTR = "tagLead";
export const TAG_TRAIL_ATTR = "tagTrail";
export const MIN_IMAGE_WIDTH = 16;
export const MAX_IMAGE_WIDTH = 4096;

export type ImageTagAttrs = {
  src: string;
  alt: string;
  title: string | null;
  width: number | null;
};

/** A stored image width: whole pixels within the supported range, else null. */
export function imageWidth(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_IMAGE_WIDTH &&
    value <= MAX_IMAGE_WIDTH
    ? value
    : null;
}

/** The width written as an attribute value (plain digits), else null. */
export function parseImageWidth(
  text: string | null | undefined,
): number | null {
  return text && /^[1-9][0-9]{0,3}$/.test(text)
    ? imageWidth(Number(text))
    : null;
}

const ATTRIBUTE = String.raw`[ \t]+[a-z]+="[^"<>\r\n]*"`;
const TAG = String.raw`<img((?:${ATTRIBUTE})+)[ \t]*\/?>`;
const TAG_RE = new RegExp(`^${TAG}$`);
const INLINE_RE = new RegExp(`^${TAG}`);
// A tag alone on its line, then every line up to the next blank one: what marked reads as one HTML block.
// The line break after it is left for marked, which uses it to tell a loose list from a tight one.
const BLOCK_RE = new RegExp(
  String.raw`^ {0,3}(${TAG})[ \t]*(?:\n(?![ \t]*(?:\n|$))[^\n]*)*(?=\n|$)`,
);
const ATTRIBUTE_RE = /([a-z]+)="([^"]*)"/g;
const ALLOWED = new Set(["src", "alt", "title", "width", "height"]);
const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&quot;": '"',
  "&lt;": "<",
  "&gt;": ">",
  "&#39;": "'",
  "&#9;": "\t",
  "&#10;": "\n",
  "&#13;": "\r",
};

const decode = (value: string): string =>
  value.replace(
    /&(?:amp|quot|lt|gt|#39|#9|#10|#13);/g,
    (entity) => ENTITIES[entity]!,
  );

// Line breaks and tabs become references so the tag stays on one line and survives list indentation.
const encode = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\t/g, "&#9;")
    .replace(/\n/g, "&#10;")
    .replace(/\r/g, "&#13;");

function acceptedSource(src: string): boolean {
  if (classifyImageSrc(src) !== null) return true;
  try {
    return parseImageReference(src) !== null;
  } catch {
    return false;
  }
}

/** The source of every accepted tag in Markdown text. A heuristic for previews only:
 *  like a scan for `![…](…)`, it also sees tags inside code and after a backslash. */
export function imageTagSources(markdown: string): string[] {
  return [...markdown.matchAll(new RegExp(TAG, "g"))].flatMap((match) => {
    const attrs = parseImageTag(match[0]);
    return attrs ? [attrs.src] : [];
  });
}

/** Reads the one HTML form documents accept; null for anything else. */
export function parseImageTag(tag: string): ImageTagAttrs | null {
  const match = TAG_RE.exec(tag);
  if (!match) return null;
  const values = new Map<string, string>();
  for (const [, name, value] of match[1]!.matchAll(ATTRIBUTE_RE)) {
    if (!ALLOWED.has(name!) || values.has(name!)) return null;
    values.set(name!, decode(value!));
  }
  const src = values.get("src");
  if (src === undefined) return null;
  if (!acceptedSource(src)) return null;
  return {
    src,
    alt: values.get("alt") ?? "",
    title: values.get("title")?.length ? values.get("title")! : null,
    width: parseImageWidth(values.get("width")),
  };
}

export function renderImageTag(attrs: {
  src: string;
  alt: string;
  title: string;
  width: number;
}): string {
  const title = attrs.title ? ` title="${encode(attrs.title)}"` : "";
  return `<img src="${encode(attrs.src)}" alt="${encode(attrs.alt)}"${title} width="${attrs.width}">`;
}

// Marked reads a lone tag line as an HTML block, so the inline rule never sees it.
// Like that block, a tag line does not interrupt the paragraph above it.
export const ImageTagBlock = Extension.create({
  name: "imageTagBlock",
  markdownTokenizer: {
    name: "imageTagBlock",
    level: "block",
    start: () => -1,
    tokenize: (src, _tokens, lexer) => {
      const match = BLOCK_RE.exec(src);
      if (!match || !parseImageTag(match[1]!)) return undefined;
      const text = match[0].replace(/\s+$/, "");
      return {
        type: "imageTagBlock",
        raw: match[0],
        text,
        tokens: lexer.inlineTokens(text.trimStart()),
      };
    },
  },
  parseMarkdown: (token, helpers) => ({
    type: "paragraph",
    attrs: { [TAG_BLOCK_ATTR]: token.text },
    content: helpers.parseInline(token.tokens ?? []),
  }),
});

export const ImageTagInline = Extension.create({
  name: "imageTagInline",
  markdownTokenizer: {
    name: "imageTagInline",
    level: "inline",
    start: (src) => src.indexOf("<img"),
    tokenize: (src) => {
      const match = INLINE_RE.exec(src);
      return match && parseImageTag(match[0])
        ? { type: "imageTagInline", raw: match[0] }
        : undefined;
    },
  },
  // Text, so surrounding marks apply to it; the parser turns it into an image where one can stand.
  parseMarkdown: (token) => ({
    type: "text",
    text: token.raw,
    marks: [{ type: TAG_MARK }],
  }),
});

const isTagForm = (node: JSONContent | undefined): boolean =>
  node?.type === "image" && imageWidth(node.attrs?.width) !== null;

/** A copy in which every tag-form image inside a list or task item asks for the
 *  blank lines the item's renderer leaves out: it joins blocks with a single
 *  line break, and a block directly under a tag line is read as part of it. */
export function withTagSpacing(node: JSONContent): JSONContent {
  if (!node.content) return node;
  const content = node.content.map(withTagSpacing);
  if (node.type !== "listItem" && node.type !== "taskItem")
    return { ...node, content };
  return {
    ...node,
    content: content.map((child, index) => {
      if (index === 0 || !isTagForm(child)) return child;
      const next = content[index + 1];
      const trail = next && next.type !== "paragraph" && !isTagForm(next);
      return {
        ...child,
        attrs: {
          ...child.attrs,
          [TAG_LEAD_ATTR]: true,
          ...(trail ? { [TAG_TRAIL_ATTR]: true } : {}),
        },
      };
    }),
  };
}

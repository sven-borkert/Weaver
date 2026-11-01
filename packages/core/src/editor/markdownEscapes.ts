import type { JSONContent } from "@tiptap/core";

export function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) {
    longest = Math.max(longest, match[0].length);
  }
  return longest;
}

export function codeFence(source: string): string {
  return "`".repeat(Math.max(3, longestBacktickRun(source) + 1));
}

// CommonMark link destination: bare when unambiguous, otherwise <bracketed>.
export function linkDestination(url: string): string {
  let depth = 0;
  let bare = url !== "" && !/[\s<>\x00-\x1f]/.test(url);
  for (let index = 0; bare && index < url.length; index++) {
    const char = url[index];
    if (char === "\\") index++;
    else if (char === "(") depth++;
    else if (char === ")" && --depth < 0) bare = false;
  }
  return bare && depth === 0 ? url : `<${url.replace(/[\\<>]/g, "\\$&")}>`;
}

export function quotedTitle(title: string): string {
  return ` "${title.replace(/[\\"]/g, "\\$&")}"`;
}

export function altText(alt: string): string {
  return alt.replace(/[\\[\]]/g, "\\$&");
}

type CodeAttrs = { fence: number; pad: boolean; segment?: number };

const isCodeText = (node: JSONContent): boolean =>
  node.type === "text" &&
  (node.marks ?? []).some((mark) => mark.type === "code");

const otherMarks = (node: JSONContent): string =>
  JSON.stringify((node.marks ?? []).filter((mark) => mark.type !== "code"));

function stampCode(node: JSONContent, attrs: CodeAttrs): JSONContent {
  return {
    ...node,
    marks: node.marks!.map((mark) =>
      mark.type === "code"
        ? { ...mark, attrs: { ...mark.attrs, ...attrs } }
        : mark,
    ),
  };
}

function withoutCode(node: JSONContent): JSONContent {
  const { marks = [], ...rest } = node;
  const kept = marks.filter((mark) => mark.type !== "code");
  return kept.length ? { ...rest, marks: kept } : rest;
}

// Mark renderers never see their text, so the fence travels on transient attrs.
export function withInlineCodeFences(node: JSONContent): JSONContent {
  if (!node.content) return node;
  const content = node.content.map(withInlineCodeFences);
  let segment = 0;
  for (let start = 0; start < content.length; start++) {
    if (!isCodeText(content[start]!)) {
      segment = 0;
      continue;
    }
    const marks = otherMarks(content[start]!);
    let end = start;
    while (
      end + 1 < content.length &&
      isCodeText(content[end + 1]!) &&
      otherMarks(content[end + 1]!) === marks
    )
      end++;
    const text = content
      .slice(start, end + 1)
      .map((child) => child.text ?? "")
      .join("");
    const run = longestBacktickRun(text);
    // The serializer hoists edge whitespace out of the span before fencing it.
    const inner = text.trim();
    const pad = inner.startsWith("`") || inner.endsWith("`");
    if (inner === "") {
      // An all-whitespace span would serialize as literal backticks.
      for (let index = start; index <= end; index++)
        content[index] = withoutCode(content[index]!);
      start = end;
      continue;
    }
    // A span cannot contain other marks' delimiters, so each mark change starts a new span.
    const adjoinsCode =
      segment > 0 ||
      (end + 1 < content.length && isCodeText(content[end + 1]!));
    if (run > 0 || pad || adjoinsCode) {
      const attrs: CodeAttrs = { fence: run + 1, pad };
      if (adjoinsCode) attrs.segment = segment;
      for (let index = start; index <= end; index++)
        content[index] = stampCode(content[index]!, attrs);
    }
    segment++;
    start = end;
  }
  return { ...node, content };
}

// GFM splits table rows on unescaped pipes; the parser restores `\|` in cells.
export function escapeCellPipes(rendered: string): string {
  return rendered.replace(/\|/g, "\\|");
}

function escapeLineStart(line: string, continuation: boolean): string {
  // The first line of a paragraph never gets indented-code whitespace.
  const value = continuation
    ? line
    : line.replace(/^[ \t]+/, (ws) =>
        ws.includes("\t") || ws.length > 3 ? "   " : ws,
      );
  if (/^ {0,3}#{1,6}(?:\s|$)/.test(value))
    return value.replace(/^( {0,3})#/, "$1\\#");
  // A `#` line ends a list item's lazy continuation even without a space.
  if (continuation && /^ {0,3}#/.test(value))
    return value.replace(/^( {0,3})#/, "$1\\#");
  if (/^ {0,3}(?:-[ \t]*){3,}$/.test(value))
    return value.replace(/^( {0,3})-/, "$1\\-");
  if (/^ {0,3}[-+](?:\s|$)/.test(value))
    return value.replace(/^( {0,3})([-+])/, "$1\\$2");
  if (/^ {0,3}\d{1,9}[.)](?:\s|$)/.test(value))
    return value.replace(/^( {0,3}\d{1,9})([.)])/, "$1\\$2");
  // A `=` line after a hard break would underline a setext heading.
  if (continuation && /^ {0,3}=+[ \t]*$/.test(value))
    return value.replace(/^( {0,3})=/, "$1\\=");
  if (/^ {0,3}>/.test(value)) return value.replace(/^( {0,3})>/, "$1\\>");
  return value;
}

// The manager entity-encodes `<`/`>`; keep them literal unless `<` could open a tag or autolink.
// GFM autolinks would swallow a literal `>`, so URL-like words stay encoded.
export function literalAngleBrackets(encoded: string): string {
  return encoded.replace(/\S+/g, (word) =>
    /:\/\/|www\.|@/i.test(word)
      ? word
      : word.replace(/&gt;/g, ">").replace(/&lt;(?![A-Za-z/!?]|$)/g, "<"),
  );
}

// The manager entity-encodes every `&`; only one that would start an entity
// reference (`&name;`, `&#123;`, `&#x1F;`) needs it, so keep the rest literal.
export function literalAmpersands(encoded: string): string {
  return encoded.replace(
    /&amp;(?![A-Za-z][A-Za-z0-9]{0,31};|#[0-9]{1,7};|#[xX][0-9a-fA-F]{1,6};)/g,
    "&",
  );
}

// Rendered paragraph text whose line start would open a block construct on re-parse.
export function escapeBlockStarts(rendered: string): string {
  return rendered
    .split("\n")
    .map((line, index) => escapeLineStart(line, index > 0))
    .join("\n");
}

function inlineRuns(
  block: JSONContent,
  isInline: (type: string) => boolean,
): JSONContent[][] {
  if (!block.content) return block.type === "paragraph" ? [[]] : [];
  if (block.content.every((child) => isInline(child.type ?? "")))
    return [block.content];
  return block.content.flatMap((child) =>
    isInline(child.type ?? "") ? [[child]] : inlineRuns(child, isInline),
  );
}

// Markdown cells hold one line of inline content; blocks become hard breaks.
export function flattenTableCells(
  node: JSONContent,
  isInline: (type: string) => boolean,
): JSONContent {
  if (!node.content) return node;
  if (node.type === "tableCell" || node.type === "tableHeader") {
    const [only, ...rest] = node.content;
    if (rest.length === 0 && only?.type === "paragraph") return node;
    const content = inlineRuns(node, isInline).flatMap((run, index) =>
      index === 0 ? run : [{ type: "hardBreak" }, ...run],
    );
    return { ...node, content: [{ type: "paragraph", content }] };
  }
  return {
    ...node,
    content: node.content.map((child) => flattenTableCells(child, isInline)),
  };
}

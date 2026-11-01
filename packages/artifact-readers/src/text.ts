import MarkdownIt, { type Token } from "markdown-it";
import { ArtifactReadError } from "./errors";
import { normalizeLimit, normalizeOffset, utf8Prefix } from "./limits";

const MAX_RESULT_BYTES = 128 * 1024;
const MAX_LABEL_BYTES = 500;

export type TextPosition = { line: number; charOffset: number };
export type TextReadInput = {
  startLine?: number;
  endLine?: number;
  limit?: number;
  sectionId?: string;
  position?: TextPosition;
  markdown?: boolean;
};
export type TextReadResult = {
  text: string;
  start: TextPosition;
  end: TextPosition;
  lineCount: number;
  nextPosition: TextPosition | null;
};
export type TextHeading = {
  id: string;
  title: string;
  level: number;
  startLine: number;
  endLine: number;
};
export type TextOverview = {
  lineCount: number;
  headingCount: number;
  headings: TextHeading[];
  nextOffset: number | null;
};
export type TextSearchResult = {
  matches: Array<{ line: number; charOffset: number; snippet: string }>;
  nextPosition: TextPosition | null;
};
export type TextLine = { start: number; contentEnd: number; end: number };

export function decodeUtf8(data: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new ArtifactReadError("malformed", "artifact is not valid UTF-8");
  }
}

export function scanTextLines(text: string): TextLine[] {
  const lines: TextLine[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text.charCodeAt(index);
    if (char !== 10 && char !== 13) continue;
    const contentEnd = index;
    if (char === 13 && text.charCodeAt(index + 1) === 10) index++;
    lines.push({ start, contentEnd, end: index + 1 });
    start = index + 1;
  }
  if (start < text.length)
    lines.push({ start, contentEnd: text.length, end: text.length });
  return lines;
}

function invalid(message: string): never {
  throw new ArtifactReadError("invalid_input", message);
}

function splitsSurrogate(text: string, index: number): boolean {
  return (
    index > 0 &&
    index < text.length &&
    text.charCodeAt(index - 1) >= 0xd800 &&
    text.charCodeAt(index - 1) <= 0xdbff &&
    text.charCodeAt(index) >= 0xdc00 &&
    text.charCodeAt(index) <= 0xdfff
  );
}

export function textPositionAtOffset(
  lines: readonly TextLine[],
  offset: number,
): TextPosition {
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (lines[mid]!.end <= offset) low = mid + 1;
    else high = mid;
  }
  if (low < lines.length)
    return { line: low + 1, charOffset: offset - lines[low]!.start };
  const last = lines.at(-1);
  if (last && last.contentEnd === last.end)
    return { line: lines.length, charOffset: last.end - last.start };
  return { line: lines.length + 1, charOffset: 0 };
}

export function textOffsetAtPosition(
  text: string,
  lines: readonly TextLine[],
  position: TextPosition,
): number {
  if (
    !Number.isSafeInteger(position.line) ||
    position.line < 1 ||
    !Number.isSafeInteger(position.charOffset) ||
    position.charOffset < 0
  ) {
    invalid(
      "position must contain a positive line and a non-negative charOffset",
    );
  }
  const eof = textPositionAtOffset(lines, text.length);
  if (position.line === eof.line && position.charOffset === eof.charOffset)
    return text.length;
  const line = lines[position.line - 1];
  if (!line || position.charOffset >= line.end - line.start)
    invalid("position is outside the source");
  const offset = line.start + position.charOffset;
  if (splitsSurrogate(text, offset))
    invalid("position splits a Unicode character");
  return offset;
}

// Pass the whole reader window so a prefix ending at CR can distinguish CRLF.
export function textPositionAfterPrefix(
  start: TextPosition,
  text: string,
  prefixLength: number,
): TextPosition {
  if (
    !Number.isSafeInteger(prefixLength) ||
    prefixLength < 0 ||
    prefixLength > text.length ||
    splitsSurrogate(text, prefixLength)
  ) {
    invalid(
      "prefixLength must end at a Unicode character boundary within the text",
    );
  }
  let line = start.line;
  let charOffset = start.charOffset;
  for (let index = 0; index < prefixLength; index++) {
    const char = text.charCodeAt(index);
    if (char === 13 && text.charCodeAt(index + 1) === 10) {
      if (index + 1 === prefixLength) {
        charOffset++;
        continue;
      }
      index++;
      line++;
      charOffset = 0;
    } else if (char === 10 || char === 13) {
      line++;
      charOffset = 0;
    } else charOffset++;
  }
  return { line, charOffset };
}

function outline(text: string, lines: readonly TextLine[]): TextHeading[] {
  const headings: TextHeading[] = [];
  const open: TextHeading[] = [];
  const parser = new MarkdownIt("commonmark", { maxNesting: Infinity });
  parser.core.ruler.enableOnly(["normalize", "block"]);
  let tokens: Token[];
  try {
    tokens = parser.parse(text, {});
  } catch {
    throw new ArtifactReadError(
      "resource_limit",
      "Markdown outline is too large or complex; read the source by line range",
    );
  }
  function add(startLine: number, title: string, level: number) {
    while (open.length && open.at(-1)!.level >= level)
      open.pop()!.endLine = startLine - 1;
    const heading = {
      id: `heading-${startLine}`,
      title: utf8Prefix(title, MAX_LABEL_BYTES),
      level,
      startLine,
      endLine: lines.length,
    };
    headings.push(heading);
    open.push(heading);
  }
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    const inline = tokens[index + 1];
    if (
      token.type !== "heading_open" ||
      !token.map ||
      inline?.type !== "inline"
    )
      continue;
    // Normalization preserves physical line numbers; section bytes use the original source.
    add(
      token.map[0] + 1,
      inline.content
        .split("\n")
        .map((line) => line.trim())
        .join(" "),
      Number(token.tag.slice(1)),
    );
  }
  return headings;
}

export function readTextOverview(
  data: Uint8Array,
  input: { markdown?: boolean; offset?: number; limit?: number },
): TextOverview {
  const offset = normalizeOffset({ value: input.offset, label: "offset" });
  const limit = normalizeLimit({
    value: input.limit,
    defaultValue: 100,
    hardMax: 500,
    label: "limit",
  });
  const text = decodeUtf8(data);
  const lines = scanTextLines(text);
  const headings = input.markdown ? outline(text, lines) : [];
  const selected: TextHeading[] = [];
  let size = 100;
  for (
    let index = offset;
    index < Math.min(headings.length, offset + limit);
    index++
  ) {
    const heading = headings[index]!;
    const cost = Buffer.byteLength(JSON.stringify(heading)) + 1;
    if (size + cost > MAX_RESULT_BYTES) break;
    selected.push(heading);
    size += cost;
  }
  return {
    lineCount: lines.length,
    headingCount: headings.length,
    headings: selected,
    nextOffset:
      offset + selected.length < headings.length
        ? offset + selected.length
        : null,
  };
}

function positiveLine(
  value: number | undefined,
  fallback: number,
  lineCount: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > Math.max(lineCount, 1)
  )
    invalid(`${label} is outside the source`);
  return value;
}

function windowEnd(text: string, start: number, end: number): number {
  let size = 0;
  let index = start;
  while (index < end) {
    const code = text.codePointAt(index)!;
    const cost = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (size + cost > MAX_RESULT_BYTES) break;
    size += cost;
    index += code > 0xffff ? 2 : 1;
  }
  if (index < end && text[index - 1] === "\r" && text[index] === "\n") index--;
  return index;
}

export function readText(
  data: Uint8Array,
  input: TextReadInput,
): TextReadResult {
  const limit = normalizeLimit({
    value: input.limit,
    defaultValue: 100,
    hardMax: 500,
    label: "limit",
  });
  const text = decodeUtf8(data);
  const lines = scanTextLines(text);
  let startLine = positiveLine(input.startLine, 1, lines.length, "startLine");
  let endLine = positiveLine(
    input.endLine,
    lines.length,
    lines.length,
    "endLine",
  );
  if (input.sectionId !== undefined) {
    if (
      !input.markdown ||
      input.startLine !== undefined ||
      input.endLine !== undefined
    )
      invalid(
        "sectionId requires Markdown and cannot be combined with a line range",
      );
    const section = outline(text, lines).find(
      (heading) => heading.id === input.sectionId,
    );
    if (!section) invalid("sectionId does not identify a heading");
    startLine = section.startLine;
    endLine = section.endLine;
  }
  if (lines.length && endLine < startLine)
    invalid("endLine must not precede startLine");
  const rangeStart = lines[startLine - 1]?.start ?? 0;
  const rangeEnd = lines[endLine - 1]?.end ?? 0;
  const from = input.position
    ? textOffsetAtPosition(text, lines, input.position)
    : rangeStart;
  if (from < rangeStart || from > rangeEnd)
    invalid("position is outside the selected range");
  const start = textPositionAtOffset(lines, from);
  const pageEnd = Math.min(
    rangeEnd,
    lines[start.line + limit - 2]?.end ?? text.length,
  );
  const to = windowEnd(text, from, pageEnd);
  const end = textPositionAtOffset(lines, to);
  const lineCount =
    to === from ? 0 : textPositionAtOffset(lines, to - 1).line - start.line + 1;
  return {
    text: text.slice(from, to),
    start,
    end,
    lineCount,
    nextPosition: to < rangeEnd ? end : null,
  };
}

export function literalSearchPattern(query: string): RegExp {
  if (!query.length) invalid("query must not be empty");
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
}

export function searchText(
  data: Uint8Array,
  input: { query: string; position?: TextPosition; limit?: number },
): TextSearchResult {
  const pattern = literalSearchPattern(input.query);
  const limit = normalizeLimit({
    value: input.limit,
    defaultValue: 25,
    hardMax: 100,
    label: "limit",
  });
  const text = decodeUtf8(data);
  const lines = scanTextLines(text);
  pattern.lastIndex = input.position
    ? textOffsetAtPosition(text, lines, input.position)
    : 0;
  const matches: TextSearchResult["matches"] = [];
  let nextPosition: TextPosition | null = null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (matches.length === limit) break;
    const position = textPositionAtOffset(lines, match.index);
    const line = lines[position.line - 1]!;
    let snippetStart = Math.max(line.start, match.index - 80);
    if (splitsSurrogate(text, snippetStart)) snippetStart--;
    let snippetEnd = Math.min(
      line.contentEnd,
      match.index + match[0].length + 80,
    );
    if (splitsSurrogate(text, snippetEnd)) snippetEnd--;
    matches.push({
      ...position,
      snippet: utf8Prefix(
        text.slice(snippetStart, snippetEnd),
        MAX_LABEL_BYTES,
      ),
    });
    nextPosition = textPositionAtOffset(lines, pattern.lastIndex);
  }
  return { matches, nextPosition: match ? nextPosition : null };
}

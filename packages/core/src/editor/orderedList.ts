import type { MarkdownLexerConfiguration, MarkdownToken } from "@tiptap/core";
import {
  detectMarkerType,
  markerToStart,
  ORDERED_LIST_MARKER_PATTERN,
  OrderedList,
} from "@tiptap/extension-list";

// Ported from @tiptap/extension-list 3.30.5 utils.ts (MIT): upstream's content indent omits the separator.

const ORDERED_LIST_ITEM_REGEX = new RegExp(
  `^(\\s*)(${ORDERED_LIST_MARKER_PATTERN})([.)])\\s+(.*)$`,
);
const INDENTED_LINE_REGEX = /^\s/;
const PARAGRAPH_INTERRUPTERS = {
  heading: /^#{1,6}(?:\s|$)/,
  bulletItem: /^[-+*]\s+/,
  codeFence: /^(?:```|~~~)/,
  blockMath: /^\$\$/,
  thematicBreak: /^(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$/,
};

type ListItemInfo = {
  indent: number;
  number: number;
  type: ReturnType<typeof detectMarkerType>;
  contentLines: string[];
  raw: string;
};

const isOrderedListMarkerLine = (line: string): boolean =>
  ORDERED_LIST_ITEM_REGEX.test(line.trimStart());

function isBlockContentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return (
    PARAGRAPH_INTERRUPTERS.bulletItem.test(trimmed) ||
    isOrderedListMarkerLine(trimmed) ||
    PARAGRAPH_INTERRUPTERS.heading.test(trimmed) ||
    (PARAGRAPH_INTERRUPTERS.thematicBreak.test(trimmed) &&
      !trimmed.startsWith("-")) ||
    trimmed.startsWith(">") ||
    PARAGRAPH_INTERRUPTERS.codeFence.test(trimmed) ||
    trimmed.startsWith("$$")
  );
}

const interruptsLazyContinuation = (line: string): boolean =>
  Object.values(PARAGRAPH_INTERRUPTERS).some((pattern) => pattern.test(line));

function splitItemContent(contentLines: string[]): {
  paragraphLines: string[];
  blockLines: string[];
} {
  const paragraphLines: string[] = [];
  const blockLines: string[] = [];
  let reachedBlockBoundary = false;
  for (const line of contentLines) {
    if (reachedBlockBoundary) {
      blockLines.push(line);
      continue;
    }
    if (line.trim() === "") {
      reachedBlockBoundary = true;
      blockLines.push(line);
      continue;
    }
    if (paragraphLines.length > 0 && isBlockContentLine(line)) {
      reachedBlockBoundary = true;
      blockLines.push(line);
      continue;
    }
    paragraphLines.push(line);
  }
  return { paragraphLines, blockLines };
}

function collectOrderedListItems(lines: string[]): [ListItemInfo[], number] {
  const listItems: ListItemInfo[] = [];
  let currentLineIndex = 0;
  let consumed = 0;
  while (currentLineIndex < lines.length) {
    const line = lines[currentLineIndex]!;
    const match = ORDERED_LIST_ITEM_REGEX.exec(line);
    if (!match) break;
    const indent = match[1] ?? "";
    const marker = match[2] ?? "";
    const separator = match[3] ?? "";
    const content = match[4] ?? "";
    const indentLevel = indent.length;
    const number = parseInt(marker, 10);
    const markerType = Number.isNaN(number)
      ? detectMarkerType(marker)
      : undefined;
    const itemNumber = Number.isNaN(number) ? markerToStart(marker) : number;
    const contentIndent = indentLevel + marker.length + separator.length + 1;
    const itemContentLines = [content];
    const itemLines = [line];
    let nextLineIndex = currentLineIndex + 1;
    let sawBlankLine = false;
    while (nextLineIndex < lines.length) {
      const nextLine = lines[nextLineIndex]!;
      if (ORDERED_LIST_ITEM_REGEX.test(nextLine)) break;
      if (nextLine.trim() === "") {
        itemLines.push(nextLine);
        itemContentLines.push("");
        sawBlankLine = true;
        nextLineIndex += 1;
      } else if (INDENTED_LINE_REGEX.test(nextLine)) {
        const leadingWhitespace = nextLine.length - nextLine.trimStart().length;
        itemLines.push(nextLine);
        itemContentLines.push(
          nextLine.slice(Math.min(leadingWhitespace, contentIndent)),
        );
        nextLineIndex += 1;
      } else {
        if (sawBlankLine || interruptsLazyContinuation(nextLine)) break;
        itemLines.push(nextLine);
        itemContentLines.push(nextLine);
        nextLineIndex += 1;
      }
    }
    listItems.push({
      indent: indentLevel,
      number: itemNumber,
      type: markerType,
      contentLines: itemContentLines,
      raw: itemLines.join("\n"),
    });
    consumed = nextLineIndex;
    currentLineIndex = nextLineIndex;
  }
  return [listItems, consumed];
}

function buildNestedStructure(
  items: ListItemInfo[],
  baseIndent: number,
  lexer: MarkdownLexerConfiguration,
): MarkdownToken[] {
  const result: MarkdownToken[] = [];
  let currentIndex = 0;
  while (currentIndex < items.length) {
    const item = items[currentIndex]!;
    if (item.indent !== baseIndent) {
      currentIndex += 1;
      continue;
    }
    const { paragraphLines, blockLines } = splitItemContent(item.contentLines);
    const mainText = paragraphLines.join("\n").trim();
    const tokens: MarkdownToken[] = [];
    if (mainText)
      tokens.push({
        type: "paragraph",
        raw: mainText,
        tokens: lexer.inlineTokens(mainText),
      });
    const additionalContent = blockLines.join("\n").trim();
    if (additionalContent) tokens.push(...lexer.blockTokens(additionalContent));
    let lookAheadIndex = currentIndex + 1;
    const nestedItems: ListItemInfo[] = [];
    while (
      lookAheadIndex < items.length &&
      items[lookAheadIndex]!.indent > baseIndent
    ) {
      nestedItems.push(items[lookAheadIndex]!);
      lookAheadIndex += 1;
    }
    if (nestedItems.length > 0) {
      const nestedListItems = buildNestedStructure(
        nestedItems,
        Math.min(...nestedItems.map((nestedItem) => nestedItem.indent)),
        lexer,
      );
      tokens.push({
        type: "list",
        ordered: true,
        start: nestedItems[0]!.number,
        typeMarker: nestedItems[0]!.type,
        items: nestedListItems,
        raw: nestedItems.map((nestedItem) => nestedItem.raw).join("\n"),
      });
    }
    result.push({ type: "list_item", raw: item.raw, tokens });
    currentIndex = lookAheadIndex;
  }
  return result;
}

export const MarkdownOrderedList = OrderedList.extend({
  markdownTokenizer: {
    name: "orderedList",
    level: "block",
    start: () => -1,
    tokenize: (src, _tokens, lexer) => {
      const lines = src.split("\n");
      const [listItems, consumed] = collectOrderedListItems(lines);
      const first = listItems[0];
      if (!first) return undefined;
      const items = buildNestedStructure(listItems, first.indent, lexer);
      if (items.length === 0) return undefined;
      return {
        type: "list",
        ordered: true,
        start: first.number || 1,
        typeMarker: first.type,
        items,
        raw: lines.slice(0, consumed).join("\n"),
      };
    },
  },
});

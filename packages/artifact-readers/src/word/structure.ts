/**
 * Body segmentation: the ordered block list, its stable ids, the chapter
 * ranges derived from heading styles, and placeholder-aware table reading.
 */
import { ArtifactReadError } from "../errors";
import {
  attr,
  directElementChildren,
  directWordChild,
  firstDescendant,
  idFor,
  isWordElement,
  textOf,
  type XmlDocument,
  type XmlElement,
} from "./package";
import type { WordStyleIndex } from "./controls";
import {
  declaredOutlineLevel,
  inferHeadingLevels,
  type TypographyContext,
} from "./typography";

const BODY_MISSING_MESSAGE =
  "Unable to read the document. Corrupt or invalid files are not supported.";

/** `chapter-000` is the synthetic front matter, `document-body` the synthetic
 *  chapter of a document without headings. */
const CHAPTER_ID_PATTERN = /^(chapter-\d{3,}|document-body)$/;
const TABLE_ID_PATTERN = /^table-\d{3,}$/;

export interface WordChapterSummary {
  chapterId: string;
  blockId: string | null;
  level: number;
  title: string;
  /** Paragraphs classified instruction/mixed inside this chapter's range. */
  instructionParagraphCount?: number;
  /** True for a heading with no title and no content blocks (outline noise). */
  empty?: boolean;
  blockCount: number;
  /** Heading detected from font size or bold, not from a style or outline level. */
  inferred?: true;
}

export interface WordPlaceholderCell {
  rowIndex: number;
  columnIndex: number;
  placeholder: string;
}

export interface BodyBlock {
  element: XmlElement;
  bodyIndex: number;
  type: "paragraph" | "table";
  blockId: string;
  paragraphOrdinal?: number;
  tableOrdinal?: number;
  headingLevel?: number;
  headingTitle?: string;
  /** A collapsed table-of-contents field (body-level SDT); not editable. */
  isToc?: boolean;
  inferredHeading?: true;
}

export interface ChapterRef {
  chapterId: string;
  blockId: string | null;
  level: number;
  title: string;
  startBlockIndex: number;
  endBlockIndex: number;
  headingBlock?: BodyBlock;
  /** Sequence-derived heading number, e.g. "4.6.1" (undefined for synthetic chapters). */
  numberPath?: string;
  inferred?: true;
}

export interface DocumentStructure {
  body: XmlElement;
  blocks: BodyBlock[];
  chapters: ChapterRef[];
  /** Nearest enclosing chapter per block index, resolved once at build time. */
  chapterByBlockIndex: (ChapterRef | null)[];
  headingSource: "styles" | "inferred" | "none";
}

export interface TableCellEntry {
  cell: XmlElement;
  wrapperSdt?: XmlElement;
}

export interface DetailedTableRows {
  rows: string[][];
  placeholderCells: WordPlaceholderCell[];
}

export interface ExtractedText {
  text: string;
  placeholders: string[];
}

export function buildStructure(
  doc: XmlDocument,
  typography: TypographyContext,
): DocumentStructure {
  const documentElement = doc.documentElement;
  if (!documentElement) {
    throw new ArtifactReadError("malformed", BODY_MISSING_MESSAGE);
  }
  const body = firstDescendant(documentElement, "body");
  if (!body) throw new ArtifactReadError("malformed", BODY_MISSING_MESSAGE);
  const blocks: BodyBlock[] = [];
  let paragraphOrdinal = 0;
  let tableOrdinal = 0;
  let bodyIndex = 0;

  const pushElement = (element: XmlElement, isToc: boolean) => {
    const index = bodyIndex;
    bodyIndex += 1;
    if (isToc || isWordElement(element, "p")) {
      paragraphOrdinal += 1;
      const headingLevel = isToc
        ? null
        : headingLevelOf(element, typography.styles);
      blocks.push({
        element,
        bodyIndex: index,
        type: "paragraph",
        blockId: idFor("p", paragraphOrdinal),
        paragraphOrdinal,
        headingLevel: headingLevel ?? undefined,
        headingTitle: headingLevel ? textOf(element) : undefined,
        ...(isToc ? { isToc: true } : {}),
      });
    } else {
      tableOrdinal += 1;
      blocks.push({
        element,
        bodyIndex: index,
        type: "table",
        blockId: idFor("table", tableOrdinal),
        tableOrdinal,
      });
    }
  };

  // Body-level SDTs (block content controls) wrap real paragraphs/tables —
  // flatten them so their content is reachable. A table-of-contents SDT is
  // collapsed to one read-only paragraph block instead of dumping the field.
  const walkBodyChildren = (parent: XmlElement) => {
    for (const element of directElementChildren(parent)) {
      if (isWordElement(element, "p") || isWordElement(element, "tbl")) {
        pushElement(element, false);
      } else if (isWordElement(element, "sdt")) {
        if (isTocSdt(element)) {
          pushElement(element, true);
          continue;
        }
        const content = directWordChild(element, "sdtContent");
        if (content) walkBodyChildren(content);
      }
    }
  };
  walkBodyChildren(body);

  let headingSource: DocumentStructure["headingSource"] = blocks.some(
    (block) => block.headingLevel,
  )
    ? "styles"
    : "none";
  if (headingSource === "none") {
    const levels = inferHeadingLevels(
      blocks.filter((block) => block.type === "paragraph" && !block.isToc),
      typography,
    );
    for (const block of blocks) {
      const level = levels.get(block.bodyIndex);
      if (!level) continue;
      block.headingLevel = level;
      block.headingTitle = textOf(block.element);
      block.inferredHeading = true;
    }
    if (levels.size > 0) headingSource = "inferred";
  }

  const chapters = buildChapters(blocks);
  return {
    body,
    blocks,
    chapters,
    chapterByBlockIndex: resolveChapterByBlockIndex(blocks, chapters),
    headingSource,
  };
}

/**
 * Scanning every chapter per call would be quadratic on a document with many
 * blocks. The answer (ranges nest, so the last containing chapter in document order
 * wins) is precomputed here in one pass; a block is inside at most one chapter
 * per heading level, so this stays linear.
 */
function resolveChapterByBlockIndex(
  blocks: BodyBlock[],
  chapters: ChapterRef[],
): (ChapterRef | null)[] {
  const byIndex: (ChapterRef | null)[] = new Array<ChapterRef | null>(
    blocks.length,
  ).fill(null);
  for (const chapter of chapters) {
    const end = Math.min(chapter.endBlockIndex, blocks.length);
    for (let index = chapter.startBlockIndex; index < end; index += 1) {
      byIndex[index] = chapter;
    }
  }
  return byIndex;
}

function isTocSdt(sdt: XmlElement): boolean {
  const sdtPr = directWordChild(sdt, "sdtPr");
  const docPartObj = sdtPr ? directWordChild(sdtPr, "docPartObj") : null;
  const gallery = docPartObj
    ? directWordChild(docPartObj, "docPartGallery")
    : null;
  const value = gallery ? attr(gallery, "val") : null;
  return value !== null && /table of contents/i.test(value);
}

function buildChapters(blocks: BodyBlock[]): ChapterRef[] {
  const headingBlocks = blocks.filter((block) => block.headingLevel);
  if (headingBlocks.length === 0) {
    return [
      {
        chapterId: "document-body",
        blockId: null,
        level: 0,
        title: "Document body",
        startBlockIndex: 0,
        endBlockIndex: blocks.length,
      },
    ];
  }

  const chapters: ChapterRef[] = [];
  // Everything before the first heading (title page, template instructions,
  // TOC, …) is reachable as the synthetic front-matter chapter. Heading
  // chapters keep their 1-based numbering, so adding it never renumbers them.
  const firstHeadingIndex = headingBlocks[0]!.bodyIndex;
  if (firstHeadingIndex > 0) {
    chapters.push({
      chapterId: idFor("chapter", 0),
      blockId: null,
      level: 0,
      title: "Front matter",
      startBlockIndex: 0,
      endBlockIndex: firstHeadingIndex,
    });
  }

  // Sequence-derived heading numbers ("4.6.1"): counters per level in
  // document order, deeper levels reset when a shallower heading appears.
  const counters: number[] = [];
  const ends = chapterEndIndexes(headingBlocks, blocks.length);

  for (const [index, block] of headingBlocks.entries()) {
    const startBlockIndex = block.bodyIndex;
    const nextIndex = ends[index]!;
    const level = block.headingLevel ?? 1;
    counters[level - 1] = (counters[level - 1] ?? 0) + 1;
    counters.length = level;
    chapters.push({
      chapterId: idFor("chapter", index + 1),
      blockId: block.blockId,
      level,
      title: normalizeTitleText(block.headingTitle ?? ""),
      startBlockIndex,
      endBlockIndex: nextIndex,
      headingBlock: block,
      ...(block.inferredHeading ? { inferred: true as const } : {}),
      numberPath: counters.map((count) => count ?? 0).join("."),
    });
  }
  return chapters;
}

/** Each heading's end index in one backward pass — a deliberate deviation
 *  from the source's per-heading rescan, which is quadratic. */
function chapterEndIndexes(
  headingBlocks: BodyBlock[],
  blockCount: number,
): number[] {
  const maxLevel = 9;
  const nextAtOrAbove = new Array<number>(maxLevel + 1).fill(blockCount);
  const ends = new Array<number>(headingBlocks.length).fill(blockCount);
  for (let index = headingBlocks.length - 1; index >= 0; index -= 1) {
    const block = headingBlocks[index]!;
    const level = Math.min(Math.max(block.headingLevel ?? 1, 1), maxLevel);
    ends[index] = nextAtOrAbove[level]!;
    for (let deeper = level; deeper <= maxLevel; deeper += 1) {
      nextAtOrAbove[deeper] = block.bodyIndex;
    }
  }
  return ends;
}

/** Collapse tabs/NBSP/multi-spaces in heading titles (outline hygiene). */
function normalizeTitleText(title: string): string {
  return title.replace(/\s+/g, " ").trim();
}

/** A heading chapter with no title and no own content blocks. */
export function isEmptyChapter(chapter: ChapterRef): boolean {
  if (!chapter.headingBlock) return false;
  if (chapter.title !== "") return false;
  return chapter.startBlockIndex + 1 >= chapter.endBlockIndex;
}

export function requireChapter(
  structure: DocumentStructure,
  chapterId: string,
): ChapterRef {
  if (!CHAPTER_ID_PATTERN.test(chapterId)) {
    throw new ArtifactReadError(
      "invalid_input",
      `Invalid chapterId ${chapterId}`,
    );
  }
  const chapter = structure.chapters.find(
    (item) => item.chapterId === chapterId,
  );
  if (!chapter) {
    throw new ArtifactReadError(
      "not_found",
      `Chapter ${chapterId} was not found`,
    );
  }
  return chapter;
}

export function requireTable(
  structure: DocumentStructure,
  tableId: string,
): BodyBlock {
  if (!TABLE_ID_PATTERN.test(tableId)) {
    throw new ArtifactReadError("invalid_input", `Invalid tableId ${tableId}`);
  }
  const table = structure.blocks.find(
    (block) => block.type === "table" && block.blockId === tableId,
  );
  if (!table) {
    throw new ArtifactReadError("not_found", `Table ${tableId} was not found`);
  }
  return table;
}

export function blocksInChapter(
  structure: DocumentStructure,
  chapter: ChapterRef,
  options: { includeHeading: boolean },
): BodyBlock[] {
  const start = chapter.startBlockIndex + (options.includeHeading ? 0 : 1);
  if (!chapter.headingBlock && !options.includeHeading) {
    return structure.blocks.slice(
      chapter.startBlockIndex,
      chapter.endBlockIndex,
    );
  }
  return structure.blocks.slice(start, chapter.endBlockIndex);
}

/**
 * Nearest enclosing chapter: ranges nest (a level-1 range contains its
 * sub-chapters' ranges) and chapters are in document order, so the LAST
 * match is the innermost heading — not the outermost as `find` would give.
 */
export function chapterForBlock(
  structure: DocumentStructure,
  block: BodyBlock,
): ChapterRef | null {
  return structure.chapterByBlockIndex[block.bodyIndex] ?? null;
}

export function chapterIdForBlock(
  structure: DocumentStructure,
  block: BodyBlock,
): string | null {
  return chapterForBlock(structure, block)?.chapterId ?? null;
}

function headingLevelOf(
  paragraph: XmlElement,
  styles: WordStyleIndex,
): number | null {
  const outlineLevel = declaredOutlineLevel(paragraph, styles);
  if (outlineLevel === "body") return null;
  const pPr = directElementChildren(paragraph).find((child) =>
    isWordElement(child, "pPr"),
  );
  const pStyle = pPr
    ? directElementChildren(pPr).find((child) => isWordElement(child, "pStyle"))
    : null;
  const style = pStyle ? attr(pStyle, "val") : null;
  const match = style ? /^heading\s*([1-9])$/i.exec(style) : null;
  if (match) return Number(match[1]);
  return outlineLevel;
}

export function tableCellEntries(row: XmlElement): TableCellEntry[] {
  const entries: TableCellEntry[] = [];
  for (const child of directElementChildren(row)) {
    if (isWordElement(child, "tc")) {
      entries.push({ cell: child });
      continue;
    }
    if (!isWordElement(child, "sdt")) continue;
    const content = directWordChild(child, "sdtContent");
    const cell = content ? directWordChild(content, "tc") : null;
    if (cell) entries.push({ cell, wrapperSdt: child });
  }
  return entries;
}

export function tableRowElements(table: XmlElement): XmlElement[] {
  return directElementChildren(table).filter((element) =>
    isWordElement(element, "tr"),
  );
}

/**
 * Like textOf, but text inside an unfilled content control (w:showingPlcHdr)
 * is separated out — so "Choose an item." never masquerades as a value.
 */
export function extractTextExcludingPlaceholders(
  element: XmlElement,
): ExtractedText {
  const parts: string[] = [];
  const placeholders: string[] = [];
  const walk = (parent: XmlElement, inPlaceholder: boolean) => {
    for (const child of directElementChildren(parent)) {
      let childInPlaceholder = inPlaceholder;
      if (isWordElement(child, "sdt")) {
        const sdtPr = directWordChild(child, "sdtPr");
        if (sdtPr && directWordChild(sdtPr, "showingPlcHdr")) {
          childInPlaceholder = true;
        }
      }
      if (isWordElement(child, "t")) {
        (childInPlaceholder ? placeholders : parts).push(
          child.textContent ?? "",
        );
      } else if (isWordElement(child, "tab")) {
        if (!childInPlaceholder) parts.push("\t");
      } else if (isWordElement(child, "br")) {
        if (!childInPlaceholder) parts.push("\n");
      }
      walk(child, childInPlaceholder);
    }
  };
  walk(element, false);
  return { text: parts.join(""), placeholders };
}

/** Placeholder-aware table rows: placeholder-only cells read as "". */
export function tableRowsDetailed(table: XmlElement): DetailedTableRows {
  const rows: string[][] = [];
  const placeholderCells: WordPlaceholderCell[] = [];
  tableRowElements(table).forEach((row, rowIdx) => {
    const cells = tableCellEntries(row).map((entry, columnIdx) => {
      const extracted = extractTextExcludingPlaceholders(entry.cell);
      if (
        extracted.text.trim() === "" &&
        extracted.placeholders.join("").trim() !== ""
      ) {
        placeholderCells.push({
          rowIndex: rowIdx + 1,
          columnIndex: columnIdx + 1,
          placeholder: extracted.placeholders.join(""),
        });
        return "";
      }
      return extracted.text;
    });
    rows.push(cells);
  });
  return { rows, placeholderCells };
}

export function tableRows(table: XmlElement): string[][] {
  return tableRowsDetailed(table).rows;
}

export function captionForTable(
  tableBlock: BodyBlock,
  structure: DocumentStructure,
): string | null {
  const index = tableBlock.bodyIndex;
  for (const candidate of [
    structure.blocks[index - 1],
    structure.blocks[index + 1],
  ]) {
    if (candidate?.type !== "paragraph") continue;
    const text = textOf(candidate.element).trim();
    if (/^Table\s+\d+\s*:/i.test(text)) return text;
  }
  return null;
}

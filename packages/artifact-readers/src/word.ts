/**
 * Pure reader for .docx/.dotx artifacts: outline, chapter bodies, tables and
 * their inventory, table search, content controls, template guidance and
 * full-text search.
 *
 * The package loader does not go through JSZip, which inflates entries with no real output bound: every part is read through
 * archive.ts's bounded entry reader after assertReadableArchive (see
 * ./word/package.ts). Out-of-range numeric inputs are reported as invalid_input,
 * as the Excel reader in this package does.
 */
import {
  collectDropdownControls,
  collectTableDropdownControls,
  classifyParagraph,
  DEFAULT_INSTRUCTION_PROFILE,
  loadStyleSheet,
  paragraphKindOf,
  type WordDropdownRead,
  type WordDropdownsRead,
  type WordInstructionItem,
  type WordInstructionProfile,
  type WordParagraphKind,
} from "./word/controls";
import { ArtifactReadError, rethrowAsReadError } from "./errors";
import { capEntries, normalizeLimit, normalizeOffset } from "./limits";
import { createImageResolver, type WordImageRead } from "./word/images";
import {
  countDescendants,
  isWordElement,
  loadDocx,
  maxColumns,
  readOptionalPartDocument,
  readWordComments,
  textOf,
  visitElements,
  type WordCommentRead,
} from "./word/package";
import {
  blocksInChapter,
  buildStructure,
  captionForTable,
  chapterForBlock,
  chapterIdForBlock,
  extractTextExcludingPlaceholders,
  isEmptyChapter,
  requireChapter,
  requireTable,
  tableCellEntries,
  tableRows,
  tableRowElements,
  tableRowsDetailed,
  type BodyBlock,
  type ChapterRef,
  type DocumentStructure,
  type WordChapterSummary,
  type WordPlaceholderCell,
} from "./word/structure";

export type { WordChapterSummary, WordPlaceholderCell } from "./word/structure";
export type { WordCommentRead } from "./word/package";
export type { WordImageRead } from "./word/images";
export {
  DEFAULT_INSTRUCTION_PROFILE,
  type WordDropdownControlType,
  type WordDropdownOption,
  type WordDropdownRead,
  type WordDropdownsRead,
  type WordInstructionItem,
  type WordInstructionProfile,
  type WordParagraphKind,
} from "./word/controls";

const DEFAULT_SEARCH_LIMIT = 20;
const HARD_SEARCH_LIMIT = 100;
const DEFAULT_MAX_TABLE_RESULTS = 10;
const HARD_MAX_TABLE_RESULTS = 25;
const DEFAULT_MAX_BLOCKS = 200;
const HARD_MAX_BLOCKS = 500;
const DEFAULT_MAX_ROWS = 200;
const HARD_MAX_ROWS = 500;
const SEARCH_SNIPPET_CONTEXT_CHARS = 80;

export interface WordOutline {
  headingSource: DocumentStructure["headingSource"];
  chapters: WordChapterSummary[];
  tables: WordTableSummary[];
  /** Either list was cut at OVERVIEW_ENTRY_CAP entries. */
  truncated: boolean;
}

export interface WordTableSummary {
  tableId: string;
  chapterId: string | null;
  caption: string | null;
  rows: number;
  columns: number;
  contentControlCount: number;
  dropdownCount: number;
}

export interface WordChapterRead {
  chapterId: string;
  title: string;
  level: number;
  /** One window of the chapter's blocks, starting at `fromBlock`. */
  blocks: WordBlockRead[];
  /** Blocks in the chapter after the instruction filter, across all windows. */
  blockCount: number;
  /** Index of the block after this window, or null once the chapter is exhausted. */
  nextBlock: number | null;
}

export type WordBlockRead =
  | {
      blockId: string;
      type: "paragraph";
      text: string;
      /** Classification per the instruction profile; headings carry level + the chapterId they open. */
      kind: WordParagraphKind;
      headingLevel?: number;
      chapterId?: string;
      images?: WordImageRead[];
      imageWarnings?: string[];
    }
  | {
      blockId: string;
      type: "table";
      tableId: string;
      rows: number;
      columns: number;
      values?: string[][];
      placeholderCells?: WordPlaceholderCell[];
      imageCount?: number;
    };

export interface WordTableRead {
  tableId: string;
  chapterId: string | null;
  /** Row 0 of the table, whatever window was asked for; null for an empty table. */
  header: string[] | null;
  /** Rows and widest row over the whole table, not just this window. */
  rowCount: number;
  columnCount: number;
  /** One window of rows, starting at `fromRow` (0 is the header row). */
  rows: string[][];
  /** Index of the row after this window, or null once the table is exhausted. */
  nextRow: number | null;
  /** Cells in this window whose only content is an unfilled content-control placeholder; their row value is "". */
  placeholderCells?: WordPlaceholderCell[];
  /** Only with `includeDropdowns` on a window that starts at the header or first data row. */
  dropdowns?: WordDropdownRead[];
  /** Pictures in this window's cells; row and column are 1-based. */
  images?: Array<WordImageRead & { rowIndex: number; columnIndex: number }>;
  imageWarnings?: string[];
}

export interface WordTableInventoryEntry {
  tableId: string;
  caption: string | null;
  chapterId: string | null;
  chapterTitle: string | null;
  /** Numbered heading path of the nearest enclosing heading, e.g. "4.6.1 Logical Infrastructure Connections". */
  chapterPath: string | null;
  rows: number;
  columns: number;
  /** Rows below the header row. */
  dataRows: number;
  /** Data rows whose cells are all empty (placeholder-only cells count as empty). */
  emptyDataRows: number;
  contentControlCount: number;
  dropdownCount: number;
}

export interface WordTableInventory {
  tables: WordTableInventoryEntry[];
  /** The list was cut at OVERVIEW_ENTRY_CAP tables. */
  truncated: boolean;
}

export interface WordTableFindInput {
  query?: string;
  captionNumber?: number;
  expectedHeaders?: string[];
  chapterTitle?: string;
  includePreview?: boolean;
  maxResults?: number;
}

export interface WordTableFindCandidate {
  tableId: string;
  chapterId: string | null;
  chapter?: Pick<
    WordChapterSummary,
    "chapterId" | "blockId" | "level" | "title"
  >;
  caption: string | null;
  rows: number;
  columns: number;
  contentControlCount: number;
  dropdownCount: number;
  headerRow?: string[];
  previewRows?: string[][];
  score: number;
  matchReasons: string[];
}

export interface WordTableFindResult {
  candidates: WordTableFindCandidate[];
  truncated: boolean;
  warnings: string[];
}

export interface WordSearchMatch {
  location: "body" | "table" | "header" | "footer";
  snippet: string;
  chapterId?: string;
  chapterTitle?: string;
  blockId?: string;
  tableId?: string;
  rowIndex?: number;
  columnIndex?: number;
  /** The header/footer part filename for those locations. */
  part?: string;
}

export interface WordSearchResult {
  total: number;
  truncated: boolean;
  matches: WordSearchMatch[];
}

export interface WordInstructionsRead {
  groups: Array<{
    chapterId: string | null;
    title: string;
    items: WordInstructionItem[];
  }>;
  /** Review comments from word/comments.xml (empty when the part is absent). */
  comments: WordCommentRead[];
  totalItems: number;
}

/** Deeply nested XML overflows the recursive element walks below; a bare
 *  RangeError would escape the closed error list. */
function guardDepth<A extends unknown[], R>(
  read: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    try {
      return await read(...args);
    } catch (cause) {
      rethrowAsReadError(cause);
    }
  };
}

function openDocument(data: Uint8Array) {
  const loaded = loadDocx(data);
  const sheet = loadStyleSheet(loaded);
  return {
    loaded,
    styles: sheet.index,
    structure: buildStructure(loaded.doc, {
      styles: sheet.index,
      defaultSize: sheet.defaultSize,
    }),
  };
}

export const readWordOutline = guardDepth(readWordOutlineImpl);
export const readWordChapter = guardDepth(readWordChapterImpl);
export const readWordTable = guardDepth(readWordTableImpl);
export const searchWordText = guardDepth(searchWordTextImpl);
export const readWordInstructions = guardDepth(readWordInstructionsImpl);
export const readWordTableInventory = guardDepth(readWordTableInventoryImpl);
export const findWordTables = guardDepth(findWordTablesImpl);
export const readWordDropdowns = guardDepth(readWordDropdownsImpl);

async function readWordOutlineImpl(data: Uint8Array): Promise<WordOutline> {
  const { structure, styles } = openDocument(data);
  const profile = DEFAULT_INSTRUCTION_PROFILE;

  const instructionCounts = new Map<string, number>();
  for (const block of structure.blocks) {
    if (block.type !== "paragraph" || block.headingLevel || block.isToc) {
      continue;
    }
    const kind = paragraphKindOf(block, styles, profile);
    if (kind !== "instruction" && kind !== "mixed") continue;
    const chapterId = chapterIdForBlock(structure, block);
    if (!chapterId) continue;
    instructionCounts.set(
      chapterId,
      (instructionCounts.get(chapterId) ?? 0) + 1,
    );
  }

  const chapters = capEntries(structure.chapters);
  const tables = capEntries(
    structure.blocks.filter((block) => block.type === "table"),
  );
  return {
    headingSource: structure.headingSource,
    chapters: chapters.items.map((chapter) => ({
      chapterId: chapter.chapterId,
      blockId: chapter.blockId,
      level: chapter.level,
      title: chapter.title,
      blockCount: chapter.endBlockIndex - chapter.startBlockIndex,
      ...(chapter.inferred ? { inferred: true as const } : {}),
      instructionParagraphCount: instructionCounts.get(chapter.chapterId) ?? 0,
      ...(isEmptyChapter(chapter) ? { empty: true } : {}),
    })),
    tables: tables.items.map((block) => tableSummary(block, structure)),
    truncated: chapters.truncated || tables.truncated,
  };
}

type BlockWindowInput = {
  includeTables?: boolean;
  excludeInstructions?: boolean;
  fromBlock?: number;
  maxBlocks?: number;
};

/** One window over `blocks`, counted after the instruction filter so a block
 *  index means the same whether or not instructions were excluded. */
function readBlockWindow(
  document: ReturnType<typeof openDocument>,
  blocks: readonly BodyBlock[],
  input: BlockWindowInput,
): { blocks: WordBlockRead[]; blockCount: number; nextBlock: number | null } {
  const fromBlock = normalizeOffset({
    value: input.fromBlock,
    label: "fromBlock",
  });
  const maxBlocks = normalizeLimit({
    value: input.maxBlocks,
    defaultValue: DEFAULT_MAX_BLOCKS,
    hardMax: HARD_MAX_BLOCKS,
    label: "maxBlocks",
  });
  const { structure, styles } = document;
  const profile = DEFAULT_INSTRUCTION_PROFILE;
  const chaptersByBlockId = chapterIndex(structure, (item) => item.blockId);
  const resolver = createImageResolver(document.loaded);
  const reads: WordBlockRead[] = [];
  let blockCount = 0;
  const inWindow = () => {
    const index = blockCount;
    blockCount += 1;
    return index >= fromBlock && index < fromBlock + maxBlocks;
  };
  for (const block of blocks) {
    if (block.type === "paragraph") {
      const kind = paragraphKindOf(block, styles, profile);
      if (input.excludeInstructions && kind === "instruction") continue;
      if (!inWindow()) continue;
      const nested =
        kind === "heading" ? chaptersByBlockId.get(block.blockId) : undefined;
      const pictures = block.isToc
        ? { images: [], warnings: [] }
        : resolver.read(block.element);
      reads.push({
        blockId: block.blockId,
        type: "paragraph",
        text: block.isToc
          ? "[Table of contents]"
          : extractTextExcludingPlaceholders(block.element).text,
        kind,
        ...(nested
          ? { headingLevel: nested.level, chapterId: nested.chapterId }
          : {}),
        ...(pictures.images.length ? { images: pictures.images } : {}),
        ...(pictures.warnings.length
          ? { imageWarnings: pictures.warnings }
          : {}),
      });
      continue;
    }
    if (!inWindow()) continue;
    const detailed = tableRowsDetailed(block.element);
    const imageCount = resolver.count(block.element);
    reads.push({
      blockId: block.blockId,
      type: "table",
      tableId: block.blockId,
      rows: detailed.rows.length,
      columns: maxColumns(detailed.rows),
      ...(input.includeTables
        ? {
            values: detailed.rows,
            ...(detailed.placeholderCells.length > 0
              ? { placeholderCells: detailed.placeholderCells }
              : {}),
          }
        : {}),
      ...(imageCount ? { imageCount } : {}),
    });
  }
  const nextBlock = fromBlock + reads.length;
  return {
    blocks: reads,
    blockCount,
    nextBlock: reads.length > 0 && nextBlock < blockCount ? nextBlock : null,
  };
}

async function readWordChapterImpl(
  data: Uint8Array,
  input: { chapterId: string } & BlockWindowInput,
): Promise<WordChapterRead> {
  const document = openDocument(data);
  const chapter = requireChapter(document.structure, input.chapterId);
  const window = readBlockWindow(
    document,
    blocksInChapter(document.structure, chapter, { includeHeading: false }),
    input,
  );
  return {
    chapterId: chapter.chapterId,
    title: chapter.title,
    level: chapter.level,
    ...window,
  };
}

const MAX_LEAD_IN_BLOCKS = 20;

export interface WordBlocksRead {
  /** First block of the range, lead-in included, even when the instruction filter drops it. */
  startBlockId: string;
  /** Chapter `startBlockId` lies in. */
  startChapter: { chapterId: string; title: string; level: number } | null;
  blocks: WordBlockRead[];
  blockCount: number;
  nextBlock: number | null;
}

async function readWordBlocksImpl(
  data: Uint8Array,
  input: {
    fromBlockId: string;
    toBlockId?: string;
    before?: number;
  } & BlockWindowInput,
): Promise<WordBlocksRead> {
  const before = input.before ?? 0;
  if (!Number.isInteger(before) || before < 0 || before > MAX_LEAD_IN_BLOCKS)
    throw new ArtifactReadError(
      "invalid_input",
      `before must be between 0 and ${MAX_LEAD_IN_BLOCKS}`,
    );
  const document = openDocument(data);
  const { blocks } = document.structure;
  const indexOf = (blockId: string) => {
    const index = blocks.findIndex((block) => block.blockId === blockId);
    if (index < 0)
      throw new ArtifactReadError("not_found", `block ${blockId} not found`);
    return index;
  };
  const from = indexOf(input.fromBlockId);
  const to =
    input.toBlockId === undefined
      ? blocks.length - 1
      : indexOf(input.toBlockId);
  if (to < from)
    throw new ArtifactReadError(
      "invalid_input",
      "toBlockId must not precede fromBlockId",
    );
  const start = Math.max(from - before, 0);
  const first = blocks[start]!;
  const chapter = chapterForBlock(document.structure, first);
  return {
    startBlockId: first.blockId,
    startChapter: chapter
      ? {
          chapterId: chapter.chapterId,
          title: chapter.title,
          level: chapter.level,
        }
      : null,
    ...readBlockWindow(document, blocks.slice(start, to + 1), input),
  };
}

export const readWordBlocks = guardDepth(readWordBlocksImpl);

async function readWordTableImpl(
  data: Uint8Array,
  input: {
    tableId: string;
    includeDropdowns?: boolean;
    includeHeaderImages?: boolean;
    fromRow?: number;
    maxRows?: number;
  },
): Promise<WordTableRead> {
  const fromRow = normalizeOffset({ value: input.fromRow, label: "fromRow" });
  const maxRows = normalizeLimit({
    value: input.maxRows,
    defaultValue: DEFAULT_MAX_ROWS,
    hardMax: HARD_MAX_ROWS,
    label: "maxRows",
  });
  const { loaded, structure } = openDocument(data);
  const tableBlock = requireTable(structure, input.tableId);
  const detailed = tableRowsDetailed(tableBlock.element);
  const rows = detailed.rows.slice(fromRow, fromRow + maxRows);
  const nextRow = fromRow + rows.length;
  // placeholderCells report 1-based rows.
  const placeholderCells = detailed.placeholderCells.filter(
    (cell) => cell.rowIndex > fromRow && cell.rowIndex <= nextRow,
  );
  const resolver = createImageResolver(loaded);
  const tableImages: NonNullable<WordTableRead["images"]> = [];
  const tableWarnings = new Set<string>();
  const allImageRows = tableRowElements(tableBlock.element);
  const imageRows = allImageRows
    .slice(fromRow, fromRow + maxRows)
    .map((row, offset) => ({ row, rowIndex: fromRow + offset + 1 }));
  if (input.includeHeaderImages && fromRow > 0 && allImageRows[0])
    imageRows.unshift({ row: allImageRows[0], rowIndex: 1 });
  imageRows.forEach(({ row, rowIndex }) => {
    tableCellEntries(row).forEach((entry, column) => {
      const pictures = resolver.read(entry.cell);
      for (const image of pictures.images)
        tableImages.push({
          rowIndex,
          columnIndex: column + 1,
          ...image,
        });
      for (const warning of pictures.warnings) tableWarnings.add(warning);
    });
  });
  return {
    tableId: tableBlock.blockId,
    chapterId: chapterIdForBlock(structure, tableBlock),
    header: detailed.rows[0] ?? null,
    rowCount: detailed.rows.length,
    columnCount: maxColumns(detailed.rows),
    rows,
    nextRow: rows.length > 0 && nextRow < detailed.rows.length ? nextRow : null,
    ...(placeholderCells.length > 0 ? { placeholderCells } : {}),
    ...(tableImages.length ? { images: tableImages } : {}),
    ...(tableWarnings.size ? { imageWarnings: [...tableWarnings] } : {}),
    // Dropdowns travel with the first page only; a continuation spends its
    // whole budget on rows.
    ...(input.includeDropdowns && fromRow <= 1
      ? {
          dropdowns: collectDropdownControls(structure, {
            tableId: input.tableId,
            includeOptions: true,
          }).controls,
        }
      : {}),
  };
}

async function searchWordTextImpl(
  data: Uint8Array,
  input: { query: string; matchCase?: boolean; limit?: number },
): Promise<WordSearchResult> {
  // An empty needle would match at every offset without advancing.
  if (input.query === "") {
    throw new ArtifactReadError("invalid_input", "query must not be empty");
  }
  const { loaded, structure } = openDocument(data);
  const matchCase = input.matchCase ?? false;
  const limit = normalizeLimit({
    value: input.limit,
    defaultValue: DEFAULT_SEARCH_LIMIT,
    hardMax: HARD_SEARCH_LIMIT,
    label: "limit",
  });
  const needle = matchCase ? input.query : input.query.toLowerCase();
  const state = { total: 0, matches: [] as WordSearchMatch[] };

  for (const block of structure.blocks) {
    const chapter = chapterForBlock(structure, block);
    const chapterId = chapter?.chapterId;
    const chapterTitle = chapter?.title;
    if (block.type === "paragraph") {
      if (block.isToc) continue;
      pushSearchMatches(
        extractTextExcludingPlaceholders(block.element).text,
        needle,
        matchCase,
        limit,
        state,
        { location: "body", chapterId, chapterTitle, blockId: block.blockId },
      );
      continue;
    }
    const detailed = tableRowsDetailed(block.element);
    detailed.rows.forEach((row, rowIdx) => {
      row.forEach((cell, columnIdx) => {
        pushSearchMatches(cell, needle, matchCase, limit, state, {
          location: "table",
          chapterId,
          chapterTitle,
          tableId: block.blockId,
          rowIndex: rowIdx + 1,
          columnIndex: columnIdx + 1,
        });
      });
    });
  }

  // Headers and footers live in their own parts.
  const partNames = loaded.partNames
    .filter((name) => /^word\/(header|footer)\d*\.xml$/.test(name))
    .sort();
  for (const partName of partNames) {
    const doc = readOptionalPartDocument(loaded.data, partName);
    const root = doc?.documentElement;
    if (!root) continue;
    const paragraphs: string[] = [];
    visitElements(root, (child) => {
      if (isWordElement(child, "p")) paragraphs.push(textOf(child));
    });
    pushSearchMatches(paragraphs.join("\n"), needle, matchCase, limit, state, {
      location: partName.includes("header") ? "header" : "footer",
      part: partName.replace(/^word\//, ""),
    });
  }

  return {
    total: state.total,
    truncated: state.total > state.matches.length,
    matches: state.matches,
  };
}

async function readWordInstructionsImpl(
  data: Uint8Array,
  input: {
    chapterId?: string;
    styleNames?: string[];
    colors?: string[];
  },
): Promise<WordInstructionsRead> {
  const { loaded, structure, styles } = openDocument(data);
  const profile: WordInstructionProfile = {
    styleNames: input.styleNames?.length
      ? input.styleNames
      : DEFAULT_INSTRUCTION_PROFILE.styleNames,
    colors: input.colors?.length
      ? input.colors
      : DEFAULT_INSTRUCTION_PROFILE.colors,
    coverageThreshold: DEFAULT_INSTRUCTION_PROFILE.coverageThreshold,
  };

  let range: { start: number; end: number } | null = null;
  if (input.chapterId) {
    const chapter = requireChapter(structure, input.chapterId);
    range = { start: chapter.startBlockIndex, end: chapter.endBlockIndex };
  }

  const groups = new Map<
    string | null,
    { chapterId: string | null; title: string; items: WordInstructionItem[] }
  >();
  const addItem = (chapter: ChapterRef | null, item: WordInstructionItem) => {
    const key = chapter?.chapterId ?? null;
    let group = groups.get(key);
    if (!group) {
      group = {
        chapterId: chapter?.chapterId ?? null,
        title: chapter?.title ?? "(no chapter)",
        items: [],
      };
      groups.set(key, group);
    }
    group.items.push(item);
  };

  let totalItems = 0;
  structure.blocks.forEach((block, index) => {
    if (range && (index < range.start || index >= range.end)) return;
    const chapter = chapterForBlock(structure, block);
    if (block.type === "paragraph") {
      if (block.headingLevel || block.isToc) return;
      const kind = classifyParagraph(block.element, styles, profile);
      if (kind === "content") return;
      totalItems += 1;
      addItem(chapter, {
        chapterId: chapter?.chapterId ?? null,
        kind,
        text: extractTextExcludingPlaceholders(block.element).text,
        blockId: block.blockId,
      });
      return;
    }
    // Guidance also lives inside table cells.
    tableRowElements(block.element).forEach((row, rowIdx) => {
      tableCellEntries(row).forEach((entry, columnIdx) => {
        visitElements(entry.cell, (child) => {
          if (!isWordElement(child, "p")) return;
          const kind = classifyParagraph(child, styles, profile);
          if (kind === "content") return;
          const text = extractTextExcludingPlaceholders(child).text;
          if (text.trim() === "") return;
          totalItems += 1;
          addItem(chapter, {
            chapterId: chapter?.chapterId ?? null,
            kind,
            text,
            tableId: block.blockId,
            rowIndex: rowIdx + 1,
            columnIndex: columnIdx + 1,
          });
        });
      });
    });
  });

  return {
    groups: [...groups.values()],
    comments: readWordComments(loaded),
    totalItems,
  };
}

async function readWordTableInventoryImpl(
  data: Uint8Array,
): Promise<WordTableInventory> {
  const { structure } = openDocument(data);
  const tables: WordTableInventoryEntry[] = [];
  const tableBlocks = capEntries(
    structure.blocks.filter((block) => block.type === "table"),
  );
  for (const block of tableBlocks.items) {
    const chapter = chapterForBlock(structure, block);
    const detailed = tableRowsDetailed(block.element);
    const dataRowValues = detailed.rows.slice(1);
    const dropdowns = collectTableDropdownControls(block, structure, false);
    tables.push({
      tableId: block.blockId,
      caption: captionForTable(block, structure),
      chapterId: chapter?.chapterId ?? null,
      chapterTitle: chapter?.title ?? null,
      chapterPath: chapter
        ? chapter.numberPath
          ? `${chapter.numberPath} ${chapter.title}`.trim()
          : chapter.title
        : null,
      rows: detailed.rows.length,
      columns: maxColumns(detailed.rows),
      dataRows: dataRowValues.length,
      emptyDataRows: dataRowValues.filter((row) =>
        row.every((cell) => cell.trim() === ""),
      ).length,
      contentControlCount: countDescendants(block.element, "sdt"),
      dropdownCount: dropdowns.length,
    });
  }
  return { tables, truncated: tableBlocks.truncated };
}

async function findWordTablesImpl(
  data: Uint8Array,
  input: WordTableFindInput,
): Promise<WordTableFindResult> {
  const { structure } = openDocument(data);
  const maxResults = normalizeLimit({
    value: input.maxResults,
    defaultValue: DEFAULT_MAX_TABLE_RESULTS,
    hardMax: HARD_MAX_TABLE_RESULTS,
    label: "maxResults",
  });
  const query = normalizeSearchText(input.query ?? "");
  const chapterQuery = normalizeSearchText(input.chapterTitle ?? "");
  const expectedHeaders = (input.expectedHeaders ?? [])
    .map((header) => normalizeSearchText(header))
    .filter(Boolean);
  const chaptersById = chapterIndex(structure, (item) => item.chapterId);
  const candidates = structure.blocks
    .filter((block) => block.type === "table")
    .map((block) =>
      scoreTableCandidate(block, structure, {
        query,
        captionNumber: input.captionNumber,
        expectedHeaders,
        chapterQuery,
        includePreview: input.includePreview ?? false,
        chaptersById,
      }),
    )
    .sort((a, b) => b.score - a.score || a.tableId.localeCompare(b.tableId));

  return {
    candidates: candidates.slice(0, maxResults),
    truncated: candidates.length > maxResults,
    warnings:
      candidates.length === 0
        ? ["No tables were found in the DOCX main document body."]
        : [],
  };
}

async function readWordDropdownsImpl(
  data: Uint8Array,
  input: {
    tableId?: string;
    chapterId?: string;
    includeOptions?: boolean;
    maxControls?: number;
  },
): Promise<WordDropdownsRead> {
  const { structure } = openDocument(data);
  return collectDropdownControls(structure, input);
}

/** One pass over the chapters, so a per-block or per-table lookup does not
 *  rescan them all. */
function chapterIndex(
  structure: DocumentStructure,
  keyOf: (chapter: ChapterRef) => string | null,
): Map<string, ChapterRef> {
  const index = new Map<string, ChapterRef>();
  for (const chapter of structure.chapters) {
    const key = keyOf(chapter);
    if (key !== null && !index.has(key)) index.set(key, chapter);
  }
  return index;
}

function tableSummary(
  tableBlock: BodyBlock,
  structure: DocumentStructure,
): WordTableSummary {
  const rows = tableRows(tableBlock.element);
  const dropdowns = collectTableDropdownControls(tableBlock, structure, false);
  return {
    tableId: tableBlock.blockId,
    chapterId: chapterIdForBlock(structure, tableBlock),
    caption: captionForTable(tableBlock, structure),
    rows: rows.length,
    columns: maxColumns(rows),
    contentControlCount: countDescendants(tableBlock.element, "sdt"),
    dropdownCount: dropdowns.length,
  };
}

function scoreTableCandidate(
  tableBlock: BodyBlock,
  structure: DocumentStructure,
  input: {
    query: string;
    captionNumber?: number;
    expectedHeaders: string[];
    chapterQuery: string;
    includePreview: boolean;
    chaptersById: Map<string, ChapterRef>;
  },
): WordTableFindCandidate {
  const summary = tableSummary(tableBlock, structure);
  const rows = tableRows(tableBlock.element);
  const headerRow = rows.find((row) =>
    row.some((cell) => cell.trim().length > 0),
  );
  const chapter = summary.chapterId
    ? input.chaptersById.get(summary.chapterId)
    : undefined;
  const searchable = normalizeSearchText(
    [
      summary.caption ?? "",
      chapter?.title ?? "",
      ...(headerRow ?? []),
      ...rows.slice(0, 5).flat(),
    ].join(" "),
  );
  const normalizedCaption = normalizeSearchText(summary.caption ?? "");
  const normalizedChapter = normalizeSearchText(chapter?.title ?? "");
  const normalizedHeaders = (headerRow ?? []).map(normalizeSearchText);
  let score = 0;
  const reasons: string[] = [];

  if (input.query) {
    if (normalizedCaption.includes(input.query)) {
      score += 80;
      reasons.push("query matched caption");
    } else if (searchable.includes(input.query)) {
      score += 30;
      reasons.push("query matched table text");
    }
  }

  if (input.captionNumber !== undefined && summary.caption) {
    const match = /^Table\s+(\d+)\s*:/i.exec(summary.caption.trim());
    if (match && Number(match[1]) === input.captionNumber) {
      score += 60;
      reasons.push(`caption number matched Table ${input.captionNumber}`);
    }
  }

  if (input.chapterQuery && normalizedChapter.includes(input.chapterQuery)) {
    score += 20;
    reasons.push("chapter title matched");
  }

  const matchedHeaders = input.expectedHeaders.filter((expected) =>
    normalizedHeaders.some(
      (actual) => actual === expected || actual.includes(expected),
    ),
  );
  if (matchedHeaders.length > 0) {
    score += matchedHeaders.length * 20;
    reasons.push(
      `expected headers matched: ${matchedHeaders.length}/${input.expectedHeaders.length}`,
    );
  }

  if (reasons.length === 0) reasons.push("listed table");

  return {
    tableId: summary.tableId,
    chapterId: summary.chapterId,
    ...(chapter
      ? {
          chapter: {
            chapterId: chapter.chapterId,
            blockId: chapter.blockId,
            level: chapter.level,
            title: chapter.title,
          },
        }
      : {}),
    caption: summary.caption,
    rows: summary.rows,
    columns: summary.columns,
    contentControlCount: summary.contentControlCount,
    dropdownCount: summary.dropdownCount,
    ...(headerRow ? { headerRow } : {}),
    ...(input.includePreview ? { previewRows: rows.slice(0, 3) } : {}),
    score,
    matchReasons: reasons,
  };
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function pushSearchMatches(
  haystack: string,
  needle: string,
  matchCase: boolean,
  limit: number,
  state: { total: number; matches: WordSearchMatch[] },
  location: Omit<WordSearchMatch, "snippet">,
): void {
  const source = matchCase ? haystack : haystack.toLowerCase();
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at < 0) break;
    state.total += 1;
    if (state.matches.length < limit) {
      const start = Math.max(0, at - SEARCH_SNIPPET_CONTEXT_CHARS);
      const end = Math.min(
        haystack.length,
        at + needle.length + SEARCH_SNIPPET_CONTEXT_CHARS,
      );
      state.matches.push({ ...location, snippet: haystack.slice(start, end) });
    }
    from = at + needle.length;
  }
}

import {
  imageReference,
  markdownImage,
} from "@weaver/core/documents/imageReferences";
import type { ArtifactFormat } from "@weaver/core/artifacts/readerOperations";
import {
  staleBaseError,
  type ArtifactCursorBinding,
} from "@weaver/core/services/artifactCursors";
import {
  describeArtifact,
  readArtifact,
  type ArtifactEnvelope,
} from "@weaver/core/services/artifactReads";
import {
  cursorQueryIdentity,
  invalidCursorError,
} from "@weaver/core/services/contentCursors";
import { z } from "zod";
import {
  boundItems,
  clampText,
  newPageBudget,
  requireScope,
  ToolError,
  utf8Bytes,
  utf8Prefix,
  type OutputBudget,
  type ToolContext,
} from "../contract";
import { fitTextChunk, sliceTextChunk } from "./snapshotReads";

export const artifactTarget = {
  projectId: z.uuid(),
  filename: z.string().min(1).max(255),
};

export type ArtifactInput = { projectId: string; filename: string };

function target(input: ArtifactInput) {
  return { projectId: input.projectId, filename: input.filename };
}

/** Scope check, then the service's Viewer check: no tool touches bytes first. */
export async function describeFor(input: ArtifactInput, ctx: ToolContext) {
  requireScope(ctx, input.projectId);
  return describeArtifact(ctx.db, ctx.actor, target(input));
}

/** describeArtifact and readArtifact look the artifact up separately, so a
 *  replace between them would apply a position decoded against the old digest
 *  to the new content — the same failure a stale cursor reports. */
export function assertSameContent(
  expectedDigest: string,
  artifact: ArtifactEnvelope,
): void {
  if (artifact.sha256 !== expectedDigest) throw staleBaseError();
}

export async function readOperation(
  ctx: ToolContext,
  input: ArtifactInput,
  operation: Parameters<typeof readArtifact>[3],
  readerInput: unknown,
  expectedDigest?: string,
) {
  const loaded = await readArtifact(
    ctx.db,
    ctx.actor,
    target(input),
    operation,
    readerInput,
    {
      signal: ctx.signal,
    },
  );
  if (expectedDigest !== undefined)
    assertSameContent(expectedDigest, loaded.artifact);
  return loaded;
}

/** Leaves the non-list part of a result out of the item budget, so a heavy
 *  header (PDF metadata, a long filename) shrinks the lists instead of
 *  overflowing the output. */
export function budgetAfter(head: unknown): OutputBudget {
  const budget = newPageBudget();
  budget.remaining -= utf8Bytes(JSON.stringify(head));
  return budget;
}

/** Overview headers stay short; sheet and table rows are bounded by the row
 *  paging below, which reports what it clamped. Every cap here is UTF-8 bytes. */
export const MAX_CELL_CHARS = 120;
/** No string a file controls may grow a head without bound: a head is charged
 *  before the item budget, so one long title or caption could otherwise leave
 *  a page with nothing to spend on rows. */
const MAX_HEAD_TEXT_CHARS = 500;
/** A file-derived string inside an overview list item (a chapter title, a
 *  sheet name): one 20,000-character heading would otherwise be the whole page
 *  and boundItems, which keeps a prefix, would drop every entry after it. */
const MAX_OVERVIEW_ITEM_TEXT_CHARS = 200;

export function headText(value: string): string {
  return utf8Prefix(value, MAX_HEAD_TEXT_CHARS);
}

export function overviewText(value: string): {
  text: string;
  truncated: boolean;
} {
  return clampText(value, MAX_OVERVIEW_ITEM_TEXT_CHARS);
}

/** A head field repeated on every page (a table's header row) gets a fixed
 *  share of one page; what does not fit is dropped and reported. */
export function boundHeadCells(
  cells: readonly string[],
  divisor: number,
): { cells: string[]; truncated: boolean } {
  const budget = { remaining: Math.floor(newPageBudget().remaining / divisor) };
  const bounded = boundItems(
    cells.map((cell) => cellText(cell) ?? ""),
    budget,
  );
  return { cells: bounded.items, truncated: bounded.truncated };
}

export function cellText(
  value: unknown,
  maxChars = MAX_CELL_CHARS,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return utf8Prefix(value, maxChars);
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (typeof value === "object") {
    const record = value as { text?: unknown; result?: unknown };
    if (typeof record.text === "string")
      return utf8Prefix(record.text, maxChars);
    if ("result" in record) return cellText(record.result, maxChars);
  }
  return null;
}

export type ArtifactFileOutput = {
  id: string;
  filename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  updatedAt: string;
  url: string;
};

/** Tools have no access to the deployment's base path, so this is the
 *  app-relative path the Files page answers (it reads ?file=). */
export function artifactUrl(projectId: string, filename: string): string {
  return `/projects/${projectId}/artifacts?file=${encodeURIComponent(filename)}`;
}

export function artifactEnvelope(
  artifact: ArtifactEnvelope,
): ArtifactFileOutput {
  return {
    id: artifact.id,
    filename: artifact.filename,
    contentType: artifact.contentType,
    byteSize: artifact.byteSize,
    sha256: artifact.sha256,
    updatedAt: artifact.updatedAt,
    url: artifactUrl(artifact.projectId, artifact.filename),
  };
}

/** The one table from which every wrong-format message is generated: which
 *  tools read a format, and what to say instead. The first tool of a format
 *  is the one a misdirected caller is sent to. */
const FORMAT_TOOLS = {
  word: {
    plural: "Word",
    singular: "a Word file",
    tools: [
      "read_word_chapter",
      "read_word_blocks",
      "find_word_tables",
      "read_word_table",
      "search_artifact_text",
    ],
  },
  excel: {
    plural: "Excel",
    singular: "an Excel file",
    tools: ["read_excel_sheet"],
  },
  pdf: {
    plural: "PDF",
    singular: "a PDF file",
    tools: ["read_pdf_pages", "search_artifact_text"],
  },
  json: {
    plural: "JSON",
    singular: "a JSON file",
    tools: ["query_json_artifact", "inspect_structured_artifact"],
  },
  text: {
    plural: "text",
    singular: "a text file",
    tools: ["read_text_artifact", "search_artifact_text"],
  },
  markdown: {
    plural: "Markdown",
    singular: "a Markdown file",
    tools: ["read_text_artifact", "search_artifact_text"],
  },
  csv: {
    plural: "CSV",
    singular: "a CSV file",
    tools: ["read_csv_artifact", "read_text_artifact", "search_artifact_text"],
  },
  yaml: {
    plural: "YAML",
    singular: "a YAML file",
    tools: [
      "inspect_structured_artifact",
      "query_json_artifact",
      "read_text_artifact",
      "search_artifact_text",
    ],
  },
  onenote: {
    plural: "OneNote",
    singular: "a OneNote notebook",
    tools: ["read_onenote", "search_artifact_text"],
  },
} as const satisfies Record<
  ArtifactFormat,
  { plural: string; singular: string; tools: readonly string[] }
>;

const FORMATS = Object.keys(FORMAT_TOOLS) as ArtifactFormat[];

function joinWithAnd(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

export function wrongFormat(
  actual: ArtifactFormat | null,
  tool: string,
): ToolError {
  const reads = FORMATS.filter((format) =>
    (FORMAT_TOOLS[format].tools as readonly string[]).includes(tool),
  ).map((format) => FORMAT_TOOLS[format].plural);
  const entry = actual === null ? null : FORMAT_TOOLS[actual];
  return new ToolError(
    "BAD_REQUEST",
    `${tool} reads ${joinWithAnd(reads)} files; ${
      entry === null
        ? "this file type has no reader"
        : `for ${entry.singular} use ${entry.tools[0]}`
    }`,
  );
}

export function cursorBinding(
  tool: string,
  artifact: ArtifactEnvelope,
  query: unknown,
): ArtifactCursorBinding {
  return {
    tool,
    projectId: artifact.projectId,
    artifactId: artifact.id,
    contentDigest: artifact.sha256,
    query: cursorQueryIdentity(query),
  };
}

/** A reader result crosses the child's IPC boundary as unknown; a shape we
 *  cannot narrow is our own bug, never the caller's input. */
export function readerResult<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ToolError("INTERNAL", "tool failed");
  return parsed.data;
}

/** `{"page":123,"text":""},` plus JSON escaping slack. */
export const PAGE_ENTRY_OVERHEAD = 32;
const MIN_PAGE_TEXT_CHARS = 200;

export type PdfPagePosition = { page: number; charOffset: number };
export type PdfReaderPages = {
  pages: ReadonlyArray<{ page: number; text: string }>;
  truncated: boolean;
};

function positionAdvances(position: string, from: PdfPagePosition): boolean {
  const [page, offset] = position.split(":").map(Number) as [number, number];
  return page > from.page || (page === from.page && offset > from.charOffset);
}

/**
 * Cuts one `pdf.pages` result down to a page that fits `budgetChars` and says
 * where to resume. `windowChars` is the reader's own per-call ceiling: when it
 * ends inside a page the reader returns that page's prefix (possibly empty)
 * and flags `truncated`, and the resume position depends on which it was.
 */
export function assemblePdfPages(
  reader: PdfReaderPages,
  from: PdfPagePosition,
  limits: { lastPage: number; budgetChars: number; windowChars: number },
): {
  pages: Array<{ page: number; text: string }>;
  nextPosition: string | null;
  omittedPageTail: number | null;
} {
  let remaining = limits.budgetChars;
  const pages: Array<{ page: number; text: string }> = [];
  let nextPosition: string | null = null;
  let omittedPageTail: number | null = null;
  for (const [index, entry] of reader.pages.entries()) {
    const readerCut = reader.truncated && index === reader.pages.length - 1;
    const start =
      entry.page === from.page
        ? Math.min(from.charOffset, entry.text.length)
        : 0;
    if (start < entry.text.length) {
      if (
        pages.length > 0 &&
        remaining < PAGE_ENTRY_OVERHEAD + MIN_PAGE_TEXT_CHARS
      ) {
        nextPosition = `${entry.page}:${start}`;
        break;
      }
      const chunk = fitTextChunk(
        entry.text,
        start,
        entry.text.length - start,
        remaining - PAGE_ENTRY_OVERHEAD,
      );
      pages.push({ page: entry.page, text: chunk.text });
      remaining -= utf8Bytes(JSON.stringify(chunk.text)) + PAGE_ENTRY_OVERHEAD;
      if (chunk.end < entry.text.length) {
        nextPosition = `${entry.page}:${chunk.end}`;
        break;
      }
    }
    if (!readerCut) continue;
    if (entry.text.length === 0) {
      // Earlier pages used up the reader's window, so this page arrived empty:
      // resume at it and the next call spends a whole window on it.
      nextPosition = `${entry.page}:0`;
    } else if (entry.text.length < limits.windowChars) {
      nextPosition = `${entry.page}:${entry.text.length}`;
    } else {
      // The page is longer than one whole window and the cursor already sits
      // at its edge, so the rest of it can never be read.
      omittedPageTail = entry.page;
      nextPosition =
        entry.page < limits.lastPage ? `${entry.page + 1}:0` : null;
    }
    break;
  }
  // A page must always advance: a position at or behind the one we were given
  // would stall, so treat what is left of that page as unreachable.
  if (nextPosition !== null && !positionAdvances(nextPosition, from)) {
    omittedPageTail = from.page;
    nextPosition = from.page < limits.lastPage ? `${from.page + 1}:0` : null;
  }
  return { pages, nextPosition, omittedPageTail };
}

/** Matches boundItems' accounting (UTF-8 bytes), so one page's items are
 *  measured the same way whether they were bounded or assembled here. */
function entrySize(item: unknown): number {
  return utf8Bytes(JSON.stringify(item)) + 1;
}

export function positionIndex(position: string): number {
  if (!/^\d{1,9}$/.test(position)) throw invalidCursorError();
  return Number(position);
}

export type ToolImage = {
  markdown: string;
  contentType: string;
  byteSize: number;
};

export const readerImageSchema = z.object({
  imageId: z.string().regex(/^[0-9a-f]{64}$/),
  contentType: z.string(),
  byteSize: z.number(),
  alt: z.string(),
});

/** Reader images as Markdown a document write copies in; alt text is clamped
 *  like every other file-derived head string. */
export function imageEntries(
  artifactId: string,
  images: readonly z.infer<typeof readerImageSchema>[],
): ToolImage[] {
  return images.map((image) => ({
    markdown: markdownImage(
      overviewText(image.alt).text,
      imageReference(artifactId, image.imageId),
    ),
    contentType: image.contentType,
    byteSize: image.byteSize,
  }));
}

export type ChapterBlock =
  | {
      blockId: string;
      type: "paragraph";
      kind: string;
      text: string;
      headingLevel?: number;
      chapterId?: string;
      images?: ToolImage[];
      imageWarnings?: string[];
    }
  | {
      blockId: string;
      type: "table";
      tableId: string;
      rowCount: number;
      columnCount: number;
      values?: string[][];
      imageCount?: number;
    };

export type ChapterBlockOut = ChapterBlock & {
  clamped?: true;
  omitted?: true;
  hint?: string;
  /** Pictures a clamped paragraph had; a table block always reports its own. */
  imageCount?: number;
};

const TABLE_HINT = "too large for this page: read it with read_word_table";
const MIN_CLAMPED_TEXT_CHARS = 8;

/** Ever smaller representations of one paragraph, largest first: clamped text,
 *  then no text, then the id alone — so even a budget nothing fits still makes
 *  the page advance instead of emitting an entry that overflows it. Dropped
 *  pictures stay counted wherever the count fits. */
function clampParagraph(
  block: Extract<ChapterBlock, { type: "paragraph" }>,
  budgetChars: number,
): ChapterBlockOut {
  const { images, imageWarnings: _warnings, ...bare } = block;
  const count = images?.length ? { imageCount: images.length } : {};
  const empty: ChapterBlockOut = { ...bare, text: "", clamped: true, ...count };
  const room = budgetChars - entrySize(empty);
  if (room >= MIN_CLAMPED_TEXT_CHARS)
    return {
      ...empty,
      text: fitTextChunk(block.text, 0, block.text.length, room).text,
    };
  if (entrySize(empty) <= budgetChars) return empty;
  const idOnly: ChapterBlockOut = {
    blockId: block.blockId,
    type: "paragraph",
    kind: block.kind,
    text: "",
    clamped: true,
    omitted: true,
  };
  const counted = { ...idOnly, ...count };
  return entrySize(counted) <= budgetChars ? counted : idOnly;
}

/**
 * Cuts one chapter's blocks down to a page that fits `budgetChars` and says
 * which block index resumes it. A block that does not fit is left for the next
 * page, which starts with a whole budget — unless it is the first block of
 * this page, which would stall the cursor: a paragraph then comes back clamped
 * and a table as a summary that names read_word_table.
 */
export function assembleChapterBlocks(
  blocks: readonly ChapterBlock[],
  from: number,
  limits: { budgetChars: number },
): { blocks: ChapterBlockOut[]; nextIndex: number | null; clamped: boolean } {
  let remaining = limits.budgetChars;
  const kept: ChapterBlockOut[] = [];
  let clamped = false;
  let index = Math.max(from, 0);
  for (; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    const size = entrySize(block);
    if (size <= remaining) {
      kept.push(block);
      remaining -= size;
      continue;
    }
    if (kept.length > 0) break;
    kept.push(
      block.type === "paragraph"
        ? clampParagraph(block, remaining)
        : {
            blockId: block.blockId,
            type: "table",
            tableId: block.tableId,
            rowCount: block.rowCount,
            columnCount: block.columnCount,
            omitted: true,
            hint: TABLE_HINT,
          },
    );
    clamped = true;
    index += 1;
    break;
  }
  return {
    blocks: kept,
    nextIndex: index < blocks.length ? index : null,
    clamped,
  };
}

export type SheetRow = {
  sheet?: string;
  row: number;
  values: Array<string | null>;
};
export type SheetRowOut = SheetRow & { clamped?: true; omitted?: true };

/** Largest per-cell length whose row still fits; the cells are monotonic in
 *  that length, so this is a plain binary search. */
function clampRow(row: SheetRow, budgetChars: number): SheetRowOut {
  const cut = (chars: number): SheetRowOut => ({
    ...row,
    values: row.values.map((value) =>
      typeof value === "string" ? sliceTextChunk(value, 0, chars).text : value,
    ),
    clamped: true,
  });
  let low = 0;
  let high = Math.max(
    0,
    ...row.values.map((value) =>
      typeof value === "string" ? value.length : 0,
    ),
  );
  let fitted: SheetRowOut | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = cut(middle);
    if (entrySize(candidate) <= budgetChars) {
      fitted = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  // Even empty cells overflow (a very wide row): the row number still has to
  // travel, or the caller can never move past it.
  return fitted ?? { ...row, values: [], omitted: true, clamped: true };
}

/**
 * Keeps whole rows while they fit `budgetChars` and reports how many of the
 * reader's rows that consumed. A first row larger than the whole page comes
 * back with its cells clamped rather than dropped, so a page always advances.
 */
export function assembleRowPage(
  rows: readonly SheetRow[],
  limits: { budgetChars: number },
): { rows: SheetRowOut[]; kept: number; clamped: boolean } {
  let remaining = limits.budgetChars;
  const kept: SheetRowOut[] = [];
  let clamped = false;
  for (const row of rows) {
    const size = entrySize(row);
    if (size <= remaining) {
      kept.push(row);
      remaining -= size;
      continue;
    }
    if (kept.length === 0) {
      kept.push(clampRow(row, remaining));
      clamped = true;
    }
    break;
  }
  return { rows: kept, kept: kept.length, clamped };
}

/** readExcelSheet returns contiguous rows, so a budget cut resumes at the row
 *  after the last one kept; an uncut page hands over to the reader's cursor. */
export function nextSheetPosition(
  rows: readonly { row: number }[],
  kept: number,
  readerNextCursor: string | null,
): string | null {
  if (rows.length === 0) return readerNextCursor;
  if (kept >= rows.length) return readerNextCursor;
  return String(rows[Math.max(kept, 1) - 1]!.row + 1);
}

/**
 * A workbook position is the reader's own `"<sheet>:<row>"` cursor, optionally
 * with the number of rows of that reader page already sent (`_<skip>`).
 * readExcelWorkbook reports no worksheet index per returned sheet and omits
 * empty sheets entirely, so a mid-page cut cannot name the sheet it stopped
 * in; replaying the same deterministic page and skipping what was already sent
 * resumes it exactly instead.
 */
export function parseWorkbookPosition(position: string | undefined): {
  cursor: string;
  skip: number;
} {
  if (position === undefined) return { cursor: "1:1", skip: 0 };
  const match = /^([1-9]\d{0,6}:[1-9]\d{0,8})(?:_(\d{1,9}))?$/.exec(position);
  if (!match) throw invalidCursorError();
  return {
    cursor: match[1]!,
    skip: match[2] === undefined ? 0 : Number(match[2]),
  };
}

export function nextWorkbookPosition(
  page: { cursor: string; skip: number },
  kept: number,
  available: number,
  readerNextCursor: string | null,
): string | null {
  if (available === 0 || kept >= available) return readerNextCursor;
  return `${page.cursor}_${page.skip + Math.max(kept, 1)}`;
}

export const fileCursorInput = z.string().min(1).max(2000).optional();
export const csvOptions = {
  delimiter: z.enum([",", ";", "\t"]).optional(),
  hasHeader: z.boolean().optional(),
};
export type CsvOptions = { delimiter?: "," | ";" | "\t"; hasHeader?: boolean };

export function csvQuery(input: CsvOptions) {
  return {
    delimiter: input.delimiter ?? null,
    hasHeader: input.hasHeader ?? true,
  };
}

export function rejectCsvOptions(input: CsvOptions): void {
  if (input.delimiter !== undefined || input.hasHeader !== undefined)
    throw new ToolError(
      "BAD_REQUEST",
      "delimiter and hasHeader apply only to CSV files",
    );
}

export function completeOutputBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value));
}

import {
  decodeArtifactCursor,
  encodeArtifactCursor,
} from "@weaver/core/services/artifactCursors";
import { z } from "zod";
import { boundItems, defineTool, ToolError } from "../contract";
import {
  artifactEnvelope,
  artifactTarget,
  assembleChapterBlocks,
  assembleRowPage,
  boundHeadCells,
  budgetAfter,
  cursorBinding,
  describeFor,
  headText,
  imageEntries,
  positionIndex,
  readOperation,
  readerImageSchema,
  readerResult,
  wrongFormat,
  type ChapterBlock,
  type SheetRow,
} from "./artifactsShared";
import { cursorInput } from "./snapshotReads";

/** A position no page can reach, so the head is charged for a real cursor. */
const CURSOR_PLACEHOLDER = "999999999";
/** Dropdown options travel with the first page only, so a continuation always
 *  spends its whole budget on rows; a third of one page bounds them. */
const DROPDOWN_BUDGET_SHARE = 3;
/** The header row is repeated on every page, so it may never crowd out the
 *  rows that have to make progress. */
const HEADER_BUDGET_SHARE = 3;
/** A candidate's header row shares the page with up to 24 other candidates. */
const CANDIDATE_HEADER_SHARE = 6;

const wordChapterSchema = z.object({
  chapterId: z.string(),
  title: z.string(),
  level: z.number(),
  blockCount: z.number(),
  nextBlock: z.number().nullable(),
  blocks: z.array(
    z.discriminatedUnion("type", [
      z.object({
        blockId: z.string(),
        type: z.literal("paragraph"),
        kind: z.string(),
        text: z.string(),
        headingLevel: z.number().optional(),
        chapterId: z.string().optional(),
        images: z.array(readerImageSchema).optional(),
        imageWarnings: z.array(z.string()).optional(),
      }),
      z.object({
        blockId: z.string(),
        type: z.literal("table"),
        tableId: z.string(),
        rows: z.number(),
        columns: z.number(),
        values: z.array(z.array(z.string())).optional(),
        imageCount: z.number().optional(),
      }),
    ]),
  ),
});

const BLOCK_ID = z
  .string()
  .regex(/^(p|table)-\d{3,9}$/, "a blockId such as p-065 or table-003");

const wordBlocksSchema = wordChapterSchema
  .omit({ chapterId: true, title: true, level: true })
  .extend({
    startBlockId: z.string(),
    startChapter: z
      .object({ chapterId: z.string(), title: z.string(), level: z.number() })
      .nullable(),
  });

const wordFindTablesSchema = z.object({
  truncated: z.boolean(),
  warnings: z.array(z.string()),
  candidates: z.array(
    z.object({
      tableId: z.string(),
      chapterId: z.string().nullable(),
      chapter: z.object({ title: z.string() }).optional(),
      caption: z.string().nullable(),
      rows: z.number(),
      columns: z.number(),
      dropdownCount: z.number(),
      headerRow: z.array(z.string()).optional(),
      score: z.number(),
      matchReasons: z.array(z.string()),
    }),
  ),
});

const wordTableSchema = z.object({
  tableId: z.string(),
  chapterId: z.string().nullable(),
  header: z.array(z.string()).nullable(),
  rowCount: z.number(),
  columnCount: z.number(),
  rows: z.array(z.array(z.string())),
  nextRow: z.number().nullable(),
  dropdowns: z
    .array(
      z.object({
        controlId: z.string(),
        controlType: z.string(),
        rowIndex: z.number().optional(),
        columnIndex: z.number().optional(),
        alias: z.string().optional(),
        selectedText: z.string(),
        selectedValue: z.string().nullable(),
        placeholderShown: z.boolean(),
        optionCount: z.number(),
        options: z
          .array(z.object({ value: z.string(), displayText: z.string() }))
          .optional(),
      }),
    )
    .optional(),
  images: z
    .array(
      readerImageSchema.extend({
        rowIndex: z.number(),
        columnIndex: z.number(),
      }),
    )
    .optional(),
  imageWarnings: z.array(z.string()).optional(),
});

/** The reader names a table block's size `rows`/`columns`; the page calls them
 *  rowCount/columnCount so they never read as the rows themselves. */
function chapterBlocks(
  artifactId: string,
  result: { blocks: z.infer<typeof wordChapterSchema>["blocks"] },
): ChapterBlock[] {
  return result.blocks.map((block) => {
    if (block.type === "paragraph") {
      const { images, ...rest } = block;
      return images?.length
        ? { ...rest, images: imageEntries(artifactId, images) }
        : rest;
    }
    return {
      blockId: block.blockId,
      type: "table",
      tableId: block.tableId,
      rowCount: block.rows,
      columnCount: block.columns,
      ...(block.values ? { values: block.values } : {}),
      ...(block.imageCount ? { imageCount: block.imageCount } : {}),
    };
  });
}

export const readWordChapterTool = defineTool({
  name: "read_word_chapter",
  kind: "read",
  capability: "content:read",
  description:
    "Reads one Word chapter by a chapterId from get_artifact_overview: paragraphs and tables. Pass nextCursor to continue. includeTables adds cell values; a table too large arrives as a summary for read_word_table. Pictures come as ![alt](weaver-image:…) Markdown; kept in a document, they copy the image.",
  inputSchema: z.object({
    ...artifactTarget,
    chapterId: z.string().min(1).max(40),
    includeTables: z.boolean().default(false),
    includeInstructions: z
      .boolean()
      .default(false)
      .describe("Keeps template guidance paragraphs, which are dropped."),
    cursor: cursorInput,
  }),
  async execute(input, ctx) {
    const { artifact, format } = await describeFor(input, ctx);
    if (format !== "word") throw wrongFormat(format, "read_word_chapter");
    const query = {
      chapterId: input.chapterId,
      includeTables: input.includeTables,
      includeInstructions: input.includeInstructions,
    };
    const from =
      input.cursor === undefined
        ? 0
        : positionIndex(
            decodeArtifactCursor(
              input.cursor,
              cursorBinding("read_word_chapter", artifact, query),
            ),
          );

    // The reader hands back one window of blocks from the cursor, so the
    // page is assembled from index 0 of that window.
    const loaded = await readOperation(
      ctx,
      input,
      "word.chapter",
      {
        chapterId: input.chapterId,
        includeTables: input.includeTables,
        excludeInstructions: !input.includeInstructions,
        fromBlock: from,
      },
      artifact.sha256,
    );
    const result = readerResult(wordChapterSchema, loaded.value);
    const file = artifactEnvelope(loaded.artifact);
    const binding = cursorBinding("read_word_chapter", loaded.artifact, query);
    const head = {
      format,
      chapterId: result.chapterId,
      title: headText(result.title),
      level: result.level,
      blockCount: result.blockCount,
      startIndex: from,
      clamped: false,
      truncated: false,
      hasMore: false,
      nextCursor: encodeArtifactCursor(binding, CURSOR_PLACEHOLDER),
      blocks: [] as unknown[],
    };
    const page = assembleChapterBlocks(
      chapterBlocks(loaded.artifact.id, result),
      0,
      {
        budgetChars: budgetAfter({ artifact: file, result: head }).remaining,
      },
    );
    const nextIndex =
      page.nextIndex === null ? result.nextBlock : from + page.nextIndex;
    const nextCursor =
      nextIndex === null
        ? null
        : encodeArtifactCursor(binding, String(nextIndex));
    return {
      output: {
        artifact: file,
        result: {
          ...head,
          clamped: page.clamped,
          truncated: page.clamped || nextCursor !== null,
          hasMore: nextCursor !== null,
          nextCursor,
          blocks: page.blocks,
        },
      },
    };
  },
});

export const readWordBlocksTool = defineTool({
  name: "read_word_blocks",
  kind: "read",
  capability: "content:read",
  description:
    "Reads Word paragraphs and tables in order from fromBlockId (from search_artifact_text or a read), across chapters. toBlockId ends the range; before adds lead-in blocks. Pass nextCursor to continue. Pictures come as ![alt](weaver-image:…) Markdown; kept in a document, they copy the image.",
  inputSchema: z.object({
    ...artifactTarget,
    fromBlockId: BLOCK_ID,
    toBlockId: BLOCK_ID.optional(),
    before: z.number().int().min(0).max(20).default(0),
    includeTables: z.boolean().default(false),
    includeInstructions: z
      .boolean()
      .default(false)
      .describe("Keeps template guidance paragraphs, which are dropped."),
    cursor: cursorInput,
  }),
  async execute(input, ctx) {
    const { artifact, format } = await describeFor(input, ctx);
    if (format !== "word") throw wrongFormat(format, "read_word_blocks");
    const query = {
      fromBlockId: input.fromBlockId,
      toBlockId: input.toBlockId ?? null,
      before: input.before,
      includeTables: input.includeTables,
      includeInstructions: input.includeInstructions,
    };
    const from =
      input.cursor === undefined
        ? 0
        : positionIndex(
            decodeArtifactCursor(
              input.cursor,
              cursorBinding("read_word_blocks", artifact, query),
            ),
          );
    const loaded = await readOperation(
      ctx,
      input,
      "word.blocks",
      {
        fromBlockId: input.fromBlockId,
        toBlockId: input.toBlockId,
        before: input.before,
        includeTables: input.includeTables,
        excludeInstructions: !input.includeInstructions,
        fromBlock: from,
      },
      artifact.sha256,
    );
    const result = readerResult(wordBlocksSchema, loaded.value);
    const file = artifactEnvelope(loaded.artifact);
    const binding = cursorBinding("read_word_blocks", loaded.artifact, query);
    const head = {
      format,
      startBlockId: result.startBlockId,
      startChapter: result.startChapter
        ? { ...result.startChapter, title: headText(result.startChapter.title) }
        : null,
      blockCount: result.blockCount,
      startIndex: from,
      clamped: false,
      truncated: false,
      hasMore: false,
      nextCursor: encodeArtifactCursor(binding, CURSOR_PLACEHOLDER),
      blocks: [] as unknown[],
    };
    const page = assembleChapterBlocks(
      chapterBlocks(loaded.artifact.id, result),
      0,
      {
        budgetChars: budgetAfter({ artifact: file, result: head }).remaining,
      },
    );
    const nextIndex =
      page.nextIndex === null ? result.nextBlock : from + page.nextIndex;
    const nextCursor =
      nextIndex === null
        ? null
        : encodeArtifactCursor(binding, String(nextIndex));
    return {
      output: {
        artifact: file,
        result: {
          ...head,
          clamped: page.clamped,
          truncated: page.clamped || nextCursor !== null,
          hasMore: nextCursor !== null,
          nextCursor,
          blocks: page.blocks,
        },
      },
    };
  },
});

export const findWordTablesTool = defineTool({
  name: "find_word_tables",
  kind: "read",
  capability: "content:read",
  description:
    "Ranks the tables of a Word file by a text query, a caption number, expected header cells or a chapter title; at least one of the four is required. Each candidate carries the tableId and header row read_word_table needs.",
  inputSchema: z.object({
    ...artifactTarget,
    query: z.string().max(500).optional(),
    captionNumber: z
      .number()
      .int()
      .min(1)
      .max(10_000)
      .optional()
      .describe("The N of a 'Table N:' caption."),
    expectedHeaders: z.array(z.string().max(200)).max(30).optional(),
    chapterTitle: z.string().max(500).optional(),
    maxResults: z.number().int().min(1).max(25).default(10),
  }),
  async execute(input, ctx) {
    const { artifact, format } = await describeFor(input, ctx);
    if (format !== "word") throw wrongFormat(format, "find_word_tables");
    if (
      input.query === undefined &&
      input.captionNumber === undefined &&
      (input.expectedHeaders ?? []).length === 0 &&
      input.chapterTitle === undefined
    )
      throw new ToolError(
        "BAD_REQUEST",
        "find_word_tables needs at least one of query, captionNumber, expectedHeaders or chapterTitle",
      );

    const loaded = await readOperation(
      ctx,
      input,
      "word.findTables",
      {
        query: input.query,
        captionNumber: input.captionNumber,
        expectedHeaders: input.expectedHeaders,
        chapterTitle: input.chapterTitle,
        maxResults: input.maxResults,
      },
      artifact.sha256,
    );
    const result = readerResult(wordFindTablesSchema, loaded.value);
    const file = artifactEnvelope(loaded.artifact);
    const head = { format, truncated: result.truncated };
    const budget = budgetAfter({ artifact: file, result: head });
    const warnings = boundItems(result.warnings, budget);
    const candidates = boundItems(
      result.candidates.map((candidate) => ({
        tableId: candidate.tableId,
        caption:
          candidate.caption === null ? null : headText(candidate.caption),
        chapterId: candidate.chapterId,
        chapterTitle:
          candidate.chapter === undefined
            ? null
            : headText(candidate.chapter.title),
        rows: candidate.rows,
        columns: candidate.columns,
        dropdownCount: candidate.dropdownCount,
        ...(candidate.headerRow
          ? {
              headerRow: boundHeadCells(
                candidate.headerRow,
                CANDIDATE_HEADER_SHARE,
              ).cells,
            }
          : {}),
        score: candidate.score,
        matchReasons: candidate.matchReasons,
      })),
      budget,
    );
    return {
      output: {
        artifact: file,
        result: {
          ...head,
          truncated: result.truncated || candidates.truncated,
          warnings: warnings.items,
          candidates: candidates.items,
        },
      },
    };
  },
});

export const readWordTableTool = defineTool({
  name: "read_word_table",
  kind: "read",
  capability: "content:read",
  description:
    "Reads one Word table by a tableId from get_artifact_overview or find_word_tables, row by row with its header on every page. Pass nextCursor to continue. includeDropdowns adds content-control options to the first page. Pictures in cells are listed under images with row and column.",
  inputSchema: z.object({
    ...artifactTarget,
    tableId: z.string().min(1).max(40),
    includeDropdowns: z.boolean().default(false),
    cursor: cursorInput,
  }),
  async execute(input, ctx) {
    const { artifact, format } = await describeFor(input, ctx);
    if (format !== "word") throw wrongFormat(format, "read_word_table");
    const query = {
      tableId: input.tableId,
      includeDropdowns: input.includeDropdowns,
    };
    // Row 1 is the header, repeated on every page; data rows start at index 1.
    const from =
      input.cursor === undefined
        ? 1
        : positionIndex(
            decodeArtifactCursor(
              input.cursor,
              cursorBinding("read_word_table", artifact, query),
            ),
          );

    // The reader hands back one window of rows from the cursor, with the
    // header row and whole-table counts alongside.
    const loaded = await readOperation(
      ctx,
      input,
      "word.table",
      {
        tableId: input.tableId,
        includeDropdowns: input.includeDropdowns,
        includeHeaderImages: input.cursor === undefined,
        fromRow: from,
      },
      artifact.sha256,
    );
    const result = readerResult(wordTableSchema, loaded.value);
    const file = artifactEnvelope(loaded.artifact);
    const binding = cursorBinding("read_word_table", loaded.artifact, query);
    // The reader knows no header beyond the first row, and a table without
    // rows has none to invent. It is charged to the head of every page, so it
    // is clamped and bounded like any repeated field.
    const header =
      result.header === null
        ? null
        : boundHeadCells(result.header, HEADER_BUDGET_SHARE);
    const dropdownItems =
      input.includeDropdowns && input.cursor === undefined
        ? (result.dropdowns ?? [])
        : null;
    const rows: SheetRow[] = result.rows.map((values, index) => ({
      row: from + index + 1,
      values,
    }));
    const head = {
      format,
      tableId: result.tableId,
      chapterId: result.chapterId,
      rowCount: result.rowCount,
      columnCount: result.columnCount,
      header: header?.cells ?? null,
      headerTruncated: header?.truncated ?? false,
      startRow: rows[0]?.row ?? null,
      clamped: false,
      truncated: false,
      hasMore: false,
      nextCursor: encodeArtifactCursor(binding, CURSOR_PLACEHOLDER),
      ...(dropdownItems ? { dropdownsTruncated: false } : {}),
      ...(result.images?.length ? { imagesTruncated: false } : {}),
      ...(result.imageWarnings?.length
        ? { imageWarnings: result.imageWarnings }
        : {}),
      rows: [] as unknown[],
    };
    const budget = budgetAfter({ artifact: file, result: head });
    const dropdowns =
      dropdownItems === null
        ? null
        : spendShare(budget, DROPDOWN_BUDGET_SHARE, dropdownItems);

    const tableImages = spendShare(
      budget,
      DROPDOWN_BUDGET_SHARE,
      (result.images ?? []).map((image) => ({
        rowIndex: image.rowIndex,
        columnIndex: image.columnIndex,
        ...imageEntries(loaded.artifact.id, [image])[0]!,
      })),
    );

    const page = assembleRowPage(rows, { budgetChars: budget.remaining });
    const nextIndex = from + page.kept;
    const nextCursor =
      nextIndex < result.rowCount
        ? encodeArtifactCursor(binding, String(nextIndex))
        : null;
    return {
      output: {
        artifact: file,
        result: {
          ...head,
          clamped: page.clamped,
          truncated: page.clamped || nextCursor !== null,
          hasMore: nextCursor !== null,
          nextCursor,
          ...(dropdowns
            ? {
                dropdowns: dropdowns.items,
                dropdownsTruncated: dropdowns.truncated,
              }
            : {}),
          ...(result.images?.length
            ? {
                images: tableImages.items,
                imagesTruncated: tableImages.truncated,
              }
            : {}),
          rows: page.rows,
        },
      },
    };
  },
});

/** Bounds a secondary list against a fraction of the page and charges what it
 *  used to the shared budget, so the rows that must make progress keep theirs. */
function spendShare<T>(
  budget: { remaining: number },
  divisor: number,
  items: readonly T[],
): { items: T[]; truncated: boolean } {
  const share = { remaining: Math.floor(budget.remaining / divisor) };
  const allowance = share.remaining;
  const bounded = boundItems(items, share);
  budget.remaining -= allowance - share.remaining;
  return bounded;
}

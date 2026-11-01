import {
  decodeArtifactCursor,
  encodeArtifactCursor,
} from "@weaver/core/services/artifactCursors";
import { artifactFormatOf } from "@weaver/core/artifacts/readerOperations";
import { isCoreError } from "@weaver/core/errors";
import { listArtifacts } from "@weaver/core/services/artifacts";
import { invalidCursorError } from "@weaver/core/services/contentCursors";
import type { ArtifactEnvelope } from "@weaver/core/services/artifactReads";
import { z } from "zod";
import {
  boundItems,
  defineTool,
  newPageBudget,
  requireScope,
  ToolError,
  utf8Prefix,
  type ToolOutcome,
} from "../contract";
import {
  csvOptions,
  rejectCsvOptions,
  artifactEnvelope,
  artifactTarget,
  assemblePdfPages,
  assembleRowPage,
  budgetAfter,
  cellText,
  cursorBinding,
  describeFor,
  headText,
  nextSheetPosition,
  nextWorkbookPosition,
  overviewText,
  parseWorkbookPosition,
  positionIndex,
  readOperation as read,
  readerResult,
  wrongFormat,
  type ArtifactFileOutput,
  type SheetRow,
} from "./artifactsShared";
import { cursorInput, fitTextChunk, textChunkBudget } from "./snapshotReads";
import { notebookOverviewFor, notebookSearchFor } from "./artifactsNotebook";

import { textFamily, textOverviewFor, textSearchFor } from "./artifactsText";
import { csvOverviewFor } from "./artifactsCsv";
import { structuredFor } from "./artifactsStructured";

const LIST_PAGE_SIZE = 25;
const MAX_INFO_ENTRIES = 8;
const MAX_INFO_VALUE_CHARS = 200;
/** The PDF reader's own per-call ceiling; one child spawn per tool call. */
const PDF_READER_MAX_CHARS = 100_000;
/** Room for the `{"truncatedJson":""}` wrapper around a clamped match. */
const JSON_ITEM_SLACK = 32;
/** Widest position an artifact cursor can carry (positionIndex: 9 digits). */
const JSON_CURSOR_PLACEHOLDER = "999999999";

/** `{ titleTruncated: true }` only when the clamp cut something, so an
 *  untouched list item costs no extra bytes. */
function truncationFlag<K extends string>(
  clamped: { truncated: boolean },
  flag: K,
): Partial<Record<K, true>> {
  return (clamped.truncated ? { [flag]: true } : {}) as Partial<
    Record<K, true>
  >;
}

// Reader results arrive as unknown from the child process. These schemas
// declare only the fields the tools use, so @weaver/artifact-readers stays
// out of this package entirely (not even as a type dependency).
const wordOutlineSchema = z.object({
  headingSource: z.enum(["styles", "inferred", "none"]),
  chapters: z.array(
    z.object({
      chapterId: z.string(),
      level: z.number(),
      title: z.string(),
      blockId: z.string().nullable(),
      blockCount: z.number(),
      inferred: z.literal(true).optional(),
    }),
  ),
});
const wordInventorySchema = z.object({
  tables: z.array(
    z.object({
      tableId: z.string(),
      caption: z.string().nullable(),
      chapterPath: z.string().nullable(),
      rows: z.number(),
      columns: z.number(),
      dataRows: z.number(),
    }),
  ),
});
const wordSearchSchema = z.object({
  total: z.number(),
  truncated: z.boolean(),
  matches: z.array(
    z.object({
      location: z.string(),
      snippet: z.string(),
      chapterId: z.string().optional(),
      chapterTitle: z.string().optional(),
      blockId: z.string().optional(),
      tableId: z.string().optional(),
      rowIndex: z.number().optional(),
      columnIndex: z.number().optional(),
      part: z.string().optional(),
    }),
  ),
});
const excelOverviewSchema = z.object({
  sheets: z.array(
    z.object({
      index: z.number(),
      name: z.string(),
      rowCount: z.number(),
      columnCount: z.number(),
      empty: z.boolean(),
      truncated: z.boolean(),
      likelyHeaders: z.object({ values: z.array(z.unknown()) }).nullable(),
    }),
  ),
  omittedSheets: z.array(z.object({ index: z.number(), name: z.string() })),
  truncated: z.boolean(),
  warnings: z.array(z.string()),
});
const pdfSummarySchema = z.object({
  pageCount: z.number(),
  totalChars: z.number(),
  info: z.record(z.string(), z.unknown()),
  pages: z.array(z.object({ page: z.number(), chars: z.number() })),
  warnings: z.array(z.string()),
});
const pdfPagesSchema = z.object({
  pageCount: z.number(),
  truncated: z.boolean(),
  pages: z.array(z.object({ page: z.number(), text: z.string() })),
});
const pdfSearchSchema = z.object({
  total: z.number(),
  truncated: z.boolean(),
  matches: z.array(z.object({ page: z.number(), snippet: z.string() })),
});
const jsonOverviewSchema = z.object({
  sizeBytes: z.number(),
  rootType: z.string(),
  rootCount: z.number().nullable(),
  topLevel: z.array(
    z.object({
      key: z.string(),
      type: z.string(),
      count: z.number().nullable(),
    }),
  ),
});
const jsonQuerySchema = z.object({
  total: z.number(),
  offset: z.number(),
  truncated: z.boolean(),
  items: z.array(z.unknown()),
});

type ArtifactOverviewOutput = {
  artifact: ArtifactFileOutput;
  result:
    | Awaited<ReturnType<typeof textOverviewFor>>["result"]
    | Awaited<ReturnType<typeof csvOverviewFor>>["result"]
    | Awaited<ReturnType<typeof structuredFor>>["result"]
    | Awaited<ReturnType<typeof notebookOverviewFor>>["result"]
    | { readable: false; format: null }
    | {
        readable: true;
        format: "word";
        hint: string;
        chapters: Array<
          Omit<
            z.infer<typeof wordOutlineSchema>["chapters"][number],
            "blockId"
          > & { blockId?: string; titleTruncated?: true }
        >;
        chaptersTruncated: boolean;
        tables: Array<
          z.infer<typeof wordInventorySchema>["tables"][number] & {
            captionTruncated?: true;
          }
        >;
        tablesTruncated: boolean;
      }
    | {
        readable: true;
        format: "excel";
        truncated: boolean;
        warnings: string[];
        warningsTruncated: boolean;
        sheets: Array<{
          index: number;
          name: string;
          nameTruncated?: true;
          rowCount: number;
          columnCount: number;
          empty: boolean;
          truncated: boolean;
          headers: Array<string | null>;
        }>;
        sheetsTruncated: boolean;
        omittedSheetCount: number;
        omittedSheets: Array<
          z.infer<typeof excelOverviewSchema>["omittedSheets"][number] & {
            nameTruncated?: true;
          }
        >;
        omittedSheetsTruncated: boolean;
      }
    | {
        readable: true;
        format: "pdf";
        pageCount: number;
        totalChars: number;
        info: Record<string, string>;
        warnings: string[];
        warningsTruncated: boolean;
        pages: z.infer<typeof pdfSummarySchema>["pages"];
        pagesTruncated: boolean;
      }
    | {
        readable: true;
        format: "json";
        sizeBytes: number;
        rootType: string;
        rootCount: number | null;
        topLevel: Array<
          z.infer<typeof jsonOverviewSchema>["topLevel"][number] & {
            keyTruncated?: true;
          }
        >;
        topLevelTruncated: boolean;
      };
};

export const searchArtifactsTool = defineTool({
  name: "search_artifacts",
  kind: "read",
  capability: "content:read",
  description:
    "Lists the files uploaded to a project (name order, 25 per page, optional filename search). readable means Weaver can read inside it; continue with get_artifact_overview.",
  inputSchema: z.object({
    projectId: z.uuid(),
    query: z.string().max(200).optional().describe("Filename substring."),
    page: z.number().int().min(1).default(1),
  }),
  async execute(input, ctx) {
    requireScope(ctx, input.projectId);
    const result = await listArtifacts(ctx.db, ctx.actor, {
      projectId: input.projectId,
      page: input.page,
      pageSize: LIST_PAGE_SIZE,
      search: input.query,
      sort: "filename",
      dir: "asc",
    });
    const mapped = result.items.map((row) => ({
      id: row.id,
      filename: row.filename,
      contentType: row.contentType,
      byteSize: row.byteSize,
      updatedAt: row.updatedAt.toISOString(),
      readable: artifactFormatOf(row.contentType, row.filename) !== null,
    }));
    const { items, truncated } = boundItems(mapped, newPageBudget());
    return {
      output: { page: result.page, total: result.total, truncated, items },
    };
  },
});

export const getArtifactOverviewTool = defineTool({
  name: "get_artifact_overview",
  kind: "read",
  capability: "content:read",
  description:
    "Start with file structure: native Office/PDF/JSON/OneNote summaries, text lines/Markdown headings, CSV columns or YAML shape. Cursor pages new formats; delimiter/hasHeader apply to CSV. Inspect JSON/YAML before selective queries. OneNote prepares in background.",
  inputSchema: z.object({
    ...artifactTarget,
    ...csvOptions,
    cursor: cursorInput,
  }),
  async execute(input, ctx): Promise<ToolOutcome<ArtifactOverviewOutput>> {
    const { artifact, format } = await describeFor(input, ctx);
    const file = artifactEnvelope(artifact);
    if (format === "csv")
      return { output: await csvOverviewFor(input, ctx, artifact) };
    rejectCsvOptions(input);
    if (format === "text" || format === "markdown")
      return { output: await textOverviewFor(input, ctx, artifact, format) };
    if (format === "yaml")
      return {
        output: await structuredFor(
          { ...input, pointer: "", depth: 1, includeSamples: false, limit: 50 },
          ctx,
          artifact,
          format,
          "get_artifact_overview",
        ),
      };
    if (input.cursor)
      throw new ToolError(
        "BAD_REQUEST",
        "This native overview does not accept cursor; use its format-specific read tool",
      );
    if (format === "onenote")
      return { output: await notebookOverviewFor(ctx, artifact) };
    if (format === null)
      return {
        output: { artifact: file, result: { readable: false, format } },
      };

    if (format === "word") {
      // The readers cap their own lists (5,000 entries) and say so.
      const outline = readerResult(
        wordOutlineSchema.extend({ truncated: z.boolean().optional() }),
        (await read(ctx, input, "word.outline", {}, artifact.sha256)).value,
      );
      const inventory = readerResult(
        wordInventorySchema.extend({ truncated: z.boolean().optional() }),
        (await read(ctx, input, "word.tableInventory", {}, artifact.sha256))
          .value,
      );
      const head = {
        readable: true as const,
        format,
        outlineSource: outline.headingSource,
        hint:
          outline.headingSource === "inferred"
            ? "Chapters are inferred from formatting, not heading styles. Use read_word_chapter for one, read_word_blocks to read from any blockId, find_word_tables to locate a table."
            : "Use read_word_chapter for a chapter, read_word_blocks to read from any blockId, and find_word_tables to locate a table.",
      };
      // One budget for both lists, chapters first: the outline is what a
      // reader needs to ask the next question. Every file-derived string in
      // an item is clamped first, or one long heading would end the list.
      const budget = budgetAfter({ artifact: file, result: head });
      const chapters = boundItems(
        outline.chapters.map((chapter) => {
          const title = overviewText(chapter.title);
          return {
            chapterId: chapter.chapterId,
            level: chapter.level,
            title: title.text,
            ...(chapter.blockId === null ? {} : { blockId: chapter.blockId }),
            blockCount: chapter.blockCount,
            ...(chapter.inferred ? { inferred: true as const } : {}),
            ...truncationFlag(title, "titleTruncated"),
          };
        }),
        budget,
      );
      const tables = boundItems(
        inventory.tables.map((table) => {
          const caption =
            table.caption === null ? null : overviewText(table.caption);
          return {
            ...table,
            caption: caption === null ? null : caption.text,
            chapterPath:
              table.chapterPath === null ? null : headText(table.chapterPath),
            ...(caption === null
              ? {}
              : truncationFlag(caption, "captionTruncated")),
          };
        }),
        budget,
      );
      return {
        output: {
          artifact: file,
          result: {
            ...head,
            chapters: chapters.items,
            chaptersTruncated: chapters.truncated || outline.truncated === true,
            tables: tables.items,
            tablesTruncated: tables.truncated || inventory.truncated === true,
          },
        },
      };
    }

    if (format === "excel") {
      const overview = readerResult(
        excelOverviewSchema,
        (await read(ctx, input, "excel.overview", {}, artifact.sha256)).value,
      );
      const head = {
        readable: true as const,
        format,
        truncated: overview.truncated,
        omittedSheetCount: overview.omittedSheets.length,
      };
      // Every list the reader hands back is unbounded, including the omitted
      // sheets of a workbook with thousands of them; warnings go first because
      // they are short and say why something is missing.
      const budget = budgetAfter({ artifact: file, result: head });
      const warnings = boundItems(overview.warnings.map(headText), budget);
      const sheets = boundItems(
        overview.sheets.map((sheet) => {
          const name = overviewText(sheet.name);
          return {
            index: sheet.index,
            name: name.text,
            ...truncationFlag(name, "nameTruncated"),
            rowCount: sheet.rowCount,
            columnCount: sheet.columnCount,
            empty: sheet.empty,
            truncated: sheet.truncated,
            // Never point-free: map would pass the index as maxChars.
            headers: (sheet.likelyHeaders?.values ?? []).map((value) =>
              cellText(value),
            ),
          };
        }),
        budget,
      );
      const omitted = boundItems(
        overview.omittedSheets.map((sheet) => {
          const name = overviewText(sheet.name);
          return {
            index: sheet.index,
            name: name.text,
            ...truncationFlag(name, "nameTruncated"),
          };
        }),
        budget,
      );
      return {
        output: {
          artifact: file,
          result: {
            ...head,
            warnings: warnings.items,
            warningsTruncated: warnings.truncated,
            sheets: sheets.items,
            sheetsTruncated: sheets.truncated,
            omittedSheets: omitted.items,
            omittedSheetsTruncated: omitted.truncated,
          },
        },
      };
    }

    if (format === "pdf") {
      const summary = readerResult(
        pdfSummarySchema,
        (await read(ctx, input, "pdf.summary", {}, artifact.sha256)).value,
      );
      const head = {
        readable: true as const,
        format,
        pageCount: summary.pageCount,
        totalChars: summary.totalChars,
        info: Object.fromEntries(
          Object.entries(summary.info)
            .slice(0, MAX_INFO_ENTRIES)
            .map(([key, value]) => [
              utf8Prefix(key, MAX_INFO_VALUE_CHARS),
              utf8Prefix(String(value), MAX_INFO_VALUE_CHARS),
            ]),
        ),
      };
      const budget = budgetAfter({ artifact: file, result: head });
      const warnings = boundItems(summary.warnings.map(headText), budget);
      const pages = boundItems(summary.pages, budget);
      return {
        output: {
          artifact: file,
          result: {
            ...head,
            warnings: warnings.items,
            warningsTruncated: warnings.truncated,
            pages: pages.items,
            pagesTruncated: pages.truncated,
          },
        },
      };
    }

    const overview = readerResult(
      jsonOverviewSchema.extend({ truncated: z.boolean().optional() }),
      (await read(ctx, input, "json.overview", {}, artifact.sha256)).value,
    );
    const head = {
      readable: true as const,
      format,
      sizeBytes: overview.sizeBytes,
      rootType: overview.rootType,
      rootCount: overview.rootCount,
    };
    const topLevel = boundItems(
      overview.topLevel.map((entry) => {
        const key = overviewText(entry.key);
        return {
          key: key.text,
          type: entry.type,
          count: entry.count,
          ...truncationFlag(key, "keyTruncated"),
        };
      }),
      budgetAfter({ artifact: file, result: head }),
    );
    return {
      output: {
        artifact: file,
        result: {
          ...head,
          topLevel: topLevel.items,
          topLevelTruncated: topLevel.truncated || overview.truncated === true,
        },
      },
    };
  },
});

export const searchArtifactTextTool = defineTool({
  name: "search_artifact_text",
  kind: "read",
  capability: "content:read",
  description:
    "Finds literal text in Word/PDF/OneNote and TXT/Markdown/YAML/CSV. Text/CSV are case-insensitive, default 25 matches, with cursor; CSV supports delimiter/hasHeader. Native defaults stay 20. Locations enable selective reads; raw recovery uses read_text_artifact.",
  inputSchema: z.object({
    ...artifactTarget,
    query: z.string().min(1).max(200),
    matchCase: z.boolean().default(false),
    limit: z.number().int().min(1).max(100).optional(),
    ...csvOptions,
    cursor: cursorInput,
  }),
  async execute(input, ctx): Promise<ToolOutcome<unknown>> {
    const { artifact, format } = await describeFor(input, ctx);
    if (textFamily(format))
      return { output: await textSearchFor(input, ctx, artifact, format) };
    rejectCsvOptions(input);
    if (input.cursor)
      throw new ToolError(
        "BAD_REQUEST",
        "Native search does not accept cursor; use the format-specific read tool (read_onenote for OneNote search paging)",
      );
    if (format === "onenote")
      return {
        output: await notebookSearchFor(
          ctx,
          artifact,
          input.query,
          input.limit ?? 20,
          input.matchCase,
        ),
      };
    if (format !== "word" && format !== "pdf")
      throw wrongFormat(format, "search_artifact_text");
    const file = artifactEnvelope(artifact);
    const raw = (
      await read(
        ctx,
        input,
        format === "word" ? "word.search" : "pdf.search",
        {
          query: input.query,
          matchCase: input.matchCase,
          limit: input.limit ?? 20,
        },
        artifact.sha256,
      )
    ).value;
    const result =
      format === "word"
        ? readerResult(wordSearchSchema, raw)
        : readerResult(pdfSearchSchema, raw);
    const head = { format, query: input.query, total: result.total };
    const items =
      format === "word"
        ? (result.matches as Array<{ chapterTitle?: string }>).map((match) =>
            match.chapterTitle === undefined
              ? match
              : {
                  ...match,
                  chapterTitle: overviewText(match.chapterTitle).text,
                },
          )
        : result.matches;
    const matches = boundItems<unknown>(
      items,
      budgetAfter({ artifact: file, result: head }),
    );
    return {
      output: {
        artifact: file,
        result: {
          ...head,
          truncated: result.truncated || matches.truncated,
          matches: matches.items,
        },
      },
    };
  },
});

export const queryJsonArtifactTool = defineTool({
  name: "query_json_artifact",
  kind: "read",
  capability: "content:read",
  description:
    "Queries JSON or YAML with existing JSONPath and dotted-field projection. Use inspect_structured_artifact first for paths. Pass nextCursor as cursor; offset starts fresh. Oversized matches use truncatedJson: select deeper paths/fields. Unsupported YAML can be read with read_text_artifact.",
  inputSchema: z.object({
    ...artifactTarget,
    path: z
      .string()
      .min(1)
      .max(8192)
      .refine(
        (value) => Buffer.byteLength(value, "utf8") <= 8192,
        "JSONPath must fit 8192 UTF-8 bytes",
      )
      .describe("JSONPath, at most 8192 UTF-8 bytes, e.g. $.items[*]"),
    fields: z
      .array(z.string().max(200))
      .max(20)
      .optional()
      .describe("Dotted paths to keep from each match."),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: cursorInput,
  }),
  async execute(input, ctx) {
    const { artifact, format } = await describeFor(input, ctx);
    if (format !== "json" && format !== "yaml")
      throw wrongFormat(format, "query_json_artifact");
    const query = { path: input.path, fields: input.fields ?? null };
    const offset = jsonCursorOffset(input, artifact, query);
    const loaded = await read(
      ctx,
      input,
      format === "yaml" ? "yaml.query" : "json.query",
      {
        path: input.path,
        fields: input.fields,
        offset,
        limit: input.limit,
      },
      artifact.sha256,
    );
    const result = readerResult(jsonQuerySchema, loaded.value);
    const file = artifactEnvelope(loaded.artifact);
    const binding = cursorBinding(
      "query_json_artifact",
      loaded.artifact,
      query,
    );
    // Placeholders keep the reserve honest: a real cursor and offset are
    // charged before any item is.
    const head = {
      format,
      path: input.path,
      total: result.total,
      offset: result.offset,
      truncated: true,
      hasMore: true,
      nextOffset: Number(JSON_CURSOR_PLACEHOLDER) as number | null,
      nextCursor: encodeArtifactCursor(binding, JSON_CURSOR_PLACEHOLDER) as
        string | null,
    };
    const page = (
      items: unknown[],
      truncated: boolean,
      next: number | null,
    ) => ({
      output: {
        artifact: file,
        result: {
          ...head,
          truncated,
          nextOffset: next,
          nextCursor:
            next === null ? null : encodeArtifactCursor(binding, String(next)),
          hasMore: next !== null,
          items,
        },
      },
    });
    const budget = budgetAfter({ artifact: file, result: head });
    if (budget.remaining < 128)
      throw new ToolError(
        "BAD_REQUEST",
        "The query path cannot fit this output; select a shorter path or inspect an ancestor pointer.",
      );
    const bounded = boundItems(result.items, budget);
    if (bounded.items.length === 0 && result.items.length > 0) {
      // A page must advance: hand back the first match clamped rather than an
      // empty page that would repeat this offset forever.
      const serialized = JSON.stringify(result.items[0]) ?? "null";
      const { text } = fitTextChunk(
        serialized,
        0,
        serialized.length,
        budget.remaining - JSON_ITEM_SLACK,
      );
      const next = result.offset + 1;
      return page(
        [{ truncatedJson: text }],
        true,
        next < result.total ? next : null,
      );
    }
    const cut = bounded.truncated || result.truncated;
    return page(
      bounded.items,
      cut,
      cut && bounded.items.length > 0
        ? result.offset + bounded.items.length
        : null,
    );
  },
});

function jsonCursorOffset(
  input: { offset?: number; cursor?: string },
  artifact: ArtifactEnvelope,
  query: unknown,
): number {
  if (input.cursor === undefined) return input.offset ?? 0;
  const offset = positionIndex(
    decodeArtifactCursor(
      input.cursor,
      cursorBinding("query_json_artifact", artifact, query),
    ),
  );
  // Cursor wins over a repeated field, but they must agree (concept §4.2).
  if (input.offset !== undefined && input.offset !== offset)
    throw invalidCursorError();
  return offset;
}

function pdfCursorPosition(
  input: { startPage?: number; cursor?: string },
  artifact: ArtifactEnvelope,
  endPage: number | undefined,
): { page: number; charOffset: number } {
  if (input.cursor === undefined)
    return { page: input.startPage ?? 1, charOffset: 0 };
  const position = decodeArtifactCursor(
    input.cursor,
    cursorBinding("read_pdf_pages", artifact, { endPage: endPage ?? null }),
  );
  const match = /^(\d+):(\d+)$/.exec(position);
  if (!match) throw invalidCursorError();
  const page = Number(match[1]);
  // Cursor wins over a repeated field, but they must agree (concept §4.2).
  if (input.startPage !== undefined && input.startPage !== page)
    throw invalidCursorError();
  return { page, charOffset: Number(match[2]) };
}

export const readPdfPagesTool = defineTool({
  name: "read_pdf_pages",
  kind: "read",
  capability: "content:read",
  description:
    "Reads extracted PDF text for a page range (no OCR). Pass nextCursor to continue exactly where the last page stopped; startPage/endPage choose the range. omittedPageTail names a page too long for one read window, whose tail cannot be reached.",
  inputSchema: z.object({
    ...artifactTarget,
    startPage: z.number().int().min(1).optional(),
    endPage: z.number().int().min(1).optional(),
    cursor: cursorInput,
  }),
  async execute(input, ctx) {
    const { artifact, format } = await describeFor(input, ctx);
    if (format !== "pdf") throw wrongFormat(format, "read_pdf_pages");
    const from = pdfCursorPosition(input, artifact, input.endPage);
    const loaded = await read(
      ctx,
      input,
      "pdf.pages",
      {
        startPage: from.page,
        endPage: input.endPage,
        maxChars: PDF_READER_MAX_CHARS,
      },
      artifact.sha256,
    );
    const result = readerResult(pdfPagesSchema, loaded.value);
    const file = artifactEnvelope(loaded.artifact);
    const binding = cursorBinding("read_pdf_pages", loaded.artifact, {
      endPage: input.endPage ?? null,
    });
    const lastPage = Math.min(
      input.endPage ?? result.pageCount,
      result.pageCount,
    );
    const head = {
      format,
      pageCount: result.pageCount,
      startPage: from.page,
      endPage: lastPage,
      omittedPageTail: null as number | null,
      truncated: true,
      hasMore: true,
      nextCursor: encodeArtifactCursor(binding, "999999:999999"),
      pages: [] as Array<{ page: number; text: string }>,
    };
    const { pages, nextPosition, omittedPageTail } = assemblePdfPages(
      result,
      from,
      {
        lastPage,
        budgetChars: textChunkBudget({ artifact: file, result: head }),
        windowChars: PDF_READER_MAX_CHARS,
      },
    );
    const nextCursor =
      nextPosition === null
        ? null
        : encodeArtifactCursor(binding, nextPosition);
    return {
      output: {
        artifact: file,
        result: {
          ...head,
          omittedPageTail,
          pages,
          nextCursor,
          hasMore: nextCursor !== null,
          truncated: nextCursor !== null,
        },
      },
    };
  },
});

const excelRowsSchema = z.object({
  sheetName: z.string(),
  startRow: z.number(),
  endRow: z.number(),
  rows: z.array(
    z.object({ rowNumber: z.number(), values: z.array(z.unknown()) }),
  ),
  nextCursor: z.string().nullable(),
});
const excelWorkbookSchema = z.object({
  sheets: z.array(excelRowsSchema),
  nextCursor: z.string().nullable(),
});

/** One output page holds 240 (three wide text columns) to 960 (four short
 *  ones) cells, measured against assembleRowPage; 600 normally fills a page
 *  without the budget cutting the reader's own page, which the reader's
 *  default of 1,000 would do on most sheets. */
const EXCEL_DEFAULT_MAX_CELLS = 600;
/** Well past one page: a cell this long is clamped by the row paging, which
 *  says so, rather than silently shortened here. */
const SHEET_CELL_CHARS = 20_000;
/** The reader names a worksheet NUMBER, which this tool takes no input for. */
const WIDE_SHEET_HINT =
  "find the sheet's name with get_artifact_overview, then read it with sheetName and a range";

function sheetRows(
  reader: z.infer<typeof excelRowsSchema>,
  sheet?: string,
): SheetRow[] {
  return reader.rows.map((row) => ({
    ...(sheet === undefined ? {} : { sheet: headText(sheet) }),
    row: row.rowNumber,
    values: row.values.map((value) => cellText(value, SHEET_CELL_CHARS)),
  }));
}

/** The reader refuses a sheet no row of which fits maxCells; in workbook form
 *  the caller cannot narrow it without naming the sheet first. The message
 *  match is pinned by artifactTools.spec.ts, since the readers package is not
 *  this package's to change. */
function widerThanPage(error: unknown): boolean {
  return (
    isCoreError(error) &&
    error.code === "BAD_REQUEST" &&
    error.message.includes("columns wide")
  );
}

export const readExcelSheetTool = defineTool({
  name: "read_excel_sheet",
  kind: "read",
  capability: "content:read",
  description:
    "Reads spreadsheet rows: one sheet named with sheetName (optionally narrowed to an A1 range), or every sheet in workbook order when sheetName is omitted. Pass nextCursor to continue; maxCells sizes one read of the file.",
  inputSchema: z.object({
    ...artifactTarget,
    sheetName: z.string().max(31).optional(),
    range: z.string().max(40).optional().describe("A1 notation, e.g. B2:D50."),
    maxCells: z
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(EXCEL_DEFAULT_MAX_CELLS),
    cursor: cursorInput,
  }),
  async execute(input, ctx) {
    const { artifact, format } = await describeFor(input, ctx);
    if (format !== "excel") throw wrongFormat(format, "read_excel_sheet");
    if (input.sheetName === undefined && input.range !== undefined)
      throw new ToolError(
        "BAD_REQUEST",
        "range needs a sheetName; name the sheet you want to read",
      );
    const query = {
      sheetName: input.sheetName ?? null,
      range: input.range ?? null,
      maxCells: input.maxCells,
    };
    const position =
      input.cursor === undefined
        ? undefined
        : decodeArtifactCursor(
            input.cursor,
            cursorBinding("read_excel_sheet", artifact, query),
          );

    // Null for a named sheet, whose cursor is the reader's own row number.
    const workbookPage =
      input.sheetName === undefined ? parseWorkbookPosition(position) : null;
    let loaded;
    try {
      loaded = await read(
        ctx,
        input,
        workbookPage ? "excel.workbook" : "excel.sheet",
        workbookPage
          ? { cursor: workbookPage.cursor, maxCells: input.maxCells }
          : {
              sheetName: input.sheetName,
              range: input.range,
              cursor: position,
              maxCells: input.maxCells,
            },
        artifact.sha256,
      );
    } catch (error) {
      if (workbookPage && widerThanPage(error))
        throw new ToolError(
          "BAD_REQUEST",
          `${(error as Error).message} ${WIDE_SHEET_HINT}.`,
          "PAYLOAD_TOO_LARGE",
        );
      throw error;
    }

    const file = artifactEnvelope(loaded.artifact);
    const binding = cursorBinding("read_excel_sheet", loaded.artifact, query);
    const workbook = workbookPage
      ? readerResult(excelWorkbookSchema, loaded.value)
      : null;
    const sheet = workbook ? null : readerResult(excelRowsSchema, loaded.value);
    const rows =
      workbook && workbookPage
        ? workbook.sheets
            .flatMap((entry) => sheetRows(entry, entry.sheetName))
            .slice(workbookPage.skip)
        : sheetRows(sheet!);
    const readerNext = workbook ? workbook.nextCursor : sheet!.nextCursor;

    const head = {
      format,
      sheetName: sheet === null ? null : headText(sheet.sheetName),
      range: input.range === undefined ? null : headText(input.range),
      startRow: rows[0]?.row ?? null,
      endRow: rows.at(-1)?.row ?? null,
      clamped: false,
      truncated: false,
      hasMore: false,
      nextCursor: encodeArtifactCursor(binding, "999999:999999_999999"),
      rows: [] as unknown[],
    };
    const assembled = assembleRowPage(rows, {
      budgetChars: budgetAfter({ artifact: file, result: head }).remaining,
    });
    const nextPosition = workbookPage
      ? nextWorkbookPosition(
          workbookPage,
          assembled.kept,
          rows.length,
          readerNext,
        )
      : nextSheetPosition(rows, assembled.kept, readerNext);
    const nextCursor =
      nextPosition === null
        ? null
        : encodeArtifactCursor(binding, nextPosition);
    return {
      output: {
        artifact: file,
        result: {
          ...head,
          startRow: assembled.rows[0]?.row ?? null,
          endRow: assembled.rows.at(-1)?.row ?? null,
          clamped: assembled.clamped,
          truncated: assembled.clamped || nextCursor !== null,
          hasMore: nextCursor !== null,
          nextCursor,
          rows: assembled.rows,
        },
      },
    };
  },
});

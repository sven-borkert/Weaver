import {
  decodeArtifactCursor,
  encodeArtifactCursor,
} from "@weaver/core/services/artifactCursors";
import type { ArtifactEnvelope } from "@weaver/core/services/artifactReads";
import { invalidCursorError } from "@weaver/core/services/contentCursors";
import { z } from "zod";
import {
  defineTool,
  MAX_TOOL_OUTPUT_CHARS,
  ToolError,
  type ToolContext,
} from "../contract";
import {
  artifactTarget,
  artifactEnvelope,
  completeOutputBytes,
  csvOptions,
  csvQuery,
  cursorBinding,
  describeFor,
  fileCursorInput,
  readOperation,
  readerResult,
  wrongFormat,
  type ArtifactInput,
  type CsvOptions,
} from "./artifactsShared";
import { fitTextChunk } from "./snapshotReads";

const columnSchema = z.object({
  index: z.number(),
  name: z.string(),
  nameTruncated: z.boolean(),
});
const cellSchema = z.object({
  index: z.number(),
  value: z.string(),
  truncated: z.boolean(),
});
const rowSchema = z.object({
  row: z.number(),
  startLine: z.number(),
  endLine: z.number(),
  width: z.number(),
  cells: z.array(cellSchema),
  omittedCellCount: z.number(),
});
const overviewSchema = z.object({
  delimiter: z.enum([",", ";", "\t"]),
  hasHeader: z.boolean(),
  rowCount: z.number(),
  columnCount: z.number(),
  columns: z.array(columnSchema),
  irregularRowCount: z.number(),
  nextOffset: z.number().nullable(),
});
const rowsSchema = overviewSchema
  .omit({ irregularRowCount: true, nextOffset: true })
  .extend({
    omittedColumnCount: z.number(),
    rows: z.array(rowSchema),
    nextRow: z.number().nullable(),
  });
export const csvPositionSchema = z.object({
  row: z.number().int().positive(),
  column: z.number().int().nonnegative(),
  charOffset: z.number().int().nonnegative(),
});
export const csvSearchSchema = z.object({
  matches: z.array(
    csvPositionSchema.extend({
      snippet: z.string(),
      startLine: z.number(),
      endLine: z.number(),
    }),
  ),
  nextPosition: csvPositionSchema.nullable(),
});
export function csvPositionString(position: z.infer<typeof csvPositionSchema>) {
  return `${position.row}:${position.column}:${position.charOffset}`;
}
export function parseCsvPosition(position: string) {
  if (!/^\d{1,12}:\d{1,12}:\d{1,12}$/.test(position))
    throw invalidCursorError();
  const [row, column, charOffset] = position.split(":").map(Number);
  const parsed = csvPositionSchema.safeParse({ row, column, charOffset });
  if (!parsed.success) throw invalidCursorError();
  return parsed.data;
}

export async function csvOverviewFor(
  input: ArtifactInput & CsvOptions & { cursor?: string },
  ctx: ToolContext,
  artifact: ArtifactEnvelope,
) {
  const binding = cursorBinding(
    "get_artifact_overview",
    artifact,
    csvQuery(input),
  );
  const offset = input.cursor
    ? Number(decodeArtifactCursor(input.cursor, binding))
    : 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw invalidCursorError();
  const result = readerResult(
    overviewSchema,
    (
      await readOperation(
        ctx,
        input,
        "csv.overview",
        { ...csvQuery(input), delimiter: input.delimiter, offset },
        artifact.sha256,
      )
    ).value,
  );
  const file = artifactEnvelope(artifact);
  const page = (
    columns: z.infer<typeof columnSchema>[],
    next: number | null,
  ) => ({
    artifact: file,
    result: {
      ...result,
      readable: true,
      format: "csv",
      columns,
      nextOffset: next,
      nextCursor:
        next === null ? null : encodeArtifactCursor(binding, String(next)),
    },
  });
  const columns: z.infer<typeof columnSchema>[] = [];
  for (const column of result.columns) {
    if (
      completeOutputBytes(
        page([...columns, column], offset + columns.length + 1),
      ) > MAX_TOOL_OUTPUT_CHARS
    )
      break;
    columns.push(column);
  }
  if (result.columns.length && !columns.length)
    throw new ToolError(
      "BAD_REQUEST",
      "CSV metadata cannot fit; select columns with read_csv_artifact",
    );
  return page(
    columns,
    columns.length < result.columns.length
      ? offset + columns.length
      : result.nextOffset,
  );
}

export const readCsvArtifactTool = defineTool({
  name: "read_csv_artifact",
  kind: "read",
  capability: "content:read",
  description:
    "Reads original CSV string rows and zero-based columns (including duplicate/empty headers). Start with overview. Cursor resumes at the next data row; repeated startRow must agree. Truncated cells/omitted cells include source lines for recovery with read_text_artifact.",
  inputSchema: z.object({
    ...artifactTarget,
    ...csvOptions,
    startRow: z.number().int().positive().optional(),
    columns: z.array(z.number().int().nonnegative()).max(200).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: fileCursorInput,
  }),
  async execute(input, ctx) {
    const { artifact, format } = await describeFor(input, ctx);
    if (format !== "csv") throw wrongFormat(format, "read_csv_artifact");
    const binding = cursorBinding("read_csv_artifact", artifact, {
      ...csvQuery(input),
      columns: input.columns ?? null,
    });
    const startRow = input.cursor
      ? Number(decodeArtifactCursor(input.cursor, binding))
      : (input.startRow ?? 1);
    if (
      !Number.isSafeInteger(startRow) ||
      startRow < 1 ||
      (input.cursor &&
        input.startRow !== undefined &&
        input.startRow !== startRow)
    )
      throw invalidCursorError();
    const result = readerResult(
      rowsSchema,
      (
        await readOperation(
          ctx,
          input,
          "csv.rows",
          { ...input, startRow },
          artifact.sha256,
        )
      ).value,
    );
    const file = artifactEnvelope(artifact);
    const columns: z.infer<typeof columnSchema>[] = [];
    for (const column of result.columns) {
      if (completeOutputBytes([...columns, column]) > 2000) break;
      columns.push(column);
    }
    const page = (rows: z.infer<typeof rowSchema>[], next: number | null) => ({
      artifact: file,
      result: {
        ...result,
        format,
        columns,
        omittedColumnCount:
          result.omittedColumnCount + result.columns.length - columns.length,
        rows,
        nextRow: next,
        nextCursor:
          next === null ? null : encodeArtifactCursor(binding, String(next)),
        hint: "Use read_text_artifact with source startLine/endLine to recover truncated or omitted cells.",
      },
    });
    const rows: z.infer<typeof rowSchema>[] = [];
    for (const row of result.rows) {
      if (
        completeOutputBytes(page([...rows, row], row.row + 1)) <=
        MAX_TOOL_OUTPUT_CHARS
      ) {
        rows.push(row);
        continue;
      }
      if (rows.length) break;
      const clipped = {
        ...row,
        cells: [] as z.infer<typeof cellSchema>[],
        omittedCellCount: row.width,
      };
      for (const cell of row.cells) {
        const trial = {
          ...clipped,
          cells: [...clipped.cells, cell],
          omittedCellCount: row.width - clipped.cells.length - 1,
        };
        if (
          completeOutputBytes(page([trial], row.row + 1)) <=
          MAX_TOOL_OUTPUT_CHARS
        ) {
          clipped.cells.push(cell);
          clipped.omittedCellCount--;
          continue;
        }
        const blank = {
          ...trial,
          cells: [...clipped.cells, { ...cell, value: "", truncated: true }],
        };
        const remaining =
          MAX_TOOL_OUTPUT_CHARS -
          completeOutputBytes(page([blank], row.row + 1));
        if (remaining >= 8) {
          const text = fitTextChunk(
            cell.value,
            0,
            cell.value.length,
            remaining,
          ).text;
          clipped.cells.push({ ...cell, value: text, truncated: true });
          clipped.omittedCellCount--;
        }
        break;
      }
      rows.push(clipped);
      break;
    }
    const next =
      rows.length < result.rows.length
        ? result.rows[rows.length]!.row
        : result.nextRow;
    return { output: page(rows, next) };
  },
});

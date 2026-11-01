import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@weaver/db/client";
import { titleFromFileName } from "../documents/importMarkdown";
import { CoreError } from "../errors";
import {
  coerceCsvCell,
  columnNamesFromHeader,
  CsvError,
  inferColumnType,
  type InferredColumnType,
  parseCsv,
} from "../tables/csv";
import type { CellValue, TableColumn, TableRow } from "../tables/types";
import { MAX_TABLE_COLUMNS } from "../tables/validation";
import type { EnrichedActor } from "./documents";
import {
  createTable,
  MAX_DATA_FILE_BYTES,
  MAX_TABLE_ROWS,
  type TableWriteResult,
} from "./tables";

const MAX_COLUMN_NAME_LENGTH = 100;
const DEDUPE_SUFFIX_HEADROOM = 6;

export async function importCsvTable(
  db: PrismaClient,
  input: {
    projectId: string;
    folderPath: string[];
    fileName: string;
    content: string;
  },
  actor: EnrichedActor,
): Promise<TableWriteResult> {
  if (Buffer.byteLength(input.content, "utf8") > MAX_DATA_FILE_BYTES)
    throw new CoreError(
      "PRECONDITION_FAILED",
      "The file exceeds the 5 MB table data limit",
    );
  let parsed;
  try {
    parsed = parseCsv(input.content, {
      preferredDelimiter: /\.tsv$/i.test(input.fileName) ? "\t" : undefined,
    });
  } catch (error) {
    if (error instanceof CsvError)
      throw new CoreError(
        "BAD_REQUEST",
        `The file is not valid CSV: ${error.message}`,
        { field: "content" },
      );
    throw error;
  }
  if (parsed.header.length === 0 || parsed.header.every((h) => h.trim() === ""))
    throw new CoreError("BAD_REQUEST", "The file has no header row", {
      field: "content",
    });
  if (parsed.header.length > MAX_TABLE_COLUMNS)
    throw new CoreError(
      "PRECONDITION_FAILED",
      `The file has ${parsed.header.length} columns; the limit is ${MAX_TABLE_COLUMNS}`,
    );
  if (parsed.rows.length > MAX_TABLE_ROWS)
    throw new CoreError(
      "PRECONDITION_FAILED",
      `The file has ${parsed.rows.length} rows; the limit is ${MAX_TABLE_ROWS}`,
    );
  // Quoted multi-line headers can carry line/paragraph separators or NUL; flatten them
  // to spaces the same way the title is sanitized below.
  const sanitizedHeader = parsed.header.map((h) =>
    h.replace(/[\r\n\u2028\u2029\u0000]+/g, " "),
  );
  // Leave room for the dedupe suffix (up to " (100)") so deduped names still fit the cap.
  const truncatedHeader = sanitizedHeader.map((h) =>
    h.slice(0, MAX_COLUMN_NAME_LENGTH - DEDUPE_SUFFIX_HEADROOM),
  );
  const names = columnNamesFromHeader(truncatedHeader);
  const columns: TableColumn[] = names.map((name, index) => ({
    id: randomUUID(),
    name,
    type: inferColumnType(parsed.rows.map((row) => row[index] ?? "")),
  }));
  const rows: TableRow[] = parsed.rows.map((raw) => {
    const cells: Record<string, CellValue> = {};
    columns.forEach((column, index) => {
      const value = coerceCsvCell(
        raw[index] ?? "",
        column.type as InferredColumnType,
      );
      if (value !== undefined) cells[column.id] = value;
    });
    return { id: randomUUID(), cells };
  });
  const title =
    titleFromFileName(input.fileName)
      .replace(/[\r\n\u2028\u2029\u0000]+/g, " ")
      .trim() || "Imported table";
  return createTable(
    db,
    {
      projectId: input.projectId,
      folderPath: input.folderPath,
      title,
      columns,
      rows,
    },
    actor,
  );
}

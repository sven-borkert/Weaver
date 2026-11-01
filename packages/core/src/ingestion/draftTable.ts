import { serializedRowBytes } from "../tables/jsonl";
import type { CellValue } from "../tables/types";
import { MAX_DATA_FILE_BYTES } from "../tables/validation";
import { parseDraftCell } from "./columnTypes";
import {
  MAX_DRAFT_TABLE_CELL_CHARS,
  MAX_DRAFT_TABLE_COLUMN_NAME_CHARS,
  MAX_DRAFT_TABLE_COLUMNS,
  MAX_DRAFT_TABLE_ROWS,
} from "./limits";

export const DRAFT_COLUMN_TYPES = [
  "text",
  "number",
  "boolean",
  "date",
] as const;
export type DraftColumnType = (typeof DRAFT_COLUMN_TYPES)[number];
export type DraftTableColumn = { name: string; type: DraftColumnType };

function megabytes(bytes: number): string {
  return (Math.ceil(bytes / 100_000) / 10).toFixed(1);
}

/** Returns a user-facing reason when a parsed table cannot become a draft. */
export function draftTableIssue(
  columns: DraftTableColumn[],
  rows: string[][],
): string | null {
  if (columns.length === 0) return "a table draft needs at least one column";
  if (columns.length > MAX_DRAFT_TABLE_COLUMNS) {
    return `a table draft may have at most ${MAX_DRAFT_TABLE_COLUMNS} columns`;
  }
  const names = new Set<string>();
  for (const column of columns) {
    if (!DRAFT_COLUMN_TYPES.includes(column.type))
      return "table draft columns must be text, number, boolean, or date columns";
    if (
      column.name.length === 0 ||
      column.name !== column.name.trim() ||
      column.name.length > MAX_DRAFT_TABLE_COLUMN_NAME_CHARS
    ) {
      return `table draft column names must be trimmed and at most ${MAX_DRAFT_TABLE_COLUMN_NAME_CHARS} characters`;
    }
    if (names.has(column.name)) return `duplicate column name ${column.name}`;
    names.add(column.name);
  }
  if (rows.length > MAX_DRAFT_TABLE_ROWS) {
    return `a table draft may have at most ${MAX_DRAFT_TABLE_ROWS} rows`;
  }
  let bytes = 0;
  for (const row of rows) {
    if (row.length !== columns.length) {
      return "every table draft row must match the column count";
    }
    const stored: CellValue[] = [];
    for (const [index, cell] of row.entries()) {
      if (cell.length > MAX_DRAFT_TABLE_CELL_CHARS) {
        return `cell text exceeds ${MAX_DRAFT_TABLE_CELL_CHARS} characters`;
      }
      // a failed parse counts as its text; columnTypeIssue reports it
      const parsed = parseDraftCell(cell, columns[index]!.type);
      if (!parsed.ok) stored.push(cell);
      else if (parsed.value !== null) stored.push(parsed.value);
    }
    bytes += serializedRowBytes(stored);
  }
  if (bytes > MAX_DATA_FILE_BYTES) {
    return `the table would take ${megabytes(bytes)} MB once stored, above the ${megabytes(MAX_DATA_FILE_BYTES)} MB limit; split the sheet or remove columns, then upload again`;
  }
  return null;
}

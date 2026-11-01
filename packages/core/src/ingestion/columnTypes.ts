import { isRoundTrippingNumber, isValidIsoDate } from "../tables/validation";
import type { DraftColumnType, DraftTableColumn } from "./draftTable";

export type DraftCellValue = string | number | boolean;
export type ParsedDraftCell =
  { ok: true; value: DraftCellValue | null } | { ok: false };

const INFERENCE_ORDER = ["number", "boolean", "date"] as const;

/** Text keeps the raw string; an empty typed cell becomes null and is omitted at accept. */
export function parseDraftCell(
  text: string,
  type: DraftColumnType,
): ParsedDraftCell {
  if (type === "text") return { ok: true, value: text };
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  switch (type) {
    case "number": {
      if (!isRoundTrippingNumber(trimmed)) return { ok: false };
      return { ok: true, value: Number(trimmed) };
    }
    case "boolean": {
      const lower = trimmed.toLowerCase();
      if (lower === "true") return { ok: true, value: true };
      if (lower === "false") return { ok: true, value: false };
      return { ok: false };
    }
    case "date":
      return isValidIsoDate(trimmed)
        ? { ok: true, value: trimmed }
        : { ok: false };
  }
}

export function inferColumnTypes(
  columns: DraftTableColumn[],
  rows: string[][],
): DraftTableColumn[] {
  return columns.map((column, index) => {
    const cells = rows
      .map((row) => row[index] ?? "")
      .filter((cell) => cell.trim().length > 0);
    const type =
      cells.length === 0
        ? "text"
        : (INFERENCE_ORDER.find((candidate) =>
            cells.every((cell) => parseDraftCell(cell, candidate).ok),
          ) ?? "text");
    return { name: column.name, type };
  });
}

export type ColumnTypeIssue = { column: string; row: number; value: string };

/** First cell the column's type cannot represent; null when every row converts. */
export function columnTypeIssue(
  columns: DraftTableColumn[],
  rows: string[][],
): ColumnTypeIssue | null {
  for (const [rowIndex, row] of rows.entries()) {
    for (const [columnIndex, column] of columns.entries()) {
      const value = row[columnIndex] ?? "";
      if (!parseDraftCell(value, column.type).ok) {
        return {
          column: column.name,
          row: rowIndex + 1,
          value: value.slice(0, 40),
        };
      }
    }
  }
  return null;
}

import { draftTableIssue } from "@weaver/core/ingestion/draftTable";
import { MAX_DRAFT_TABLE_COLUMN_NAME_CHARS } from "@weaver/core/ingestion/limits";
import type { ParsedTable, ParseFailure } from "../parser";

function columnNames(header: string[]): string[] {
  const seen = new Set<string>();
  const nextSuffix = new Map<string, number>();
  return header.map((raw, index) => {
    const base =
      raw.trim().slice(0, MAX_DRAFT_TABLE_COLUMN_NAME_CHARS).trim() ||
      `Column ${index + 1}`;
    let name = base;
    for (let count = nextSuffix.get(base) ?? 2; seen.has(name); count += 1) {
      const suffix = ` (${count})`;
      name = `${base.slice(0, MAX_DRAFT_TABLE_COLUMN_NAME_CHARS - suffix.length).trimEnd()}${suffix}`;
      nextSuffix.set(base, count + 1);
    }
    seen.add(name);
    return name;
  });
}

function usedWidth(row: string[]): number {
  let width = row.length;
  while (width > 0 && row[width - 1]!.trim().length === 0) width -= 1;
  return width;
}

/** One aggregated note for data rows wider than the header; rows count from the header as row 1. */
export function headerOverflowWarning(rows: string[][]): string | null {
  const [header, ...data] = rows;
  if (!header) return null;
  let count = 0;
  let first = 0;
  for (const [index, row] of data.entries()) {
    if (usedWidth(row) <= header.length) continue;
    if (count === 0) first = index + 2;
    count += 1;
  }
  if (count === 0) return null;
  return `${count} row${count === 1 ? " had" : "s had"} more cells than the header; the extra values were kept in generated columns (first: row ${first})`;
}

/** First row is the header; wider data rows add generated columns, shorter ones are padded. */
export function tableFromRows(
  rows: string[][],
  name: string | null,
): ParsedTable | ParseFailure {
  const [header, ...data] = rows;
  if (!header || header.length === 0) {
    return {
      failureKind: "validation",
      message: "the spreadsheet contains no data",
    };
  }
  const width = data.reduce(
    (widest, row) => Math.max(widest, usedWidth(row)),
    header.length,
  );
  const columns = columnNames([
    ...header,
    ...Array<string>(width - header.length).fill(""),
  ]);
  const body = data.map((row) =>
    Array.from({ length: columns.length }, (_, index) => row[index] ?? ""),
  );
  const issue = draftTableIssue(
    columns.map((column) => ({ name: column, type: "text" as const })),
    body,
  );
  if (issue) return { failureKind: "validation", message: issue };
  return { name, columns, rows: body };
}

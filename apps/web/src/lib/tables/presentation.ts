import type { MergeConflict } from "@weaver/core/tables/merge";
import type { TableDiff } from "@weaver/core/tables/diff";
import type {
  ColumnType,
  TableColumn,
  TableRow,
} from "@weaver/core/tables/types";
import { CANONICAL_UUID_RE } from "@weaver/core/tables/validation";

import { formatDateTimeCell } from "./datetime";

export type ConflictSection = {
  kind: "title" | "columns" | "rows" | "cells";
  heading: string;
  items: string[];
};

export type TableDiffSection = {
  kind: "title" | "columns" | "rows" | "cells";
  heading: string;
  items: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMergeConflict(value: unknown): value is MergeConflict {
  if (!isRecord(value)) return false;

  switch (value.kind) {
    case "title":
      return true;
    case "column":
      return (
        typeof value.columnId === "string" &&
        CANONICAL_UUID_RE.test(value.columnId)
      );
    case "row":
      return (
        typeof value.rowId === "string" && CANONICAL_UUID_RE.test(value.rowId)
      );
    case "cell":
      return (
        typeof value.rowId === "string" &&
        CANONICAL_UUID_RE.test(value.rowId) &&
        typeof value.columnId === "string" &&
        CANONICAL_UUID_RE.test(value.columnId)
      );
    default:
      return false;
  }
}

export function parseTableConflicts(value: unknown): MergeConflict[] | null {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every(isMergeConflict)
    ? value
    : null;
}

function shortId(id: string): string {
  return id.slice(0, 7);
}

const DIFF_TEXT_MAX_CHARS = 120;

/** Truncates a possibly-long diff cell to its first line, then a char cap. */
function truncateDiffText(
  value: string,
  maxChars = DIFF_TEXT_MAX_CHARS,
): string {
  const firstLine = value.split("\n")[0] ?? "";
  const truncatedToLine = firstLine.length < value.length;
  const capped =
    firstLine.length > maxChars ? firstLine.slice(0, maxChars) : firstLine;
  const truncated = truncatedToLine || capped.length < firstLine.length;
  return truncated ? `${capped}…` : capped;
}

function columnLabel(
  columnId: string,
  columns: readonly TableColumn[],
): string {
  return (
    columns.find((column) => column.id === columnId)?.name ??
    `Column ${shortId(columnId)}`
  );
}

function rowLabel(rowId: string, rows: readonly TableRow[]): string {
  const index = rows.findIndex((row) => row.id === rowId);
  return index === -1 ? `Row ${shortId(rowId)}` : `Row ${index + 1}`;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled table conflict: ${JSON.stringify(value)}`);
}

export function presentTableConflicts(
  conflicts: readonly MergeConflict[],
  columns: readonly TableColumn[],
  rows: readonly TableRow[],
): ConflictSection[] {
  const sections: Record<ConflictSection["kind"], string[]> = {
    title: [],
    columns: [],
    rows: [],
    cells: [],
  };

  for (const conflict of conflicts) {
    switch (conflict.kind) {
      case "title":
        sections.title.push("Title changed in both versions");
        break;
      case "column":
        sections.columns.push(
          `${columnLabel(conflict.columnId, columns)} changed in both versions`,
        );
        break;
      case "row":
        sections.rows.push(
          `${rowLabel(conflict.rowId, rows)} changed in both versions`,
        );
        break;
      case "cell":
        sections.cells.push(
          `${rowLabel(conflict.rowId, rows)} · ${columnLabel(conflict.columnId, columns)}`,
        );
        break;
      default:
        assertNever(conflict);
    }
  }

  const presented: ConflictSection[] = [
    { kind: "title", heading: "Title", items: sections.title },
    { kind: "columns", heading: "Columns", items: sections.columns },
    { kind: "rows", heading: "Rows", items: sections.rows },
    { kind: "cells", heading: "Cells", items: sections.cells },
  ];
  return presented.filter((section) => section.items.length > 0);
}

export function formatDiffCellValue(
  value: string | number | boolean | string[] | null,
  column: TableColumn | undefined,
  type: ColumnType | undefined = column?.type,
): string {
  if (value === null) return "Empty";
  if (Array.isArray(value)) {
    return value
      .map(
        (id) =>
          column?.options?.find((option) => option.id === id)?.label ?? id,
      )
      .join(", ");
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (type === "datetime" && typeof value === "string") {
    return formatDateTimeCell(value);
  }
  if ((type === "longtext" || type === "url") && typeof value === "string") {
    return truncateDiffText(value);
  }
  if (type === "select" && typeof value === "string") {
    return (
      column?.options?.find((option) => option.id === value)?.label ??
      `Option ${shortId(value)}`
    );
  }
  if (type === "document" && typeof value === "string") {
    return `Document ${shortId(value)}`;
  }
  return String(value);
}

export function presentTableDiff(
  diff: TableDiff,
  columns: readonly TableColumn[],
): TableDiffSection[] {
  const removedColumns = diff.columnChanges.flatMap((change) =>
    change.kind === "removed" ? [change.column] : [],
  );
  const displayColumns = [...columns];
  const knownColumnIds = new Set(columns.map((column) => column.id));
  for (const column of removedColumns) {
    if (!knownColumnIds.has(column.id)) displayColumns.push(column);
  }
  const columnById = new Map(
    displayColumns.map((column) => [column.id, column]),
  );
  const retypeByColumnId = new Map(
    diff.columnChanges.flatMap((change) =>
      change.kind === "retyped"
        ? [[change.columnId, { from: change.from, to: change.to }] as const]
        : [],
    ),
  );
  const titleItems = diff.titleChange
    ? [`${diff.titleChange.from} → ${diff.titleChange.to}`]
    : [];
  const columnItems = diff.columnChanges.map((change) => {
    switch (change.kind) {
      case "added":
        return `Added ${change.column.name} (${change.column.type})`;
      case "removed":
        return `Removed ${change.column.name} (${change.column.type})`;
      case "renamed":
        return `Renamed ${change.from} → ${change.to}`;
      case "retyped":
        return `Retyped ${columnLabel(change.columnId, displayColumns)}: ${change.from} → ${change.to}`;
      case "options":
        return `Options changed for ${columnLabel(change.columnId, displayColumns)}`;
      default:
        return assertNever(change);
    }
  });
  if (diff.columnsReordered) columnItems.push("Column order changed");
  const rowItems = [
    ...diff.addedRows.map((rowId) => `Added Row ${shortId(rowId)}`),
    ...diff.removedRows.map((rowId) => `Removed Row ${shortId(rowId)}`),
    ...(diff.rowsReordered ? ["Row order changed"] : []),
  ];
  const cellItems = diff.changedCells.map((change) => {
    const column = columnById.get(change.columnId);
    const retype = retypeByColumnId.get(change.columnId);
    return `Row ${shortId(change.rowId)} · ${columnLabel(change.columnId, displayColumns)}: ${formatDiffCellValue(change.from, column, retype?.from)} → ${formatDiffCellValue(change.to, column, retype?.to)}`;
  });

  return [
    { kind: "title" as const, heading: "Title", items: titleItems },
    { kind: "columns" as const, heading: "Columns", items: columnItems },
    { kind: "rows" as const, heading: "Rows", items: rowItems },
    { kind: "cells" as const, heading: "Cells", items: cellItems },
  ].filter((section) => section.items.length > 0);
}

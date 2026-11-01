import { cellValuesEqual } from "./cellValues";
import type { CellValue, ColumnType, TableColumn, TableData } from "./types";

export type ColumnChange =
  | { kind: "added"; column: TableColumn }
  | { kind: "removed"; column: TableColumn }
  | { kind: "renamed"; columnId: string; from: string; to: string }
  | { kind: "retyped"; columnId: string; from: ColumnType; to: ColumnType }
  | { kind: "options"; columnId: string };

export type CellChange = {
  rowId: string;
  columnId: string;
  from: CellValue | null;
  to: CellValue | null;
};

export type TableDiff = {
  titleChange: { from: string; to: string } | null;
  columnChanges: ColumnChange[];
  columnsReordered: boolean;
  rowsReordered: boolean;
  addedRows: string[];
  removedRows: string[];
  changedCells: CellChange[];
};

function optionsEqual(a: TableColumn, b: TableColumn): boolean {
  return (
    JSON.stringify(a.options ?? null) === JSON.stringify(b.options ?? null)
  );
}

// Compares the relative order of the ids both versions share.
function sharedOrderDiffers(
  from: readonly { id: string }[],
  to: readonly { id: string }[],
): boolean {
  const toIds = new Set(to.map((entry) => entry.id));
  const fromIds = new Set(from.map((entry) => entry.id));
  const before = from.filter((entry) => toIds.has(entry.id));
  const after = to.filter((entry) => fromIds.has(entry.id));
  return before.some((entry, index) => entry.id !== after[index]?.id);
}

export function diffTables(from: TableData, to: TableData): TableDiff {
  const fromColumns = new Map(
    from.columns.map((column) => [column.id, column]),
  );
  const toColumns = new Map(to.columns.map((column) => [column.id, column]));
  const columnChanges: ColumnChange[] = [];

  for (const column of to.columns) {
    const before = fromColumns.get(column.id);
    if (!before) {
      columnChanges.push({ kind: "added", column });
      continue;
    }
    if (before.name !== column.name) {
      columnChanges.push({
        kind: "renamed",
        columnId: column.id,
        from: before.name,
        to: column.name,
      });
    }
    if (before.type !== column.type) {
      columnChanges.push({
        kind: "retyped",
        columnId: column.id,
        from: before.type,
        to: column.type,
      });
    } else if (!optionsEqual(before, column)) {
      columnChanges.push({ kind: "options", columnId: column.id });
    }
  }
  for (const column of from.columns) {
    if (!toColumns.has(column.id)) {
      columnChanges.push({ kind: "removed", column });
    }
  }

  const fromRows = new Map(from.rows.map((row) => [row.id, row]));
  const toRows = new Map(to.rows.map((row) => [row.id, row]));
  const addedRows = to.rows
    .filter((row) => !fromRows.has(row.id))
    .map((row) => row.id);
  const removedRows = from.rows
    .filter((row) => !toRows.has(row.id))
    .map((row) => row.id);

  const changedCells: CellChange[] = [];
  for (const row of to.rows) {
    const before = fromRows.get(row.id);
    if (!before) continue;
    const columnIds = new Set([
      ...Object.keys(before.cells),
      ...Object.keys(row.cells),
    ]);
    for (const columnId of columnIds) {
      const beforeValue = before.cells[columnId] ?? null;
      const afterValue = row.cells[columnId] ?? null;
      if (!cellValuesEqual(beforeValue ?? undefined, afterValue ?? undefined)) {
        changedCells.push({
          rowId: row.id,
          columnId,
          from: beforeValue,
          to: afterValue,
        });
      }
    }
  }

  return {
    titleChange:
      from.title === to.title ? null : { from: from.title, to: to.title },
    columnChanges,
    columnsReordered: sharedOrderDiffers(from.columns, to.columns),
    rowsReordered: sharedOrderDiffers(from.rows, to.rows),
    addedRows,
    removedRows,
    changedCells,
  };
}

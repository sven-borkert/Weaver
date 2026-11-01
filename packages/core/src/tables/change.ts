import { randomUUID } from "node:crypto";
import { CoreError } from "../errors";
import { validateRows } from "./cellValues";
import { columnsShapeIssue } from "./validation";
import {
  hasOptions,
  type CellValue,
  type ColumnType,
  type SelectOption,
  type TableColumn,
  type TableData,
  type TableRow,
} from "./types";

export type TableColumnChange =
  | {
      op: "add";
      column: {
        id?: string;
        name: string;
        type: ColumnType;
        options?: SelectOption[];
      };
    }
  | { op: "rename"; columnId: string; name: string }
  | { op: "remove"; columnId: string }
  | {
      op: "retype";
      columnId: string;
      type: ColumnType;
      options?: SelectOption[];
    }
  | { op: "reorder"; columnIds: string[] }
  | {
      op: "option_add";
      columnId: string;
      option: { id?: string; label: string };
    }
  | { op: "option_rename"; columnId: string; optionId: string; label: string }
  | { op: "option_remove"; columnId: string; optionId: string };

export type TableRowChanges = {
  inserts: { id?: string; cells: Record<string, CellValue> }[];
  updates: {
    rowId: string;
    set?: Record<string, CellValue>;
    clear?: string[];
  }[];
  deletes: string[];
};

export type TableChange = {
  title?: string;
  columns: TableColumnChange[];
  rows: TableRowChanges;
};

function bad(message: string): CoreError {
  return new CoreError("BAD_REQUEST", message);
}

function requireColumn(columns: TableColumn[], columnId: string): TableColumn {
  const column = columns.find((candidate) => candidate.id === columnId);
  if (!column) throw bad(`unknown column ${columnId}`);
  return column;
}

function assertNameFree(
  columns: TableColumn[],
  name: string,
  exceptId?: string,
): void {
  if (
    columns.some(
      (column) =>
        column.id !== exceptId &&
        column.name.toLowerCase() === name.toLowerCase(),
    )
  )
    throw bad(`duplicate column name ${name}`);
}

function applyColumnChanges(
  columns: TableColumn[],
  changes: TableColumnChange[],
): TableColumn[] {
  let next: TableColumn[] = columns.map((column) => ({
    ...column,
    options: column.options
      ? column.options.map((option) => ({ ...option }))
      : undefined,
  }));
  for (const change of changes) {
    switch (change.op) {
      case "add": {
        const column: TableColumn = {
          id: change.column.id ?? randomUUID(),
          name: change.column.name,
          type: change.column.type,
          ...(change.column.options
            ? {
                options: change.column.options.map((option) => ({ ...option })),
              }
            : {}),
        };
        if (next.some((candidate) => candidate.id === column.id))
          throw bad(`duplicate column id ${column.id}`);
        assertNameFree(next, column.name);
        next.push(column);
        break;
      }
      case "rename": {
        const column = requireColumn(next, change.columnId);
        assertNameFree(next, change.name, column.id);
        column.name = change.name;
        break;
      }
      case "remove": {
        requireColumn(next, change.columnId);
        next = next.filter((column) => column.id !== change.columnId);
        break;
      }
      case "retype": {
        // Only the column changes; cells that are now invalid must be fixed
        // by explicit updates in the same operation (concept §6.2).
        const column = requireColumn(next, change.columnId);
        column.type = change.type;
        if (change.options)
          column.options = change.options.map((option) => ({ ...option }));
        // A select<->multiselect retype keeps the option list so the
        // change's explicit cell updates stay valid.
        else if (!hasOptions(change.type)) delete column.options;
        break;
      }
      case "reorder": {
        const ids = next.map((column) => column.id);
        const wanted = change.columnIds;
        if (
          wanted.length !== ids.length ||
          new Set(wanted).size !== wanted.length ||
          wanted.some((id) => !ids.includes(id))
        )
          throw bad("reorder must list every current column id exactly once");
        next = wanted.map((id) => next.find((column) => column.id === id)!);
        break;
      }
      case "option_add": {
        const column = requireColumn(next, change.columnId);
        if (!hasOptions(column.type))
          throw bad(
            `column ${column.id} is not a select or multiselect column`,
          );
        const option = {
          id: change.option.id ?? randomUUID(),
          label: change.option.label,
        };
        column.options = [...(column.options ?? [])];
        if (column.options.some((existing) => existing.id === option.id))
          throw bad(`duplicate option id ${option.id}`);
        column.options.push(option);
        break;
      }
      case "option_rename": {
        const column = requireColumn(next, change.columnId);
        const option = (column.options ?? []).find(
          (candidate) => candidate.id === change.optionId,
        );
        if (!option) throw bad(`unknown option ${change.optionId}`);
        option.label = change.label;
        break;
      }
      case "option_remove": {
        const column = requireColumn(next, change.columnId);
        if (
          !(column.options ?? []).some(
            (option) => option.id === change.optionId,
          )
        )
          throw bad(`unknown option ${change.optionId}`);
        column.options = (column.options ?? []).filter(
          (option) => option.id !== change.optionId,
        );
        break;
      }
    }
  }
  if (next.length === 0) throw bad("a table needs at least one column");
  return next;
}

function applyRowChanges(
  columns: TableColumn[],
  rows: TableRow[],
  changes: TableRowChanges,
): TableRow[] {
  const live = new Set(columns.map((column) => column.id));
  const byId = new Map(
    rows.map((row) => [row.id, { id: row.id, cells: { ...row.cells } }]),
  );
  // A removed column takes its cells with it.
  for (const row of byId.values())
    for (const columnId of Object.keys(row.cells))
      if (!live.has(columnId)) delete row.cells[columnId];
  for (const update of changes.updates) {
    const row = byId.get(update.rowId);
    if (!row) throw bad(`unknown row ${update.rowId}`);
    const clear = update.clear ?? [];
    const set = update.set ?? {};
    for (const columnId of clear)
      if (Object.prototype.hasOwnProperty.call(set, columnId))
        throw bad(
          `column ${columnId} appears in both set and clear for row ${update.rowId}`,
        );
    for (const columnId of clear) delete row.cells[columnId];
    Object.assign(row.cells, set);
  }
  for (const rowId of changes.deletes)
    if (!byId.delete(rowId)) throw bad(`unknown row ${rowId}`);
  for (const insert of changes.inserts) {
    const row = { id: insert.id ?? randomUUID(), cells: { ...insert.cells } };
    if (byId.has(row.id)) throw bad(`duplicate row id ${row.id}`);
    byId.set(row.id, row);
  }
  return [...byId.values()];
}

/** Applies every part of a coherent table change, then validates the final state once. */
export function applyTableChange(
  current: TableData,
  change: TableChange,
): TableData {
  const columns = applyColumnChanges(current.columns, change.columns);
  // The same column-shape rules the Git writer enforces, so a clean preview
  // can never be rejected at acceptance (design §5.4).
  const shape = columnsShapeIssue(columns);
  if (shape)
    throw new CoreError("BAD_REQUEST", `invalid final table state: ${shape}`, {
      reason: "INVALID_FINAL_STATE",
    });

  const removed = new Set(
    change.columns.flatMap((entry) =>
      entry.op === "remove" ? [entry.columnId] : [],
    ),
  );
  for (const entry of change.columns) {
    if (entry.op !== "retype" || removed.has(entry.columnId)) continue;
    const original = current.columns.find(
      (column) => column.id === entry.columnId,
    );
    if (!original || !hasOptions(original.type) || hasOptions(entry.type))
      continue;
    for (const row of current.rows) {
      if (
        row.cells[entry.columnId] === undefined ||
        change.rows.deletes.includes(row.id)
      )
        continue;
      const update = change.rows.updates.find(
        (candidate) => candidate.rowId === row.id,
      );
      if (
        !update?.clear?.includes(entry.columnId) &&
        !Object.prototype.hasOwnProperty.call(update?.set ?? {}, entry.columnId)
      )
        throw bad(
          `retyping option column ${entry.columnId} requires explicit cell updates or clears`,
        );
    }
  }
  const cleanRows = current.rows.map((row) => ({
    ...row,
    cells: Object.fromEntries(
      Object.entries(row.cells).filter(([id]) => !removed.has(id)),
    ),
  }));
  const rows = applyRowChanges(columns, cleanRows, change.rows);
  const result = validateRows(columns, rows);
  if (!result.ok)
    throw new CoreError(
      "BAD_REQUEST",
      `invalid final table state: ${result.errors
        .slice(0, 5)
        .map((error) => `${error.rowId}/${error.columnId}: ${error.reason}`)
        .join("; ")}`,
      { reason: "INVALID_FINAL_STATE" },
    );
  return { title: change.title ?? current.title, columns, rows };
}

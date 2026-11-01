import { compareCells } from "@weaver/core/tables/query";
import type { ColDef } from "ag-grid-community";

import type {
  CellValue,
  TableColumn,
  TableRow,
} from "@weaver/core/tables/types";
import {
  CANONICAL_UUID_RE,
  dateTimeInstant,
  isValidDateTimeCell,
  isValidIsoDate,
  isValidUrlCell,
  MAX_TEXT_CHARS,
  normalizeDateTimeCell,
} from "@weaver/core/tables/validation";

export type GridTableRow = { __rowId: string } & Record<
  string,
  CellValue | undefined
>;

export type CoercedGridValue =
  { ok: true; value: CellValue | undefined } | { ok: false };

/** Text form of a multiselect cell, used for the grid's value formatter/comparator. */
function multiselectCellLabel(column: TableColumn, value: unknown): string {
  if (!Array.isArray(value)) return "";
  return (value as unknown[])
    .map((id) =>
      typeof id === "string"
        ? ((column.options ?? []).find((option) => option.id === id)?.label ??
          id)
        : String(id),
    )
    .join(", ");
}

const gridRows = new WeakMap<TableRow, GridTableRow>();

export function toGridRows(rows: TableRow[]): GridTableRow[] {
  return rows.map((row) => {
    let value = gridRows.get(row);
    if (!value) {
      value = { __rowId: row.id, ...row.cells };
      gridRows.set(row, value);
    }
    return value;
  });
}

export function toGridColumnDefs(
  columns: TableColumn[],
  editable: boolean,
): ColDef<GridTableRow>[] {
  return columns.map((column) => {
    const common: ColDef<GridTableRow> = {
      field: column.id,
      colId: column.id,
      headerName: column.name,
      editable,
      sortable: true,
      resizable: true,
    };

    switch (column.type) {
      case "text":
        return {
          ...common,
          filter: "agTextColumnFilter",
          cellEditor: "agTextCellEditor",
          cellDataType: "text",
        };
      case "number":
        return {
          ...common,
          filter: "agNumberColumnFilter",
          cellEditor: "agNumberCellEditor",
          cellDataType: "number",
        };
      case "date":
        return {
          ...common,
          filter: "agDateColumnFilter",
          cellEditor: "agDateStringCellEditor",
          cellDataType: "dateString",
        };
      case "select":
        return {
          comparator: (a: CellValue | undefined, b: CellValue | undefined) =>
            compareCells(a, b, column),
          ...common,
          filter: "agTextColumnFilter",
          cellEditor: "agSelectCellEditor",
          cellEditorParams: {
            values: ["", ...(column.options ?? []).map((option) => option.id)],
          },
          cellDataType: false,
        };
      case "boolean":
        return {
          ...common,
          filter: false,
          cellEditor: "agCheckboxCellEditor",
          cellDataType: "boolean",
        };
      case "document":
        return {
          ...common,
          filter: "agTextColumnFilter",
          cellEditor: "documentCellEditor",
          cellDataType: false,
        };
      case "datetime":
        return {
          ...common,
          filter: "agTextColumnFilter",
          cellEditor: "dateTimeCellEditor",
          cellDataType: "text",
          comparator: (a, b) => {
            const instantA = typeof a === "string" ? dateTimeInstant(a) : NaN;
            const instantB = typeof b === "string" ? dateTimeInstant(b) : NaN;
            if (Number.isNaN(instantA) && Number.isNaN(instantB)) return 0;
            if (Number.isNaN(instantA)) return -1;
            if (Number.isNaN(instantB)) return 1;
            return instantA - instantB;
          },
        };
      case "url":
        return {
          ...common,
          filter: "agTextColumnFilter",
          cellEditor: "agTextCellEditor",
          cellDataType: "text",
        };
      case "longtext":
        return {
          ...common,
          filter: "agTextColumnFilter",
          cellEditor: "agLargeTextCellEditor",
          cellEditorPopup: true,
          cellEditorParams: { maxLength: MAX_TEXT_CHARS, rows: 10, cols: 60 },
          cellDataType: "text",
        };
      case "multiselect":
        return {
          ...common,
          filter: "agTextColumnFilter",
          cellDataType: "object",
          cellEditor: "multiselectCellEditor",
          cellEditorPopup: true,
          cellEditorParams: { column },
          // AG Grid warns (#48) about an "object" data type column with no
          // valueParser; the editor always supplies structured values
          // itself, so this only needs to pass through/normalize a clear.
          valueParser: ({ newValue }) =>
            newValue === "" || newValue == null ? null : newValue,
          valueFormatter: ({ value }) => multiselectCellLabel(column, value),
          comparator: (a, b) =>
            multiselectCellLabel(column, a).localeCompare(
              multiselectCellLabel(column, b),
            ),
        };
    }
  });
}

export function coerceGridValue(
  column: TableColumn,
  value: unknown,
): CoercedGridValue {
  if (value === undefined || value === null || value === "") {
    return { ok: true, value: undefined };
  }

  switch (column.type) {
    case "text":
      return typeof value === "string" ? { ok: true, value } : { ok: false };
    case "number": {
      if (typeof value === "string" && value.trim() === "")
        return { ok: true, value: undefined };
      const number =
        typeof value === "number"
          ? value
          : typeof value === "string"
            ? Number(value.trim())
            : Number.NaN;
      return Number.isFinite(number)
        ? { ok: true, value: number }
        : { ok: false };
    }
    case "date":
      return typeof value === "string" && isValidIsoDate(value)
        ? { ok: true, value }
        : { ok: false };
    case "select":
      return typeof value === "string" &&
        (column.options ?? []).some((option) => option.id === value)
        ? { ok: true, value }
        : { ok: false };
    case "boolean":
      return typeof value === "boolean" ? { ok: true, value } : { ok: false };
    case "document":
      return typeof value === "string" && CANONICAL_UUID_RE.test(value)
        ? { ok: true, value }
        : { ok: false };
    case "datetime":
      return typeof value === "string" && isValidDateTimeCell(value)
        ? { ok: true, value: normalizeDateTimeCell(value) }
        : { ok: false };
    case "url":
      return typeof value === "string" && isValidUrlCell(value)
        ? { ok: true, value }
        : { ok: false };
    case "longtext":
      return typeof value === "string" && value.length <= MAX_TEXT_CHARS
        ? { ok: true, value }
        : { ok: false };
    case "multiselect": {
      if (!Array.isArray(value)) return { ok: false };
      if (value.length === 0) return { ok: true, value: undefined };
      const ids = new Set((column.options ?? []).map((option) => option.id));
      return value.every(
        (entry) => typeof entry === "string" && ids.has(entry),
      ) && new Set(value).size === value.length
        ? { ok: true, value: value as string[] }
        : { ok: false };
    }
  }
}

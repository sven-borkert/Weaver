import { z } from "zod";
import { CoreError } from "../errors";
import type { CellValue, ColumnType, TableColumn, TableRow } from "./types";
import {
  dateTimeInstant,
  isValidIsoDate,
  isValidDateTimeCell,
  normalizeDateTimeCell,
} from "./validation";

// The same cap the tool applies to an inlined cell (MAX_INLINE_CELL_CHARS in
// assistant-tools/src/tools/tables.ts): a filter value longer than a cell can
// ever be inlined as is never a meaningful match, and leaving it unbounded let
// one long `contains` value alone balloon a cursor's query identity.
export const MAX_FILTER_VALUE_CHARS = 2_000;

export const FILTER_OPS = [
  "eq",
  "neq",
  "contains",
  "gt",
  "gte",
  "lt",
  "lte",
  "isEmpty",
  "notEmpty",
] as const;

export const filterValueSchema = z.union([
  z.string().max(MAX_FILTER_VALUE_CHARS),
  z.number(),
  z.boolean(),
  z.array(z.string().max(MAX_FILTER_VALUE_CHARS)).max(200),
]);

export const tableFilterSchema = z.object({
  columnId: z.string(),
  op: z.enum(FILTER_OPS),
  value: filterValueSchema.optional(),
});
export type TableFilter = z.infer<typeof tableFilterSchema>;

export const tableFiltersSchema = z.array(tableFilterSchema).max(20);

export const tableSortSchema = z.object({
  columnId: z.string(),
  dir: z.enum(["asc", "desc"]),
});

export function columnsById(
  columns: readonly TableColumn[],
): Map<string, TableColumn> {
  return new Map(columns.map((column) => [column.id, column]));
}

export function requireColumn(
  byId: Map<string, TableColumn>,
  columnId: string,
): TableColumn {
  const column = byId.get(columnId);
  if (!column) throw new CoreError("BAD_REQUEST", `unknown column ${columnId}`);
  return column;
}

export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function labelsOf(column: TableColumn, ids: string[]): string {
  const byId = new Map(
    (column.options ?? []).map((option) => [option.id, option.label]),
  );
  return ids.map((id) => byId.get(id) ?? id).join(", ");
}

/** Compare declared types, resolving option labels and datetime instants. */
export function compareCells(
  a: CellValue | undefined,
  b: CellValue | undefined,
  column: TableColumn | ColumnType,
): number {
  const type = typeof column === "string" ? column : column.type;
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  if (type === "number") {
    const an = typeof a === "number" ? a : Number(a);
    const bn = typeof b === "number" ? b : Number(b);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
  } else if (type === "boolean") {
    return Number(a === true) - Number(b === true);
  } else if (type === "datetime") {
    const ai = dateTimeInstant(String(a));
    const bi = dateTimeInstant(String(b));
    if (Number.isFinite(ai) && Number.isFinite(bi)) return ai - bi;
  } else if (
    (type === "multiselect" || type === "select") &&
    typeof column !== "string"
  ) {
    return labelsOf(column, Array.isArray(a) ? a : [String(a)]).localeCompare(
      labelsOf(column, Array.isArray(b) ? b : [String(b)]),
    );
  }
  return String(a).localeCompare(String(b));
}

/**
 * Validates (and, only where unambiguous, coerces) a filter's value against
 * its column's declared type, so filtering never silently answers a mistyped
 * filter with a wrong-but-plausible row set (spec §13: typed filters, not
 * untyped ones). The one coercion allowed is a numeric string against a
 * `number` column ("2" -> 2); every other mismatch is rejected.
 */
export function coerceFilterValue(
  column: TableColumn,
  filter: TableFilter,
): TableFilter {
  if (filter.op === "isEmpty" || filter.op === "notEmpty") return filter;
  const { value } = filter;
  if (value === undefined)
    throw new CoreError(
      "BAD_REQUEST",
      `filter on column "${column.id}" (${filter.op}) requires a value`,
    );

  if (column.type === "select") {
    if (
      (filter.op !== "eq" && filter.op !== "neq") ||
      typeof value !== "string" ||
      !(column.options ?? []).some((option) => option.id === value)
    )
      throw new CoreError(
        "BAD_REQUEST",
        `filter on select column "${column.id}" requires eq/neq and a known option id`,
      );
    return filter;
  }
  if (
    column.type === "date" &&
    (typeof value !== "string" || !isValidIsoDate(value))
  )
    throw new CoreError(
      "BAD_REQUEST",
      `filter on date column "${column.id}" requires YYYY-MM-DD`,
    );

  if (column.type === "multiselect") {
    if (filter.op === "contains") {
      if (
        typeof value !== "string" ||
        !(column.options ?? []).some((option) => option.id === value)
      )
        throw new CoreError(
          "BAD_REQUEST",
          `contains filter on column "${column.id}" must name an option id`,
        );
      return filter;
    }
    if (filter.op === "eq" || filter.op === "neq") {
      if (
        !Array.isArray(value) ||
        value.some((entry) => typeof entry !== "string")
      )
        throw new CoreError(
          "BAD_REQUEST",
          `${filter.op} filter on column "${column.id}" requires an array of option ids`,
        );
      const ids = new Set((column.options ?? []).map((option) => option.id));
      for (const entry of value)
        if (!ids.has(entry))
          throw new CoreError(
            "BAD_REQUEST",
            `${filter.op} filter on column "${column.id}" names an unknown option "${entry}"`,
          );
      return { ...filter, value: [...new Set(value)] };
    }
    throw new CoreError(
      "BAD_REQUEST",
      `ordering filters are not supported on column "${column.id}" (multiselect)`,
    );
  }

  // Every remaining column type takes a scalar value; only multiselect
  // filters (handled above) ever take an array.
  if (Array.isArray(value))
    throw new CoreError(
      "BAD_REQUEST",
      `filter value for column "${column.id}" must not be an array`,
    );

  if (filter.op === "contains") {
    if (
      typeof value !== "string" ||
      column.type === "number" ||
      column.type === "boolean"
    )
      throw new CoreError(
        "BAD_REQUEST",
        `contains filter on column "${column.id}" requires a text value and a text-typed column`,
      );
    return filter;
  }
  if (column.type === "number") {
    if (typeof value === "number") return filter;
    if (
      typeof value === "string" &&
      value.trim() !== "" &&
      Number.isFinite(Number(value))
    )
      return { ...filter, value: Number(value) };
    throw new CoreError(
      "BAD_REQUEST",
      `filter value for column "${column.id}" must be a number`,
    );
  }
  if (column.type === "boolean") {
    if (typeof value === "boolean") return filter;
    throw new CoreError(
      "BAD_REQUEST",
      `filter value for column "${column.id}" must be a boolean`,
    );
  }

  const isOrderingOp =
    filter.op === "gt" ||
    filter.op === "gte" ||
    filter.op === "lt" ||
    filter.op === "lte";

  if (column.type === "url" || column.type === "longtext") {
    if (typeof value !== "string")
      throw new CoreError(
        "BAD_REQUEST",
        `filter value for column "${column.id}" must be a string`,
      );
    if (isOrderingOp)
      throw new CoreError(
        "BAD_REQUEST",
        `ordering filters are not supported on column "${column.id}" (${column.type})`,
      );
    return filter;
  }

  if (column.type === "datetime") {
    // Validated and normalised the same way for eq/neq as for ordering: a
    // datetime filter always compares instants (matchesFilter), so the
    // stored value must be a real datetime, not merely a string.
    if (typeof value !== "string" || !isValidDateTimeCell(value))
      throw new CoreError(
        "BAD_REQUEST",
        `filter value for column "${column.id}" must be a valid datetime`,
      );
    return { ...filter, value: normalizeDateTimeCell(value) };
  }

  // text, select, date, document — cell values are strings for all of these,
  // and ordering over them stays lexical as it already was.
  if (typeof value !== "string")
    throw new CoreError(
      "BAD_REQUEST",
      `filter value for column "${column.id}" must be a string`,
    );
  return filter;
}

function idArray(value: CellValue | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [String(value)];
}

/**
 * Order-insensitive, duplicate-tolerant set equality, for multiselect
 * eq/neq. Self-contained: it never assumes either input is already
 * deduplicated (coerceFilterValue dedupes the filter side, but the cell
 * side is whatever was stored), so two arrays with the same distinct
 * members compare equal regardless of repeats or order.
 */
function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const entry of setA) if (!setB.has(entry)) return false;
  return true;
}

/** True when both sides are datetime strings naming the same instant. */
function sameInstant(cell: CellValue | undefined, value: unknown): boolean {
  if (typeof cell !== "string" || typeof value !== "string") return false;
  const ci = dateTimeInstant(cell);
  const vi = dateTimeInstant(value);
  return Number.isFinite(ci) && Number.isFinite(vi) && ci === vi;
}

export function matchesFilter(
  cell: CellValue | undefined,
  filter: TableFilter,
  column: TableColumn | ColumnType,
): boolean {
  const type = typeof column === "string" ? column : column.type;
  // `[]` is empty the same way an absent cell or "" is (concept §13:
  // multiselect has no meaningful distinction between "no options" states).
  const isEmptyCell =
    cell === undefined ||
    cell === "" ||
    (Array.isArray(cell) && cell.length === 0);
  switch (filter.op) {
    case "isEmpty":
      return isEmptyCell;
    case "notEmpty":
      return !isEmptyCell;
    case "eq":
      if (Array.isArray(cell) || Array.isArray(filter.value))
        return sameIdSet(idArray(cell), idArray(filter.value));
      if (type === "datetime") return sameInstant(cell, filter.value);
      return cell === filter.value;
    case "neq":
      if (Array.isArray(cell) || Array.isArray(filter.value))
        return !sameIdSet(idArray(cell), idArray(filter.value));
      if (type === "datetime") return !sameInstant(cell, filter.value);
      return cell !== filter.value;
    case "contains":
      if (Array.isArray(cell))
        return typeof filter.value === "string" && cell.includes(filter.value);
      return (
        typeof cell === "string" &&
        typeof filter.value === "string" &&
        cell.toLowerCase().includes(filter.value.toLowerCase())
      );
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (cell === undefined) return false;
      // Both sides were validated/coerced against the same declared column
      // type by coerceFilterValue, so comparing against the column directly
      // is safe here.
      const cmp = compareCells(cell, filter.value, column);
      if (filter.op === "gt") return cmp > 0;
      if (filter.op === "gte") return cmp >= 0;
      if (filter.op === "lt") return cmp < 0;
      return cmp <= 0;
    }
  }
}

/** Conjunctive typed filtering in input order; coercion happens once up front. */
export function filterRows(
  byId: Map<string, TableColumn>,
  rows: readonly TableRow[],
  filters: readonly TableFilter[],
): TableRow[] {
  const coerced = filters.map((filter) => {
    const column = requireColumn(byId, filter.columnId);
    return { column, filter: coerceFilterValue(column, filter) };
  });
  return rows.filter((row) =>
    coerced.every(({ column, filter }) =>
      matchesFilter(row.cells[filter.columnId], filter, column),
    ),
  );
}

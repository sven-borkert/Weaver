import { z } from "zod";
import { CoreError } from "../errors";
import { compareCells, requireColumn } from "./query";
import type { CellValue, ColumnType, TableColumn, TableRow } from "./types";
import {
  dateTimeInstant,
  isValidDateTimeCell,
  isValidIsoDate,
} from "./validation";

export const AGGREGATE_FNS = [
  "count",
  "countNonEmpty",
  "sum",
  "avg",
  "min",
  "max",
  "distinctCount",
] as const;
export type AggregateFn = (typeof AGGREGATE_FNS)[number];

export const aggregateSpecSchema = z.object({
  fn: z.enum(AGGREGATE_FNS),
  columnId: z.string().optional(),
});
export type AggregateSpec = z.infer<typeof aggregateSpecSchema>;
export const aggregateSpecsSchema = z.array(aggregateSpecSchema).min(1).max(10);
export const groupBySchema = z.array(z.string()).max(2);

export type AggregateResult = {
  fn: AggregateFn;
  columnId: string | null;
  /** A date minimum/maximum is its ISO string; everything else is numeric. */
  value: number | string | null;
  /** How many rows' cells fed the value — tells an empty result from an unasked question. */
  contributing: number;
};

// The same cap the tool applies to an inlined cell (MAX_INLINE_CELL_CHARS in
// assistant-tools/src/tools/tables.ts) and to a filter value
// (MAX_FILTER_VALUE_CHARS): a key wider than that returns text the row reader
// refuses to inline, and one wide enough to blow the page budget would leave
// its group unreachable, since no filter could even name it.
export const MAX_GROUP_KEY_CHARS = 2_000;

export type GroupKeyPart = {
  columnId: string;
  /** null is the absent bucket, distinct from "", false and 0. */
  value: CellValue | null;
  /** Present for a select column: the option's label at this schema revision. */
  label?: string;
  /** `value` is the first MAX_GROUP_KEY_CHARS characters of the cell; bucketing, ordering and every aggregate used the whole of it. */
  valueTruncated?: true;
};

export type AggregateGroup = {
  key: GroupKeyPart[];
  matched: number;
  aggregates: AggregateResult[];
};

const isPresent = (cell: CellValue | undefined): cell is CellValue =>
  cell !== undefined;

/** Only an absent cell and an empty string are empty; false and 0 are values. */
const isEmptyCell = (cell: CellValue | undefined): boolean =>
  cell === undefined || cell === "";

function assertFinite(value: number, columnId: string): number {
  if (!Number.isFinite(value))
    throw new CoreError(
      "BAD_REQUEST",
      `the result for column "${columnId}" is not a finite number; narrow the filter or aggregate fewer rows`,
      { field: "aggregates" },
    );
  return value;
}

/**
 * The column type(s) a fn may run against. Shared by assertAggregateSpecs
 * (the tool-facing precondition) and computeOne (enforced again inside
 * aggregation itself), so a caller that skips the assert — or calls it and
 * aggregateRows out of order — still gets a rejection instead of a silently
 * wrong number (e.g. summing a boolean column via `0 + true`).
 */
function columnTypeIssue(fn: AggregateFn, column: TableColumn): string | null {
  if ((fn === "sum" || fn === "avg") && column.type !== "number")
    return `${fn} requires a number column; "${column.id}" is ${column.type}`;
  if (
    (fn === "min" || fn === "max") &&
    column.type !== "number" &&
    column.type !== "date" &&
    column.type !== "datetime"
  )
    return `${fn} requires a number or date/datetime column; "${column.id}" is ${column.type}`;
  return null;
}

export function assertAggregateSpecs(
  byId: Map<string, TableColumn>,
  specs: readonly AggregateSpec[],
): void {
  const seen = new Set<string>();
  for (const spec of specs) {
    if (spec.fn === "count") {
      if (spec.columnId !== undefined)
        throw new CoreError(
          "BAD_REQUEST",
          "count is the row count and takes no columnId",
          { field: "aggregates" },
        );
    } else {
      if (spec.columnId === undefined)
        throw new CoreError("BAD_REQUEST", `${spec.fn} requires a columnId`, {
          field: "aggregates",
        });
      const column = requireColumn(byId, spec.columnId);
      const issue = columnTypeIssue(spec.fn, column);
      if (issue)
        throw new CoreError("BAD_REQUEST", issue, { field: "aggregates" });
    }
    // A result is addressed by fn and columnId, so the same pair twice would
    // be returned under an ambiguous key (design §8.3).
    const key = `${spec.fn}:${spec.columnId ?? ""}`;
    if (seen.has(key))
      throw new CoreError(
        "BAD_REQUEST",
        `${spec.fn}${spec.columnId ? ` on "${spec.columnId}"` : ""} is requested twice`,
        { field: "aggregates" },
      );
    seen.add(key);
  }
}

export function assertGroupBy(
  byId: Map<string, TableColumn>,
  groupBy: readonly string[],
): void {
  const seen = new Set<string>();
  for (const columnId of groupBy) {
    requireColumn(byId, columnId);
    if (seen.has(columnId))
      throw new CoreError(
        "BAD_REQUEST",
        `groupBy names column "${columnId}" twice`,
        { field: "groupBy" },
      );
    seen.add(columnId);
  }
}

function dateInstant(value: string): number {
  return Date.parse(value);
}

/** Cells this column can be ordered or summed over, in row order. */
function orderableValues(
  column: TableColumn,
  rows: readonly TableRow[],
): CellValue[] {
  const out: CellValue[] = [];
  for (const row of rows) {
    const cell = row.cells[column.id];
    if (cell === undefined) continue;
    if (column.type === "number") {
      if (typeof cell === "number" && Number.isFinite(cell)) out.push(cell);
    } else if (column.type === "date") {
      // isValidIsoDate already requires a parseable Date; the explicit
      // dateInstant guard is kept so a malformed date is never ordered
      // against, even if that helper's contract changes later.
      if (
        typeof cell === "string" &&
        isValidIsoDate(cell) &&
        !Number.isNaN(dateInstant(cell))
      )
        out.push(cell);
    } else if (column.type === "datetime") {
      if (typeof cell === "string" && isValidDateTimeCell(cell)) out.push(cell);
    } else {
      out.push(cell);
    }
  }
  return out;
}

/**
 * Orders min/max candidates. A date or datetime compares by the instant it
 * names, not by its printed digits — compareCells' lexical fallback (shared
 * with the row sort, and not touched here) would rank "...+05:00" above
 * "...Z" even when its instant is earlier. Numbers compare numerically, as
 * before.
 */
function orderForMinMax(a: CellValue, b: CellValue, type: ColumnType): number {
  if (type === "date")
    return dateInstant(a as string) - dateInstant(b as string);
  if (type === "datetime")
    return dateTimeInstant(a as string) - dateTimeInstant(b as string);
  return (a as number) - (b as number);
}

function computeOne(
  byId: Map<string, TableColumn>,
  rows: readonly TableRow[],
  spec: AggregateSpec,
): AggregateResult {
  if (spec.fn === "count")
    return {
      fn: "count",
      columnId: null,
      value: rows.length,
      contributing: rows.length,
    };
  const column = requireColumn(byId, spec.columnId!);
  const columnId = column.id;
  // Enforced again here, not just in assertAggregateSpecs: a caller that
  // skips the precondition must still get a rejection, not a wrong number.
  const issue = columnTypeIssue(spec.fn, column);
  if (issue) throw new CoreError("BAD_REQUEST", issue, { field: "aggregates" });
  if (spec.fn === "countNonEmpty") {
    let n = 0;
    for (const row of rows) if (!isEmptyCell(row.cells[columnId])) n += 1;
    return { fn: spec.fn, columnId, value: n, contributing: n };
  }
  if (spec.fn === "distinctCount") {
    if (column.type === "multiselect") {
      // Flattened: a multiselect cell holds several ids at once, so
      // "distinct" counts distinct ids across rows, not distinct arrays.
      const distinct = new Set<string>();
      let contributing = 0;
      for (const row of rows) {
        const cell = row.cells[columnId];
        if (!Array.isArray(cell) || cell.length === 0) continue;
        contributing += 1;
        for (const id of cell) distinct.add(id);
      }
      return { fn: spec.fn, columnId, value: distinct.size, contributing };
    }
    const distinct = new Set<CellValue>();
    let contributing = 0;
    for (const row of rows) {
      const cell = row.cells[columnId];
      // Concept §8: distinct count excludes absent cells only — "" is a value.
      if (!isPresent(cell)) continue;
      contributing += 1;
      distinct.add(
        column.type === "datetime" ? dateTimeInstant(String(cell)) : cell,
      );
    }
    return { fn: spec.fn, columnId, value: distinct.size, contributing };
  }
  const values = orderableValues(column, rows);
  if (spec.fn === "sum" || spec.fn === "avg") {
    // Deterministic left fold in row order; float64, documented, not decimal.
    let total = 0;
    for (const value of values) total += value as number;
    if (spec.fn === "sum")
      return {
        fn: spec.fn,
        columnId,
        value: assertFinite(total, columnId),
        contributing: values.length,
      };
    return {
      fn: spec.fn,
      columnId,
      value:
        values.length === 0
          ? null
          : assertFinite(total / values.length, columnId),
      contributing: values.length,
    };
  }
  if (values.length === 0)
    return { fn: spec.fn, columnId, value: null, contributing: 0 };
  let best = values[0]!;
  for (const value of values.slice(1)) {
    const cmp = orderForMinMax(value, best, column.type);
    if (spec.fn === "min" ? cmp < 0 : cmp > 0) best = value;
  }
  return {
    fn: spec.fn,
    columnId,
    value: best as number | string,
    contributing: values.length,
  };
}

export function aggregateRows(
  byId: Map<string, TableColumn>,
  rows: readonly TableRow[],
  specs: readonly AggregateSpec[],
): AggregateResult[] {
  return specs.map((spec) => computeOne(byId, rows, spec));
}

/**
 * Group-by candidates for one row's cell in one group-by column. Every
 * non-multiselect column contributes exactly one candidate (the cell, or
 * null when absent). A multiselect column explodes: the row contributes one
 * candidate per option id it holds, so a group-by over it buckets rows by
 * option, not by the whole array; an absent or empty cell falls to the null
 * bucket like any other column.
 */
function groupCandidates(
  column: TableColumn,
  cell: CellValue | undefined,
): (CellValue | null)[] {
  if (column.type === "multiselect")
    return Array.isArray(cell) && cell.length > 0 ? cell : [null];
  return [cell ?? null];
}

/** The cartesian product of several candidate lists, in list order. */
function cartesian<T>(lists: readonly T[][]): T[][] {
  return lists.reduce<T[][]>(
    (acc, list) =>
      acc.flatMap((prefix) => list.map((item) => [...prefix, item])),
    [[]],
  );
}

/**
 * JSON.stringify collapses NaN and +/-Infinity to "null" — the same
 * serialization an absent cell gets — which would silently merge a
 * non-finite number cell into the absent bucket. Tag non-finite numbers so
 * they keep a bucket of their own.
 */
function serializeGroupValue(value: CellValue | null): string {
  if (typeof value === "number" && !Number.isFinite(value)) return `#${value}`;
  return JSON.stringify(value);
}

/** U+0000 as a join separator is not a character JSON.stringify or the
 * `#`-tag ever produces, so it can't be absorbed into one value and shift
 * where it ends and the next begins. */
function bucketId(values: readonly (CellValue | null)[]): string {
  return values.map(serializeGroupValue).join("\u0000");
}

/**
 * Renders one key part. Only what is RENDERED is bounded: the bucket keeps
 * its identity on the whole cell (bucketId, the sort below and every
 * aggregate read the raw value), so two keys that share their first
 * MAX_GROUP_KEY_CHARS characters stay two groups rather than merging into a
 * wrong total.
 */
function keyPart(column: TableColumn, value: CellValue | null): GroupKeyPart {
  if (value === null) return { columnId: column.id, value: null };
  // After exploding (groupCandidates), a multiselect group's value is a
  // single option id here, same shape as a select cell — the label lookup
  // is identical for both.
  const label =
    column.type === "select" || column.type === "multiselect"
      ? (column.options ?? []).find((option) => option.id === value)?.label
      : undefined;
  const truncated =
    typeof value === "string" && value.length > MAX_GROUP_KEY_CHARS;
  return {
    columnId: column.id,
    value: truncated ? value.slice(0, MAX_GROUP_KEY_CHARS) : value,
    ...(label === undefined ? {} : { label }),
    ...(truncated ? { valueTruncated: true as const } : {}),
  };
}

export function groupAndAggregate(
  byId: Map<string, TableColumn>,
  rows: readonly TableRow[],
  groupBy: readonly string[],
  specs: readonly AggregateSpec[],
): AggregateGroup[] {
  const groupColumns = groupBy.map((columnId) => requireColumn(byId, columnId));
  const buckets = new Map<
    string,
    { key: GroupKeyPart[]; values: (CellValue | null)[]; rows: TableRow[] }
  >();
  for (const row of rows) {
    // Each group-by column contributes one or more candidates per row (a
    // multiselect column contributes one per option it holds); the
    // cartesian product across the (at most two) group-by columns is what
    // lets a row land in several buckets at once — one per combination.
    const candidateLists = groupColumns.map((column) =>
      groupCandidates(column, row.cells[column.id]),
    );
    for (const rawValues of cartesian(candidateLists)) {
      const id = bucketId(
        rawValues.map((value, index) =>
          value !== null && groupColumns[index]!.type === "datetime"
            ? dateTimeInstant(String(value))
            : value,
        ),
      );
      let bucket = buckets.get(id);
      if (!bucket) {
        // keyPart's select-label lookup only needs to run once per bucket,
        // not once per row — so it happens here, the first time this
        // combination of values is seen, not in the per-row loop above.
        const key = groupColumns.map((column, index) =>
          keyPart(column, rawValues[index]!),
        );
        bucket = { key, values: rawValues, rows: [] };
        buckets.set(id, bucket);
      }
      bucket.rows.push(row);
    }
  }
  return [...buckets.entries()]
    .sort(([idA, a], [idB, b]) => {
      for (let index = 0; index < groupColumns.length; index++) {
        // The raw values, not the key's: a rendered key may be truncated
        // (keyPart), and ordering two groups by a shared prefix would make
        // the order depend on where the cut fell.
        const cmp = compareCells(
          a.values[index] ?? undefined,
          b.values[index] ?? undefined,
          groupColumns[index]!.type,
        );
        if (cmp !== 0) return cmp;
      }
      // compareCells can tie on values it treats as equal — a Unicode
      // collation quirk, or "2" coerced to 2 in a number column — even
      // though the buckets are genuinely distinct. The bucket id keeps the
      // order stable and reproducible instead of leaving it to whatever a
      // particular sort implementation does with a zero comparator.
      return idA < idB ? -1 : idA > idB ? 1 : 0;
    })
    .map(([, bucket]) => ({
      key: bucket.key,
      matched: bucket.rows.length,
      aggregates: aggregateRows(byId, bucket.rows, specs),
    }));
}

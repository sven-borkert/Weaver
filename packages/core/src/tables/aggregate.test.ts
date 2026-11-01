import { describe, expect, it } from "vitest";
import { CoreError } from "../errors";
import { columnsById } from "./query";
import type { TableColumn, TableRow } from "./types";
import {
  aggregateRows,
  aggregateSpecsSchema,
  assertAggregateSpecs,
  assertGroupBy,
  groupAndAggregate,
  groupBySchema,
  MAX_GROUP_KEY_CHARS,
} from "./aggregate";

const columns: TableColumn[] = [
  { id: "t", name: "Title", type: "text" },
  { id: "n", name: "Count", type: "number" },
  { id: "b", name: "Done", type: "boolean" },
  { id: "d", name: "When", type: "date" },
  {
    id: "s",
    name: "Stage",
    type: "select",
    options: [
      { id: "11111111-1111-4111-8111-111111111111", label: "Draft" },
      { id: "22222222-2222-4222-8222-222222222222", label: "Live" },
    ],
  },
];
const ALPHA = "33333333-3333-4333-8333-333333333333";
const BETA = "44444444-4444-4444-8444-444444444444";
columns.push(
  { id: "dt", name: "Scheduled", type: "datetime" },
  {
    id: "m",
    name: "Tags",
    type: "multiselect",
    options: [
      { id: ALPHA, label: "Alpha" },
      { id: BETA, label: "Beta" },
    ],
  },
);
const byId = columnsById(columns);
const DRAFT = "11111111-1111-4111-8111-111111111111";
const LIVE = "22222222-2222-4222-8222-222222222222";

const rows: TableRow[] = [
  { id: "r1", cells: { t: "a", n: 2, b: true, d: "2026-01-02", s: DRAFT } },
  { id: "r2", cells: { t: "", n: 0, b: false, d: "2026-01-01", s: LIVE } },
  { id: "r3", cells: { b: false } },
];

/**
 * `vi.stubEnv` does not work here: V8 caches the zone, so the new value is
 * never read. Assigning `process.env.TZ` and then constructing a Date forces
 * the re-read.
 */
function withTimeZone<T>(tz: string, run: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  new Date().getTimezoneOffset();
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
    new Date().getTimezoneOffset();
  }
}

describe("assertAggregateSpecs", () => {
  it("accepts count without a columnId and rejects one with it", () => {
    expect(() => assertAggregateSpecs(byId, [{ fn: "count" }])).not.toThrow();
    expect(() =>
      assertAggregateSpecs(byId, [{ fn: "count", columnId: "n" }]),
    ).toThrow(/count/);
  });

  it("requires a columnId for every other function", () => {
    expect(() => assertAggregateSpecs(byId, [{ fn: "sum" }])).toThrow(
      /columnId/,
    );
  });

  it("restricts sum and avg to number columns", () => {
    expect(() =>
      assertAggregateSpecs(byId, [{ fn: "sum", columnId: "t" }]),
    ).toThrow(/number/);
    expect(() =>
      assertAggregateSpecs(byId, [{ fn: "avg", columnId: "d" }]),
    ).toThrow(/number/);
    expect(() =>
      assertAggregateSpecs(byId, [{ fn: "sum", columnId: "n" }]),
    ).not.toThrow();
  });

  it("allows min and max on numbers and dates only", () => {
    expect(() =>
      assertAggregateSpecs(byId, [{ fn: "min", columnId: "n" }]),
    ).not.toThrow();
    expect(() =>
      assertAggregateSpecs(byId, [{ fn: "max", columnId: "d" }]),
    ).not.toThrow();
    expect(() =>
      assertAggregateSpecs(byId, [{ fn: "max", columnId: "t" }]),
    ).toThrow(/number or date/);
  });

  it("accepts min/max on datetime and still rejects sum/avg on it", () => {
    expect(() =>
      assertAggregateSpecs(byId, [{ fn: "max", columnId: "dt" }]),
    ).not.toThrow();
    expect(() =>
      assertAggregateSpecs(byId, [{ fn: "sum", columnId: "dt" }]),
    ).toThrow(/number/);
  });

  it("allows countNonEmpty and distinctCount on any column", () => {
    expect(() =>
      assertAggregateSpecs(byId, [
        { fn: "countNonEmpty", columnId: "t" },
        { fn: "distinctCount", columnId: "s" },
      ]),
    ).not.toThrow();
  });

  it("rejects an unknown column and a duplicated fn/column pair", () => {
    expect(() =>
      assertAggregateSpecs(byId, [{ fn: "sum", columnId: "zz" }]),
    ).toThrow(/zz/);
    expect(() =>
      assertAggregateSpecs(byId, [
        { fn: "sum", columnId: "n" },
        { fn: "sum", columnId: "n" },
      ]),
    ).toThrow(/twice|duplicate/i);
  });

  it("throws CoreError with BAD_REQUEST", () => {
    let thrown: unknown;
    try {
      assertAggregateSpecs(byId, [{ fn: "sum", columnId: "t" }]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CoreError);
    expect((thrown as CoreError).code).toBe("BAD_REQUEST");
  });
});

describe("aggregateRows", () => {
  it("counts rows and non-empty cells, treating zero and false as present", () => {
    expect(
      aggregateRows(byId, rows, [
        { fn: "count" },
        { fn: "countNonEmpty", columnId: "n" },
        { fn: "countNonEmpty", columnId: "t" },
        { fn: "countNonEmpty", columnId: "b" },
      ]),
    ).toEqual([
      { fn: "count", columnId: null, value: 3, contributing: 3 },
      // r3 has no n cell; r2's zero counts.
      { fn: "countNonEmpty", columnId: "n", value: 2, contributing: 2 },
      // r2's "" is empty, r3's absent cell is empty.
      { fn: "countNonEmpty", columnId: "t", value: 1, contributing: 1 },
      // false is a value, not an absence.
      { fn: "countNonEmpty", columnId: "b", value: 3, contributing: 3 },
    ]);
  });

  it("sums and averages numbers, excluding absent cells and keeping zero", () => {
    expect(
      aggregateRows(byId, rows, [
        { fn: "sum", columnId: "n" },
        { fn: "avg", columnId: "n" },
      ]),
    ).toEqual([
      { fn: "sum", columnId: "n", value: 2, contributing: 2 },
      { fn: "avg", columnId: "n", value: 1, contributing: 2 },
    ]);
  });

  it("sums nothing to zero but averages nothing to null", () => {
    expect(
      aggregateRows(
        byId,
        [{ id: "x", cells: {} }],
        [
          { fn: "sum", columnId: "n" },
          { fn: "avg", columnId: "n" },
          { fn: "min", columnId: "n" },
          { fn: "max", columnId: "d" },
        ],
      ),
    ).toEqual([
      { fn: "sum", columnId: "n", value: 0, contributing: 0 },
      { fn: "avg", columnId: "n", value: null, contributing: 0 },
      { fn: "min", columnId: "n", value: null, contributing: 0 },
      { fn: "max", columnId: "d", value: null, contributing: 0 },
    ]);
  });

  it("takes minima and maxima over numbers and over validated dates", () => {
    expect(
      aggregateRows(byId, rows, [
        { fn: "min", columnId: "n" },
        { fn: "max", columnId: "n" },
        { fn: "min", columnId: "d" },
        { fn: "max", columnId: "d" },
      ]),
    ).toEqual([
      { fn: "min", columnId: "n", value: 0, contributing: 2 },
      { fn: "max", columnId: "n", value: 2, contributing: 2 },
      { fn: "min", columnId: "d", value: "2026-01-01", contributing: 2 },
      { fn: "max", columnId: "d", value: "2026-01-02", contributing: 2 },
    ]);
  });

  it("ignores a malformed date rather than ordering against it", () => {
    const dirty: TableRow[] = [
      { id: "a", cells: { d: "2026-01-05" } },
      { id: "b", cells: { d: "not-a-date" } },
    ];
    expect(aggregateRows(byId, dirty, [{ fn: "min", columnId: "d" }])).toEqual([
      { fn: "min", columnId: "d", value: "2026-01-05", contributing: 1 },
    ]);
  });

  it("excludes timestamps from date aggregation in every host timezone", () => {
    const mixed: TableRow[] = [
      { id: "a", cells: { d: "2026-01-02" } },
      { id: "b", cells: { d: "2026-01-02T00:00:00" } },
      { id: "c", cells: { d: "2026-01-02T23:00:00+05:00" } },
    ];
    for (const tz of ["UTC", "Europe/Berlin", "America/New_York"])
      expect(
        withTimeZone(tz, () =>
          aggregateRows(byId, mixed, [
            { fn: "min", columnId: "d" },
            { fn: "max", columnId: "d" },
          ]),
        ),
      ).toEqual([
        { fn: "min", columnId: "d", value: "2026-01-02", contributing: 1 },
        { fn: "max", columnId: "d", value: "2026-01-02", contributing: 1 },
      ]);
  });

  it("picks datetime min/max by instant, not by printed offset", () => {
    const offset: TableRow[] = [
      { id: "a", cells: { dt: "2026-01-02T23:00:00+05:00" } },
      { id: "b", cells: { dt: "2026-01-02T20:00:00Z" } },
    ];
    expect(
      aggregateRows(byId, offset, [
        { fn: "min", columnId: "dt" },
        { fn: "max", columnId: "dt" },
      ]),
    ).toEqual([
      {
        fn: "min",
        columnId: "dt",
        value: "2026-01-02T23:00:00+05:00",
        contributing: 2,
      },
      {
        fn: "max",
        columnId: "dt",
        value: "2026-01-02T20:00:00Z",
        contributing: 2,
      },
    ]);
  });

  it("counts distinct present values, keeping the empty string as a value", () => {
    expect(
      aggregateRows(byId, rows, [
        { fn: "distinctCount", columnId: "t" },
        { fn: "distinctCount", columnId: "s" },
      ]),
    ).toEqual([
      // "a" and "" are two distinct present values; r3's absent cell is excluded.
      { fn: "distinctCount", columnId: "t", value: 2, contributing: 2 },
      { fn: "distinctCount", columnId: "s", value: 2, contributing: 2 },
    ]);
  });

  it("keeps contributing distinct from distinct.size when a value repeats", () => {
    // Every prior distinctCount case happens to have distinct.size ===
    // contributing, which an implementation that (wrongly) returns
    // distinct.size for both fields would still pass. A repeated "a" forces
    // them apart: 3 present cells, only 2 distinct values.
    const repeated: TableRow[] = [
      { id: "x1", cells: { t: "a" } },
      { id: "x2", cells: { t: "" } },
      { id: "x3", cells: { t: "a" } },
    ];
    expect(
      aggregateRows(byId, repeated, [{ fn: "distinctCount", columnId: "t" }]),
    ).toEqual([
      { fn: "distinctCount", columnId: "t", value: 2, contributing: 3 },
    ]);
  });

  it("counts distinct option ids across rows for a multiselect column", () => {
    const tagged: TableRow[] = [
      { id: "x1", cells: { m: [ALPHA, BETA] } },
      { id: "x2", cells: { m: [ALPHA] } },
      { id: "x3", cells: {} },
    ];
    expect(
      aggregateRows(byId, tagged, [{ fn: "distinctCount", columnId: "m" }]),
    ).toEqual([
      { fn: "distinctCount", columnId: "m", value: 2, contributing: 2 },
    ]);
  });

  it("refuses a non-finite sum instead of returning Infinity", () => {
    const huge: TableRow[] = [
      { id: "a", cells: { n: Number.MAX_VALUE } },
      { id: "b", cells: { n: Number.MAX_VALUE } },
    ];
    expect(() =>
      aggregateRows(byId, huge, [{ fn: "sum", columnId: "n" }]),
    ).toThrow(/"n"/);
    let thrown: unknown;
    try {
      aggregateRows(byId, huge, [{ fn: "sum", columnId: "n" }]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CoreError);
    expect((thrown as CoreError).code).toBe("BAD_REQUEST");
  });

  it("enforces its own column-type preconditions even without assertAggregateSpecs", () => {
    // r1/r2's boolean cells would otherwise fold as 0/1 (false + true === 1);
    // Task 4 wires assertAggregateSpecs and aggregateRows together, but a
    // caller that skips or reorders that step must still get a rejection.
    expect(() =>
      aggregateRows(byId, rows, [{ fn: "sum", columnId: "b" }]),
    ).toThrow(/number/);
  });

  it("preserves the requested order of results", () => {
    const out = aggregateRows(byId, rows, [
      { fn: "max", columnId: "n" },
      { fn: "count" },
      { fn: "min", columnId: "n" },
    ]);
    expect(out.map((r) => r.fn)).toEqual(["max", "count", "min"]);
  });
});

describe("groupAndAggregate", () => {
  it("puts absent values in their own bucket, distinct from empty string", () => {
    const groups = groupAndAggregate(byId, rows, ["t"], [{ fn: "count" }]);
    expect(groups.map((g) => g.key[0]!.value)).toEqual(["", "a", null]);
    expect(groups.map((g) => g.matched)).toEqual([1, 1, 1]);
  });

  it("keeps false and zero as values, not absences", () => {
    const byBoolean = groupAndAggregate(byId, rows, ["b"], [{ fn: "count" }]);
    expect(byBoolean.map((g) => g.key[0]!.value)).toEqual([false, true]);
    expect(byBoolean.map((g) => g.matched)).toEqual([2, 1]);

    // r2's 0 must land in its own bucket, separate from r3's absent cell.
    const byNumber = groupAndAggregate(byId, rows, ["n"], [{ fn: "count" }]);
    expect(byNumber.map((g) => g.key[0]!.value)).toEqual([0, 2, null]);
    expect(byNumber.map((g) => g.matched)).toEqual([1, 1, 1]);
  });

  it("keeps a non-finite number cell out of the absent bucket", () => {
    // JSON.stringify renders both NaN/Infinity and an absent cell as "null";
    // a bucket id built from that alone would silently merge the two.
    const nonFinite: TableRow[] = [
      { id: "a", cells: { n: Number.POSITIVE_INFINITY } },
      { id: "b", cells: {} },
    ];
    const groups = groupAndAggregate(byId, nonFinite, ["n"], [{ fn: "count" }]);
    expect(groups.map((g) => g.key[0]!.value)).toEqual([Infinity, null]);
    expect(groups.map((g) => g.matched)).toEqual([1, 1]);
  });

  it("labels select groups from the schema revision it was given", () => {
    const groups = groupAndAggregate(byId, rows, ["s"], [{ fn: "count" }]);
    expect(groups.map((g) => g.key[0])).toEqual([
      { columnId: "s", value: DRAFT, label: "Draft" },
      { columnId: "s", value: LIVE, label: "Live" },
      { columnId: "s", value: null },
    ]);
  });

  it("keeps the raw id and omits the label for a stale select option", () => {
    const stale: TableRow[] = [
      { id: "r", cells: { s: "no-longer-an-option" } },
    ];
    const groups = groupAndAggregate(byId, stale, ["s"], [{ fn: "count" }]);
    expect(groups).toEqual([
      {
        key: [{ columnId: "s", value: "no-longer-an-option" }],
        matched: 1,
        aggregates: [
          { fn: "count", columnId: null, value: 1, contributing: 1 },
        ],
      },
    ]);
  });

  it("groups by two columns and orders left to right", () => {
    const groups = groupAndAggregate(byId, rows, ["t", "b"], [{ fn: "count" }]);
    expect(groups.map((g) => g.key.map((part) => part.value))).toEqual([
      ["", false],
      ["a", true],
      [null, false],
    ]);
  });

  it("aggregates within each group, not across the whole table", () => {
    const groups = groupAndAggregate(
      byId,
      rows,
      ["b"],
      [{ fn: "sum", columnId: "n" }],
    );
    expect(groups.map((g) => g.aggregates[0]!.value)).toEqual([0, 2]);
  });

  it("returns no groups for zero rows", () => {
    expect(groupAndAggregate(byId, [], ["t"], [{ fn: "count" }])).toEqual([]);
  });

  it("returns a single group covering every row when groupBy is empty", () => {
    const groups = groupAndAggregate(byId, rows, [], [{ fn: "count" }]);
    expect(groups).toEqual([
      {
        key: [],
        matched: 3,
        aggregates: [
          { fn: "count", columnId: null, value: 3, contributing: 3 },
        ],
      },
    ]);
  });

  it("keeps a deterministic order for two group keys that tie under compareCells", () => {
    // A number column holding 2 and the string "2" ties under compareCells'
    // defensive coercion (Number("2") === 2), yet the two rows are genuinely
    // distinct groups (JSON.stringify([2]) !== JSON.stringify(["2"])); the
    // bucket-id tiebreak in the sort must still put them in a fixed order.
    const tied: TableRow[] = [
      { id: "x", cells: { n: 2 } },
      { id: "y", cells: { n: "2" } },
    ];
    const groups = groupAndAggregate(byId, tied, ["n"], [{ fn: "count" }]);
    expect(groups.map((g) => g.key[0]!.value)).toEqual(["2", 2]);
    expect(groups.map((g) => g.matched)).toEqual([1, 1]);
  });

  it("truncates a long key for rendering while keeping bucket identity on the whole cell", () => {
    const shared = "x".repeat(MAX_GROUP_KEY_CHARS);
    const wide: TableRow[] = [
      { id: "a", cells: { t: `${shared}-alpha`, n: 1 } },
      { id: "b", cells: { t: `${shared}-beta`, n: 10 } },
      { id: "c", cells: { t: `${shared}-beta`, n: 100 } },
    ];
    const groups = groupAndAggregate(
      byId,
      wide,
      ["t"],
      [{ fn: "sum", columnId: "n" }],
    );
    // Two keys sharing their first MAX_GROUP_KEY_CHARS characters are still
    // two buckets, each with its own total — truncation must never merge them.
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.matched)).toEqual([1, 2]);
    expect(groups.map((g) => g.aggregates[0]!.value)).toEqual([1, 110]);
    // What is returned is cut and flagged.
    for (const group of groups)
      expect(group.key).toEqual([
        { columnId: "t", value: shared, valueTruncated: true },
      ]);
  });

  it("explodes a multiselect group-by into one bucket per option, plus a null bucket for rows with no value", () => {
    const tagged: TableRow[] = [
      { id: "r1", cells: { m: [ALPHA, BETA] } },
      { id: "r2", cells: { m: [ALPHA] } },
      { id: "r3", cells: {} },
    ];
    const groups = groupAndAggregate(byId, tagged, ["m"], [{ fn: "count" }]);
    expect(groups.map((g) => g.key[0])).toEqual([
      { columnId: "m", value: ALPHA, label: "Alpha" },
      { columnId: "m", value: BETA, label: "Beta" },
      { columnId: "m", value: null },
    ]);
    expect(groups.map((g) => g.matched)).toEqual([2, 1, 1]);
  });

  it("groups a datetime column by its raw string, with no label", () => {
    const scheduled: TableRow[] = [
      { id: "a", cells: { dt: "2026-01-02T10:00:00Z" } },
      { id: "b", cells: { dt: "2026-01-02T10:00:00Z" } },
      { id: "c", cells: { dt: "2026-01-03T10:00:00Z" } },
      { id: "d", cells: {} },
    ];
    const groups = groupAndAggregate(
      byId,
      scheduled,
      ["dt"],
      [{ fn: "count" }],
    );
    expect(groups.map((g) => g.key[0])).toEqual([
      { columnId: "dt", value: "2026-01-02T10:00:00Z" },
      { columnId: "dt", value: "2026-01-03T10:00:00Z" },
      { columnId: "dt", value: null },
    ]);
    expect(groups.map((g) => g.matched)).toEqual([2, 1, 1]);
  });

  it("leaves a key at the cap unflagged and uncut", () => {
    const exact = "y".repeat(MAX_GROUP_KEY_CHARS);
    const groups = groupAndAggregate(
      byId,
      [{ id: "a", cells: { t: exact } }],
      ["t"],
      [{ fn: "count" }],
    );
    expect(groups[0]!.key).toEqual([{ columnId: "t", value: exact }]);
  });
});

describe("assertGroupBy", () => {
  it("rejects an unknown column and a repeated one", () => {
    expect(() => assertGroupBy(byId, ["zz"])).toThrow(/zz/);
    expect(() => assertGroupBy(byId, ["t", "t"])).toThrow(/twice|duplicate/i);
    expect(() => assertGroupBy(byId, ["t", "b"])).not.toThrow();
  });

  it("does not itself cap the number of columns — that's groupBySchema's job", () => {
    expect(() => assertGroupBy(byId, ["t", "b", "n"])).not.toThrow();
  });
});

describe("aggregateSpecsSchema", () => {
  it("requires at least one spec and at most ten", () => {
    expect(aggregateSpecsSchema.safeParse([]).success).toBe(false);
    expect(
      aggregateSpecsSchema.safeParse(
        Array.from({ length: 10 }, () => ({ fn: "count" })),
      ).success,
    ).toBe(true);
    expect(
      aggregateSpecsSchema.safeParse(
        Array.from({ length: 11 }, () => ({ fn: "count" })),
      ).success,
    ).toBe(false);
  });
});

describe("groupBySchema", () => {
  it("allows up to two columns and rejects more", () => {
    expect(groupBySchema.safeParse(["t", "b"]).success).toBe(true);
    expect(groupBySchema.safeParse(["t", "b", "n"]).success).toBe(false);
  });
});

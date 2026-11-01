import { describe, expect, it } from "vitest";
import { CoreError } from "../errors";
import type { TableColumn, TableRow } from "./types";
import {
  coerceFilterValue,
  columnsById,
  compareCells,
  filterRows,
  filterValueSchema,
  matchesFilter,
  requireColumn,
  tableFiltersSchema,
} from "./query";

const columns: TableColumn[] = [
  { id: "t", name: "Title", type: "text" },
  { id: "n", name: "Count", type: "number" },
  { id: "b", name: "Done", type: "boolean" },
  { id: "d", name: "When", type: "date" },
];
const byId = columnsById(columns);

const rows: TableRow[] = [
  { id: "r1", cells: { t: "alpha", n: 2, b: true, d: "2026-01-02" } },
  { id: "r2", cells: { t: "beta", n: 0, b: false, d: "2026-01-01" } },
  { id: "r3", cells: { t: "", n: 10 } },
];

const OPT_A = "a1111111-1111-4111-8111-111111111111";
const OPT_B = "a2222222-2222-4222-8222-222222222222";
const C2 = "c2222222-2222-4222-8222-222222222222";
const C3 = "c3333333-3333-4333-8333-333333333333";
const C6 = "c6666666-6666-4666-8666-666666666666";
const C7 = "c7777777-7777-4777-8777-777777777777";

const multi: TableColumn = {
  id: C2,
  name: "m",
  type: "multiselect",
  options: [
    { id: OPT_A, label: "Alpha" },
    { id: OPT_B, label: "Beta" },
  ],
};
const dt: TableColumn = { id: C3, name: "dt", type: "datetime" };
const url: TableColumn = { id: C6, name: "u", type: "url" };
const long: TableColumn = { id: C7, name: "l", type: "longtext" };

describe("coerceFilterValue", () => {
  it("accepts a numeric string against a number column and converts it", () => {
    expect(
      coerceFilterValue(byId.get("n")!, {
        columnId: "n",
        op: "eq",
        value: "2",
      }),
    ).toEqual({ columnId: "n", op: "eq", value: 2 });
  });

  it("rejects a non-numeric value against a number column", () => {
    expect(() =>
      coerceFilterValue(byId.get("n")!, {
        columnId: "n",
        op: "eq",
        value: "two",
      }),
    ).toThrow(/must be a number/);
  });

  it("rejects contains against a number column and against a non-string value", () => {
    expect(() =>
      coerceFilterValue(byId.get("n")!, {
        columnId: "n",
        op: "contains",
        value: "2",
      }),
    ).toThrow(/contains/);
    expect(() =>
      coerceFilterValue(byId.get("t")!, {
        columnId: "t",
        op: "contains",
        value: 2,
      }),
    ).toThrow(/contains/);
  });

  it("requires a value for every op except isEmpty and notEmpty", () => {
    expect(() =>
      coerceFilterValue(byId.get("t")!, { columnId: "t", op: "eq" }),
    ).toThrow(/requires a value/);
    expect(
      coerceFilterValue(byId.get("t")!, { columnId: "t", op: "isEmpty" }),
    ).toEqual({ columnId: "t", op: "isEmpty" });
    expect(
      coerceFilterValue(byId.get("t")!, { columnId: "t", op: "notEmpty" }),
    ).toEqual({ columnId: "t", op: "notEmpty" });
  });

  it("throws CoreError, not a tool error, so core can own the language", () => {
    let thrown: unknown;
    try {
      coerceFilterValue(byId.get("b")!, {
        columnId: "b",
        op: "eq",
        value: "yes",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CoreError);
    expect((thrown as CoreError).code).toBe("BAD_REQUEST");
  });

  it("validates filters per type", () => {
    expect(
      coerceFilterValue(multi, { columnId: C2, op: "contains", value: OPT_A })
        .value,
    ).toBe(OPT_A);
    expect(() =>
      coerceFilterValue(multi, { columnId: C2, op: "contains", value: "nope" }),
    ).toThrow(/option/);
    expect(
      coerceFilterValue(multi, {
        columnId: C2,
        op: "eq",
        value: [OPT_B, OPT_A],
      }).value,
    ).toEqual([OPT_B, OPT_A]);
    expect(() =>
      coerceFilterValue(multi, { columnId: C2, op: "gt", value: [OPT_A] }),
    ).toThrow();
    expect(() =>
      coerceFilterValue(dt, { columnId: C3, op: "gt", value: "2026-09-18" }),
    ).toThrow(/datetime/);
    expect(
      coerceFilterValue(dt, {
        columnId: C3,
        op: "gt",
        value: "2026-09-18T00:00Z",
      }).value,
    ).toBe("2026-09-18T00:00:00Z");
    expect(() =>
      coerceFilterValue(url, { columnId: C6, op: "gt", value: "a" }),
    ).toThrow();
    expect(
      coerceFilterValue(long, { columnId: C7, op: "contains", value: "b" })
        .value,
    ).toBe("b");
  });

  it("validates and normalises a datetime eq/neq value the same as an ordering one", () => {
    expect(
      coerceFilterValue(dt, {
        columnId: C3,
        op: "eq",
        value: "2026-09-18T00:00Z",
      }).value,
    ).toBe("2026-09-18T00:00:00Z");
    expect(() =>
      coerceFilterValue(dt, { columnId: C3, op: "eq", value: "2026-09-18" }),
    ).toThrow(/datetime/);
    expect(() =>
      coerceFilterValue(dt, { columnId: C3, op: "neq", value: "not-a-date" }),
    ).toThrow(/datetime/);
  });
});

describe("matchesFilter", () => {
  it("treats an absent cell and an empty string as empty, but not zero or false", () => {
    const isEmpty = { columnId: "t", op: "isEmpty" } as const;
    expect(matchesFilter(undefined, isEmpty, byId.get("t")!)).toBe(true);
    expect(matchesFilter("", isEmpty, byId.get("t")!)).toBe(true);
    expect(matchesFilter(0, isEmpty, byId.get("t")!)).toBe(false);
    expect(matchesFilter(false, isEmpty, byId.get("t")!)).toBe(false);
  });

  it("compares case-insensitively for contains", () => {
    expect(
      matchesFilter(
        "Alpha",
        { columnId: "t", op: "contains", value: "PH" },
        byId.get("t")!,
      ),
    ).toBe(true);
  });

  it("never matches an absent cell for an ordering op", () => {
    expect(
      matchesFilter(
        undefined,
        { columnId: "n", op: "gt", value: 0 },
        byId.get("n")!,
      ),
    ).toBe(false);
  });

  it("matches notEmpty for a present, non-empty cell only", () => {
    const notEmpty = { columnId: "t", op: "notEmpty" } as const;
    expect(matchesFilter("alpha", notEmpty, byId.get("t")!)).toBe(true);
    expect(matchesFilter("", notEmpty, byId.get("t")!)).toBe(false);
    expect(matchesFilter(undefined, notEmpty, byId.get("t")!)).toBe(false);
  });

  it("matches lt and lte with correct boundary semantics", () => {
    expect(
      matchesFilter(5, { columnId: "n", op: "lt", value: 10 }, byId.get("n")!),
    ).toBe(true);
    expect(
      matchesFilter(10, { columnId: "n", op: "lt", value: 10 }, byId.get("n")!),
    ).toBe(false);
    expect(
      matchesFilter(
        10,
        { columnId: "n", op: "lte", value: 10 },
        byId.get("n")!,
      ),
    ).toBe(true);
    expect(
      matchesFilter(
        11,
        { columnId: "n", op: "lte", value: 10 },
        byId.get("n")!,
      ),
    ).toBe(false);
  });

  it("matches multiselect and datetime filters", () => {
    expect(
      matchesFilter(
        [OPT_A, OPT_B],
        { columnId: C2, op: "contains", value: OPT_A },
        multi,
      ),
    ).toBe(true);
    expect(
      matchesFilter(
        [OPT_A, OPT_B],
        { columnId: C2, op: "eq", value: [OPT_B, OPT_A] },
        multi,
      ),
    ).toBe(true);
    expect(
      matchesFilter(
        [OPT_A],
        { columnId: C2, op: "neq", value: [OPT_B] },
        multi,
      ),
    ).toBe(true);
    expect(
      matchesFilter(undefined, { columnId: C2, op: "isEmpty" }, multi),
    ).toBe(true);
    expect(
      matchesFilter(
        "2026-09-18T12:00:00+02:00",
        { columnId: C3, op: "lt", value: "2026-09-18T11:00:00Z" },
        dt,
      ),
    ).toBe(true);
  });

  it("treats an actual empty multiselect array as empty, not as a present value", () => {
    expect(matchesFilter([], { columnId: C2, op: "isEmpty" }, multi)).toBe(
      true,
    );
    expect(matchesFilter([], { columnId: C2, op: "notEmpty" }, multi)).toBe(
      false,
    );
  });

  it("compares datetime eq/neq by instant, not by printed offset, in both directions", () => {
    expect(
      matchesFilter(
        "2026-09-18T12:00:00+02:00",
        { columnId: C3, op: "eq", value: "2026-09-18T10:00:00Z" },
        dt,
      ),
    ).toBe(true);
    expect(
      matchesFilter(
        "2026-09-18T10:00:00Z",
        { columnId: C3, op: "eq", value: "2026-09-18T12:00:00+02:00" },
        dt,
      ),
    ).toBe(true);
    expect(
      matchesFilter(
        "2026-09-18T12:00:00+02:00",
        { columnId: C3, op: "neq", value: "2026-09-18T10:00:00Z" },
        dt,
      ),
    ).toBe(false);
    expect(
      matchesFilter(
        "2026-09-18T12:00:00+02:00",
        { columnId: C3, op: "neq", value: "2026-09-18T09:00:00Z" },
        dt,
      ),
    ).toBe(true);
  });
});

describe("compareCells", () => {
  it("orders a number column numerically, not lexically", () => {
    expect(compareCells(10, 9, "number")).toBeGreaterThan(0);
    expect(compareCells("10", "9", "text")).toBeLessThan(0);
  });

  it("orders false before true", () => {
    expect(compareCells(false, true, "boolean")).toBeLessThan(0);
  });

  it("sorts absent cells last regardless of type", () => {
    expect(compareCells(undefined, 1, "number")).toBeGreaterThan(0);
    expect(compareCells(1, undefined, "number")).toBeLessThan(0);
    expect(compareCells(undefined, undefined, "number")).toBe(0);
  });

  it("coerces a stray numeric-string cell in a number column and compares it numerically", () => {
    // Defensive coercion (see compareCells' docstring): a number column can
    // still hand back a string cell, and it must sort as the number it
    // represents, not lexically ("5" vs 10 would tie-break wrong lexically
    // since they're different JS types being stringified).
    expect(compareCells("5", 10, "number")).toBeLessThan(0);
  });

  it("falls through to string comparison for a genuinely non-numeric cell in a number column, instead of returning NaN", () => {
    // Both sides fail Number(...) here, so the numeric branch must decline
    // (via the isFinite guard) and let the lexical fallback decide, rather
    // than a NaN escaping and making every ordering comparison false.
    expect(compareCells("abc", "b", "number")).toBeLessThan(0);
  });

  it("sorts datetime by instant and multiselect by joined labels", () => {
    expect(
      compareCells("2026-09-18T12:00:00+02:00", "2026-09-18T11:00:00Z", dt),
    ).toBeLessThan(0);
    expect(compareCells([OPT_B], [OPT_A], multi)).toBeGreaterThan(0); // "Beta" > "Alpha"
  });
});

describe("filterRows", () => {
  it("applies every filter conjunctively and preserves input order", () => {
    // Each filter alone would admit a different row that the other excludes
    // (n gte 2 alone admits r3; t neq "" alone admits r2) — only a row
    // passing both survives, proving the filters AND together rather than
    // OR.
    expect(
      filterRows(byId, rows, [
        { columnId: "n", op: "gte", value: 2 },
        { columnId: "t", op: "neq", value: "" },
      ]).map((row) => row.id),
    ).toEqual(["r1"]);
  });

  it("coerces before matching, so a numeric string filter still matches", () => {
    expect(
      filterRows(byId, rows, [{ columnId: "n", op: "eq", value: "10" }]).map(
        (row) => row.id,
      ),
    ).toEqual(["r3"]);
  });

  it("returns every row when there are no filters", () => {
    expect(filterRows(byId, rows, []).map((row) => row.id)).toEqual([
      "r1",
      "r2",
      "r3",
    ]);
  });
});

describe("requireColumn", () => {
  it("names the unknown column", () => {
    expect(() => requireColumn(byId, "nope")).toThrow(/nope/);
  });
});

describe("filterValueSchema", () => {
  it("caps a filter value at MAX_FILTER_VALUE_CHARS, so one long value can't balloon a cursor's query identity", () => {
    expect(filterValueSchema.safeParse("x".repeat(2_000)).success).toBe(true);
    expect(filterValueSchema.safeParse("x".repeat(2_001)).success).toBe(false);
  });
});

describe("tableFiltersSchema", () => {
  it("caps the filter list at twenty", () => {
    const one = { columnId: "t", op: "isEmpty" as const };
    expect(tableFiltersSchema.safeParse(Array(20).fill(one)).success).toBe(
      true,
    );
    expect(tableFiltersSchema.safeParse(Array(21).fill(one)).success).toBe(
      false,
    );
  });
});

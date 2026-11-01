import { describe, expect, it } from "vitest";
import { sourceLocatorSchema } from "@weaver/core/assistant/citations";
import type { TableColumn, TableRow } from "@weaver/core/tables/types";
import {
  citedColumnIds,
  inlineRow,
  MAX_INLINE_CELL_CHARS,
  queryRows,
  summarizeColumn,
} from "./tables";

const columns: TableColumn[] = [
  { id: "n", name: "Name", type: "text" },
  { id: "p", name: "Priority", type: "number" },
  { id: "d", name: "Done", type: "boolean" },
];
const rows: TableRow[] = [
  { id: "r1", cells: { n: "Alpha", p: 3, d: false } },
  { id: "r2", cells: { n: "Beta", p: 1, d: true } },
  { id: "r3", cells: { n: "Gamma", p: 2 } },
];

describe("queryRows", () => {
  it("filters, sorts, projects, and paginates by offset", () => {
    const page = queryRows(columns, rows, {
      filters: [{ columnId: "d", op: "neq", value: true }],
      sort: { columnId: "p", dir: "asc" },
      select: ["n"],
      limit: 1,
    });
    expect(page).toEqual({
      rows: [{ id: "r3", cells: { n: "Gamma" } }],
      nextOffset: 1,
      matched: 2,
    });
    const next = queryRows(columns, rows, {
      filters: [{ columnId: "d", op: "neq", value: true }],
      sort: { columnId: "p", dir: "asc" },
      select: ["n"],
      limit: 1,
      offset: 1,
    });
    expect(next).toEqual({
      rows: [{ id: "r1", cells: { n: "Alpha" } }],
      nextOffset: null,
      matched: 2,
    });
  });

  it("breaks sort ties by row id and keeps file order when unsorted", () => {
    const tied: TableRow[] = [
      { id: "z", cells: { p: 1 } },
      { id: "a", cells: { p: 1 } },
      { id: "m", cells: { p: 1 } },
    ];
    expect(
      queryRows(columns, tied, {
        sort: { columnId: "p", dir: "asc" },
      }).rows.map((r) => r.id),
    ).toEqual(["a", "m", "z"]);
    expect(
      queryRows(columns, tied, {
        sort: { columnId: "p", dir: "desc" },
      }).rows.map((r) => r.id),
    ).toEqual(["a", "m", "z"]);
    expect(queryRows(columns, tied, {}).rows.map((r) => r.id)).toEqual([
      "z",
      "a",
      "m",
    ]);
  });

  it("replaces oversized string cells with typed metadata", () => {
    const big = "x".repeat(MAX_INLINE_CELL_CHARS + 1);
    const wide: TableRow[] = [{ id: "r1", cells: { n: big, p: 2 } }];
    expect(queryRows(columns, wide, {}).rows).toEqual([
      {
        id: "r1",
        cells: { p: 2 },
        oversizedCells: [{ columnId: "n", chars: MAX_INLINE_CELL_CHARS + 1 }],
      },
    ]);
    expect(inlineRow(wide[0]!, ["p"])).toEqual({ id: "r1", cells: { p: 2 } });
  });
  it("never marks an array (multiselect) cell oversized, however many ids it holds", () => {
    const tagOptions = Array.from({ length: 200 }, (_, i) => ({
      id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`,
      label: `Tag ${i}`,
    }));
    const tagColumns: TableColumn[] = [
      { id: "t", name: "Tags", type: "multiselect", options: tagOptions },
    ];
    const wideArray = tagOptions.map((o) => o.id);
    const tagRows: TableRow[] = [{ id: "r1", cells: { t: wideArray } }];
    // The array's serialized JSON is far past MAX_INLINE_CELL_CHARS, but
    // inlineRow only ever inspects string cells for oversizing.
    expect(JSON.stringify(wideArray).length).toBeGreaterThan(
      MAX_INLINE_CELL_CHARS,
    );
    const page = queryRows(tagColumns, tagRows, {});
    expect(page.rows).toEqual([{ id: "r1", cells: { t: wideArray } }]);
    expect(page.rows[0]).not.toHaveProperty("oversizedCells");
  });
  it("summarizes a multiselect column with an option count, like select", () => {
    const tagOptions = [
      { id: "o1", label: "A" },
      { id: "o2", label: "B" },
    ];
    expect(
      summarizeColumn({
        id: "t",
        name: "Tags",
        type: "multiselect",
        options: tagOptions,
      }),
    ).toEqual({ id: "t", name: "Tags", type: "multiselect", optionCount: 2 });
  });
  it("supports contains, comparisons, and emptiness", () => {
    expect(
      queryRows(columns, rows, {
        filters: [{ columnId: "n", op: "contains", value: "am" }],
      }).rows.map((r) => r.id),
    ).toEqual(["r3"]);
    expect(
      queryRows(columns, rows, {
        filters: [{ columnId: "p", op: "gte", value: 2 }],
      }).matched,
    ).toBe(2);
    expect(
      queryRows(columns, rows, {
        filters: [{ columnId: "d", op: "isEmpty" }],
      }).rows.map((r) => r.id),
    ).toEqual(["r3"]);
  });
  it("rejects unknown columns", () => {
    expect(() =>
      queryRows(columns, rows, {
        filters: [{ columnId: "zz", op: "eq", value: 1 }],
      }),
    ).toThrow(/unknown column/);
  });
});

describe("queryRows — typed filter values", () => {
  // A number column with a mix of single- and double-digit values: a naive
  // lexical comparison (the pre-fix behavior when filter.value arrived as a
  // string) sorts/compares "10" before "9", which is wrong for a number
  // column. These fixtures make that distinction observable.
  const numberColumns: TableColumn[] = [
    { id: "p", name: "Priority", type: "number" },
  ];
  const numberRows: TableRow[] = [
    { id: "nine", cells: { p: 9 } },
    { id: "ten", cells: { p: 10 } },
  ];

  it("coerces a numeric string filter value for a gt comparison instead of comparing lexically", () => {
    // Lexically, "10" < "9" (both start differently, "1" < "9"); numerically
    // 10 > 9. Only "ten" should match once the string "9" is coerced to 9.
    const matched = queryRows(numberColumns, numberRows, {
      filters: [{ columnId: "p", op: "gt", value: "9" }],
    }).rows.map((r) => r.id);
    expect(matched).toEqual(["ten"]);
  });

  it("coerces a numeric string filter value for an eq comparison instead of a strict ===", () => {
    // cell 9 === "9" is false under JS strict equality; coercion is required
    // for eq to match at all.
    const matched = queryRows(numberColumns, numberRows, {
      filters: [{ columnId: "p", op: "eq", value: "9" }],
    }).rows.map((r) => r.id);
    expect(matched).toEqual(["nine"]);
  });

  it("sorts a number column numerically even when given as-is, not lexically", () => {
    const ascending = queryRows(numberColumns, numberRows, {
      sort: { columnId: "p", dir: "asc" },
    }).rows.map((r) => r.id);
    // Lexical order would be ["ten", "nine"] ("10" < "9"); numeric order is
    // ["nine", "ten"] (9 < 10).
    expect(ascending).toEqual(["nine", "ten"]);
  });

  it("rejects an uncoercible filter value instead of silently matching nothing", () => {
    expect(() =>
      queryRows(numberColumns, numberRows, {
        filters: [{ columnId: "p", op: "eq", value: true }],
      }),
    ).toThrow(/must be a number/);
  });

  it("rejects a non-boolean value against a boolean column", () => {
    expect(() =>
      queryRows(columns, rows, {
        filters: [{ columnId: "d", op: "eq", value: "true" }],
      }),
    ).toThrow(/must be a boolean/);
  });

  it("rejects contains against a non-text column", () => {
    expect(() =>
      queryRows(numberColumns, numberRows, {
        filters: [{ columnId: "p", op: "contains", value: "9" }],
      }),
    ).toThrow(/contains filter/);
  });
});

describe("citedColumnIds", () => {
  it("caps at the citation schema's 50-column limit", () => {
    const many = Array.from({ length: 120 }, (_, i) => `c${i}`);
    expect(citedColumnIds(many)).toEqual(many.slice(0, 50));
    expect(citedColumnIds(many)).toHaveLength(50);
  });

  it("keeps the emitted table citation valid for a table with more than 50 columns", () => {
    const many = Array.from({ length: 120 }, (_, i) => `c${i}`);
    const citation = {
      kind: "table" as const,
      projectId: "11111111-1111-4111-8111-111111111111",
      tableId: "22222222-2222-4222-8222-222222222222",
      commitSha: "a".repeat(40),
      rowIds: [],
      columnIds: citedColumnIds(many),
    };
    // Proves the cap is load-bearing: the uncapped list fails the same
    // schema (validateSourceLocators would drop the citation entirely),
    // while the capped one — what the tools now actually emit — passes.
    expect(sourceLocatorSchema.safeParse(citation).success).toBe(true);
    expect(
      sourceLocatorSchema.safeParse({ ...citation, columnIds: many }).success,
    ).toBe(false);
  });
});

it("keeps missing values last in descending table queries", () => {
  const result = queryRows(columns, [...rows, { id: "missing", cells: {} }], {
    sort: { columnId: "p", dir: "desc" },
  });
  expect(result.rows.map((row) => row.id)).toEqual([
    "r1",
    "r3",
    "r2",
    "missing",
  ]);
});

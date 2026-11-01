import { describe, expect, it } from "vitest";
import { headerOverflowWarning, tableFromRows } from "./table";

describe("tableFromRows", () => {
  it("uses the first row as header, names blanks, and de-duplicates", () => {
    expect(
      tableFromRows(
        [
          [" Name ", "", "Name", "Total"],
          ["a", "b"],
          ["c", "d", "e", "f", "extra"],
        ],
        "Sheet1",
      ),
    ).toEqual({
      name: "Sheet1",
      columns: ["Name", "Column 2", "Name (2)", "Total", "Column 5"],
      rows: [
        ["a", "b", "", "", ""],
        ["c", "d", "e", "f", "extra"],
      ],
    });
  });

  it("keeps cells beyond the header in generated columns", () => {
    expect(tableFromRows([["Name"], ["Ada", "42"]], null)).toEqual({
      name: null,
      columns: ["Name", "Column 2"],
      rows: [["Ada", "42"]],
    });
    expect(tableFromRows([["Column 2"], ["Ada", "42"]], null)).toMatchObject({
      columns: ["Column 2", "Column 2 (2)"],
    });
  });

  it("adds no column for trailing empty cells", () => {
    expect(
      tableFromRows(
        [
          ["a", "b"],
          ["1", "2", "", " "],
        ],
        null,
      ),
    ).toEqual({ name: null, columns: ["a", "b"], rows: [["1", "2"]] });
  });

  it("aggregates overflowing rows into one note counted from the header", () => {
    expect(
      headerOverflowWarning([["Name"], ["Ada"], ["Bob", "1"], ["Cy", "", "2"]]),
    ).toBe(
      "2 rows had more cells than the header; the extra values were kept in generated columns (first: row 3)",
    );
    expect(headerOverflowWarning([["Name"], ["Ada", "42"]])).toMatch(
      /^1 row had more cells/,
    );
    expect(
      headerOverflowWarning([
        ["a", "b"],
        ["1", "2", "", ""],
      ]),
    ).toBeNull();
    expect(headerOverflowWarning([])).toBeNull();
  });

  it.each([
    {
      header: ["Name", "Name", "Name (2)"],
      columns: ["Name", "Name (2)", "Name (2) (2)"],
    },
    {
      header: ["Name", "Name (2)", "Name"],
      columns: ["Name", "Name (2)", "Name (3)"],
    },
    {
      header: ["Column 2", " ", "Column 2 (2)", ""],
      columns: ["Column 2", "Column 2 (2)", "Column 2 (2) (2)", "Column 4"],
    },
  ])(
    "avoids collisions with emitted names in $header",
    ({ header, columns }) => {
      expect(tableFromRows([header], null)).toEqual({
        name: null,
        columns,
        rows: [],
      });
    },
  );

  it("reserves suffix space when repeated headers fill the name limit", () => {
    const header = "x".repeat(100);
    expect(tableFromRows([Array<string>(10).fill(header)], null)).toEqual({
      name: null,
      columns: [
        header,
        ...Array.from(
          { length: 8 },
          (_, index) => `${"x".repeat(96)} (${index + 2})`,
        ),
        `${"x".repeat(95)} (10)`,
      ],
      rows: [],
    });
  });

  it("checks collisions between truncated bases and existing suffixed names", () => {
    const base = "x".repeat(100);
    const suffixed = `${"x".repeat(96)} (2)`;
    expect(tableFromRows([[suffixed, `${base}a`, `${base}b`]], null)).toEqual({
      name: null,
      columns: [suffixed, base, `${"x".repeat(96)} (3)`],
      rows: [],
    });
  });

  it("reports bounds as validation failures", () => {
    expect(tableFromRows([], null)).toMatchObject({
      failureKind: "validation",
      message: "the spreadsheet contains no data",
    });
    expect(
      tableFromRows(
        [Array.from({ length: 101 }, (_, index) => `C${index}`)],
        null,
      ),
    ).toMatchObject({
      failureKind: "validation",
      message: /at most 100 columns/,
    });
    expect(
      tableFromRows(
        [["A"], Array.from({ length: 101 }, (_, index) => `v${index}`)],
        null,
      ),
    ).toMatchObject({
      failureKind: "validation",
      message: /at most 100 columns/,
    });
    expect(
      tableFromRows(
        [["A"], ...Array.from({ length: 1_001 }, () => ["x"])],
        null,
      ),
    ).toMatchObject({
      failureKind: "validation",
      message: /at most 1000 rows/,
    });
  });
});

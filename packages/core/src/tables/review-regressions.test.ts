import { expect, it } from "vitest";
import { inferColumnType, parseCsv } from "./csv";
import { applyTableChange } from "./change";
import { compareCells, coerceFilterValue } from "./query";
import { aggregateRows, groupAndAggregate } from "./aggregate";
import { isValidIsoDate } from "./validation";
import type { TableColumn, TableData } from "./types";

it("preserves identifiers during CSV inference and skips blank records", () => {
  expect(inferColumnType(["01067", "04109"])).toBe("text");
  expect(inferColumnType(["+4917612345678"])).toBe("text");
  expect(parseCsv("a,b\n1,2\n\n3,4\n\n").rows).toEqual([
    ["1", "2"],
    ["3", "4"],
  ]);
});
const select: TableColumn = {
  id: "stage",
  name: "Stage",
  type: "select",
  options: [
    { id: "z", label: "Alpha" },
    { id: "a", label: "Zulu" },
  ],
};
it("sorts select labels and rejects invalid select filters", () => {
  expect(compareCells("z", "a", select)).toBeLessThan(0);
  expect(() =>
    coerceFilterValue(select, { columnId: "stage", op: "eq", value: "Alpha" }),
  ).toThrow();
  expect(() =>
    coerceFilterValue(select, {
      columnId: "stage",
      op: "contains",
      value: "z",
    }),
  ).toThrow();
});
it("requires explicit cell replacement on select retype and clears removed columns", () => {
  const table: TableData = {
    title: "T",
    columns: [select, { id: "name", name: "Name", type: "text" }],
    rows: [{ id: "r", cells: { stage: "z" } }],
  };
  const rows = { inserts: [], updates: [], deletes: [] };
  expect(() =>
    applyTableChange(table, {
      columns: [{ op: "retype", columnId: "stage", type: "text" }],
      rows,
    }),
  ).toThrow();
  expect(
    applyTableChange(table, {
      columns: [
        { op: "remove", columnId: "stage" },
        { op: "add", column: select },
      ],
      rows,
    }).rows[0]!.cells,
  ).toEqual({});
});
it("compares datetime group keys and distinct values by instant", () => {
  const columns = new Map<string, TableColumn>([
    ["at", { id: "at", name: "At", type: "datetime" }],
  ]);
  const rows = [
    { id: "a", cells: { at: "2026-09-22T10:00:00Z" } },
    { id: "b", cells: { at: "2026-09-22T11:00:00+01:00" } },
  ];
  expect(
    aggregateRows(columns, rows, [{ fn: "distinctCount", columnId: "at" }])[0]!
      .value,
  ).toBe(1);
  expect(
    groupAndAggregate(columns, rows, ["at"], [{ fn: "count" }]),
  ).toHaveLength(1);
});
it("restricts dates and date filters to calendar dates", () => {
  expect(isValidIsoDate("2026-09-22T10:00:00Z")).toBe(false);
  expect(() =>
    coerceFilterValue(
      { id: "date", name: "Date", type: "date" },
      { columnId: "date", op: "gt", value: "2026-1-5" },
    ),
  ).toThrow();
});

it("decodes Excel legacy and UTF-16 CSV without replacement characters", async () => {
  const { decodeCsvBytes } = await import("./csv");
  expect(decodeCsvBytes(new Uint8Array([77, 252, 108, 108, 101, 114]))).toBe(
    "Müller",
  );
  expect(decodeCsvBytes(new Uint8Array([255, 254, 77, 0, 252, 0]))).toBe("Mü");
  expect(decodeCsvBytes(new Uint8Array([254, 255, 0, 77, 0, 252]))).toBe("Mü");
});

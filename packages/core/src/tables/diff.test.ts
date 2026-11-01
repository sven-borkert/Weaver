import { describe, expect, it } from "vitest";
import { diffTables } from "./diff";
import type { TableColumn, TableData } from "./types";

const C1: TableColumn = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "A",
  type: "text",
};
const C2: TableColumn = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "B",
  type: "number",
};
const R1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const R2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("diffTables", () => {
  it("reports title, column, row, and cell changes", () => {
    const from: TableData = {
      title: "Old",
      columns: [C1],
      rows: [
        { id: R1, cells: { [C1.id]: "a" } },
        { id: R2, cells: { [C1.id]: "gone" } },
      ],
    };
    const to: TableData = {
      title: "New",
      columns: [{ ...C1, name: "A2" }, C2],
      rows: [{ id: R1, cells: { [C1.id]: "b", [C2.id]: 7 } }],
    };
    expect(diffTables(from, to)).toEqual({
      titleChange: { from: "Old", to: "New" },
      columnChanges: [
        { kind: "renamed", columnId: C1.id, from: "A", to: "A2" },
        { kind: "added", column: C2 },
      ],
      columnsReordered: false,
      rowsReordered: false,
      addedRows: [],
      removedRows: [R2],
      changedCells: [
        { rowId: R1, columnId: C1.id, from: "a", to: "b" },
        { rowId: R1, columnId: C2.id, from: null, to: 7 },
      ],
    });
  });

  it("reports removals and retypes", () => {
    const from: TableData = { title: "T", columns: [C1, C2], rows: [] };
    const to: TableData = {
      title: "T",
      columns: [{ ...C1, type: "number" }],
      rows: [{ id: R1, cells: {} }],
    };
    expect(diffTables(from, to)).toEqual({
      titleChange: null,
      columnChanges: [
        { kind: "retyped", columnId: C1.id, from: "text", to: "number" },
        { kind: "removed", column: C2 },
      ],
      columnsReordered: false,
      rowsReordered: false,
      addedRows: [R1],
      removedRows: [],
      changedCells: [],
    });
  });

  it("returns an empty diff for identical tables", () => {
    const data: TableData = {
      title: "T",
      columns: [C1],
      rows: [{ id: R1, cells: {} }],
    };
    expect(diffTables(data, data)).toEqual({
      titleChange: null,
      columnChanges: [],
      columnsReordered: false,
      rowsReordered: false,
      addedRows: [],
      removedRows: [],
      changedCells: [],
    });
  });

  it("reports changes to stored keys absent from both schemas", () => {
    const from: TableData = {
      title: "T",
      columns: [],
      rows: [{ id: R1, cells: { legacy: "old" } }],
    };
    const to: TableData = {
      title: "T",
      columns: [],
      rows: [{ id: R1, cells: { legacy: 7, removed: "gone" } }],
    };
    expect(diffTables(from, to).changedCells).toEqual([
      { rowId: R1, columnId: "legacy", from: "old", to: 7 },
      { rowId: R1, columnId: "removed", from: null, to: "gone" },
    ]);
  });

  it("does not report an unchanged multiselect cell as changed", () => {
    const MULTI: TableColumn = {
      id: "33333333-3333-4333-8333-333333333333",
      name: "Tags",
      type: "multiselect",
      options: [
        { id: "44444444-4444-4444-8444-444444444444", label: "Urgent" },
        { id: "55555555-5555-4555-8555-555555555555", label: "Blocked" },
      ],
    };
    const OPT_A = "44444444-4444-4444-8444-444444444444";
    const OPT_B = "55555555-5555-4555-8555-555555555555";
    // Distinct objects per side: reference equality would hide an Object.is regression.
    const snapshot = (): TableData => ({
      title: "T",
      columns: [MULTI],
      rows: [{ id: R1, cells: { [MULTI.id]: [OPT_A, OPT_B] } }],
    });
    const data = snapshot();
    expect(diffTables(snapshot(), snapshot()).changedCells).toEqual([]);

    const changed: TableData = {
      title: "T",
      columns: [MULTI],
      rows: [{ id: R1, cells: { [MULTI.id]: [OPT_B] } }],
    };
    expect(diffTables(data, changed).changedCells).toEqual([
      { rowId: R1, columnId: MULTI.id, from: [OPT_A, OPT_B], to: [OPT_B] },
    ]);
  });
  it("reports column and row reordering even when nothing else changed", () => {
    const from: TableData = {
      title: "T",
      columns: [C1, C2],
      rows: [
        { id: R1, cells: {} },
        { id: R2, cells: {} },
      ],
    };
    const moved = diffTables(from, { ...from, columns: [C2, C1] });
    expect(moved.columnsReordered).toBe(true);
    expect(moved.rowsReordered).toBe(false);
    expect(
      diffTables(from, { ...from, rows: [...from.rows].reverse() })
        .rowsReordered,
    ).toBe(true);
    // Adding or removing an entry is not a reorder of the shared ones.
    expect(diffTables(from, { ...from, columns: [C2] }).columnsReordered).toBe(
      false,
    );
  });
});

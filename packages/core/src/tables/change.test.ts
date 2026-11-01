import { describe, expect, it } from "vitest";
import { applyTableChange, type TableChange } from "./change";
import type { TableData } from "./types";

const NAME = "11111111-1111-4111-8111-111111111111";
const STAGE = "22222222-2222-4222-8222-222222222222";

const base: TableData = {
  title: "T",
  columns: [
    { id: NAME, name: "Name", type: "text" },
    {
      id: STAGE,
      name: "Stage",
      type: "select",
      options: [
        { id: "o1", label: "New" },
        { id: "o2", label: "Done" },
      ],
    },
  ],
  rows: [
    { id: "r1", cells: { [NAME]: "Ann", [STAGE]: "o1" } },
    { id: "r2", cells: { [NAME]: "Bo", [STAGE]: "o2" } },
  ],
};

const noRows = { inserts: [], updates: [], deletes: [] };
const change = (partial: Partial<TableChange>): TableChange => ({
  columns: [],
  rows: noRows,
  ...partial,
});

describe("title and rows", () => {
  it("changes only the title", () => {
    const out = applyTableChange(base, change({ title: "New" }));
    expect(out.title).toBe("New");
    expect(out.rows).toEqual(base.rows);
  });

  it("clears only the named keys and leaves others untouched", () => {
    const out = applyTableChange(
      base,
      change({
        rows: { ...noRows, updates: [{ rowId: "r1", clear: [STAGE] }] },
      }),
    );
    expect(out.rows[0]!.cells).toEqual({ [NAME]: "Ann" });
    expect(out.rows[1]!.cells).toEqual({ [NAME]: "Bo", [STAGE]: "o2" });
  });

  it("treats false, zero and empty string as values, not clears", () => {
    const flag = "33333333-3333-4333-8333-333333333333";
    const withFlag = applyTableChange(
      base,
      change({
        columns: [
          { op: "add", column: { id: flag, name: "Flag", type: "boolean" } },
        ],
        rows: { ...noRows, updates: [{ rowId: "r1", set: { [flag]: false } }] },
      }),
    );
    expect(withFlag.rows[0]!.cells[flag]).toBe(false);
    const emptied = applyTableChange(
      base,
      change({
        rows: { ...noRows, updates: [{ rowId: "r1", set: { [NAME]: "" } }] },
      }),
    );
    expect(emptied.rows[0]!.cells[NAME]).toBe("");
  });

  it("rejects a column that appears in both set and clear", () => {
    expect(() =>
      applyTableChange(
        base,
        change({
          rows: {
            ...noRows,
            updates: [{ rowId: "r1", set: { [NAME]: "x" }, clear: [NAME] }],
          },
        }),
      ),
    ).toThrow(/both set and clear/);
  });

  it("rejects updates and deletes for unknown rows", () => {
    expect(() =>
      applyTableChange(
        base,
        change({ rows: { ...noRows, updates: [{ rowId: "rX", set: {} }] } }),
      ),
    ).toThrow(/unknown row rX/);
    expect(() =>
      applyTableChange(base, change({ rows: { ...noRows, deletes: ["rX"] } })),
    ).toThrow(/unknown row rX/);
  });
});

describe("columns and options", () => {
  it("drops the cells of a removed column", () => {
    const out = applyTableChange(
      base,
      change({ columns: [{ op: "remove", columnId: STAGE }] }),
    );
    expect(out.rows.map((row) => row.cells)).toEqual([
      { [NAME]: "Ann" },
      { [NAME]: "Bo" },
    ]);
  });

  it("keeps the option id and referencing cells when renaming an option", () => {
    const out = applyTableChange(
      base,
      change({
        columns: [
          {
            op: "option_rename",
            columnId: STAGE,
            optionId: "o1",
            label: "Fresh",
          },
        ],
      }),
    );
    expect(out.columns[1]!.options).toEqual([
      { id: "o1", label: "Fresh" },
      { id: "o2", label: "Done" },
    ]);
    expect(out.rows[0]!.cells[STAGE]).toBe("o1");
  });

  it("refuses to remove an option that cells still reference, and accepts an explicit clear", () => {
    expect(() =>
      applyTableChange(
        base,
        change({
          columns: [{ op: "option_remove", columnId: STAGE, optionId: "o1" }],
        }),
      ),
    ).toThrow(/invalid final table state/);
    const fixed = applyTableChange(
      base,
      change({
        columns: [{ op: "option_remove", columnId: STAGE, optionId: "o1" }],
        rows: { ...noRows, updates: [{ rowId: "r1", clear: [STAGE] }] },
      }),
    );
    expect(fixed.rows[0]!.cells).toEqual({ [NAME]: "Ann" });
  });

  it("reorders columns and rejects an incomplete permutation", () => {
    expect(
      applyTableChange(
        base,
        change({ columns: [{ op: "reorder", columnIds: [STAGE, NAME] }] }),
      ).columns.map((column) => column.name),
    ).toEqual(["Stage", "Name"]);
    expect(() =>
      applyTableChange(
        base,
        change({ columns: [{ op: "reorder", columnIds: [STAGE] }] }),
      ),
    ).toThrow(/every current column id exactly once/);
  });

  it("rejects duplicate column names and removing the last column", () => {
    expect(() =>
      applyTableChange(
        base,
        change({ columns: [{ op: "rename", columnId: STAGE, name: "name" }] }),
      ),
    ).toThrow(/duplicate column name/);
    expect(() =>
      applyTableChange(
        base,
        change({
          columns: [
            { op: "remove", columnId: NAME },
            { op: "remove", columnId: STAGE },
          ],
        }),
      ),
    ).toThrow(/at least one column/);
  });
});

describe("multiselect columns", () => {
  const TAGS = "44444444-4444-4444-8444-444444444444";
  const multiBase: TableData = {
    title: "T",
    columns: [
      { id: NAME, name: "Name", type: "text" },
      {
        id: TAGS,
        name: "Tags",
        type: "multiselect",
        options: [
          { id: "o1", label: "Alpha" },
          { id: "o2", label: "Beta" },
        ],
      },
    ],
    rows: [
      { id: "r1", cells: { [NAME]: "Ann", [TAGS]: ["o1", "o2"] } },
      { id: "r2", cells: { [NAME]: "Bo", [TAGS]: ["o2"] } },
    ],
  };

  it("adds, renames, and removes options on a multiselect column, same as select", () => {
    const added = applyTableChange(
      multiBase,
      change({
        columns: [
          {
            op: "option_add",
            columnId: TAGS,
            option: { id: "o3", label: "Gamma" },
          },
        ],
      }),
    );
    expect(added.columns[1]!.options).toEqual([
      { id: "o1", label: "Alpha" },
      { id: "o2", label: "Beta" },
      { id: "o3", label: "Gamma" },
    ]);
    const renamed = applyTableChange(
      multiBase,
      change({
        columns: [
          {
            op: "option_rename",
            columnId: TAGS,
            optionId: "o1",
            label: "Fresh",
          },
        ],
      }),
    );
    expect(renamed.columns[1]!.options).toEqual([
      { id: "o1", label: "Fresh" },
      { id: "o2", label: "Beta" },
    ]);
    expect(renamed.rows[0]!.cells[TAGS]).toEqual(["o1", "o2"]);
  });

  it("refuses to remove an option that multiselect cells still reference, same as select", () => {
    expect.assertions(4);
    try {
      applyTableChange(
        multiBase,
        change({
          columns: [{ op: "option_remove", columnId: TAGS, optionId: "o2" }],
        }),
      );
    } catch (error) {
      expect((error as Error).message).toContain(
        `r2/${TAGS}: invalid value for type multiselect`,
      );
      expect((error as { details?: { reason?: string } }).details?.reason).toBe(
        "INVALID_FINAL_STATE",
      );
    }
    // Unchanged select behaviour, side by side with the multiselect case
    // above: table.change is explicit by design, so neither column type
    // auto-strips a removed option from referencing cells.
    try {
      applyTableChange(
        base,
        change({
          columns: [{ op: "option_remove", columnId: STAGE, optionId: "o1" }],
        }),
      );
    } catch (error) {
      expect((error as Error).message).toContain(
        `r1/${STAGE}: invalid value for type select`,
      );
      expect((error as { details?: { reason?: string } }).details?.reason).toBe(
        "INVALID_FINAL_STATE",
      );
    }
  });

  it("accepts a removed multiselect option together with explicit row changes that drop it", () => {
    // r1 held [o1, o2]: an explicit `set` drops the removed id and keeps the
    // cell. r2 held only [o2]: an explicit `clear` is required since the set
    // would otherwise leave an empty array (rejected: arrays are non-empty).
    const out = applyTableChange(
      multiBase,
      change({
        columns: [{ op: "option_remove", columnId: TAGS, optionId: "o2" }],
        rows: {
          ...noRows,
          updates: [
            { rowId: "r1", set: { [TAGS]: ["o1"] } },
            { rowId: "r2", clear: [TAGS] },
          ],
        },
      }),
    );
    expect(out.rows[0]!.cells[TAGS]).toEqual(["o1"]);
    expect(out.rows[1]!.cells).toEqual({ [NAME]: "Bo" });
  });

  it("refuses a select-to-multiselect retype with no explicit cell updates", () => {
    expect.assertions(2);
    try {
      applyTableChange(
        base,
        change({
          columns: [{ op: "retype", columnId: STAGE, type: "multiselect" }],
        }),
      );
    } catch (error) {
      expect((error as Error).message).toContain(
        `r1/${STAGE}: invalid value for type multiselect`,
      );
      expect((error as { details?: { reason?: string } }).details?.reason).toBe(
        "INVALID_FINAL_STATE",
      );
    }
  });

  it("retypes select to multiselect with explicit cell updates, keeping the options (and the reverse)", () => {
    const toMulti = applyTableChange(
      base,
      change({
        columns: [{ op: "retype", columnId: STAGE, type: "multiselect" }],
        rows: {
          ...noRows,
          updates: [
            { rowId: "r1", set: { [STAGE]: ["o1"] } },
            { rowId: "r2", set: { [STAGE]: ["o2"] } },
          ],
        },
      }),
    );
    expect(toMulti.columns[1]!.type).toBe("multiselect");
    expect(toMulti.columns[1]!.options).toEqual([
      { id: "o1", label: "New" },
      { id: "o2", label: "Done" },
    ]);
    expect(toMulti.rows.map((row) => row.cells[STAGE])).toEqual([
      ["o1"],
      ["o2"],
    ]);

    const backToSelect = applyTableChange(
      multiBase,
      change({
        columns: [{ op: "retype", columnId: TAGS, type: "select" }],
        rows: {
          ...noRows,
          updates: [
            { rowId: "r1", set: { [TAGS]: "o1" } },
            { rowId: "r2", set: { [TAGS]: "o2" } },
          ],
        },
      }),
    );
    expect(backToSelect.columns[1]!.type).toBe("select");
    expect(backToSelect.columns[1]!.options).toEqual([
      { id: "o1", label: "Alpha" },
      { id: "o2", label: "Beta" },
    ]);
  });
});

describe("final-state validation", () => {
  it("refuses a retype whose existing values are invalid under the new type", () => {
    expect.assertions(2);
    try {
      applyTableChange(
        base,
        change({ columns: [{ op: "retype", columnId: NAME, type: "number" }] }),
      );
    } catch (error) {
      expect((error as Error).message).toMatch(/invalid final table state/);
      expect((error as { details?: { reason?: string } }).details?.reason).toBe(
        "INVALID_FINAL_STATE",
      );
    }
  });

  it("refuses a retype to select that leaves the column without options", () => {
    expect.assertions(2);
    try {
      applyTableChange(
        base,
        change({ columns: [{ op: "retype", columnId: NAME, type: "select" }] }),
      );
    } catch (error) {
      expect((error as Error).message).toMatch(
        /invalid select\/multiselect options/,
      );
      expect((error as { details?: { reason?: string } }).details?.reason).toBe(
        "INVALID_FINAL_STATE",
      );
    }
  });

  it("refuses options left on a column retyped away from select", () => {
    expect.assertions(2);
    try {
      applyTableChange(
        base,
        change({
          columns: [
            {
              op: "retype",
              columnId: STAGE,
              type: "text",
              options: [{ id: "o1", label: "New" }],
            },
          ],
        }),
      );
    } catch (error) {
      expect((error as Error).message).toMatch(
        /options are only valid on select\/multiselect columns/,
      );
      expect((error as { details?: { reason?: string } }).details?.reason).toBe(
        "INVALID_FINAL_STATE",
      );
    }
  });

  it("refuses a select column whose last option was removed", () => {
    expect(() =>
      applyTableChange(
        base,
        change({
          columns: [
            { op: "option_remove", columnId: STAGE, optionId: "o1" },
            { op: "option_remove", columnId: STAGE, optionId: "o2" },
          ],
          rows: {
            ...noRows,
            updates: [
              { rowId: "r1", clear: [STAGE] },
              { rowId: "r2", clear: [STAGE] },
            ],
          },
        }),
      ),
    ).toThrow(/invalid select\/multiselect options/);
  });

  it("accepts a retype together with its explicit conversions in one change", () => {
    const out = applyTableChange(
      base,
      change({
        columns: [{ op: "retype", columnId: NAME, type: "number" }],
        rows: {
          ...noRows,
          updates: [
            { rowId: "r1", set: { [NAME]: 1 } },
            { rowId: "r2", set: { [NAME]: 2 } },
          ],
        },
      }),
    );
    expect(out.columns[0]!.type).toBe("number");
    expect(out.rows.map((row) => row.cells[NAME])).toEqual([1, 2]);
  });
});

describe("mutation safety", () => {
  it("never mutates the table it is given", () => {
    const before = structuredClone(base);
    applyTableChange(
      base,
      change({
        columns: [
          {
            op: "option_rename",
            columnId: STAGE,
            optionId: "o1",
            label: "Fresh",
          },
        ],
      }),
    );
    expect(base).toEqual(before);
  });
});

import { describe, expect, it } from "vitest";
import { mergeTables } from "./merge";
import type { TableColumn, TableData, TableRow } from "./types";

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
const C3: TableColumn = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "C",
  type: "text",
};
const R1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const R2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const R3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const row = (id: string, cells: TableRow["cells"]): TableRow => ({ id, cells });
const data = (
  title: string,
  columns: TableColumn[],
  rows: TableRow[],
): TableData => ({ title, columns, rows });

describe("mergeTables rows", () => {
  const base = data("T", [C1, C2], [row(R1, { [C1.id]: "a", [C2.id]: 1 })]);

  it("merges disjoint cell edits on the same row", () => {
    const theirs = data(
      "T",
      [C1, C2],
      [row(R1, { [C1.id]: "a2", [C2.id]: 1 })],
    );
    const ours = data("T", [C1, C2], [row(R1, { [C1.id]: "a", [C2.id]: 2 })]);
    expect(mergeTables(base, theirs, ours)).toEqual({
      ok: true,
      merged: data("T", [C1, C2], [row(R1, { [C1.id]: "a2", [C2.id]: 2 })]),
    });
  });

  it("merges row adds on both sides and deletes", () => {
    const b = data("T", [C1], [row(R1, {}), row(R2, {})]);
    const theirs = data("T", [C1], [row(R2, {}), row(R3, { [C1.id]: "new" })]);
    expect(mergeTables(b, theirs, b)).toEqual({
      ok: true,
      merged: data("T", [C1], [row(R2, {}), row(R3, { [C1.id]: "new" })]),
    });
  });

  it("keeps surviving base order before their then our additions", () => {
    const b = data("T", [C1], [row(R1, {}), row(R2, {})]);
    const r4 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const theirs = data("T", [C1], [row(R1, {}), row(R2, {}), row(R3, {})]);
    const ours = data("T", [C1], [row(R2, {}), row(r4, {})]);
    const result = mergeTables(b, theirs, ours);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.merged.rows.map((entry) => entry.id)).toEqual([R2, R3, r4]);
    }
  });

  it("conflicts on the same cell changed differently", () => {
    const theirs = data("T", [C1, C2], [row(R1, { [C1.id]: "x", [C2.id]: 1 })]);
    const ours = data("T", [C1, C2], [row(R1, { [C1.id]: "y", [C2.id]: 1 })]);
    expect(mergeTables(base, theirs, ours)).toEqual({
      ok: false,
      conflicts: [{ kind: "cell", rowId: R1, columnId: C1.id }],
    });
  });

  it("accepts the same cell changed identically", () => {
    const theirs = data("T", [C1, C2], [row(R1, { [C1.id]: "x", [C2.id]: 1 })]);
    const ours = data("T", [C1, C2], [row(R1, { [C1.id]: "x", [C2.id]: 1 })]);
    expect(mergeTables(base, theirs, ours).ok).toBe(true);
  });

  it("keeps a cell deleted identically by both sides deleted", () => {
    const without = data("T", [C1, C2], [row(R1, { [C2.id]: 1 })]);
    expect(mergeTables(base, without, without)).toEqual({
      ok: true,
      merged: without,
    });
  });

  it("conflicts on delete-vs-edit of a row", () => {
    const b = data("T", [C1], [row(R1, {}), row(R2, { [C1.id]: "keep" })]);
    const theirs = data("T", [C1], [row(R1, {})]);
    const ours = data("T", [C1], [row(R1, {}), row(R2, { [C1.id]: "edited" })]);
    expect(mergeTables(b, theirs, ours)).toEqual({
      ok: false,
      conflicts: [{ kind: "row", rowId: R2 }],
    });
  });

  it("conflicts when both sides add a row with the same id", () => {
    const b = data("T", [C1], []);
    const theirs = data("T", [C1], [row(R1, { [C1.id]: "t" })]);
    const ours = data("T", [C1], [row(R1, { [C1.id]: "o" })]);
    expect(mergeTables(b, theirs, ours)).toEqual({
      ok: false,
      conflicts: [{ kind: "row", rowId: R1 }],
    });
  });
});

describe("mergeTables schema", () => {
  const base = data("T", [C1], [row(R1, { [C1.id]: "a" })]);

  it("unions columns added on both sides in base, theirs, ours order", () => {
    const theirs = data("T", [C1, C2], [row(R1, { [C1.id]: "a" })]);
    const ours = data("T", [C1, C3], [row(R1, { [C1.id]: "a" })]);
    expect(mergeTables(base, theirs, ours)).toEqual({
      ok: true,
      merged: data("T", [C1, C2, C3], [row(R1, { [C1.id]: "a" })]),
    });
  });

  it("takes one-sided renames and conflicts on divergent retypes", () => {
    expect(
      mergeTables(base, data("T", [{ ...C1, name: "A2" }], base.rows), base),
    ).toEqual({
      ok: true,
      merged: data("T", [{ ...C1, name: "A2" }], base.rows),
    });
    expect(
      mergeTables(
        data("T", [C1], []),
        data("T", [{ ...C1, type: "number" }], []),
        data("T", [{ ...C1, type: "boolean" }], []),
      ),
    ).toEqual({
      ok: false,
      conflicts: [{ kind: "column", columnId: C1.id }],
    });
  });

  it("conflicts on column delete-vs-edit and allows delete-vs-untouched", () => {
    const b = data("T", [C1, C2], [row(R1, { [C1.id]: "a", [C2.id]: 1 })]);
    const deletedTheirs = data("T", [C1], [row(R1, { [C1.id]: "a" })]);
    expect(mergeTables(b, deletedTheirs, b)).toEqual({
      ok: true,
      merged: data("T", [C1], [row(R1, { [C1.id]: "a" })]),
    });
    const editedOurs = data(
      "T",
      [C1, C2],
      [row(R1, { [C1.id]: "a", [C2.id]: 9 })],
    );
    expect(mergeTables(b, deletedTheirs, editedOurs)).toEqual({
      ok: false,
      conflicts: [{ kind: "column", columnId: C2.id }],
    });
  });

  it("conflicts when a deleted column has a cell deleted on the other side", () => {
    const b = data("T", [C1, C2], [row(R1, { [C1.id]: "a", [C2.id]: 1 })]);
    const deletedTheirs = data("T", [C1], [row(R1, { [C1.id]: "a" })]);
    const deletedOurs = data("T", [C1, C2], [row(R1, { [C1.id]: "a" })]);
    expect(mergeTables(b, deletedTheirs, deletedOurs)).toEqual({
      ok: false,
      conflicts: [{ kind: "column", columnId: C2.id }],
    });
  });

  it("conflicts on incompatible concurrent column order", () => {
    const b = data("T", [C1, C2, C3], []);
    const theirs = data("T", [C3, C1, C2], []);
    const ours = data("T", [C2, C3, C1], []);
    expect(mergeTables(b, theirs, ours)).toEqual({
      ok: false,
      conflicts: [C1, C2, C3].map((column) => ({
        kind: "column",
        columnId: column.id,
      })),
    });
  });
});

describe("mergeTables title and validation", () => {
  it("merges one-sided title changes and conflicts on divergent ones", () => {
    const base = data("T", [C1], []);
    expect(mergeTables(base, data("T2", [C1], []), base)).toEqual({
      ok: true,
      merged: data("T2", [C1], []),
    });
    expect(
      mergeTables(base, data("T2", [C1], []), data("T3", [C1], [])),
    ).toEqual({ ok: false, conflicts: [{ kind: "title" }] });
  });

  it("escalates post-merge validation failures to column conflicts", () => {
    const base = data("T", [C1], [row(R1, { [C1.id]: "1" })]);
    const theirs = data(
      "T",
      [{ ...C1, type: "number" }],
      [row(R1, { [C1.id]: 1 })],
    );
    const ours = data(
      "T",
      [C1],
      [row(R1, { [C1.id]: "1" }), row(R2, { [C1.id]: "not-a-number" })],
    );
    expect(mergeTables(base, theirs, ours)).toEqual({
      ok: false,
      conflicts: [{ kind: "column", columnId: C1.id }],
    });
  });

  it("scrubs cells of columns deleted on both sides", () => {
    const b = data("T", [C1, C2], [row(R1, { [C1.id]: "a", [C2.id]: 1 })]);
    const without = data("T", [C1], [row(R1, { [C1.id]: "a" })]);
    expect(mergeTables(b, without, without)).toEqual({
      ok: true,
      merged: without,
    });
  });
});

it("accepts identical concurrently added rows", () => {
  const original = data("T", [C1], []);
  const added = data("T", [C1], [row(R1, { [C1.id]: "same" })]);
  expect(mergeTables(original, added, added)).toEqual({
    ok: true,
    merged: added,
  });
});

describe("mergeTables multiselect cells", () => {
  const MULTI: TableColumn = {
    id: "44444444-4444-4444-8444-444444444444",
    name: "Tags",
    type: "multiselect",
    options: [
      { id: "55555555-5555-4555-8555-555555555555", label: "Urgent" },
      { id: "66666666-6666-4666-8666-666666666666", label: "Blocked" },
    ],
  };
  const OPT_A = "55555555-5555-4555-8555-555555555555";
  const OPT_B = "66666666-6666-4666-8666-666666666666";
  // Each side is parsed separately at runtime, so build distinct objects:
  // reference equality would hide an Object.is regression.
  const snapshot = () =>
    data(
      "T",
      [C1, MULTI],
      [
        row(R1, { [C1.id]: "a", [MULTI.id]: [OPT_A, OPT_B] }),
        row(R2, { [C1.id]: "b", [MULTI.id]: [OPT_A] }),
      ],
    );
  const x = snapshot();

  it("has no false conflict when every side is an equal snapshot", () => {
    expect(mergeTables(snapshot(), snapshot(), snapshot())).toEqual({
      ok: true,
      merged: x,
    });
  });

  it("merges cleanly when only another row changes", () => {
    const ours = data(
      "T",
      [C1, MULTI],
      [
        row(R1, { [C1.id]: "a", [MULTI.id]: [OPT_A, OPT_B] }),
        row(R2, { [C1.id]: "b2", [MULTI.id]: [OPT_A] }),
      ],
    );
    expect(mergeTables(snapshot(), snapshot(), ours)).toEqual({
      ok: true,
      merged: ours,
    });
  });

  it("still reports a real divergent multiselect edit as a conflict", () => {
    const theirs = data(
      "T",
      [C1, MULTI],
      [
        row(R1, { [C1.id]: "a", [MULTI.id]: [OPT_A] }),
        row(R2, { [C1.id]: "b", [MULTI.id]: [OPT_A] }),
      ],
    );
    const ours = data(
      "T",
      [C1, MULTI],
      [
        row(R1, { [C1.id]: "a", [MULTI.id]: [OPT_B] }),
        row(R2, { [C1.id]: "b", [MULTI.id]: [OPT_A] }),
      ],
    );
    expect(mergeTables(snapshot(), theirs, ours)).toEqual({
      ok: false,
      conflicts: [{ kind: "cell", rowId: R1, columnId: MULTI.id }],
    });
  });
});

it("preserves inserted row positions during a merged save", () => {
  const b = data("T", [C1], [row(R1, {}), row(R2, {})]);
  const ours = data("T", [C1], [row(R1, {}), row(R3, {}), row(R2, {})]);
  expect(mergeTables(b, { ...b, title: "New" }, ours)).toEqual({
    ok: true,
    merged: { ...ours, title: "New" },
  });
});
it("reports incompatible concurrent row reorders", () => {
  const b = data("T", [C1], [row(R1, {}), row(R2, {}), row(R3, {})]);
  expect(
    mergeTables(
      b,
      { ...b, rows: [b.rows[1]!, b.rows[0]!, b.rows[2]!] },
      { ...b, rows: [b.rows[0]!, b.rows[2]!, b.rows[1]!] },
    ).ok,
  ).toBe(false);
});

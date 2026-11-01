import { describe, expect, it } from "vitest";
import {
  columnTypeIssue,
  inferColumnTypes,
  parseDraftCell,
} from "./columnTypes";

const columns = [
  { name: "Amount", type: "text" as const },
  { name: "Paid", type: "text" as const },
  { name: "Due", type: "text" as const },
  { name: "Note", type: "text" as const },
];

describe("parseDraftCell", () => {
  it("keeps text verbatim and omits empty typed cells", () => {
    expect(parseDraftCell("  x ", "text")).toEqual({ ok: true, value: "  x " });
    expect(parseDraftCell("   ", "number")).toEqual({ ok: true, value: null });
  });

  it("accepts decimal literals only as numbers", () => {
    expect(parseDraftCell(" 12.5 ", "number")).toEqual({
      ok: true,
      value: 12.5,
    });
    expect(parseDraftCell("1e3", "number")).toEqual({ ok: true, value: 1000 });
    expect(parseDraftCell("0x10", "number")).toEqual({ ok: false });
    expect(parseDraftCell("12,5", "number")).toEqual({ ok: false });
  });

  it.each([
    ["0.1", 0.1],
    ["1.00", 1],
    ["+.1250e+2", 12.5],
    ["001.2300E-2", 0.0123],
    ["-0.0100", -0.01],
    ["9007199254740991", 9007199254740991],
    ["9007199254740992", 9007199254740992],
    ["1e20", 100000000000000000000],
    ["5e-324", Number.MIN_VALUE],
    ["0e99999999999999999999", 0],
  ])("preserves equivalent decimal notation %s", (source, value) => {
    expect(parseDraftCell(source, "number")).toEqual({ ok: true, value });
  });

  it.each([
    "9007199254740993",
    "-9007199254740993",
    "9.007199254740993e15",
    "1000000000000000100",
    "1000000000000000128",
    "1.0000000000000001e20",
    "1e100",
    "1e309",
    "1e-324",
    "-1e-99999999999999999999",
    "4e-324",
    "0.10000000000000001",
    "1.0000000000000001",
  ])("rejects numeric conversion that changes %s", (source) => {
    expect(parseDraftCell(source, "number")).toEqual({ ok: false });
  });

  it("accepts true/false case-insensitively and ISO dates", () => {
    expect(parseDraftCell("TRUE", "boolean")).toEqual({
      ok: true,
      value: true,
    });
    expect(parseDraftCell("yes", "boolean")).toEqual({ ok: false });
    expect(parseDraftCell("2026-02-29", "date")).toEqual({ ok: false });
    expect(parseDraftCell("2026-03-01", "date")).toEqual({
      ok: true,
      value: "2026-03-01",
    });
  });
});

describe("inferColumnTypes", () => {
  it("types each column from every non-empty cell", () => {
    expect(
      inferColumnTypes(columns, [
        ["10", "true", "2026-01-01", "a"],
        ["", "false", "2026-01-02", ""],
        ["3.5", "", "", "1"],
      ]),
    ).toEqual([
      { name: "Amount", type: "number" },
      { name: "Paid", type: "boolean" },
      { name: "Due", type: "date" },
      { name: "Note", type: "text" },
    ]);
  });

  it("preserves mixed dates and timestamps as text", () => {
    expect(
      inferColumnTypes(
        [{ name: "When", type: "text" }],
        [["2026-01-01"], ["2026-01-02T10:00:00Z"]],
      ),
    ).toEqual([{ name: "When", type: "text" }]);
  });

  it("falls back to text for a mixed or empty column", () => {
    expect(inferColumnTypes(columns.slice(0, 1), [["1"], ["one"]])).toEqual([
      { name: "Amount", type: "text" },
    ]);
    expect(inferColumnTypes(columns.slice(0, 1), [[""], [""]])).toEqual([
      { name: "Amount", type: "text" },
    ]);
  });

  it("keeps adjacent large identifiers distinct as text", () => {
    expect(
      inferColumnTypes(
        [
          { name: "ID", type: "text" },
          { name: "Amount", type: "text" },
        ],
        [
          ["9007199254740992", "0.1"],
          ["9007199254740993", "1.00"],
        ],
      ),
    ).toEqual([
      { name: "ID", type: "text" },
      { name: "Amount", type: "number" },
    ]);
  });
});

describe("columnTypeIssue", () => {
  it("names the first cell that cannot take the column type", () => {
    expect(
      columnTypeIssue(
        [{ name: "Amount", type: "number" }],
        [["1"], ["two"], ["3"]],
      ),
    ).toEqual({ column: "Amount", row: 2, value: "two" });
    expect(
      columnTypeIssue([{ name: "Amount", type: "number" }], [["1"], [""]]),
    ).toBeNull();
  });

  it("rejects explicit retyping when a numeric cell would lose precision", () => {
    expect(
      columnTypeIssue(
        [{ name: "ID", type: "number" }],
        [["9007199254740992"], ["9007199254740993"]],
      ),
    ).toEqual({ column: "ID", row: 2, value: "9007199254740993" });
  });
});

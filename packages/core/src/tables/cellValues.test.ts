import { describe, expect, it } from "vitest";
import {
  cellValuesEqual,
  convertCellValue,
  isValidCellValue,
  retypeColumn,
  validateRows,
} from "./cellValues";
import type { CellValue, TableColumn, TableRow } from "./types";

const TEXT: TableColumn = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "T",
  type: "text",
};
const NUM: TableColumn = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "N",
  type: "number",
};
const DATE: TableColumn = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "D",
  type: "date",
};
const BOOL: TableColumn = {
  id: "44444444-4444-4444-8444-444444444444",
  name: "B",
  type: "boolean",
};
const DOC: TableColumn = {
  id: "55555555-5555-4555-8555-555555555555",
  name: "Ref",
  type: "document",
};
const SEL: TableColumn = {
  id: "66666666-6666-4666-8666-666666666666",
  name: "S",
  type: "select",
  options: [
    { id: "77777777-7777-4777-8777-777777777777", label: "Open" },
    { id: "88888888-8888-4888-8888-888888888888", label: "Done" },
  ],
};
const ROW = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("isValidCellValue", () => {
  it("validates each column type", () => {
    expect(isValidCellValue("x", TEXT)).toBe(true);
    expect(isValidCellValue(1, TEXT)).toBe(false);
    expect(isValidCellValue(2.5, NUM)).toBe(true);
    expect(isValidCellValue(Number.NaN, NUM)).toBe(false);
    expect(isValidCellValue("2026-08-28", DATE)).toBe(true);
    expect(isValidCellValue("2026-02-29", DATE)).toBe(false);
    expect(isValidCellValue("2024-02-29", DATE)).toBe(true);
    expect(isValidCellValue("2026-04-31T12:30:00Z", DATE)).toBe(false);
    expect(isValidCellValue("2026-08-28T12:30:00Z", DATE)).toBe(false);
    expect(isValidCellValue("28.08.2026", DATE)).toBe(false);
    expect(isValidCellValue(true, BOOL)).toBe(true);
    expect(isValidCellValue("true", BOOL)).toBe(false);
    expect(isValidCellValue("77777777-7777-4777-8777-777777777777", SEL)).toBe(
      true,
    );
    expect(isValidCellValue(ROW, SEL)).toBe(false);
    expect(isValidCellValue(ROW, DOC)).toBe(true);
    expect(isValidCellValue("not-a-uuid", DOC)).toBe(false);
  });
});

describe("validateRows", () => {
  it("accepts valid sparse rows", () => {
    const rows: TableRow[] = [
      { id: ROW, cells: { [TEXT.id]: "a", [NUM.id]: 1 } },
      { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", cells: {} },
    ];
    expect(validateRows([TEXT, NUM], rows)).toEqual({ ok: true });
  });

  it("reports unknown columns, bad values, and duplicate rows/columns", () => {
    const bad = validateRows(
      [TEXT, TEXT],
      [
        { id: ROW, cells: { [NUM.id]: 1, [TEXT.id]: 2 } },
        { id: ROW, cells: {} },
      ],
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      const reasons = bad.errors.map((error) => error.reason);
      expect(reasons).toContain("unknown column");
      expect(reasons).toContain("invalid value for type text");
      expect(reasons).toContain("duplicate row id");
      expect(reasons).toContain("duplicate column id");
    }
  });
});

describe("convertCellValue", () => {
  it("converts to text from every type", () => {
    expect(convertCellValue(2.5, NUM, TEXT)).toEqual({
      ok: true,
      value: "2.5",
    });
    expect(convertCellValue(true, BOOL, TEXT)).toEqual({
      ok: true,
      value: "true",
    });
    expect(convertCellValue("2026-08-28", DATE, TEXT)).toEqual({
      ok: true,
      value: "2026-08-28",
    });
    expect(convertCellValue(ROW, DOC, TEXT)).toEqual({ ok: true, value: ROW });
    expect(
      convertCellValue("77777777-7777-4777-8777-777777777777", SEL, TEXT),
    ).toEqual({ ok: true, value: "Open" });
  });

  it("converts from text when parseable, else fails", () => {
    expect(convertCellValue(" 42 ", TEXT, NUM)).toEqual({
      ok: true,
      value: 42,
    });
    expect(convertCellValue("abc", TEXT, NUM)).toEqual({ ok: false });
    expect(convertCellValue("true", TEXT, BOOL)).toEqual({
      ok: true,
      value: true,
    });
    expect(convertCellValue("yes", TEXT, BOOL)).toEqual({ ok: false });
    expect(convertCellValue("2026-08-28", TEXT, DATE)).toEqual({
      ok: true,
      value: "2026-08-28",
    });
    expect(convertCellValue("2026-02-29", TEXT, DATE)).toEqual({ ok: false });
    expect(convertCellValue("Open", TEXT, SEL)).toEqual({
      ok: true,
      value: "77777777-7777-4777-8777-777777777777",
    });
    expect(convertCellValue("Nope", TEXT, SEL)).toEqual({ ok: false });
    expect(convertCellValue(ROW, TEXT, DOC)).toEqual({ ok: true, value: ROW });
  });

  it("keeps same-type values and rejects other cross-type conversions", () => {
    expect(convertCellValue(3, NUM, NUM)).toEqual({ ok: true, value: 3 });
    expect(convertCellValue(1, NUM, BOOL)).toEqual({ ok: false });
    expect(convertCellValue(true, BOOL, NUM)).toEqual({ ok: true, value: 1 });
    expect(convertCellValue("2026-08-28", DATE, NUM)).toEqual({ ok: false });
  });
});

const OPT_A = "a1111111-1111-4111-8111-111111111111";
const OPT_B = "a2222222-2222-4222-8222-222222222222";
const C1 = "c1111111-1111-4111-8111-111111111111";
const C2 = "c2222222-2222-4222-8222-222222222222";
const C3 = "c3333333-3333-4333-8333-333333333333";
const C4 = "c4444444-4444-4444-8444-444444444444";
const C5 = "c5555555-5555-4555-8555-555555555555";
const C6 = "c6666666-6666-4666-8666-666666666666";
const C7 = "c7777777-7777-4777-8777-777777777777";

const opts = [
  { id: OPT_A, label: "Alpha" },
  { id: OPT_B, label: "Beta" },
];
const select = { id: C1, name: "s", type: "select" as const, options: opts };
const multi = {
  id: C2,
  name: "m",
  type: "multiselect" as const,
  options: opts,
};
const dt = { id: C3, name: "dt", type: "datetime" as const };
const date = { id: C4, name: "d", type: "date" as const };
const text = { id: C5, name: "t", type: "text" as const };
const url = { id: C6, name: "u", type: "url" as const };
const long = { id: C7, name: "l", type: "longtext" as const };

describe("new column types", () => {
  it("validates the new cell shapes", () => {
    expect(isValidCellValue([OPT_A, OPT_B], multi)).toBe(true);
    expect(isValidCellValue([OPT_A, OPT_A], multi)).toBe(false);
    expect(isValidCellValue([], multi)).toBe(false);
    expect(isValidCellValue(OPT_A, multi)).toBe(false);
    expect(isValidCellValue([OPT_A], select)).toBe(false);
    expect(isValidCellValue("2026-09-18T14:30:00Z", dt)).toBe(true);
    expect(isValidCellValue("2026-09-18", dt)).toBe(false);
    expect(isValidCellValue("2026-09-18T14:30:00Z", date)).toBe(false);
    expect(isValidCellValue("https://x.test", url)).toBe(true);
    expect(isValidCellValue("x".repeat(10_001), long)).toBe(false);
    expect(isValidCellValue("a\nb", long)).toBe(true);
  });

  it("retypes per the spec table", () => {
    const conv = (v: CellValue, from: TableColumn, to: TableColumn) =>
      convertCellValue(v, from, to);
    expect(conv("2026-09-18", date, dt)).toEqual({
      ok: true,
      value: "2026-09-18T00:00:00Z",
    });
    expect(conv("2026-09-18T10:00:00", date, dt)).toEqual({
      ok: true,
      value: "2026-09-18T10:00:00Z",
    });
    expect(conv("2026-09-18T10:00:00+02:00", dt, date)).toEqual({
      ok: true,
      value: "2026-09-18",
    });
    expect(conv("2026-09-18T10:00:00+02:00", text, dt)).toEqual({
      ok: true,
      value: "2026-09-18T10:00:00+02:00",
    });
    expect(conv("nope", text, dt)).toEqual({ ok: false });
    expect(conv(OPT_A, select, multi)).toEqual({ ok: true, value: [OPT_A] });
    expect(conv([OPT_B, OPT_A], multi, select)).toEqual({
      ok: true,
      value: OPT_B,
    });
    expect(conv([OPT_A, OPT_B], multi, text)).toEqual({
      ok: true,
      value: "Alpha, Beta",
    });
    expect(conv("Beta, Alpha", text, multi)).toEqual({
      ok: true,
      value: [OPT_B, OPT_A],
    });
    expect(conv("Beta, Gamma", text, multi)).toEqual({ ok: false });
    expect(conv("https://x.test", text, url)).toEqual({
      ok: true,
      value: "https://x.test",
    });
    expect(conv("x", text, url)).toEqual({ ok: false });
    expect(conv("a\nb", text, long)).toEqual({ ok: true, value: "a\nb" });
    expect(conv("a\nb", long, text)).toEqual({ ok: true, value: "a\nb" });
    expect(conv("https://x.test", url, text)).toEqual({
      ok: true,
      value: "https://x.test",
    });
    expect(conv(3, { ...text, type: "number" }, dt)).toEqual({ ok: false });
    // longtext is a text source: it converts like text to every other type.
    expect(conv("https://x.test", long, url)).toEqual({
      ok: true,
      value: "https://x.test",
    });
    expect(conv("not a url", long, url)).toEqual({ ok: false });
    expect(conv("https://x.test", url, long)).toEqual({
      ok: true,
      value: "https://x.test",
    });
  });

  it("compares cell values by content", () => {
    expect(cellValuesEqual([OPT_A, OPT_B], [OPT_A, OPT_B])).toBe(true);
    expect(cellValuesEqual([OPT_A, OPT_B], [OPT_B, OPT_A])).toBe(false);
    expect(cellValuesEqual(undefined, undefined)).toBe(true);
    expect(cellValuesEqual("a", ["a"])).toBe(false);
  });
});

describe("retypeColumn", () => {
  it("converts present cells, keeps absent cells absent", () => {
    const rows: TableRow[] = [
      { id: ROW, cells: { [NUM.id]: 5 } },
      { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", cells: {} },
    ];
    expect(retypeColumn(rows, NUM, TEXT)).toEqual({
      ok: true,
      rows: [
        { id: ROW, cells: { [NUM.id]: "5" } },
        { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", cells: {} },
      ],
    });
  });

  it("fails atomically, naming the offending rows", () => {
    const rows: TableRow[] = [
      { id: ROW, cells: { [TEXT.id]: "12" } },
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        cells: { [TEXT.id]: "abc" },
      },
    ];
    expect(retypeColumn(rows, TEXT, NUM)).toEqual({
      ok: false,
      failures: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
    });
  });
});

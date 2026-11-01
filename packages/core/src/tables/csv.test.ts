import { describe, expect, it } from "vitest";
import {
  coerceCsvCell,
  columnNamesFromHeader,
  detectDelimiter,
  inferColumnType,
  parseCsv,
} from "./csv";

describe("parseCsv", () => {
  it("parses quoted fields, embedded newlines and CRLF", () => {
    const text = 'name,"note"\r\n"Smith, J","line1\nline2"\r\nDoe,""\r\n';
    expect(parseCsv(text)).toEqual({
      header: ["name", "note"],
      rows: [
        ["Smith, J", "line1\nline2"],
        ["Doe", ""],
      ],
    });
  });
  it("unescapes doubled quotes", () => {
    expect(parseCsv('a\n"say ""hi"""').rows).toEqual([['say "hi"']]);
  });
  it("detects semicolon and tab delimiters from the header", () => {
    expect(detectDelimiter("a;b;c")).toBe(";");
    expect(detectDelimiter("a\tb")).toBe("\t");
    expect(detectDelimiter("a,b;c")).toBe(","); // most frequent wins, comma on ties
    expect(parseCsv("a;b\n1;2").rows).toEqual([["1", "2"]]);
  });
  it("prefers the given delimiter over the frequency rule when it appears at all", () => {
    expect(
      parseCsv("Name, first\tAge\nA, B\t3", { preferredDelimiter: "\t" }),
    ).toEqual({
      header: ["Name, first", "Age"],
      rows: [["A, B", "3"]],
    });
  });
  it("falls back to the given delimiter when none of the candidates appear", () => {
    expect(detectDelimiter("onlyfield", "\t")).toBe("\t");
  });
  it("drops trailing and interior blank lines", () => {
    expect(parseCsv("a,b\n1,2\n\n3,4\n").rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });
  it("pads short rows and rejects an unterminated quote", () => {
    expect(parseCsv("a,b\n1").rows).toEqual([["1", ""]]);
    expect(() => parseCsv('a\n"open')).toThrow(/unterminated/i);
  });
  it("strips a UTF-8 BOM", () => {
    expect(parseCsv("﻿a,b\n1,2").header).toEqual(["a", "b"]);
  });
  it("drops trailing all-empty extra fields but rejects non-empty overflow", () => {
    expect(parseCsv("a,b\n1,2,\n").rows).toEqual([["1", "2"]]);
    expect(() => parseCsv("a\n1,2")).toThrow(/Row 1 has 2 fields/);
  });
  it("detects the delimiter from a quote-aware first record, even with an embedded newline", () => {
    expect(parseCsv('"a\nb";c\n1;2')).toEqual({
      header: ["a\nb", "c"],
      rows: [["1", "2"]],
    });
  });
  it("rejects unquoted text immediately after a closing quote", () => {
    expect(() => parseCsv('a,b\n"a"b,c')).toThrow(/closing quote/i);
  });
});

describe("columnNamesFromHeader", () => {
  it("trims, fills empties and deduplicates", () => {
    expect(columnNamesFromHeader([" Name ", "", "Name", "name"])).toEqual([
      "Name",
      "Column 2",
      "Name (2)",
      "name",
    ]);
  });
  it("keeps bumping the suffix when a literal header collides with an auto-deduped name", () => {
    expect(columnNamesFromHeader(["A", "A", "A (2)"])).toEqual([
      "A",
      "A (2)",
      "A (3)",
    ]);
  });
});

describe("inferColumnType", () => {
  it("infers number, date, boolean, else text", () => {
    expect(inferColumnType(["1", "2.5", "-3", ""])).toBe("number");
    expect(inferColumnType(["2026-01-05", "2026-02-30"])).toBe("text"); // invalid calendar date
    expect(inferColumnType(["2026-01-05", ""])).toBe("date");
    expect(inferColumnType(["true", "No", "YES"])).toBe("boolean");
    expect(inferColumnType(["1", "x"])).toBe("text");
    expect(inferColumnType(["", ""])).toBe("text");
    expect(inferColumnType(["1e3"])).toBe("number");
    expect(inferColumnType(["1,5"])).toBe("text");
  });
  it("keeps a number that round-trips exactly, and stays text when precision would be lost", () => {
    expect(inferColumnType(["12345678901234567890"])).toBe("text");
    expect(inferColumnType(["9007199254740993"])).toBe("text");
    expect(inferColumnType(["1e3"])).toBe("number");
    expect(inferColumnType(["-3.25"])).toBe("number");
    expect(inferColumnType(["0"])).toBe("number");
  });
  it("infers datetime, url and longtext", () => {
    expect(
      inferColumnType(["2026-09-18T14:30:00+02:00", "2026-09-19T00:00Z"]),
    ).toBe("datetime");
    expect(
      inferColumnType(["2026-09-18T14:30:00", "2026-09-19T00:00:00"]),
    ).toBe("text"); // no zone
    expect(inferColumnType(["2026-09-18", "2026-09-18T14:30:00Z"])).toBe(
      "text",
    ); // mixed
    expect(inferColumnType(["2026-09-18", "2026-09-19"])).toBe("date");
    expect(inferColumnType(["https://a.test", "http://b.test/x"])).toBe("url");
    expect(inferColumnType(["https://a.test", "b"])).toBe("text");
    expect(inferColumnType(["short", "line1\nline2"])).toBe("longtext");
    expect(inferColumnType(["x".repeat(201)])).toBe("longtext");
    expect(coerceCsvCell("2026-09-18T14:30Z", "datetime")).toBe(
      "2026-09-18T14:30:00Z",
    );
    expect(coerceCsvCell("line1\nline2", "longtext")).toBe("line1\nline2");
  });
});

describe("coerceCsvCell", () => {
  it("coerces per type and returns undefined for empty", () => {
    expect(coerceCsvCell(" 42 ", "number")).toBe(42);
    expect(coerceCsvCell("", "number")).toBeUndefined();
    expect(coerceCsvCell("yes", "boolean")).toBe(true);
    expect(coerceCsvCell("2026-01-05", "date")).toBe("2026-01-05");
    expect(coerceCsvCell("  padded ", "text")).toBe("  padded ");
  });
});

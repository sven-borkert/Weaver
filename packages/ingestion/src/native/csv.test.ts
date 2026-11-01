import { describe, expect, it } from "vitest";
import { parseCsvRows } from "./csv";

describe("parseCsvRows", () => {
  it("handles quoted fields, escaped quotes, embedded newlines, and CRLF", () => {
    expect(
      parseCsvRows('a,b\r\n"x, y","say ""hi"""\n"multi\nline",z\n'),
    ).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["multi\nline", "z"],
    ]);
  });

  it("skips blank lines but keeps rows that carry syntax", () => {
    expect(parseCsvRows('a,b\n\n"",\n')).toEqual([
      ["a", "b"],
      ["", ""],
    ]);
  });

  it("rejects misplaced or unterminated quotes", () => {
    expect(() => parseCsvRows('a,"b')).toThrow(SyntaxError);
    expect(() => parseCsvRows('a,b"c')).toThrow(SyntaxError);
    expect(() => parseCsvRows('"a"b,c')).toThrow(SyntaxError);
  });
});

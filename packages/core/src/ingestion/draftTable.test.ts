import { describe, expect, it } from "vitest";
import { draftTableIssue } from "./draftTable";

const text = (name: string) => ({ name, type: "text" as const });

describe("draftTableIssue", () => {
  it("accepts a bounded table", () => {
    expect(
      draftTableIssue([text("Name"), text("Date")], [["A", "2026-01-01"]]),
    ).toBeNull();
    expect(draftTableIssue([text("Only")], [])).toBeNull();
  });

  it("rejects structural problems with a user-facing reason", () => {
    expect(draftTableIssue([], [])).toMatch(/at least one column/);
    expect(draftTableIssue([text("A"), text("A")], [])).toMatch(
      /duplicate column name/,
    );
    expect(draftTableIssue([text(" A")], [])).toMatch(/trimmed/);
    expect(draftTableIssue([text("A")], [["x", "y"]])).toMatch(
      /match the column count/,
    );
    expect(draftTableIssue([text("A")], [["x".repeat(10_001)]])).toMatch(
      /10000 characters/,
    );
    expect(
      draftTableIssue(
        Array.from({ length: 101 }, (_, index) => text(`C${index}`)),
        [],
      ),
    ).toMatch(/at most 100 columns/);
    expect(
      draftTableIssue(
        [text("A")],
        Array.from({ length: 1_001 }, () => ["x"]),
      ),
    ).toMatch(/at most 1000 rows/);
    expect(
      draftTableIssue(
        [text("A")],
        Array.from({ length: 600 }, () => ["y".repeat(10_000)]),
      ),
    ).toMatch(/would take 6\.1 MB once stored, above the 5\.0 MB limit/);
    expect(draftTableIssue([{ name: "A", type: "select" as never }], [])).toBe(
      "table draft columns must be text, number, boolean, or date columns",
    );
  });

  it("measures the size the accepted table would be stored at", () => {
    const columns = Array.from({ length: 100 }, (_, index) =>
      text(`C${index}`),
    );
    const rows = Array.from({ length: 1_000 }, () =>
      Array<string>(100).fill("1234567890"),
    );
    expect(draftTableIssue(columns, rows)).toBe(
      "the table would take 5.3 MB once stored, above the 5.0 MB limit; split the sheet or remove columns, then upload again",
    );
    // quotes are the only saving of a number over its text: 8 digits tip it
    const digits = rows.map((row) => row.map(() => "12345678"));
    expect(draftTableIssue(columns, digits)).toMatch(/would take 5\.1 MB/);
    expect(
      draftTableIssue(
        columns.map((column) => ({ ...column, type: "number" as const })),
        digits,
      ),
    ).toBeNull();
  });

  it("omits empty typed cells but keeps empty text cells", () => {
    const rows = Array.from({ length: 1_000 }, () =>
      Array<string>(100).fill(""),
    );
    const named = (type: "text" | "number") =>
      Array.from({ length: 100 }, (_, index) => ({ name: `C${index}`, type }));
    expect(draftTableIssue(named("number"), rows)).toBeNull();
    expect(draftTableIssue(named("text"), rows)).toBeNull();
    expect(
      draftTableIssue(
        named("text"),
        rows.map((row) => row.map(() => "12345678901")),
      ),
    ).toMatch(/once stored/);
  });
});

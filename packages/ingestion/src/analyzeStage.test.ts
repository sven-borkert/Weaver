import { describe, expect, it } from "vitest";
import {
  ANALYZE_MAX_INPUT_CHARS,
  ANALYZE_SYSTEM_PROMPT,
  analysisUserMessage,
  parseAnalysis,
} from "./analyzeStage";

describe("parseAnalysis", () => {
  it("accepts a fenced JSON object and defaults missing queries", () => {
    expect(
      parseAnalysis(
        '```json\n{"title": " Q3 report ", "folder": "reports"}\n```',
      ),
    ).toEqual({ title: "Q3 report", folder: "reports", linkQueries: [] });
  });

  it("extracts the object from surrounding prose and bounds the queries", () => {
    const queries = Array.from({ length: 7 }, (_, i) => `q${i}`);
    expect(
      parseAnalysis(
        `Sure! {"title":"T","folder":"","linkQueries":${JSON.stringify(queries)}} Done.`,
      ),
    ).toBeNull();
    expect(
      parseAnalysis('{"title":"T","folder":"","linkQueries":["a b","c"]}'),
    ).toEqual({ title: "T", folder: "", linkQueries: ["a b", "c"] });
  });

  it("rejects non-JSON, invalid titles, and multi-line titles", () => {
    expect(parseAnalysis("no json here")).toBeNull();
    expect(parseAnalysis('{"title":"","folder":""}')).toBeNull();
    expect(parseAnalysis('{"title":"a\\nb","folder":""}')).toBeNull();
    expect(parseAnalysis('{"title":"a\\u0000b","folder":""}')).toBeNull();
    expect(parseAnalysis('{"title":"a\\tb","folder":""}')).toBeNull();
  });
});

describe("analysisUserMessage", () => {
  it("lists folders, bounds the excerpt, and shows table columns with sample rows", () => {
    const message = analysisUserMessage({
      fileName: "budget.xlsx",
      targetKind: "table",
      folders: ["finance", "finance/2026"],
      excerpt: "x".repeat(30_000),
      columns: ["Item", "Amount"],
      sampleRows: [["Rent", "1200"]],
    });
    expect(message).toContain("- finance/2026");
    expect(message).toContain("Columns: Item | Amount");
    expect(message).toContain("Rent | 1200");
    expect(message.length).toBeLessThanOrEqual(ANALYZE_MAX_INPUT_CHARS);
  });

  it("bounds folder lists and table cells within the full prompt budget", () => {
    const message = analysisUserMessage({
      fileName: "x".repeat(10_000),
      targetKind: "table",
      folders: Array.from(
        { length: 1_000 },
        (_, i) => `folder-${i}-${"x".repeat(100)}`,
      ),
      excerpt: "",
      columns: ["c".repeat(10_000)],
      sampleRows: Array.from({ length: 20 }, () => ["v".repeat(10_000)]),
    });
    expect(message.length).toBeLessThanOrEqual(ANALYZE_MAX_INPUT_CHARS);
  });

  it("names every JSON field in the system prompt", () => {
    for (const field of ['"title"', '"folder"', '"linkQueries"'])
      expect(ANALYZE_SYSTEM_PROMPT).toContain(field);
  });
});

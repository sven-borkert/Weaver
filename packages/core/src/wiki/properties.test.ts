import { describe, expect, it } from "vitest";
import {
  normalizeProperties,
  parsePropertiesLine,
  WIKI_PAGE_TYPES,
} from "./properties";

describe("normalizeProperties", () => {
  it("keeps valid values in canonical key order", () => {
    const out = normalizeProperties({
      reviewExempt: true,
      sources: [{ url: "https://a.example/x", kind: "url" }],
      tags: ["a", "b"],
      summary: " S ",
      type: "entity",
      extra: 1,
    });
    expect(JSON.stringify(out)).toBe(
      '{"type":"entity","summary":"S","tags":["a","b"],"sources":[{"kind":"url","url":"https://a.example/x"}],"reviewExempt":true}',
    );
  });

  it("drops wrong types, over-limit values, bad urls and unknown keys", () => {
    expect(
      normalizeProperties({
        type: "x".repeat(41),
        summary: "y".repeat(301),
        tags: ["ok", 5, "z".repeat(41), "ok", "a\nb"],
        sources: [
          { kind: "url", url: "javascript:alert(1)" },
          { kind: "url", url: "ftp://x.example" },
          { kind: "url", id: "x" },
          { kind: "document" },
          { kind: "other", id: "x" },
          { kind: "document", id: "abc", url: "https://x.example" },
        ],
        reviewExempt: "true",
      }),
    ).toEqual({
      tags: ["ok"],
      sources: [{ kind: "document", id: "abc" }],
    });
  });

  it("caps list lengths and returns null when nothing is valid", () => {
    const out = normalizeProperties({
      tags: Array.from({ length: 30 }, (_, i) => `t${i}`),
      sources: Array.from({ length: 60 }, (_, i) => ({
        kind: "document",
        id: `d${i}`,
      })),
    });
    expect(out?.tags).toHaveLength(20);
    expect(out?.sources).toHaveLength(50);
    expect(normalizeProperties({ foo: 1 })).toBeNull();
    expect(normalizeProperties([])).toBeNull();
    expect(normalizeProperties("x")).toBeNull();
  });

  it("treats the reserved source type as plain data", () => {
    expect(WIKI_PAGE_TYPES).not.toContain("source");
    expect(normalizeProperties({ type: "source", reviewExempt: true })).toEqual(
      { type: "source", reviewExempt: true },
    );
  });
});

describe("parsePropertiesLine", () => {
  it("never throws and rejects oversized lines", () => {
    expect(parsePropertiesLine("not json")).toBeNull();
    expect(parsePropertiesLine("[]")).toBeNull();
    expect(
      parsePropertiesLine(JSON.stringify({ summary: "x".repeat(70_000) })),
    ).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  applyPagePropertiesInput,
  normalizeProperties,
  parsePropertiesLine,
  WIKI_PAGE_TYPES,
  withoutReviewExempt,
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

describe("writer input", () => {
  it("refuses every spelling of the reserved type and any reviewExempt", () => {
    for (const type of [
      "source",
      "Source",
      " SOURCE ",
      "ｓｏｕｒｃｅ",
      "so​urce",
    ])
      expect(() => applyPagePropertiesInput(undefined, { type })).toThrow(
        expect.objectContaining({ code: "BAD_REQUEST" }),
      );
    expect(() =>
      applyPagePropertiesInput(undefined, { reviewExempt: true }),
    ).toThrow(expect.objectContaining({ details: { field: "properties" } }));
  });

  it("replaces named fields, keeps omitted ones and clears on null", () => {
    const existing = { type: "note", summary: "s", tags: ["a"] };
    expect(applyPagePropertiesInput(existing, { summary: "t" })).toEqual({
      type: "note",
      summary: "t",
      tags: ["a"],
    });
    expect(
      applyPagePropertiesInput(existing, { type: null, tags: null }),
    ).toEqual({ summary: "s" });
    expect(
      applyPagePropertiesInput({ summary: "s" }, { summary: null }),
    ).toBeUndefined();
  });

  it("keeps reserved fields and refuses changing a source type", () => {
    const existing = { type: "source", reviewExempt: true as const };
    expect(applyPagePropertiesInput(existing, { summary: "x" })).toEqual({
      type: "source",
      summary: "x",
      reviewExempt: true,
    });
    expect(() => applyPagePropertiesInput(existing, { type: "note" })).toThrow(
      expect.objectContaining({ code: "BAD_REQUEST" }),
    );
    expect(() => applyPagePropertiesInput(existing, { type: null })).toThrow(
      expect.objectContaining({ code: "BAD_REQUEST" }),
    );
  });

  it("accepts only http(s) urls and well-formed source references", () => {
    const sources = (value: unknown) => () =>
      applyPagePropertiesInput(undefined, { sources: value });
    expect(sources([{ kind: "url", url: "https://x.test/a" }])).not.toThrow();
    for (const bad of [
      [{ kind: "url", url: "javascript:alert(1)" }],
      [{ kind: "url", url: "ftp://x.test" }],
      [{ kind: "url", url: "https://x.test", id: "x" }],
      [{ kind: "document" }],
      [{ kind: "document", id: "x", url: "https://x.test" }],
      [{ kind: "other", id: "x" }],
      Array.from({ length: 51 }, () => ({ kind: "document", id: "x" })),
    ])
      expect(sources(bad)).toThrow();
  });

  it("drops reviewExempt when a human sets review", () => {
    expect(withoutReviewExempt({ type: "note", reviewExempt: true })).toEqual({
      type: "note",
    });
    expect(withoutReviewExempt({ reviewExempt: true })).toBeUndefined();
    expect(withoutReviewExempt(undefined)).toBeUndefined();
  });
});

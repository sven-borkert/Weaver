import { describe, expect, it } from "vitest";
import { ToolError } from "../contract";
import { fitTextChunk, sliceTextChunk, textChunkBudget } from "./snapshotReads";

// Bytes, not UTF-16 units: the transports and the prompt budget count UTF-8.
const serializedChars = (text: string) =>
  Buffer.byteLength(JSON.stringify(text)) - 2;

function reassemble(raw: string, maxChars: number, budget: number) {
  const pages: string[] = [];
  let position = 0;
  while (position < raw.length) {
    const page = fitTextChunk(raw, position, maxChars, budget);
    expect(page.end).toBeGreaterThan(position);
    expect(page.text).toBe(raw.slice(position, page.end));
    expect(serializedChars(page.text)).toBeLessThanOrEqual(budget);
    pages.push(page.text);
    position = page.end;
  }
  return pages;
}

describe("fitTextChunk", () => {
  it("matches sliceTextChunk when the escaped chunk already fits", () => {
    const raw = "plain text ".repeat(2_000);
    expect(fitTextChunk(raw, 5, 8_000, 14_000)).toEqual(
      sliceTextChunk(raw, 5, 8_000),
    );
  });

  it("shrinks a quote-dense 8,000-char page to the serialized budget", () => {
    const raw = '"'.repeat(8_000);
    expect(serializedChars(raw)).toBe(16_000);
    const page = fitTextChunk(raw, 0, 8_000, 14_000);
    expect(page.end).toBe(7_000);
    expect(serializedChars(page.text)).toBe(14_000);
    const next = fitTextChunk(raw, page.end, 8_000, 14_000);
    expect(next).toEqual({ text: '"'.repeat(1_000), end: 8_000 });
  });

  it("pages escape-dense text with no gaps or repeats", () => {
    const raw = '"\\\n\u0001é😀'.repeat(3_000);
    const pages = reassemble(raw, 8_000, 9_000);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.join("")).toBe(raw);
  });

  it("never splits a surrogate pair while shrinking", () => {
    // An emoji is 4 UTF-8 bytes, so 4 is the smallest budget that fits one.
    const raw = "😀".repeat(4_000);
    for (const budget of [4, 5, 101, 7_001]) {
      for (const page of reassemble(raw, 8_000, budget))
        expect(page.length % 2).toBe(0);
    }
  });

  it("throws instead of stalling when not even one code point fits", () => {
    expect(() => fitTextChunk('""', 0, 8_000, 1)).toThrow(ToolError);
    expect(() => fitTextChunk("😀😀", 0, 8_000, 1)).toThrow(ToolError);
    expect(fitTextChunk("ab", 0, 8_000, 1)).toEqual({ text: "a", end: 1 });
  });

  it("returns an empty final page for an exhausted position", () => {
    expect(fitTextChunk("abc", 3, 8_000, 100)).toEqual({ text: "", end: 3 });
  });

  it("fits a CJK page to the byte budget, not the character cap", () => {
    const raw = "漢".repeat(8_000);
    const page = fitTextChunk(raw, 0, 8_000, 14_000);
    expect(page.end).toBe(4_666);
    expect(serializedChars(page.text)).toBeLessThanOrEqual(14_000);
    expect(reassemble(raw, 8_000, 14_000).join("")).toBe(raw);
  });
});

describe("textChunkBudget", () => {
  it("charges the whole serialized envelope against the transport cap", () => {
    const envelope = { heading: '"'.repeat(100), text: "", nextCursor: "c" };
    const budget = textChunkBudget(envelope);
    const text = '"'.repeat(Math.floor(budget / 2));
    expect(JSON.stringify({ ...envelope, text }).length).toBeLessThanOrEqual(
      16_000,
    );
    expect(budget).toBeLessThan(16_000 - 200);
  });

  it("charges a CJK envelope by its UTF-8 bytes", () => {
    const envelope = { heading: "漢".repeat(100), text: "", nextCursor: "c" };
    expect(textChunkBudget(envelope)).toBeLessThan(16_000 - 300);
    expect(textChunkBudget(envelope)).toBe(
      textChunkBudget({ ...envelope, heading: "x".repeat(300) }),
    );
  });
});

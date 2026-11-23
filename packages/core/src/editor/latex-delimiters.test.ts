import { describe, expect, it } from "vitest";
import { normalizeLatexDelimiters } from "./latex-delimiters";
import { parseDocumentBody } from "./markdown";

const types = (markdown: string) =>
  JSON.stringify(parseDocumentBody(normalizeLatexDelimiters(markdown)));

describe("normalizeLatexDelimiters", () => {
  it("turns parenthesis and bracket delimiters into dollar math", () => {
    expect(
      normalizeLatexDelimiters(String.raw`Euler: \( e^{i\pi} + 1 = 0 \).`),
    ).toBe(String.raw`Euler: $e^{i\pi} + 1 = 0$.`);
    expect(
      normalizeLatexDelimiters(
        ["Solve:", "\\[", "x = \\frac{-b}{2a}", "\\]", "Done."].join("\n"),
      ),
    ).toBe(["Solve:", "$$", "x = \\frac{-b}{2a}", "$$", "Done."].join("\n"));
  });

  it("produces formulas the document parser reads as math", () => {
    expect(types(String.raw`Area \(\pi r^2\) grows`)).toContain(
      '"type":"inlineMath"',
    );
    expect(types("\\[\n\\sum_{i=1}^n i\n\\]")).toContain('"type":"mathBlock"');
  });

  it("keeps code, escaped backslashes and unmatched delimiters literal", () => {
    const code = [
      "```latex",
      String.raw`\( x \)`,
      "```",
      String.raw`Inline \`\(y\)\` stays, \\(z\\) too, and \( alone.`,
    ].join("\n");
    expect(normalizeLatexDelimiters(code)).toBe(code);
  });

  it("does not join display math across blank lines", () => {
    const text = "\\[ start\n\nend \\]";
    expect(normalizeLatexDelimiters(text)).toBe(text);
  });

  it("returns text without delimiters unchanged", () => {
    const text = "Costs $5 and $10, see [notes](https://example.test).";
    expect(normalizeLatexDelimiters(text)).toBe(text);
  });
});

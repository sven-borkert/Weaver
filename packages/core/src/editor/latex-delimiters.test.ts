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

  it.each([
    String.raw`\[x^2\]`,
    String.raw`\[a_1\]`,
    String.raw`\[\frac{a}{b}\]`,
    String.raw`\[ E = mc^2 \]`,
    String.raw`\[ x + y = 2 \]`,
    "\\[\nx\n\\]",
  ])("converts bracket delimiters around LaTeX in %j", (text) => {
    expect(normalizeLatexDelimiters(text)).toBe(`$$${text.slice(2, -2)}$$`);
  });

  it.each([
    String.raw`\[1\]`,
    String.raw`\[RFC 2119\]`,
    String.raw`\[Enter\]`,
    String.raw`\[^1\]`,
    String.raw`\[snake\_case\]`,
    String.raw`\[C:\\temp\]`,
    String.raw`\[Ctrl+C\]`,
    String.raw`\[1-3\]`,
    String.raw`\[n/a\]`,
    String.raw`\[key=value\]`,
  ])("keeps escaped brackets around plain text in %j", (text) => {
    expect(normalizeLatexDelimiters(text)).toBe(text);
  });

  it("keeps a serialized selection with literal brackets as text", () => {
    const text = String.raw`See \[1\] and \[RFC 2119\] for details.`;
    expect(normalizeLatexDelimiters(text)).toBe(text);
    expect(types(text)).not.toContain("Math");
    expect(types(text)).toContain("See [1] and [RFC 2119] for details.");
    expect(
      normalizeLatexDelimiters(String.raw`Press \[Enter\], then \[x^2\].`),
    ).toBe(String.raw`Press \[Enter\], then $$x^2$$.`);
  });

  it("leaves link destinations alone", () => {
    const text = String.raw`[Foo](https://example.test/Foo_\(bar\)) and [b](<https://example.test/\(c\)>) <https://example.test/\(d\)>`;
    expect(normalizeLatexDelimiters(text)).toBe(text);
    expect(
      normalizeLatexDelimiters(
        String.raw`[Foo \(x\)](https://example.test/\(y\)) then \(z\)`,
      ),
    ).toBe(String.raw`[Foo $x$](https://example.test/\(y\)) then $z$`);
  });

  it("returns text without delimiters unchanged", () => {
    const text = "Costs $5 and $10, see [notes](https://example.test).";
    expect(normalizeLatexDelimiters(text)).toBe(text);
  });
});

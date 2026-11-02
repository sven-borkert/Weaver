import { describe, expect, it } from "vitest";
import { renderMathHtml } from "./math-render";

describe("renderMathHtml", () => {
  it("renders a command as its symbol", () => {
    const html = renderMathHtml("2 \\times 0 + 1", false);
    expect(html).toContain('class="katex"');
    expect(html).toContain("×");
    expect(html).not.toContain("katex-display");
  });

  it("renders display math as a block", () => {
    expect(renderMathHtml("x", true)).toContain("katex-display");
  });

  it("shows a formula that does not parse instead of throwing", () => {
    const html = renderMathHtml("\\frac{1", false);
    expect(html).toContain("katex-error");
    expect(html).toContain("\\frac{1");
  });

  it("escapes markup in a formula that does not parse", () => {
    const html = renderMathHtml(
      "\\unknown{<img src=x onerror=alert(1)>",
      false,
    );
    expect(html).not.toContain("<img");
  });

  it.each([
    "\\href{javascript:alert(1)}{x}",
    "\\url{javascript:alert(1)}",
    "\\includegraphics{https://example.com/a.png}",
    "\\htmlId{x}{y}",
    "\\htmlStyle{color:red}{y}",
  ])("refuses the active command in %s", (source) => {
    const html = renderMathHtml(source, false);
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('id="x"');
    expect(html).not.toMatch(/style="[^"]*color:red/);
  });

  it("caps the size of a rule", () => {
    expect(renderMathHtml("\\rule{9999em}{9999em}", false)).not.toMatch(
      /style="[^"]*9999/,
    );
  });

  it("renders the formulas the guide uses", () => {
    for (const source of [
      "\\begin{bmatrix} 1 & 2 \\\\ 3 & 4 \\end{bmatrix}",
      "\\text{softmax}(QK^T/\\sqrt{d_k})V",
      "\\frac{\\partial L}{\\partial w}",
      "[0,\\ 1.414]",
    ])
      expect(renderMathHtml(source, false)).not.toContain("katex-error");
  });
});

import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import {
  parseDocumentBody,
  serializeDocumentBody,
  validateDocumentContent,
} from "./markdown";
import { normalizeMathSource } from "./math";

const inline = (source: string) => ({
  type: "inlineMath",
  attrs: { source },
});
const paragraph = (...content: JSONContent[]) => ({
  type: "paragraph",
  content,
});
const text = (value: string) => ({ type: "text", text: value });
const doc = (...content: JSONContent[]) => ({ type: "doc", content });
const body = (markdown: string) => parseDocumentBody(markdown).content ?? [];

function nodesOfType(node: JSONContent, type: string): JSONContent[] {
  return [
    ...(node.type === type ? [node] : []),
    ...(node.content ?? []).flatMap((child) => nodesOfType(child, type)),
  ];
}

const sources = (markdown: string) =>
  nodesOfType(parseDocumentBody(markdown), "inlineMath").map(
    (node) => node.attrs?.source as string,
  );

describe("inline math Markdown", () => {
  it("reads a formula inside a sentence", () => {
    expect(body("In $y = 2x + 1$, both vary.\n")).toEqual([
      paragraph(text("In "), inline("y = 2x + 1"), text(", both vary.")),
    ]);
  });

  it("writes the source without escaping it", () => {
    const source = "\\hat{y}_i * [a] < b & c ~ `d`";
    const markdown = serializeDocumentBody(
      doc(paragraph(text("See "), inline(source))),
    );
    expect(markdown).toBe(`See $${source}$\n`);
    expect(body(markdown)).toEqual([paragraph(text("See "), inline(source))]);
  });

  it.each([
    ["a price pair", "It costs $5 and $10 today."],
    ["a price range", "From $5-$10 per unit."],
    ["space after the opener", "Keep $ x$ as text."],
    ["space before the closer", "Keep $x $ as text."],
    ["a closer before a digit", "Keep $x$5 as text."],
    ["an escaped opener", "Keep \\$x$ as text."],
    ["a line break", "Keep $x\nand y$ as text."],
    ["inline code", "Keep `$x$` as code."],
  ])("does not read %s as math", (_name, markdown) => {
    expect(sources(markdown)).toEqual([]);
  });

  it("does not pair a price with a later formula on the line", () => {
    expect(sources("Costs $5 and $10 today. Inline $w_1$ here.\n")).toEqual([
      "w_1",
    ]);
    expect(sources("From $5-$10, then $x$ and $y$.\n")).toEqual(["x", "y"]);
  });

  it("reads an escaped dollar inside a formula", () => {
    expect(sources("Pay $\\$5 + x$ now.\n")).toEqual(["\\$5 + x"]);
  });

  it("reads math in table headers and cells, like the guide's table", () => {
    const markdown = [
      "| Input $x$ | Calculation | Output $f(x)$ |",
      "| --- | --- | --- |",
      "| 0 | $2 \\times 0 + 1$ | 1 |",
      "",
    ].join("\n");
    expect(sources(markdown)).toEqual(["x", "f(x)", "2 \\times 0 + 1"]);
    expect(serializeDocumentBody(parseDocumentBody(markdown))).toContain(
      "$2 \\times 0 + 1$",
    );
  });

  it("keeps a pipe of a formula inside a table cell", () => {
    const json = doc({
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [{ type: "tableHeader", content: [paragraph(text("A"))] }],
        },
        {
          type: "tableRow",
          content: [{ type: "tableCell", content: [paragraph(inline("|x|"))] }],
        },
      ],
    });
    expect(sources(serializeDocumentBody(json))).toEqual(["|x|"]);
  });

  it("keeps a formula inside emphasis or a link, outside the mark as any atom", () => {
    const markdown =
      "**Bold $a_1$** and [link $b_2$ more](https://example.com)\n";
    expect(sources(markdown)).toEqual(["a_1", "b_2"]);
    const saved = serializeDocumentBody(parseDocumentBody(markdown));
    expect(saved).toBe(
      "**Bold** $a_1$ and [link](https://example.com) $b_2$ [more](https://example.com)\n",
    );
    expect(serializeDocumentBody(parseDocumentBody(saved))).toBe(saved);
  });

  it("keeps a formula that shares a line with $$ delimiters inline", () => {
    expect(body("See $$x^2$$ here.\n")).toEqual([
      paragraph(text("See "), inline("x^2"), text(" here.")),
    ]);
  });

  it("writes hostile sources so they read back as one formula", () => {
    for (const [source, expected] of [
      ["a\nb", "a b"],
      ["  x  ", "x"],
      ["a$b", "a\\$b"],
      ["a\\", "a\\{}"],
    ] as const) {
      const markdown = serializeDocumentBody(doc(paragraph(inline(source))));
      expect(body(markdown)).toEqual([paragraph(inline(expected))]);
    }
  });

  it("drops an empty formula", () => {
    const markdown = serializeDocumentBody(
      doc(paragraph(text("a"), inline("  "), text("b"))),
    );
    expect(markdown).toBe("ab\n");
  });
});

describe("literal dollars in text", () => {
  it.each([
    "$a$",
    "$a$b$",
    "$2 \\times 0 + 1$ and more",
    "$$x$$",
    "before $x$ after",
    "\\$x$",
  ])("keeps the text %s as text", (value) => {
    const json = doc(paragraph(text(value)));
    const markdown = serializeDocumentBody(json);
    expect(parseDocumentBody(markdown)).toEqual(json);
  });

  it("leaves dollar amounts byte for byte", () => {
    const line = "It costs $5 and $10 today.\n";
    expect(serializeDocumentBody(parseDocumentBody(line))).toBe(line);
  });
});

describe("math block Markdown", () => {
  const block = (source: string) => ({
    type: "mathBlock",
    attrs: { source },
  });

  it("reads and writes one line", () => {
    const markdown = "$$\\frac{a}{b} = c$$\n";
    expect(body(markdown)).toEqual([block("\\frac{a}{b} = c")]);
    expect(serializeDocumentBody(parseDocumentBody(markdown))).toBe(markdown);
  });

  it("reads and writes several lines", () => {
    const markdown = "$$\na = 1 \\\\\nb = 2\n$$\n";
    expect(body(markdown)).toEqual([block("a = 1 \\\\\nb = 2")]);
    expect(serializeDocumentBody(parseDocumentBody(markdown))).toBe(markdown);
  });

  it("interrupts a paragraph", () => {
    expect(body("Text\n$$x$$\nmore\n")).toEqual([
      paragraph(text("Text")),
      block("x"),
      paragraph(text("more")),
    ]);
  });

  it("keeps an unclosed or blank-line-split block as text", () => {
    expect(nodesOfType(parseDocumentBody("$$\nx\n"), "mathBlock")).toEqual([]);
    expect(
      nodesOfType(parseDocumentBody("$$\nx\n\ny\n$$\n"), "mathBlock"),
    ).toEqual([]);
  });

  it("writes hostile sources so they read back as one block", () => {
    for (const [source, expected] of [
      ["a\n\nb", "a\nb"],
      ["a$$b", "a$ $b"],
      ["\n x \n", "x"],
    ] as const) {
      const markdown = serializeDocumentBody(doc(block(source)));
      expect(body(markdown)).toEqual([block(expected)]);
    }
  });

  it("reads inside quotes and later list blocks", () => {
    expect(
      nodesOfType(parseDocumentBody("> $$x$$\n"), "mathBlock"),
    ).toHaveLength(1);
    const json = parseDocumentBody("- item\n\n  $$x$$\n");
    expect(nodesOfType(json, "mathBlock")).toHaveLength(1);
    validateDocumentContent(json);
  });

  it("makes a list item that starts with a block valid", () => {
    for (const markdown of ["- $$x$$\n", "1. $$x$$\n", "- [ ] $$x$$\n"]) {
      const json = parseDocumentBody(markdown);
      validateDocumentContent(json);
      expect(nodesOfType(json, "inlineMath")).toHaveLength(1);
    }
  });

  it("flattens a block in a table cell to an inline formula", () => {
    const json = doc({
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [{ type: "tableHeader", content: [block("x")] }],
        },
      ],
    });
    expect(serializeDocumentBody(json)).toContain("| $x$ |");
  });
});

describe("validation", () => {
  it("accepts formulas", () => {
    expect(() =>
      validateDocumentContent(
        doc(paragraph(inline("x")), {
          type: "mathBlock",
          attrs: { source: "y" },
        }),
      ),
    ).not.toThrow();
  });

  it.each(["inlineMath", "mathBlock"])("rejects an oversized %s", (type) => {
    const node = { type, attrs: { source: "x".repeat(5_001) } };
    expect(() =>
      validateDocumentContent(
        doc(type === "inlineMath" ? paragraph(node) : node),
      ),
    ).toThrow("formula too long");
  });

  it.each(["inlineMath", "mathBlock"])("rejects a %s without text", (type) => {
    const node = { type, attrs: { source: 1 } };
    expect(() =>
      validateDocumentContent(
        doc(type === "inlineMath" ? paragraph(node) : node),
      ),
    ).toThrow("invalid math attributes");
  });
});

describe("normalizeMathSource: formulas saved before math existed", () => {
  it.each([
    ["2 \\\\times 0 + 1", "2 \\times 0 + 1"],
    ["\\\\sqrt{d\\_k}", "\\sqrt{d_k}"],
    ["x = \\[1, 2\\]", "x = [1, 2]"],
    ["a &lt; b &gt; c &amp; d", "a < b > c & d"],
    ["a\\*b \\~c \\`d", "a*b ~c `d"],
    ["[0,\\\\ 1.414]", "[0,\\ 1.414]"],
  ])("repairs %s", (stored, expected) => {
    expect(normalizeMathSource(stored, false)).toBe(expected);
  });

  it("keeps a matrix row break", () => {
    const source = "\\\\begin{bmatrix} 1 \\\\ 2 \\\\end{bmatrix}";
    const expected = "\\begin{bmatrix} 1 \\\\ 2 \\end{bmatrix}";
    expect(normalizeMathSource(source, false)).toBe(expected);
    expect(normalizeMathSource(source, true)).toBe(expected);
  });

  it("keeps a line break in display math", () => {
    expect(normalizeMathSource("a \\\\ b", true)).toBe("a \\\\ b");
  });

  it("keeps an underscore escape inside text", () => {
    expect(normalizeMathSource("\\text{a\\_b}_c", false)).toBe(
      "\\text{a\\_b}_c",
    );
  });

  it("keeps a spaced row break with an optional size", () => {
    expect(
      normalizeMathSource("\\begin{aligned}a\\\\[2pt]b\\end{aligned}", true),
    ).toBe("\\begin{aligned}a\\\\[2pt]b\\end{aligned}");
  });

  it("is stable on what it produces", () => {
    for (const stored of [
      "\\\\text{a\\_b} \\\\times \\[1\\]",
      "[0,\\\\ 1]",
      "\\\\begin{bmatrix} 1 \\\\ 2 \\\\end{bmatrix}",
    ]) {
      const once = normalizeMathSource(stored, false);
      expect(normalizeMathSource(once, false)).toBe(once);
    }
  });

  it("repairs what the guide's table was saved as", () => {
    expect(sources("| Calc |\n| --- |\n| $2 \\\\times 0 + 1$ |\n")).toEqual([
      "2 \\times 0 + 1",
    ]);
  });

  it("repairs a saved block", () => {
    expect(body("$$\\\\frac{a\\_1}{b} = \\[c\\]$$\n")).toEqual([
      { type: "mathBlock", attrs: { source: "\\frac{a_1}{b} = [c]" } },
    ]);
  });
});

describe("parser limits", () => {
  it("parses many unmatched dollars on one line quickly", () => {
    const started = performance.now();
    parseDocumentBody(`${"$a ".repeat(60_000)}\n`);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it("charges paragraphs of unclosed block openers like plain paragraphs", () => {
    const timed = (markdown: string) => {
      const started = performance.now();
      parseDocumentBody(markdown);
      return performance.now() - started;
    };
    const plain = timed("ab cd\n\n".repeat(4_000));
    expect(timed("$$ a\n\n".repeat(4_000))).toBeLessThan(plain * 3 + 500);
  }, 30_000);

  it("parses many unclosed block openers quickly", () => {
    const started = performance.now();
    parseDocumentBody("$$ a\n".repeat(30_000));
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

import { getSchema, type JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import {
  applyCrossrefLabels,
  validateDocumentContent,
  parseDocumentBody,
  serializeDocumentBody,
} from "./markdown";
import { documentExtensions } from "./extensions";
import { Mermaid } from "./mermaid";

const ID = "6f1f39d4-3f6a-4b7e-9a80-0a4c3a3f1b2c";
const TABLE_ID = "7a2f40e5-4a7b-4c8f-8b91-1b5d4b4f2c3d";
const CROSSREF_LABEL = "Setup [Guide] \\ Notes";
const CALLOUT_VARIANTS = [
  "NOTE",
  "TIP",
  "IMPORTANT",
  "WARNING",
  "CAUTION",
] as const;

function nodesOfType(
  json: { content?: unknown[]; type?: string },
  type: string,
) {
  const nodes = json.type === type ? [json] : [];
  for (const child of json.content ?? []) {
    if (typeof child === "object" && child !== null) {
      nodes.push(...nodesOfType(child, type));
    }
  }
  return nodes;
}

// Every supported construct appears here; extend when the editor grows.
const CORPUS = `# Heading

Paragraph with **bold**, *italic*, \`code\`, a [link](https://example.com) and a crossref [Setup \\[Guide\\] \\\\ Notes](weaver://document/${ID}).

- item one
- item two

1. first
2. second

- [ ] open task
- [x] completed task

> plain blockquote still works

> [!WARNING]
> Callouts round-trip with their variant.

\`\`\`ts
const x: number = 1;
\`\`\`

\`\`\`mermaid
graph TD; A-->B;
\`\`\`


| a   | b   |
| --- | --- |
| 1   | 2   |


![alt text](https://example.com/img.png)
`;

describe("markdown round-trip", () => {
  it.each([
    "**`host` is shared.**",
    "*`host`*",
    "~~`host`~~",
    "[`host`](https://example.com)",
  ])("preserves and validates formatted inline code: %s", (markdown) => {
    const parsed = parseDocumentBody(markdown);
    expect(() => validateDocumentContent(parsed)).not.toThrow();
    const serialized = serializeDocumentBody(parsed);
    expect(serialized.trim()).toBe(markdown);
    const reparsed = parseDocumentBody(serialized);
    expect(() => validateDocumentContent(reparsed)).not.toThrow();
    expect(reparsed).toEqual(parsed);
  });

  it("preserves callout marker-line text and block content", () => {
    const input = "> [!TIP] Heading text\n> - item\n";
    const output = serializeDocumentBody(parseDocumentBody(input));
    expect(output).toContain("Heading text");
    expect(output).toContain("- item");
  });
  it("markdown -> JSON -> markdown preserves the canonical bytes", () => {
    expect(serializeDocumentBody(parseDocumentBody(CORPUS))).toBe(CORPUS);
  });

  it("JSON -> markdown -> JSON is lossless", () => {
    const json = parseDocumentBody(CORPUS);
    const reparsed = parseDocumentBody(serializeDocumentBody(json));
    expect(reparsed).toEqual(json);
  });

  it("preserves crossref target and label through the round-trip", () => {
    const md = serializeDocumentBody(parseDocumentBody(CORPUS));
    expect(md).toContain(
      `[Setup \\[Guide\\] \\\\ Notes](weaver://document/${ID})`,
    );
  });

  it("parses crossrefs as document nodes with their attrs", () => {
    const [crossref] = nodesOfType(parseDocumentBody(CORPUS), "crossref");
    expect(crossref).toMatchObject({
      type: "crossref",
      attrs: {
        targetType: "document",
        targetId: ID,
        label: CROSSREF_LABEL,
      },
    });
  });

  it("round-trips table cross-references", () => {
    const markdown = `See [Budget](weaver://table/${TABLE_ID}) for details.\n`;
    const json = parseDocumentBody(markdown);
    expect(nodesOfType(json, "crossref")[0]).toMatchObject({
      type: "crossref",
      attrs: {
        targetType: "table",
        targetId: TABLE_ID,
        label: "Budget",
      },
    });
    expect(serializeDocumentBody(json)).toBe(markdown);
  });

  it("parses Mermaid fences as dedicated nodes", () => {
    const [diagram] = nodesOfType(parseDocumentBody(CORPUS), "mermaid");
    expect(diagram).toMatchObject({
      type: "mermaid",
      attrs: { source: "graph TD; A-->B;" },
    });
  });

  it.each(["mermaidish", "mermaid-v2"])(
    "keeps the Mermaid-prefix language %s as generic code",
    (language) => {
      const markdown = `\`\`\`${language}\ngraph TD; A-->B;\n\`\`\`\n`;
      const json = parseDocumentBody(markdown);

      expect(nodesOfType(json, "mermaid")).toHaveLength(0);
      expect(nodesOfType(json, "codeBlock")[0]).toMatchObject({
        type: "codeBlock",
        attrs: { language },
      });
      expect(serializeDocumentBody(json)).toBe(markdown);
    },
  );

  it("uses a fence longer than every backtick run in Mermaid source", () => {
    const source = "flowchart TD\n  A --> B\n```\n  B --> C\n`````";
    const json = {
      type: "doc",
      content: [{ type: "mermaid", attrs: { source } }],
    };
    const markdown = serializeDocumentBody(json);

    expect(markdown).toBe(`\`\`\`\`\`\`mermaid\n${source}\n\`\`\`\`\`\`\n`);
    expect(parseDocumentBody(markdown)).toEqual(json);
  });

  it("extracts Mermaid source from clipboard HTML", () => {
    const parseHTML = Mermaid.config.parseHTML as
      | (() => readonly {
          getAttrs?: (element: HTMLElement) => unknown;
        }[])
      | undefined;
    const [rule] = parseHTML?.() ?? [];
    const source = "flowchart TD\n  A --> B";
    const element = {
      textContent: "wrong fallback",
      querySelector: (selector: string) =>
        selector === "code" ? { textContent: source } : null,
    } as unknown as HTMLElement;

    expect(rule?.getAttrs?.(element)).toEqual({ source });
  });

  it("keeps plain blockquotes distinct from callouts", () => {
    const json = parseDocumentBody(CORPUS);
    const types = JSON.stringify(json);
    expect(types).toContain('"blockquote"');
    expect(types).toContain('"callout"');
  });

  it("parses task lists as task-list and task-item nodes", () => {
    const json = parseDocumentBody(CORPUS);

    expect(nodesOfType(json, "taskList")).toHaveLength(1);
    expect(nodesOfType(json, "taskItem")).toHaveLength(2);
  });

  it("serialization is deterministic", () => {
    const json = parseDocumentBody(CORPUS);
    expect(serializeDocumentBody(json)).toBe(serializeDocumentBody(json));
  });

  it("always ends with a newline", () => {
    expect(serializeDocumentBody(parseDocumentBody("hi")).endsWith("\n")).toBe(
      true,
    );
  });

  it.each(CALLOUT_VARIANTS)("round-trips the %s callout variant", (variant) => {
    const markdown = `> [!${variant}]
> ${variant} callout.\n`;
    const json = parseDocumentBody(markdown);
    const [callout] = nodesOfType(json, "callout");

    expect(callout).toMatchObject({
      type: "callout",
      attrs: { variant },
    });
    expect(parseDocumentBody(serializeDocumentBody(json))).toEqual(json);
  });

  it.each(["not-a-canonical-uuid", ID.toUpperCase()])(
    "rejects the noncanonical target ID %s during serialization",
    (targetId) => {
      expect(() =>
        serializeDocumentBody({
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "crossref",
                  attrs: {
                    targetType: "document",
                    targetId,
                    label: "Broken",
                  },
                },
              ],
            },
          ],
        }),
      ).toThrow("canonical lowercase UUID");
    },
  );
});

describe("callout block round-trip", () => {
  const text = (value: string): JSONContent => ({ type: "text", text: value });
  const p = (value?: string): JSONContent => ({
    type: "paragraph",
    content: value ? [text(value)] : [],
  });
  const item = (value: string): JSONContent => ({
    type: "listItem",
    content: [p(value)],
  });
  const callout = (...content: JSONContent[]): JSONContent => ({
    type: "callout",
    attrs: { variant: "NOTE" },
    content,
  });

  // Structures the editor's callout command can wrap.
  it.each<[string, JSONContent[]]>([
    ["several paragraphs", [p("First"), p("Second"), p("Third")]],
    ["an empty paragraph", [p()]],
    ["empty paragraphs between text", [p(), p("Text"), p(), p(), p("End")]],
    [
      "a heading and a paragraph",
      [
        { type: "heading", attrs: { level: 2 }, content: [text("Title")] },
        p("Body"),
      ],
    ],
    [
      "a bullet list",
      [{ type: "bulletList", content: [item("a"), item("b")] }],
    ],
    [
      "an ordered list",
      [{ type: "orderedList", content: [item("a"), item("b")] }],
    ],
    [
      "a task list",
      [
        {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { checked: true },
              content: [p("done")],
            },
            {
              type: "taskItem",
              attrs: { checked: false },
              content: [p("open")],
            },
          ],
        },
      ],
    ],
    [
      "a code block with blank and indented lines",
      [
        {
          type: "codeBlock",
          attrs: { language: "ts" },
          content: [text("const a = 1;\n\n  return a;")],
        },
      ],
    ],
    ["a blockquote", [{ type: "blockquote", content: [p("Quoted")] }]],
    [
      "a Mermaid diagram",
      [{ type: "mermaid", attrs: { source: "graph TD; A-->B;" } }],
    ],
    [
      "a table",
      [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableHeader",
                  content: [p("h")],
                },
              ],
            },
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  content: [p("c")],
                },
              ],
            },
          ],
        },
      ],
    ],
    [
      "a list followed by a paragraph",
      [{ type: "bulletList", content: [item("a")] }, p("after")],
    ],
  ])("JSON -> markdown -> JSON keeps a callout around %s", (_name, content) => {
    for (const json of [
      { type: "doc", content: [callout(...content)] },
      { type: "doc", content: [p("Before"), callout(...content), p("After")] },
      {
        type: "doc",
        content: [
          { type: "blockquote", content: [p("Quote"), callout(...content)] },
        ],
      },
    ]) {
      const markdown = serializeDocumentBody(json);
      expect(parseDocumentBody(markdown), markdown).toEqual(json);
    }
  });

  it("separates the blocks inside a callout", () => {
    expect(
      serializeDocumentBody({
        type: "doc",
        content: [callout(p("a"), p("b"))],
      }),
    ).toBe("> [!NOTE]\n> a\n>\n> b\n");
  });

  it.each<[string, JSONContent[], JSONContent[]]>([
    ["between text", [p("a"), p("  "), p("b")], [p("a"), p(), p("b")]],
    ["at the end", [p("a"), p("\u00a0 ")], [p("a"), p()]],
    ["alone", [p(" ")], [p()]],
  ])(
    "keeps a whitespace-only paragraph %s as an empty paragraph",
    (_name, content, expected) => {
      const markdown = serializeDocumentBody({
        type: "doc",
        content: [callout(...content)],
      });
      expect(parseDocumentBody(markdown), markdown).toEqual({
        type: "doc",
        content: [callout(...expected)],
      });
    },
  );

  it("reads a callout without body lines as one empty paragraph", () => {
    expect(parseDocumentBody("> [!TIP]\n>\n")).toEqual({
      type: "doc",
      content: [{ type: "callout", attrs: { variant: "TIP" }, content: [p()] }],
    });
  });
});

describe("applyCrossrefLabels", () => {
  it("fills labels from the map without mutating the input", () => {
    const json = parseDocumentBody(`See [Old Name](weaver://document/${ID}).`);
    const out = applyCrossrefLabels(
      json,
      new Map([[`document:${ID}`, "New Name"]]),
    );
    expect(JSON.stringify(out)).toContain('"label":"New Name"');
    expect(JSON.stringify(json)).toContain('"label":"Old Name"');
  });

  it("keeps document and table labels distinct when target ids collide", () => {
    const json = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "crossref",
              attrs: { targetId: ID, label: "Old Document" },
            },
            {
              type: "crossref",
              attrs: {
                targetType: "table",
                targetId: ID,
                label: "Old Table",
              },
            },
          ],
        },
      ],
    };

    const out = applyCrossrefLabels(
      json,
      new Map([
        [`document:${ID}`, "Document Title"],
        [`table:${ID}`, "Table Title"],
      ]),
    );

    expect(serializeDocumentBody(out)).toBe(
      `[Document Title](weaver://document/${ID})[Table Title](weaver://table/${ID})\n`,
    );
  });

  it("keeps the existing label when the map has no entry", () => {
    const json = parseDocumentBody(`See [Old Name](weaver://document/${ID}).`);
    const out = applyCrossrefLabels(json, new Map());
    expect(JSON.stringify(out)).toContain('"label":"Old Name"');
  });
});

it.each([
  "text",
  { type: "unknown" },
  { type: "doc", content: [{ type: "unknown" }] },
  { type: "doc", content: [{ type: "text", text: "invalid root text" }] },
])("rejects malformed document trees", (input) => {
  expect(() => validateDocumentContent(input)).toThrow();
});

it.each([
  { targetId: null },
  { targetId: ID.toUpperCase() },
  { targetId: ID, targetType: "project" },
  { targetId: ID, label: 42 },
])("rejects invalid crossrefs before serialization: %j", (attrs) => {
  expect(() =>
    validateDocumentContent({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "crossref", attrs }] }],
    }),
  ).toThrow();
});

it("rejects oversized content before schema validation", () => {
  expect(() =>
    validateDocumentContent({
      type: "doc",
      content: [{ type: "unknown", text: "x".repeat(2_000_001) }],
    }),
  ).toThrow("document too large");
});

it("rejects excessive nesting without entering the recursive schema parser", () => {
  let node: { type: string; content?: unknown[] } = { type: "paragraph" };
  for (let i = 0; i < 200; i++) node = { type: "blockquote", content: [node] };
  expect(() =>
    validateDocumentContent({ type: "doc", content: [node] }),
  ).toThrow("document too deeply nested");
});

it("rejects excessive node counts", () => {
  expect(() =>
    validateDocumentContent({
      type: "doc",
      content: Array.from({ length: 25_001 }, () => ({ type: "paragraph" })),
    }),
  ).toThrow("too many document nodes");
});

describe("images sharing a paragraph", () => {
  const types = (markdown: string) => {
    const json = parseDocumentBody(markdown);
    validateDocumentContent(json);
    return json.content?.map((node) =>
      node.type === "paragraph"
        ? `p:${node.content?.map((child) => child.text ?? child.type).join("")}`
        : node.type,
    );
  };

  it("lifts adjacent images into their own blocks", () => {
    expect(types("![a](a.png)\n![b](b.png)\n")).toEqual(["image", "image"]);
    expect(types("![a](a.png) ![b](b.png)\n")).toEqual(["image", "image"]);
  });

  it("keeps the text around an inline image as paragraphs", () => {
    expect(types("Before ![a](a.png) after\n")).toEqual([
      "p:Before",
      "image",
      "p:after",
    ]);
  });

  it("leaves content alone where an image block is not allowed", () => {
    // A list item must start with a paragraph.
    const json = parseDocumentBody("- ![a](a.png) text\n");
    expect(() => validateDocumentContent(json)).toThrow();
  });
});

describe("documents without image widths", () => {
  it("keep the Markdown image form byte for byte", () => {
    const markdown = `${CORPUS}
![](a.png)

![A \\[b\\]](<guide.assets/my shot.png> "T \\"t\\"")

- Item
  ![in list](guide.assets/a.png)

> ![quoted](https://example.com/a.png?x=1&y=2)

Text &lt;img src="a.png" width="200"> and &lt;img src=x onerror=alert(1)>
`;
    const output = serializeDocumentBody(parseDocumentBody(markdown));
    expect(output).toBe(markdown);
    expect(output).not.toMatch(/<img/);
  });
});

describe("validateDocumentContent image rules", () => {
  const withImage = (attrs: Record<string, unknown>) => ({
    type: "doc",
    content: [{ type: "image", attrs }],
  });

  it("accepts http(s) and relative sources with string alt/title", () => {
    expect(() =>
      validateDocumentContent(
        withImage({ src: "guide.assets/a.png", alt: "A", title: null }),
      ),
    ).not.toThrow();
    expect(() =>
      validateDocumentContent(
        withImage({ src: "https://example.com/a.png", alt: null, title: "t" }),
      ),
    ).not.toThrow();
  });

  it("rejects data URIs, other schemes, absolute paths, and non-string alt", () => {
    for (const attrs of [
      { src: "data:image/png;base64,AAAA" },
      { src: "javascript:alert(1)" },
      { src: "/etc/passwd" },
      { src: "a\\b.png" },
      { src: "" },
      { src: "guide.assets/a.png", alt: 3 },
      { src: "guide.assets/a.png", title: {} },
      {},
    ]) {
      expect(() => validateDocumentContent(withImage(attrs))).toThrow();
    }
  });
});

describe("markdown escaping round-trip", () => {
  const doc = (...content: JSONContent[]): JSONContent => ({
    type: "doc",
    content,
  });
  const paragraph = (...content: JSONContent[]): JSONContent => ({
    type: "paragraph",
    content,
  });
  const code = (text: string, ...marks: string[]): JSONContent => ({
    type: "text",
    text,
    marks: [{ type: "code" }, ...marks.map((type) => ({ type }))],
  });
  const image = (attrs: Record<string, unknown>): JSONContent => ({
    type: "image",
    attrs: { src: "a.png", alt: "alt", title: null, ...attrs },
  });
  const link = (attrs: Record<string, unknown>): JSONContent =>
    paragraph({
      type: "text",
      text: "label",
      marks: [
        {
          type: "link",
          attrs: {
            href: "https://e.com",
            title: null,
            ...attrs,
          },
        },
      ],
    });

  const cases: [string, JSONContent][] = [
    [
      "a code block containing a fence line",
      doc({
        type: "codeBlock",
        attrs: { language: "md" },
        content: [{ type: "text", text: "before\n```\ninner\n```\nafter" }],
      }),
    ],
    ["inline code with a backtick", doc(paragraph(code("a`b")))],
    [
      "inline code that is only a backtick",
      doc(paragraph({ type: "text", text: "x " }, code("`"))),
    ],
    ["inline code starting with a backtick", doc(paragraph(code("`a")))],
    ["inline code ending with a backtick run", doc(paragraph(code("a``")))],
    [
      "inline code split by a bold segment",
      doc(paragraph(code("a`"), code("b``", "bold"), code("c"))),
    ],
    [
      "adjacent inline code under different marks",
      doc(paragraph(code("a", "italic"), code("b", "bold"))),
    ],
    ["image alt with brackets", doc(image({ alt: "x ] y [" }))],
    [
      "image title with quote and backslash",
      doc(image({ title: 'say "hi" \\' })),
    ],
    ["image src with a space", doc(image({ src: "assets/my pic.png" }))],
    ["image src with a closing paren", doc(image({ src: "assets/a)b.png" }))],
    [
      "link href with a closing paren",
      doc(link({ href: "https://e.com/a)b" })),
    ],
    [
      "link href with a space and a quoted title",
      doc(link({ href: "https://e.com/a b", title: 'the "best"' })),
    ],
  ];

  it.each(cases)("round-trips %s", (_name, json) => {
    const before = structuredClone(json);
    const markdown = serializeDocumentBody(json);
    expect(json).toEqual(before);
    expect(parseDocumentBody(markdown)).toEqual(json);
  });

  const text = (value: string): JSONContent => ({ type: "text", text: value });
  const hardBreak: JSONContent = { type: "hardBreak" };
  const cell = (
    type: "tableCell" | "tableHeader",
    ...content: JSONContent[]
  ): JSONContent => ({ type, content });
  const table = (...rows: JSONContent[][]): JSONContent => ({
    type: "table",
    content: rows.map((cells) => ({ type: "tableRow", content: cells })),
  });
  const header = cell("tableHeader", paragraph(text("h")));

  const tableCases: [string, JSONContent][] = [
    [
      "a cell containing a pipe",
      doc(table([header], [cell("tableCell", paragraph(text("a | b")))])),
    ],
    [
      "a header cell containing a pipe",
      doc(table([cell("tableHeader", paragraph(text("x | y")))])),
    ],
    [
      "a cell containing a backslash before a pipe",
      doc(table([header], [cell("tableCell", paragraph(text("a \\| b")))])),
    ],
    [
      "a cell containing a pipe inside inline code",
      doc(table([header], [cell("tableCell", paragraph(code("a | b")))])),
    ],
    [
      "a cell containing a hard break",
      doc(
        table(
          [header],
          [cell("tableCell", paragraph(text("l1"), hardBreak, text("l2")))],
        ),
      ),
    ],
    [
      "a cell containing literal <br> text",
      doc(table([header], [cell("tableCell", paragraph(text("a <br> b")))])),
    ],
    [
      "a cell whose text starts like a heading",
      doc(table([header], [cell("tableCell", paragraph(text("# x")))])),
    ],
    [
      "a paragraph containing literal <br> text",
      doc(paragraph(text("x <br> y"))),
    ],
  ];

  it.each(tableCases)("round-trips %s", (_name, json) => {
    const before = structuredClone(json);
    const markdown = serializeDocumentBody(json);
    expect(json).toEqual(before);
    expect(parseDocumentBody(markdown)).toEqual(json);
  });

  const bulletList = (...items: string[]): JSONContent => ({
    type: "bulletList",
    content: items.map((item) => ({
      type: "listItem",
      content: [paragraph(text(item))],
    })),
  });

  const angleCases: [string, JSONContent][] = [
    ["arrows", doc(paragraph(text("a -> b <- c <=> d => e")))],
    ["a line starting with >", doc(paragraph(text("> not a quote")))],
    [
      "a hard-break line starting with >",
      doc(paragraph(text("x"), hardBreak, text(">y"))),
    ],
    ["a list item starting with >", doc(bulletList("> a", "-> b"))],
    ["tag-like text", doc(paragraph(text("<b>x</b> <mailto:a> <!-- c <?x")))],
    ["a trailing <", doc(paragraph(text("a <"), code("b")))],
    ["entity-like text", doc(paragraph(text("&gt; &lt; &amp; &nbsp;")))],
    [
      "plain ampersands",
      doc(paragraph(text("Platform & Operations, AT&T, a&b, R&D;"))),
    ],
    [
      "numeric entity-like text",
      doc(paragraph(text("&#169; &#x1F600; &#; &x;"))),
    ],
    [
      "an ampersand in a link target",
      doc(link({ href: "https://e.com/?a=1&b=2" })),
    ],
    [
      "an ampersand in a cell",
      doc(table([header], [cell("tableCell", paragraph(text("Q&A")))])),
    ],
    [
      "a > in a cell",
      doc(table([header], [cell("tableCell", paragraph(text("> a")))])),
    ],
  ];

  it.each(angleCases)("round-trips %s", (_name, json) => {
    expect(parseDocumentBody(serializeDocumentBody(json))).toEqual(json);
  });

  it("writes arrows literally and escapes only a quote-opening >", () => {
    expect(
      serializeDocumentBody(
        doc(
          paragraph(text("a -> b <- c <=> d")),
          paragraph(text("> x")),
          bulletList("Altersvorsorge -> Ja"),
        ),
      ),
    ).toBe("a -> b <- c <=> d\n\n\\> x\n\n- Altersvorsorge -> Ja\n");
    expect(serializeDocumentBody(doc(paragraph(text("<b> & &gt;"))))).toBe(
      "&lt;b> & &amp;gt;\n",
    );
    // An `&` is encoded only where it would start an entity reference.
    expect(
      serializeDocumentBody(
        doc(paragraph(text("Platform & Operations &copy; &#169; a&b"))),
      ),
    ).toBe("Platform & Operations &amp;copy; &amp;#169; a&b\n");
    // A literal `>` would extend the GFM autolink.
    expect(
      serializeDocumentBody(doc(paragraph(text("(https://e.com)>")))),
    ).toBe("(https://e.com)&gt;\n");
  });

  it("escapes pipes in cells so the column count survives", () => {
    const markdown = serializeDocumentBody(
      doc(table([header], [cell("tableCell", paragraph(text("a | b")))])),
    );
    expect(markdown).toContain("| a \\| b |");
  });

  it("joins the blocks of a multi-block cell with hard breaks", () => {
    const json = doc(
      table(
        [header],
        [cell("tableCell", paragraph(text("h1")), paragraph(text("h2")))],
      ),
    );
    const before = structuredClone(json);
    const markdown = serializeDocumentBody(json);
    expect(json).toEqual(before);
    expect(markdown).toContain("| h1<br>h2 |");
    expect(parseDocumentBody(markdown)).toEqual(
      doc(
        table(
          [header],
          [cell("tableCell", paragraph(text("h1"), hardBreak, text("h2")))],
        ),
      ),
    );
  });

  it("flattens nested blocks in a cell to one paragraph", () => {
    const json = doc(
      table(
        [header],
        [
          cell("tableCell", {
            type: "bulletList",
            content: [
              { type: "listItem", content: [paragraph(text("one"))] },
              { type: "listItem", content: [paragraph(text("two"))] },
            ],
          }),
        ],
      ),
    );
    expect(parseDocumentBody(serializeDocumentBody(json))).toEqual(
      doc(
        table(
          [header],
          [cell("tableCell", paragraph(text("one"), hardBreak, text("two")))],
        ),
      ),
    );
  });

  const blockStarts = [
    "# not a heading",
    "## two",
    "###### six",
    "#",
    "- not a bullet",
    "-",
    "+ plus",
    "1. not a list",
    "12) paren",
    "1.",
    "---",
    "- - -",
    "===",
    "#hashtag",
    "1.5 stays",
    "-x stays",
  ];
  const wrap = (block: JSONContent): JSONContent[] => [
    block,
    { type: "bulletList", content: [{ type: "listItem", content: [block] }] },
    { type: "blockquote", content: [block] },
    { type: "callout", attrs: { variant: "NOTE" }, content: [block] },
  ];

  it.each(blockStarts)("round-trips block-start text %j", (value) => {
    for (const block of wrap(paragraph(text(value)))) {
      const json = doc(block);
      const markdown = serializeDocumentBody(json);
      expect(parseDocumentBody(markdown), markdown).toEqual(json);
    }
  });

  it.each(blockStarts)(
    "round-trips block-start text %j after a hard break",
    (value) => {
      for (const block of wrap(paragraph(text("a"), hardBreak, text(value)))) {
        const json = doc(block);
        const markdown = serializeDocumentBody(json);
        expect(parseDocumentBody(markdown), markdown).toEqual(json);
      }
    },
  );

  // List items and callouts trim edge whitespace; paragraphs and quotes keep it.
  it.each(["   # three leading spaces", "----- "])(
    "round-trips block-start text %j with edge whitespace",
    (value) => {
      for (const block of wrap(paragraph(text(value))).filter(
        (candidate) =>
          candidate.type !== "bulletList" && candidate.type !== "callout",
      )) {
        const json = doc(block);
        const markdown = serializeDocumentBody(json);
        expect(parseDocumentBody(markdown), markdown).toEqual(json);
      }
    },
  );

  it("keeps consecutive empty paragraphs", () => {
    const json = doc(
      paragraph(text("a")),
      { type: "paragraph", content: [] },
      { type: "paragraph", content: [] },
      paragraph(text("b")),
    );
    expect(parseDocumentBody(serializeDocumentBody(json))).toEqual(json);
  });

  it.each([
    ["    four spaces", "   four spaces"],
    ["\ttab", "   tab"],
    [" \t mixed", "   mixed"],
  ])("trims indented-code leading whitespace %j to %j", (value, expected) => {
    const markdown = serializeDocumentBody(doc(paragraph(text(value))));
    expect(parseDocumentBody(markdown)).toEqual(doc(paragraph(text(expected))));
  });

  it("keeps a balanced-paren URL unbracketed", () => {
    const json = doc(link({ href: "https://e.com/a_(b)" }));
    const markdown = serializeDocumentBody(json);
    expect(markdown).toBe("[label](https://e.com/a_(b))\n");
    expect(parseDocumentBody(markdown)).toEqual(json);
  });

  it("fences on the text left after edge whitespace is hoisted", () => {
    expect(serializeDocumentBody(doc(paragraph(code(" `a"))))).toBe(
      " `` `a ``\n",
    );
  });

  it("drops the code mark from whitespace-only spans", () => {
    const x = { type: "text", text: "x" };
    expect(serializeDocumentBody(doc(paragraph(x, code("  "), x)))).toBe(
      "x  x\n",
    );
  });

  it("does not leak the transient fence attrs into the caller's tree", () => {
    const json = doc(paragraph(code("a`b")));
    expect(serializeDocumentBody(json)).toBe("``a`b``\n");
    expect(JSON.stringify(json)).not.toContain("fence");
  });
});

describe("validateDocumentContent merged table cells", () => {
  const table = (type: string, attrs: Record<string, unknown>) => ({
    type: "doc",
    content: [
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [{ type, attrs, content: [{ type: "paragraph" }] }],
          },
        ],
      },
    ],
  });

  it("accepts unmerged cells", () => {
    expect(() =>
      validateDocumentContent(table("tableCell", { colspan: 1, rowspan: 1 })),
    ).not.toThrow();
  });

  it.each([
    ["tableCell", { colspan: 2 }],
    ["tableCell", { rowspan: 2 }],
    ["tableHeader", { colspan: 3, rowspan: 1 }],
  ])("rejects a merged %s %o", (type, attrs) => {
    expect(() => validateDocumentContent(table(type, attrs))).toThrow(
      "merged table cells are not supported",
    );
  });
});

describe("callout variant normalization", () => {
  it("parses a lowercase marker as the uppercase variant", () => {
    const [callout] = nodesOfType(
      parseDocumentBody("> [!note]\n> body\n"),
      "callout",
    );
    expect(callout).toMatchObject({
      type: "callout",
      attrs: { variant: "NOTE" },
    });
  });

  it.each([
    ["tip", "TIP"],
    ["Warning", "WARNING"],
    ["bogus", "NOTE"],
    [undefined, "NOTE"],
  ])("serializes variant %j as %s", (variant, expected) => {
    const json: JSONContent = {
      type: "doc",
      content: [
        {
          type: "callout",
          attrs: { variant },
          content: [
            { type: "paragraph", content: [{ type: "text", text: "x" }] },
          ],
        },
      ],
    };
    const markdown = serializeDocumentBody(json);
    expect(markdown).toBe(`> [!${expected}]\n> x\n`);
    expect(
      nodesOfType(parseDocumentBody(markdown), "callout")[0],
    ).toMatchObject({ attrs: { variant: expected } });
  });
});

describe("pasted merged cells", () => {
  const schema = getSchema(documentExtensions());
  // The parse rules only read attributes, so a stub element stands in for a DOM.
  const element = (attrs: Record<string, string>, empty = false) =>
    ({
      getAttribute: (name: string) => attrs[name] ?? null,
      hasAttribute: (name: string) => name in attrs,
      closest: () => null,
      style: {},
      children: [],
      textContent: empty ? "" : "x",
    }) as unknown as HTMLElement;

  it.each(["tableCell", "tableHeader"])(
    "clamps colspan and rowspan on %s",
    (type) => {
      const rules = schema.nodes[type]!.spec.parseDOM!;
      expect(rules.length).toBeGreaterThanOrEqual(2);
      expect(
        rules[1]!.getAttrs!(element({ colspan: "2", rowspan: "3" })),
      ).toMatchObject({ colspan: 1, rowspan: 1 });
      expect(
        rules[0]!.getAttrs!(element({ colspan: "2", rowspan: "3" }, true)),
      ).toMatchObject({ colspan: 1, rowspan: 1 });
    },
  );
});

describe("ordered list items without text", () => {
  const markdown = "5. \n```python\nx = 1\n```\n";

  it("parses the empty item as one empty paragraph", () => {
    const json = parseDocumentBody(markdown);
    expect(nodesOfType(json, "listItem")).toEqual([
      { type: "listItem", content: [{ type: "paragraph", content: [] }] },
    ]);
    expect(() => validateDocumentContent(json)).not.toThrow();
  });

  it("serializes and round-trips the empty item", () => {
    const json = parseDocumentBody(markdown);
    const serialized = serializeDocumentBody(json);
    expect(parseDocumentBody(serialized)).toEqual(json);
  });
});

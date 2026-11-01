import { getSchema, type JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { documentExtensions } from "./extensions";
import { parseImageTag, renderImageTag } from "./imageTag";
import {
  parseDocumentBody,
  serializeDocumentBody,
  validateDocumentContent,
} from "./markdown";

const REFERENCE = "weaver-image:6f1f39d4-3f6a-4b7e-9a80-0a4c3a3f1b2c";

const doc = (...content: JSONContent[]): JSONContent => ({
  type: "doc",
  content,
});
const image = (attrs: Record<string, unknown>): JSONContent => ({
  type: "image",
  attrs,
});
const images = (markdown: string) =>
  (parseDocumentBody(markdown).content ?? [])
    .filter((node) => node.type === "image")
    .map((node) => node.attrs);
const shape = (markdown: string) => {
  const json = parseDocumentBody(markdown);
  validateDocumentContent(json);
  return json.content?.map((node) =>
    node.type === "paragraph"
      ? `p:${node.content?.map((child) => child.text ?? child.type).join("")}`
      : node.type,
  );
};
const literal = (markdown: string) => {
  const json = parseDocumentBody(markdown);
  expect(JSON.stringify(json)).not.toContain('"image"');
  return json;
};

describe("image width in Markdown", () => {
  it("writes an image with a width as an img tag on its own line", () => {
    expect(
      serializeDocumentBody(
        doc(
          { type: "paragraph", content: [{ type: "text", text: "Before" }] },
          image({
            src: "doc.assets/shot.png",
            alt: "Login dialog",
            width: 400,
          }),
          { type: "paragraph", content: [{ type: "text", text: "After" }] },
        ),
      ),
    ).toBe(
      'Before\n\n<img src="doc.assets/shot.png" alt="Login dialog" width="400">\n\nAfter\n',
    );
  });

  it("orders the attributes src, alt, title, width and escapes their values", () => {
    expect(
      serializeDocumentBody(
        doc(
          image({
            src: "https://example.com/a.png?x=1&y=2",
            alt: 'A "quoted" <tag> & more',
            title: "T > \"t\" & 'u'",
            width: 16,
          }),
        ),
      ),
    ).toBe(
      '<img src="https://example.com/a.png?x=1&amp;y=2" alt="A &quot;quoted&quot; &lt;tag&gt; &amp; more" title="T &gt; &quot;t&quot; &amp; \'u\'" width="16">\n',
    );
  });

  it("keeps an image without a width as plain Markdown", () => {
    for (const width of [null, undefined]) {
      expect(
        serializeDocumentBody(
          doc(image({ src: "a.png", alt: "A [b]", title: 'T "t"', width })),
        ),
      ).toBe('![A \\[b\\]](a.png "T \\"t\\"")\n');
    }
  });

  it("reads the tag back with its width", () => {
    expect(
      images(
        '<img src="doc.assets/shot.png" alt="Login dialog" width="400">\n',
      ),
    ).toEqual([
      {
        src: "doc.assets/shot.png",
        alt: "Login dialog",
        title: null,
        width: 400,
      },
    ]);
    expect(
      images(
        '<img src="a.png" alt="A &quot;q&quot; &lt;t&gt; &amp; b" title="it&#39;s" width="4096" />\n',
      ),
    ).toEqual([
      { src: "a.png", alt: 'A "q" <t> & b', title: "it's", width: 4096 },
    ]);
  });

  it.each([
    doc(image({ src: "doc.assets/shot.png", alt: "Login dialog", width: 400 })),
    doc(
      image({
        src: "https://example.com/a.png?x=1&y=2",
        alt: 'A "quoted" <tag> & \\ [x] &amp; more',
        title: "T > \"t\" & 'u' &lt;",
        width: 16,
      }),
    ),
    doc(
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Item" }] },
              image({ src: "a.png", alt: "", width: 300 }),
            ],
          },
        ],
      },
      {
        type: "blockquote",
        content: [image({ src: "b.png", alt: "B", width: 120 })],
      },
      {
        type: "callout",
        attrs: { variant: "NOTE" },
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Note" }] },
          image({ src: "c.png", alt: "C", width: 640 }),
        ],
      },
      image({ src: "d.png", alt: "D", width: 64 }),
      image({ src: "e.png", alt: "E" }),
    ),
  ])("round-trips a tree with widths (%#)", (tree) => {
    const markdown = serializeDocumentBody(tree);
    const parsed = parseDocumentBody(markdown);
    validateDocumentContent(parsed);
    expect(serializeDocumentBody(parsed)).toBe(markdown);
    expect(parseDocumentBody(serializeDocumentBody(parsed))).toEqual(parsed);
  });

  it("keeps every width of a round-tripped tree", () => {
    const markdown =
      '- Item\n  \n  <img src="a.png" alt="" width="300">\n\n> <img src="b.png" alt="B" width="120">\n';
    const widths: unknown[] = [];
    const walk = (node: JSONContent): void => {
      if (node.type === "image") widths.push(node.attrs?.width);
      node.content?.forEach(walk);
    };
    walk(parseDocumentBody(markdown));
    expect(widths).toEqual([300, 120]);
    expect(serializeDocumentBody(parseDocumentBody(markdown))).toBe(markdown);
  });

  it("drops a width outside 16–4096 or not a whole number, keeping the image", () => {
    for (const width of [
      "15",
      "4097",
      "0",
      "-5",
      "040",
      "12.5",
      "50%",
      "abc",
      "",
      "400px",
      "99999",
    ]) {
      const markdown = `<img src="a.png" alt="A" width="${width}">\n`;
      expect(images(markdown)).toEqual([
        { src: "a.png", alt: "A", title: null },
      ]);
      expect(serializeDocumentBody(parseDocumentBody(markdown))).toBe(
        "![A](a.png)\n",
      );
    }
  });

  it("normalizes a tag without a width to plain Markdown and drops height", () => {
    expect(
      serializeDocumentBody(parseDocumentBody('<img src="a.png" alt="A">\n')),
    ).toBe("![A](a.png)\n");
    expect(
      serializeDocumentBody(
        parseDocumentBody('<img src="a.png" width="200" height="900">\n'),
      ),
    ).toBe('<img src="a.png" alt="" width="200">\n');
  });

  it("lifts a tag that shares a paragraph with text", () => {
    expect(
      shape('Before <img src="a.png" alt="A" width="200"> after\n'),
    ).toEqual(["p:Before", "image", "p:after"]);
    expect(
      shape('Before\n<img src="a.png" alt="A" width="200">\nafter\n'),
    ).toEqual(["p:Before", "image", "p:after"]);
    expect(
      shape(
        '<img src="a.png" width="200"> ![b](b.png)\n<img src="c.png" width="20">\n',
      ),
    ).toEqual(["image", "image", "image"]);
    expect(
      serializeDocumentBody(
        parseDocumentBody(
          'Before <img src="a.png" alt="A" width="200"> after\n',
        ),
      ),
    ).toBe('Before\n\n<img src="a.png" alt="A" width="200">\n\nafter\n');
  });

  describe("where an image cannot stand", () => {
    const tag = '<img src="a.png" alt="A" width="200">';
    const text = (value: string): JSONContent => ({
      type: "paragraph",
      content: [{ type: "text", text: value }],
    });
    const item = (...content: JSONContent[]): JSONContent => ({
      type: "listItem",
      content,
    });
    const row = (type: string, ...cells: string[]): JSONContent => ({
      type: "tableRow",
      content: cells.map((cell) => ({ type, content: [text(cell)] })),
    });

    // Each expected tree is what the parser produced before tags were recognised.
    it.each([
      [
        "a heading",
        `# How to write ${tag} here\n`,
        [
          {
            type: "heading",
            attrs: { level: 1 },
            content: [{ type: "text", text: `How to write ${tag} here` }],
          },
        ],
      ],
      [
        "a heading holding only the tag",
        `## ${tag}\n`,
        [
          {
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: tag }],
          },
        ],
      ],
      [
        "a table cell",
        `| a | b |\n| --- | --- |\n| ${tag} | text ${tag} |\n`,
        [
          {
            type: "table",
            content: [
              row("tableHeader", "a", "b"),
              row("tableCell", tag, `text ${tag}`),
            ],
          },
        ],
      ],
      [
        "a table header",
        `| ${tag} | b |\n| --- | --- |\n| 1 | 2 |\n`,
        [
          {
            type: "table",
            content: [row("tableHeader", tag, "b"), row("tableCell", "1", "2")],
          },
        ],
      ],
      [
        "a list item's first paragraph",
        `- ${tag} text\n`,
        [{ type: "bulletList", content: [item(text(`${tag} text`))] }],
      ],
      [
        "a list item holding only the tag",
        `- ${tag}\n`,
        [{ type: "bulletList", content: [item(text(tag))] }],
      ],
      [
        "an ordered list item",
        `1. ${tag}\n2. ${tag} two\n`,
        [
          {
            type: "orderedList",
            content: [item(text(tag)), item(text(`${tag} two`))],
          },
        ],
      ],
      [
        "a task item",
        `- [ ] ${tag} todo\n`,
        [
          {
            type: "taskList",
            content: [
              {
                type: "taskItem",
                attrs: { checked: false },
                content: [text(`${tag} todo`)],
              },
            ],
          },
        ],
      ],
      [
        "a nested list item",
        `- one\n  - ${tag} deep\n`,
        [
          {
            type: "bulletList",
            content: [
              item(text("one"), {
                type: "bulletList",
                content: [item(text(`${tag} deep`))],
              }),
            ],
          },
        ],
      ],
      [
        "inline code",
        `Use \`${tag}\` here\n`,
        [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Use " },
              { type: "text", text: tag, marks: [{ type: "code" }] },
              { type: "text", text: " here" },
            ],
          },
        ],
      ],
      [
        "a fenced code block",
        `\`\`\`html\n${tag}\n\`\`\`\n`,
        [
          {
            type: "codeBlock",
            attrs: { language: "html" },
            content: [{ type: "text", text: tag }],
          },
        ],
      ],
      [
        "an indented code block",
        `    ${tag}\n`,
        [
          {
            type: "codeBlock",
            attrs: { language: null },
            content: [{ type: "text", text: tag }],
          },
        ],
      ],
    ])("keeps the tag as literal text in %s", (_name, markdown, content) => {
      const json = parseDocumentBody(markdown);
      expect(json).toEqual({ type: "doc", content });
      validateDocumentContent(json);
      const again = serializeDocumentBody(json);
      expect(parseDocumentBody(again)).toEqual(json);
      expect(serializeDocumentBody(parseDocumentBody(again))).toBe(again);
    });

    it("keeps a cell's Markdown image handling when a tag sits beside it", () => {
      const cell = parseDocumentBody(`| a |\n| --- |\n| ![m](m.png) ${tag} |\n`)
        .content![0]!.content![1]!.content![0]!;
      expect(cell.content).toEqual([
        { type: "image", attrs: { src: "m.png", title: null, alt: "m" } },
        text(tag),
      ]);
    });

    it("still reads the tag after a list item's first paragraph", () => {
      const markdown = `- Item\n  ${tag}\n`;
      // Saved with a blank line above the tag, which is how Weaver writes it.
      const saved = `- Item\n  \n  ${tag}\n`;
      expect(serializeDocumentBody(parseDocumentBody(markdown))).toBe(saved);
      expect(serializeDocumentBody(parseDocumentBody(saved))).toBe(saved);
      expect(JSON.stringify(parseDocumentBody(markdown))).toContain(
        '"width":200',
      );
    });

    it("never stores the tag source on an image", () => {
      for (const markdown of [`${tag}\n`, `Text ${tag} more\n`, `> ${tag}\n`])
        expect(JSON.stringify(parseDocumentBody(markdown))).not.toContain(
          "imageTag",
        );
    });
  });

  it("accepts an image reference as the source", () => {
    expect(images(`<img src="${REFERENCE}" alt="Shot" width="300">\n`)).toEqual(
      [{ src: REFERENCE, alt: "Shot", title: null, width: 300 }],
    );
  });

  it.each([
    "<img src=x onerror=alert(1)>",
    '<img src="a.png" onerror="alert(1)">',
    '<img src="a.png" onload="x" width="200">',
    '<img src="javascript:alert(1)" width="200">',
    '<img src="JaVaScRiPt:alert(1)">',
    '<img src="data:image/png;base64,AAAA" width="200">',
    '<img src="file:///etc/passwd">',
    '<img src="/etc/passwd" width="200">',
    '<img src="a\\b.png">',
    '<img src="" width="200">',
    '<img alt="no source" width="200">',
    "<img src='a.png' width='200'>",
    "<img src=a.png width=200>",
    '<img src="a.png" src="b.png">',
    '<img src="a.png" width="200" width="300">',
    '<img src="a.png" style="width:200px">',
    '<img src="a.png" class="x">',
    '<img src="a.png" srcset="b.png 2x">',
    '<img src="a.png" data-x="1">',
    '<IMG src="a.png" width="200">',
    '<img SRC="a.png" width="200">',
    '<img src="a.png"width="200">',
    '<img\nsrc="a.png" width="200">',
    '<img src="a.png" alt="a > b">',
    '<img src="a.png" alt="a < b">',
    '<img src="a.png" width="200"',
    "<img>",
    "<img />",
    '<image src="a.png" width="200">',
    '<imgx src="a.png" width="200">',
    '<picture><img src="a.png" width="200"></picture>',
    '<a href="https://example.com"><img src="a.png" width="200"></a>',
    "<script>alert(1)</script>",
    '<iframe src="https://example.com"></iframe>',
    '<div><img src="a.png" width="200"></div>',
  ])("does not turn %s into an image", (html) => {
    expect(parseImageTag(html)).toBeNull();
  });

  it.each([
    "<img src=x onerror=alert(1)>",
    '<img src="a.png" onerror="alert(1)">',
    '<img src="javascript:alert(1)" width="200">',
    '<img src="data:image/png;base64,AAAA" width="200">',
    "<img src='a.png' width='200'>",
    '<IMG src="a.png" width="200">',
    '<img src="a.png" style="width:200px">',
    "<script>alert(1)</script>",
    '<iframe src="x"></iframe>',
  ])("keeps %s as literal text, alone or beside text", (html) => {
    for (const markdown of [`${html}\n`, `Text ${html} more\n`]) {
      const json = literal(markdown);
      validateDocumentContent(json);
      expect(JSON.stringify(json)).toContain(JSON.stringify(html).slice(1, -1));
      const again = serializeDocumentBody(json);
      expect(literal(again)).toEqual(json);
    }
  });

  it("keeps a rejected tag inside the paragraph it was written in", () => {
    const markdown = "Before\n<img src=x onerror=alert(1)>\nafter\n";
    const json = literal(markdown);
    expect(json.content).toHaveLength(1);
    expect(serializeDocumentBody(json)).toBe(
      "Before\n&lt;img src=x onerror=alert(1)>\nafter\n",
    );
  });

  it("leaves a tag inside code untouched", () => {
    const tag = '<img src="a.png" alt="A" width="200">';
    for (const markdown of [
      `\`${tag}\`\n`,
      `\`\`\`html\n${tag}\n\`\`\`\n`,
      `    ${tag}\n`,
      `\\${tag}\n`,
    ])
      literal(markdown);
  });

  it("writes a typed tag as text, not as an image", () => {
    const tag = '<img src="a.png" alt="A" width="200">';
    const tree = doc({
      type: "paragraph",
      content: [{ type: "text", text: tag }],
    });
    const markdown = serializeDocumentBody(tree);
    expect(markdown).toBe(`&lt;img src="a.png" alt="A" width="200">\n`);
    expect(parseDocumentBody(markdown)).toEqual(tree);
  });

  it("renders and parses the tag form as inverses", () => {
    const attrs = {
      src: "a b/ä.png",
      alt: '&quot; "<>&',
      title: "&amp;",
      width: 123,
    };
    expect(parseImageTag(renderImageTag(attrs))).toEqual(attrs);
  });
});

describe("line breaks and tabs in alt and title", () => {
  const sized = (alt: string, title: string | null): JSONContent =>
    image({ src: "a.png", alt, title, width: 200 });
  const para = (value: string): JSONContent => ({
    type: "paragraph",
    content: [{ type: "text", text: value }],
  });

  it.each([
    ["a line feed", "a\nb"],
    ["a carriage return and line feed", "a\r\nb"],
    ["a tab", "a\tb"],
  ])("round-trips %s at top level and inside containers", (_name, value) => {
    for (const tree of [
      doc(sized(value, null), sized("A", value)),
      doc({ type: "blockquote", content: [sized(value, value)] }),
      doc({
        type: "bulletList",
        content: [
          { type: "listItem", content: [para("Item"), sized(value, value)] },
        ],
      }),
      doc({
        type: "callout",
        attrs: { variant: "NOTE" },
        content: [para("Note"), sized(value, value)],
      }),
    ]) {
      const markdown = serializeDocumentBody(tree);
      for (const line of markdown.split("\n").filter((l) => l.includes("<img")))
        expect(line).toMatch(/<img [^\n]*width="200">$/);
      const parsed = parseDocumentBody(markdown);
      validateDocumentContent(parsed);
      const attrs: unknown[] = [];
      const expected: unknown[] = [];
      const walk = (node: JSONContent, into: unknown[]): void => {
        if (node.type === "image")
          into.push([node.attrs?.alt, node.attrs?.title, node.attrs?.width]);
        node.content?.forEach((child) => walk(child, into));
      };
      walk(parsed, attrs);
      walk(tree, expected);
      expect(attrs).toEqual(expected);
      expect(serializeDocumentBody(parsed)).toBe(markdown);
      expect(parseDocumentBody(serializeDocumentBody(parsed))).toEqual(parsed);
    }
  });

  it("writes them as character references on one line", () => {
    expect(serializeDocumentBody(doc(sized("a\r\n\tb", "t\nu")))).toBe(
      '<img src="a.png" alt="a&#13;&#10;&#9;b" title="t&#10;u" width="200">\n',
    );
  });

  it("keeps a resized image whose alt text came with a line break", () => {
    const parsed = parseDocumentBody("![a\nb](a.png)\n");
    parsed.content![0]!.attrs!.width = 300;
    const markdown = serializeDocumentBody(parsed);
    expect(images(markdown)).toEqual([
      { src: "a.png", alt: "a\nb", title: null, width: 300 },
    ]);
  });
});

describe("image tags in list items", () => {
  const tag = '<img src="a.png" alt="A" width="200">';
  const bare = '<img src="a.png" alt="A">';
  const para = (value: string): JSONContent => ({
    type: "paragraph",
    content: [{ type: "text", text: value }],
  });
  const settled = (markdown: string) => {
    const json = parseDocumentBody(markdown);
    validateDocumentContent(json);
    const saved = serializeDocumentBody(json);
    const again = parseDocumentBody(saved);
    validateDocumentContent(again);
    expect(again).toEqual(json);
    expect(serializeDocumentBody(again)).toBe(saved);
    return json;
  };
  const sizedImage = { src: "a.png", title: null, alt: "A", width: 200 };
  const plainImage = { src: "a.png", title: null, alt: "A" };

  it.each([
    ["with a width", tag, sizedImage],
    ["without a width", bare, plainImage],
  ])(
    "reads a tag line between text lines like a Markdown image (%s)",
    (_name, source, attrs) => {
      const item = (markdown: string) =>
        settled(markdown).content![0]!.content![0]!.content!;
      expect(item(`- Step\n  ${source}\n  Then\n`)).toEqual([
        para("Step"),
        { type: "image", attrs },
        para("Then"),
      ]);
      expect(item(`- Step\n  ${source}\n  Then\n`)).toEqual(
        item("- Step\n  ![A](a.png)\n  Then\n").map((node) =>
          node.type === "image" ? { ...node, attrs } : node,
        ),
      );
    },
  );

  it.each([
    ["with a width", tag],
    ["without a width", bare],
  ])(
    "keeps a tag that starts the item, with its next line, as text (%s)",
    (_name, source) => {
      expect(settled(`- ${source}\n  more\n`).content).toEqual([
        {
          type: "bulletList",
          content: [{ type: "listItem", content: [para(`${source}\nmore`)] }],
        },
      ]);
    },
  );

  // A task item's own tokenizer already splits its lines into paragraphs.
  it("handles nested and task list items", () => {
    const nested = settled(`- one\n  - Step\n    ${tag}\n    Then\n`);
    expect(
      nested.content![0]!.content![0]!.content![1]!.content![0]!.content,
    ).toEqual([
      para("Step"),
      { type: "image", attrs: sizedImage },
      para("Then"),
    ]);
    const task = settled(`- [ ] Step\n  ${tag}\n  Then\n`);
    expect(task.content![0]!.content![0]!.content).toEqual([
      para("Step"),
      { type: "image", attrs: sizedImage },
      para("Then"),
    ]);
    expect(
      settled(`- [ ] ${tag}\n  more\n`).content![0]!.content![0]!.content,
    ).toEqual([para(tag), para("more")]);
  });

  it("reads a tag that is a list item's whole second paragraph", () => {
    expect(
      settled(`- Step\n\n  ${tag}\n`).content![0]!.content![0]!.content,
    ).toEqual([para("Step"), { type: "image", attrs: sizedImage }]);
  });
});

describe("tags that are not images keep the old parse", () => {
  const text = (
    value: string,
    ...marks: NonNullable<JSONContent["marks"]>
  ): JSONContent => ({
    type: "text",
    text: value,
    ...(marks.length ? { marks } : {}),
  });
  const para = (...content: JSONContent[]): JSONContent => ({
    type: "paragraph",
    content,
  });
  const sized = '<img src="a.png" width="200">';
  const escaped = '&lt;img src="a.png" width="200">';

  // Trees and Markdown below are the output of the parser before tags were recognised.
  it.each([
    '<img src="a.png" onerror="x">',
    '<img src="javascript:alert(1)" width="200">',
    '<img src="a.png" src="b.png">',
  ])("leaves %s inside its paragraph", (rejected) => {
    const json = parseDocumentBody(`a\n${rejected}\nb\n`);
    expect(json).toEqual(doc(para(text(`a\n${rejected}\nb`))));
    expect(serializeDocumentBody(json)).toBe(
      `a\n${rejected.replace("<", "&lt;")}\nb\n`,
    );
  });

  it("keeps a link around a tag in a table cell", () => {
    const json = parseDocumentBody(
      `| a |\n| --- |\n| [${sized}](http://x.y) |\n`,
    );
    const link = { type: "link", attrs: { href: "http://x.y", title: null } };
    expect(json.content![0]!.content![1]!.content![0]!.content).toEqual([
      para(text(sized, link)),
    ]);
    expect(serializeDocumentBody(json)).toBe(
      `\n| a                                              |\n| ---------------------------------------------- |\n| [${escaped}](http://x.y) |\n`,
    );
  });

  it("keeps bold around a tag that starts a list item", () => {
    const json = parseDocumentBody(`- **${sized}**\n`);
    expect(json.content![0]!.content![0]!.content).toEqual([
      para(text(sized, { type: "bold" })),
    ]);
    expect(serializeDocumentBody(json)).toBe(`- **${escaped}**\n`);
  });

  it("keeps bold around a tag in a heading", () => {
    const json = parseDocumentBody(`## a **${sized}** b\n`);
    expect(json.content![0]!.content).toEqual([
      text("a "),
      text(sized, { type: "bold" }),
      text(" b"),
    ]);
    expect(serializeDocumentBody(json)).toBe(`## a **${escaped}** b\n`);
  });

  it.each([
    '<img src="weaver-image:" width="200">',
    '<img src="weaver-image:x&quot;y" width="200">',
  ])("does not accept the malformed image reference %s", (tag) => {
    expect(parseImageTag(tag)).toBeNull();
    expect(parseDocumentBody(`${tag}\n`)).toEqual(doc(para(text(tag))));
  });

  it("reads a tag line that starts a paragraph, with the lines after it", () => {
    expect(shape(`${sized}\nmore text\n`)).toEqual(["image", "p:more text"]);
    expect(shape(`${sized}\n${sized}\n`)).toEqual(["image", "image"]);
    expect(shape(`> ${sized}\n> text\n`)).toEqual(["blockquote"]);
  });

  it("reads a tag standing alone between the lines of another element", () => {
    expect(shape(`<div>\n\n${sized}\n\n</div>\n`)).toEqual([
      "p:<div>",
      "image",
      "p:</div>",
    ]);
    expect(shape(`<div>${sized}</div>\n`)).toEqual([`p:<div>${sized}</div>`]);
  });

  it("never leaves a parser marker in a tree", () => {
    const tag = '<img src="a.png" alt="A" width="200">';
    for (const markdown of [
      `${tag}\n`,
      `   ${tag}\n`,
      `${tag}\nmore **text**\n`,
      `${tag}\n${tag}\n`,
      `Text ${tag} more\n`,
      `Text **${tag}** more\n`,
      `[${tag}](http://x.y)\n`,
      `# ${tag}\n`,
      `## a **${tag}** b\n`,
      `- ${tag}\n`,
      `- ${tag}\n  more\n`,
      `- Step\n  ${tag}\n  Then\n`,
      `- **${tag}**\n`,
      `- one\n  - ${tag} deep\n`,
      `- [ ] ${tag}\n`,
      `> ${tag}\n> text\n`,
      `> [!NOTE]\n> ${tag}\n`,
      `| ${tag} | [${tag}](http://x.y) |\n| --- | --- |\n| **${tag}** | ![m](m.png) ${tag} |\n`,
      `\`${tag}\`\n`,
      `<div>\n\n${tag}\n\n</div>\n`,
    ]) {
      const json = parseDocumentBody(markdown);
      expect(JSON.stringify(json)).not.toMatch(/imageTag|sourceTag/);
      validateDocumentContent(json);
    }
  });
});

describe("validateDocumentContent image width", () => {
  const withWidth = (width: unknown) =>
    doc(image({ src: "a.png", alt: "A", width }));

  it("accepts whole pixels from 16 to 4096 and no width", () => {
    for (const width of [16, 400, 4096, null, undefined])
      expect(() => validateDocumentContent(withWidth(width))).not.toThrow();
  });

  it("rejects any other width", () => {
    for (const width of [
      15,
      4097,
      0,
      -1,
      12.5,
      "400",
      "50%",
      NaN,
      Infinity,
      true,
      {},
    ])
      expect(() => validateDocumentContent(withWidth(width))).toThrow(
        "invalid image attributes",
      );
  });
});

describe("image width from pasted HTML", () => {
  const rule = getSchema(documentExtensions()).nodes.image!.spec.parseDOM![0]!;
  // The parse rules only read attributes, so a stub element stands in for a DOM.
  const attrs = (values: Record<string, string>) =>
    rule.getAttrs!({
      getAttribute: (name: string) => values[name] ?? null,
      hasAttribute: (name: string) => name in values,
    } as unknown as HTMLElement);

  it("keeps the width of an image copied from a document", () => {
    expect(
      attrs({
        src: "/api/projects/p/files/doc.assets/a.png",
        "data-weaver-src": "doc.assets/a.png",
        alt: "A",
        width: "300",
      }),
    ).toMatchObject({ alt: "A", width: 300 });
  });

  it("ignores the width of any other image and drops unknown attributes", () => {
    const parsed = attrs({
      src: "https://example.com/a.png",
      width: "300",
      onerror: "alert(1)",
      style: "width:300px",
      class: "x",
    }) as Record<string, unknown>;
    expect(parsed).toEqual({ src: "https://example.com/a.png" });
  });

  it("ignores a width that is out of range or not whole pixels", () => {
    for (const width of [
      "15",
      "4097",
      "12.5",
      "50%",
      "300px",
      "abc",
      "",
      "-20",
    ])
      expect(
        attrs({ src: "a.png", "data-weaver-src": "a.png", width }),
      ).toEqual({ src: "a.png" });
  });
});

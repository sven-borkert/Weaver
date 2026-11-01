import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import {
  parseDocumentBody,
  serializeDocumentBody,
  validateDocumentContent,
} from "./markdown";

const block = (markdown: string): JSONContent =>
  parseDocumentBody(markdown).content![0]!;
const para = (text: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});
const doc = (...content: JSONContent[]): JSONContent => ({
  type: "doc",
  content,
});

const SIZED = block('<img src="a.png" alt="A" width="200">\n');
const PLAIN = block("![A](a.png)\n");

const NEIGHBOURS: Record<string, JSONContent> = {
  paragraph: para("Text"),
  heading: block("## Heading\n"),
  "bullet list": block("- one\n- two\n"),
  "ordered list": block("1. one\n2. two\n"),
  "task list": block("- [ ] open\n- [x] done\n"),
  blockquote: block("> quoted\n"),
  callout: block("> [!NOTE]\n> noted\n"),
  "code block with a blank line": block("```ts\na\n\nb\n```\n"),
  "mermaid block with a blank line": block(
    "```mermaid\ngraph TD\n\nA-->B\n```\n",
  ),
  table: block("| a | b |\n| --- | --- |\n| 1 | 2 |\n"),
  "horizontal rule": block("---\n"),
  "resized image": block('<img src="b.png" alt="B" width="64">\n'),
  "plain image": block("![B](b.png)\n"),
};

const CONTAINERS: Record<string, (blocks: JSONContent[]) => JSONContent> = {
  "top level": (blocks) => doc(...blocks),
  "list item": (blocks) =>
    doc({
      type: "bulletList",
      content: [{ type: "listItem", content: [para("Item"), ...blocks] }],
    }),
  "task item": (blocks) =>
    doc({
      type: "taskList",
      content: [
        {
          type: "taskItem",
          attrs: { checked: false },
          content: [para("Task"), ...blocks],
        },
      ],
    }),
  "nested list item": (blocks) =>
    doc({
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            para("Outer"),
            {
              type: "bulletList",
              content: [
                { type: "listItem", content: [para("Inner"), ...blocks] },
              ],
            },
          ],
        },
      ],
    }),
  blockquote: (blocks) => doc({ type: "blockquote", content: blocks }),
  callout: (blocks) =>
    doc({
      type: "callout",
      attrs: { variant: "NOTE" },
      content: [para("Note"), ...blocks],
    }),
};

type Outcome = "stable" | "changed" | "invalid";

function roundTrip(tree: JSONContent): Outcome {
  const saved = serializeDocumentBody(tree);
  const parsed = parseDocumentBody(saved);
  try {
    validateDocumentContent(parsed);
  } catch {
    return "invalid";
  }
  return JSON.stringify(parsed) === JSON.stringify(tree) &&
    serializeDocumentBody(parsed) === saved
    ? "stable"
    : "changed";
}

// Outcomes [with a plain Markdown image, with a resized image] wherever they are
// not both "stable". The first column is the behaviour from before image widths
// existed: the list item renderer joins blocks with a single line break, which
// the parser reads differently. A resized image is written between blank lines
// and must never do worse than the plain one.
const KNOWN: Record<string, [Outcome, Outcome]> = {
  "list item | image before heading": ["invalid", "stable"],
  "list item | image after bullet list": ["changed", "stable"],
  "list item | image before ordered list": ["invalid", "stable"],
  "list item | image after ordered list": ["invalid", "stable"],
  "list item | image before task list": ["invalid", "stable"],
  "list item | image after blockquote": ["changed", "stable"],
  "list item | image before callout": ["invalid", "invalid"],
  "list item | image after callout": ["invalid", "invalid"],
  "list item | image before mermaid block with a blank line": [
    "invalid",
    "stable",
  ],
  "list item | image before horizontal rule": ["invalid", "stable"],
  "list item | image after horizontal rule": ["invalid", "invalid"],
  "task item | image after bullet list": ["changed", "stable"],
  "task item | image after ordered list": ["changed", "stable"],
  "task item | image after blockquote": ["changed", "stable"],
  "task item | image before horizontal rule": ["invalid", "stable"],
  "nested list item | image before heading": ["invalid", "stable"],
  "nested list item | image after bullet list": ["changed", "stable"],
  "nested list item | image before ordered list": ["invalid", "stable"],
  "nested list item | image after ordered list": ["invalid", "stable"],
  "nested list item | image before task list": ["invalid", "stable"],
  "nested list item | image after blockquote": ["changed", "stable"],
  "nested list item | image before callout": ["invalid", "invalid"],
  "nested list item | image after callout": ["invalid", "invalid"],
  "nested list item | image before mermaid block with a blank line": [
    "invalid",
    "stable",
  ],
  "nested list item | image before horizontal rule": ["invalid", "stable"],
  "nested list item | image after horizontal rule": ["invalid", "invalid"],
};
const RANK: Record<Outcome, number> = { stable: 0, changed: 1, invalid: 2 };

describe("a resized image between other blocks", () => {
  const cases = Object.keys(CONTAINERS).flatMap((container) =>
    Object.keys(NEIGHBOURS).flatMap((neighbour) =>
      (["before", "after"] as const).map(
        (side) => [container, side, neighbour] as const,
      ),
    ),
  );

  it.each(cases)("in a %s, %s a %s", (container, side, neighbour) => {
    const other = NEIGHBOURS[neighbour]!;
    const tree = (image: JSONContent) =>
      CONTAINERS[container]!(
        side === "before"
          ? [image, other, para("End")]
          : [other, image, para("End")],
      );
    const key = `${container} | image ${side} ${neighbour}`;
    const outcome: [Outcome, Outcome] = [
      roundTrip(tree(PLAIN)),
      roundTrip(tree(SIZED)),
    ];
    expect([key, ...outcome]).toEqual([
      key,
      ...(KNOWN[key] ?? ["stable", "stable"]),
    ]);
    expect(RANK[outcome[1]]).toBeLessThanOrEqual(RANK[outcome[0]]);
  });

  it("is never the cause where a list item does not survive a save", () => {
    // A callout, or a rule after text, breaks a list item without any image.
    for (const other of [NEIGHBOURS.callout!, NEIGHBOURS["horizontal rule"]!])
      expect(roundTrip(CONTAINERS["list item"]!([other, para("End")]))).toBe(
        "invalid",
      );
  });

  it("writes the tag between blank lines inside a list item", () => {
    const saved = serializeDocumentBody(
      CONTAINERS["list item"]!([
        SIZED,
        NEIGHBOURS["code block with a blank line"]!,
        para("End"),
      ]),
    );
    const lines = saved.split("\n");
    const at = lines.findIndex((line) => line.includes("<img"));
    expect(lines[at - 1]!.trim()).toBe("");
    expect(lines[at + 1]!.trim()).toBe("");
  });

  it("leaves a list item with a plain image exactly as before", () => {
    expect(
      serializeDocumentBody(
        CONTAINERS["list item"]!([PLAIN, NEIGHBOURS.heading!, para("End")]),
      ),
    ).toBe("- Item\n  ![A](a.png)\n  ## Heading\n\n  End\n");
  });
});

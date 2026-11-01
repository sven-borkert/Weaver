import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { parseDocumentBody, serializeDocumentBody } from "./markdown";

const tag = '<img src="a.png" alt="A" width="200">';
const image: JSONContent = {
  type: "image",
  attrs: { src: "a.png", alt: "A", title: null, width: 200 },
};
const para = (...content: JSONContent[]): JSONContent => ({
  type: "paragraph",
  content,
});

// Hand-written Markdown only: Weaver itself always writes blank lines around a tag.
describe("lines directly under an image tag, without a blank line", () => {
  it.each([
    ["a heading", "## Heading", "## Heading", "\\## Heading"],
    ["a list", "- one\n- two", "- one\n- two", "\\- one\n\\- two"],
    ["a blockquote", "> quoted", "> quoted", "\\> quoted"],
    ["a rule", "---", "---", "\\---"],
    ["an indented code block", "    indented", "indented", "indented"],
    [
      "a table",
      "| a |\n| --- |\n| 1 |",
      "| a |\n| --- |\n| 1 |",
      "| a |\n| --- |\n| 1 |",
    ],
  ])(
    "reads %s as paragraph text, like the HTML block the tag line used to be",
    (_name, under, text, saved) => {
      const json = parseDocumentBody(`${tag}\n${under}\n`);
      expect(json.content).toEqual([image, para({ type: "text", text })]);
      expect(serializeDocumentBody(json)).toBe(`${tag}\n\n${saved}\n`);
    },
  );

  it("reads a code fence as inline code", () => {
    const json = parseDocumentBody(`${tag}\n\`\`\`\ncode\n\`\`\`\n`);
    expect(json.content).toEqual([
      image,
      para({ type: "text", text: "code", marks: [{ type: "code" }] }),
    ]);
  });

  it.each([
    ["a heading", "## Heading", "heading"],
    ["a list", "- one\n- two", "bulletList"],
    ["a blockquote", "> quoted", "blockquote"],
    ["a rule", "---", "horizontalRule"],
    ["a code fence", "```\ncode\n```", "codeBlock"],
    ["a table", "| a |\n| --- |\n| 1 |", "table"],
  ])("keeps %s after a blank line", (_name, under, type) => {
    const json = parseDocumentBody(`${tag}\n\n${under}\n`);
    expect(json.content?.map((node) => node.type)).toEqual(["image", type]);
    const saved = serializeDocumentBody(json);
    expect(parseDocumentBody(saved)).toEqual(json);
  });
});

describe("large inputs with image tags", () => {
  const CAP = 199_000;
  const fill = (unit: string) => unit.repeat(Math.floor(CAP / unit.length));
  const LIMIT_MS = 5_000;

  it.each([
    ["a heading under every tag", fill(`${tag}\n## H\n`)],
    ["a list item under every tag", fill(`${tag}\n- l\n`)],
    ["the same inside a blockquote", fill(`> ${tag}\n> ## H\n`)],
    ["the same inside a list item", `- x\n${fill(`  ${tag}\n  ## H\n`)}`],
    ["thousands of tags on consecutive lines", fill(`${tag}\n`)],
  ])(
    "parses %s at the size cap",
    (_name, markdown) => {
      expect(markdown.length).toBeGreaterThan(190_000);
      const started = performance.now();
      const json = parseDocumentBody(markdown);
      expect(performance.now() - started).toBeLessThan(LIMIT_MS);
      expect(JSON.stringify(json)).toContain('"width":200');
      expect(JSON.stringify(json)).not.toMatch(/imageTag/);
    },
    20_000,
  );
});

import { getSchema } from "@tiptap/core";
import { Schema } from "@tiptap/pm/model";
import { documentExtensions } from "@weaver/core/editor/extensions";
import { describe, expect, it } from "vitest";
import {
  parseDocumentMarkdown,
  serializeDocumentMarkdown,
} from "./document-markdown";

const schema = getSchema(documentExtensions());

describe("editable document Markdown", () => {
  it("parses supported Markdown and retains an editable trailing paragraph", () => {
    const text =
      "# Heading\n\n**Bold text**\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\n![Image](draft.assets/image.png)\n";
    const document = parseDocumentMarkdown(schema, text);
    expect(document.firstChild?.type.name).toBe("heading");
    expect(
      document.child(1).firstChild?.marks.map((mark) => mark.type.name),
    ).toEqual(["bold"]);
    expect(document.child(2).type.name).toBe("mermaid");
    expect(document.child(3).attrs.src).toBe("draft.assets/image.png");
    expect(document.lastChild?.type.name).toBe("paragraph");
    const serialized = serializeDocumentMarkdown(document);
    expect(serialized).toContain("# Heading\n");
    expect(serialized).toContain("**Bold text**");
    expect(serialized).toContain("```mermaid\nflowchart TD\n  A --> B\n```");
    expect(serialized).toContain("![Image](draft.assets/image.png)");
  });

  it("allows an empty body as an editable empty paragraph", () => {
    const document = parseDocumentMarkdown(schema, "");
    expect(document.childCount).toBe(1);
    expect(document.firstChild?.type.name).toBe("paragraph");
    expect(document.textContent).toBe("");
    expect(serializeDocumentMarkdown(document)).toBe("\n");
  });

  it("canonicalizes emphasis while retaining parsed blank paragraphs", () => {
    const document = parseDocumentMarkdown(schema, "__Bold__\n\n\n");
    const before: unknown = document.toJSON();
    expect(document.childCount).toBe(2);
    expect(document.lastChild?.textContent).toBe("");
    expect(serializeDocumentMarkdown(document)).toBe("**Bold**\n\n");
    expect(document.toJSON()).toEqual(before);
  });

  it("bounds raw UTF-8 bytes before attempting to parse", () => {
    expect(() => parseDocumentMarkdown(schema, "é".repeat(1_000_001))).toThrow(
      "Markdown exceeds the document size limit.",
    );
  });

  it("rejects parsed images that the save pipeline cannot accept", () => {
    expect(() =>
      parseDocumentMarkdown(schema, "![Private](data:image/png;base64,secret)"),
    ).toThrow("Markdown contains content that cannot be saved.");
  });

  it("rejects content incompatible with the mounted editor schema", () => {
    const paragraphsOnly = new Schema({
      nodes: {
        doc: { content: "paragraph+" },
        paragraph: { content: "text*" },
        text: {},
      },
    });
    expect(() => parseDocumentMarkdown(paragraphsOnly, "# Heading")).toThrow(
      "Markdown contains content that cannot be saved.",
    );
  });
});

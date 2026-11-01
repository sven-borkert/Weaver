import { getSchema } from "@tiptap/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { documentExtensions } from "@weaver/core/editor/extensions";
import {
  documentOutline,
  sameDocumentOutline,
} from "./document-heading-anchors";
import { renderDocumentContent } from "./render";

const schema = getSchema(documentExtensions());
const heading = (text: string, level = 2) => ({
  type: "heading",
  attrs: { level },
  ...(text ? { content: [{ type: "text", text }] } : {}),
});

describe("document outline", () => {
  it("lists top-level headings with text under the anchors the reader renders", () => {
    const content = {
      type: "doc",
      content: [
        { type: "blockquote", content: [heading("Nested")] },
        heading(""),
        heading("Deploy"),
        { type: "paragraph", content: [{ type: "text", text: "Body" }] },
        heading("Verify", 3),
        heading("Deploy"),
        {
          type: "heading",
          attrs: { level: 1 },
          content: [
            { type: "text", text: "See  " },
            {
              type: "crossref",
              attrs: {
                targetType: "document",
                targetId: "11111111-1111-4111-8111-111111111111",
                label: "Runbook",
              },
            },
          ],
        },
      ],
    };
    const renderedIds = Array.from(
      renderToStaticMarkup(renderDocumentContent(content)).matchAll(
        /<h[1-6][^>]* id="([^"]+)"/g,
      ),
      (match) => match[1],
    );

    const outline = documentOutline(schema.nodeFromJSON(content));

    expect(outline.map(({ level, text }) => ({ level, text }))).toEqual([
      { level: 2, text: "Deploy" },
      { level: 3, text: "Verify" },
      { level: 2, text: "Deploy" },
      { level: 1, text: "See Runbook" },
    ]);
    expect(outline.map(({ anchor }) => anchor)).toEqual(renderedIds.slice(2));
    expect(outline.slice(0, 3).map(({ anchor }) => anchor)).toEqual([
      "section-deploy",
      "section-deploy--verify",
      "section-deploy-2",
    ]);
  });

  it("returns no entries for a document without headings", () => {
    expect(
      documentOutline(
        schema.nodeFromJSON({
          type: "doc",
          content: [{ type: "paragraph" }],
        }),
      ),
    ).toEqual([]);
  });

  it("compares outlines entry by entry", () => {
    const entry = { anchor: "section-deploy", level: 2, text: "Deploy" };
    expect(sameDocumentOutline([entry], [{ ...entry }])).toBe(true);
    expect(sameDocumentOutline([entry], [{ ...entry, level: 3 }])).toBe(false);
    expect(sameDocumentOutline([entry], [])).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  collectDocumentReferences,
  indexResolvedDocumentReferences,
} from "./references";

describe("collectDocumentReferences", () => {
  it("finds nested references once in document order", () => {
    const content = {
      type: "doc",
      content: [
        {
          type: "callout",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "crossref", attrs: { targetId: "a", label: "A" } },
                {
                  type: "crossref",
                  attrs: { targetId: "a", label: "Old A" },
                },
                { type: "crossref", attrs: { targetId: "b", label: "B" } },
              ],
            },
          ],
        },
      ],
    };

    expect(collectDocumentReferences(content)).toEqual([
      { targetType: "document", targetId: "a", label: "A" },
      { targetType: "document", targetId: "b", label: "B" },
    ]);
  });

  it("ignores crossrefs without string target ids", () => {
    const content = {
      type: "doc",
      content: [
        { type: "crossref", attrs: { targetId: 42, label: "Number" } },
        { type: "crossref", attrs: { label: "Missing" } },
        { type: "crossref", attrs: { targetId: "valid", label: null } },
      ],
    };

    expect(collectDocumentReferences(content)).toEqual([
      { targetType: "document", targetId: "valid", label: null },
    ]);
  });

  it("keeps document and table targets distinct when they share an id", () => {
    const content = {
      type: "doc",
      content: [
        {
          type: "crossref",
          attrs: { targetType: "document", targetId: "shared", label: "Doc" },
        },
        {
          type: "crossref",
          attrs: { targetType: "table", targetId: "shared", label: "Table" },
        },
        {
          type: "crossref",
          attrs: { targetType: "table", targetId: "shared", label: "Old" },
        },
      ],
    };

    expect(collectDocumentReferences(content)).toEqual([
      { targetType: "document", targetId: "shared", label: "Doc" },
      { targetType: "table", targetId: "shared", label: "Table" },
    ]);
  });

  it("indexes only resolved rows under their returned target type", () => {
    const index = indexResolvedDocumentReferences([
      {
        id: "shared",
        exists: true,
        targetType: "document",
        title: "Document",
      },
      { id: "missing", exists: false },
    ]);

    expect(index.get("document:shared")).toMatchObject({ title: "Document" });
    expect(index.has("table:shared")).toBe(false);
    expect(index.has("document:missing")).toBe(false);
  });
});

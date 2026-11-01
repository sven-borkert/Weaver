import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { renderDocumentContent } from "~/lib/editor/render";
import { createDocumentReferenceMapping } from "./DocumentReferenceMapping";

const documentId = "11111111-1111-1111-1111-111111111111";
const tableId = "22222222-2222-2222-2222-222222222222";
const sharedId = "33333333-3333-3333-3333-333333333333";

describe("createDocumentReferenceMapping", () => {
  it("renders neutral typed pending chips during uncached loading", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      const html = renderToStaticMarkup(
        renderDocumentContent(
          {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "crossref",
                    attrs: {
                      targetType: "document",
                      targetId: documentId,
                      label: "Stored document",
                    },
                  },
                  { type: "text", text: " and " },
                  {
                    type: "crossref",
                    attrs: {
                      targetType: "table",
                      targetId: tableId,
                      label: "Stored table",
                    },
                  },
                ],
              },
            ],
          },
          createDocumentReferenceMapping("project-id", [], "pending"),
        ),
      );

      expect(html).toContain('aria-label="Loading document reference"');
      expect(html).toContain('aria-label="Loading table reference"');
      expect(html).toContain("Stored document");
      expect(html).toContain("Stored table");
      expect(html).not.toContain("Broken document reference");
      expect(html).not.toContain("Broken table reference");
      expect(html).not.toContain(documentId);
      expect(html).not.toContain(tableId);
      expect(html).not.toContain("data-crossref-id");
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("renders typed metadata-free fallbacks without resolved rows or DOM warnings", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      const html = renderToStaticMarkup(
        renderDocumentContent(
          {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "crossref",
                    attrs: {
                      targetType: "document",
                      targetId: documentId,
                      label: "Stored document",
                    },
                  },
                  { type: "text", text: " and " },
                  {
                    type: "crossref",
                    attrs: {
                      targetType: "table",
                      targetId: tableId,
                      label: "Stored table",
                    },
                  },
                ],
              },
            ],
          },
          createDocumentReferenceMapping("project-id", [], "settled"),
        ),
      );

      expect(html).toContain('aria-label="Broken document reference"');
      expect(html).toContain('aria-label="Broken table reference"');
      expect(html).toContain("Stored document");
      expect(html).toContain("Stored table");
      expect(html).not.toContain(documentId);
      expect(html).not.toContain(tableId);
      expect(html).not.toContain("data-crossref-id");
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("treats a resolved row of the wrong type as unresolved", () => {
    const html = renderToStaticMarkup(
      renderDocumentContent(
        {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "crossref",
                  attrs: {
                    targetType: "table",
                    targetId: sharedId,
                    label: "Expected table",
                  },
                },
              ],
            },
          ],
        },
        createDocumentReferenceMapping(
          "project-id",
          [
            {
              id: sharedId,
              exists: true,
              targetType: "document",
              title: "Wrong document",
              path: "wrong.md",
              excerpt: "Wrong preview",
              lastEditedAt: new Date("2026-08-29T00:00:00.000Z"),
            },
          ],
          "settled",
        ),
      ),
    );

    expect(html).toContain('aria-label="Broken table reference"');
    expect(html).toContain("Expected table");
    expect(html).not.toContain("Wrong document");
    expect(html).not.toContain(sharedId);
  });

  it("renders a typed broken chip after an initial resolver error", () => {
    const html = renderToStaticMarkup(
      renderDocumentContent(
        {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "crossref",
                  attrs: {
                    targetType: "table",
                    targetId: tableId,
                    label: "Stored after error",
                  },
                },
              ],
            },
          ],
        },
        createDocumentReferenceMapping("project-id", [], "error"),
      ),
    );

    expect(html).toContain('aria-label="Broken table reference"');
    expect(html).toContain("Stored after error");
    expect(html).not.toContain("Loading table reference");
    expect(html).not.toContain(tableId);
    expect(html).not.toContain("data-crossref-id");
  });
});

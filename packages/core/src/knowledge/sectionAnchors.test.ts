import { describe, expect, it } from "vitest";

import {
  MAX_DOCUMENT_SECTION_ANCHOR_CHARACTERS,
  createDocumentSectionAnchorAllocator,
  projectDocumentSectionAnchors,
} from "./sectionAnchors";

describe("createDocumentSectionAnchorAllocator", () => {
  it("normalizes nested Unicode headings and allocates collisions", () => {
    const anchors = createDocumentSectionAnchorAllocator();
    expect(anchors.allocate(["Résumé & Setup", "Überblick"])).toBe(
      "section-résumé-setup--überblick",
    );
    expect(anchors.allocate(["Résumé & Setup", "Überblick"])).toBe(
      "section-résumé-setup--überblick-2",
    );
  });

  it("normalizes NFKC compatibility forms", () => {
    const compatibilityForm = createDocumentSectionAnchorAllocator();
    const normalizedForm = createDocumentSectionAnchorAllocator();

    expect(compatibilityForm.allocate(["ＡＢＣ"])).toBe(
      normalizedForm.allocate(["ABC"]),
    );
  });

  it("uses a safe fallback and keeps suffixes inside the final bound", () => {
    const anchors = createDocumentSectionAnchorAllocator();
    expect(anchors.allocate(["!!!"])).toBe("section");
    expect(anchors.allocate(["x".repeat(400)])).toBe(
      `section-${"x".repeat(48)}`,
    );
    const longPath = Array.from({ length: 4 }, () => "x".repeat(400));
    const first = anchors.allocate(longPath);
    const second = anchors.allocate(longPath);
    expect(Array.from(first)).toHaveLength(
      MAX_DOCUMENT_SECTION_ANCHOR_CHARACTERS,
    );
    expect(Array.from(second).length).toBeLessThanOrEqual(
      MAX_DOCUMENT_SECTION_ANCHOR_CHARACTERS,
    );
    expect(second.endsWith("-2")).toBe(true);
  });
});

describe("projectDocumentSectionAnchors", () => {
  it("projects canonical rich headings in order and ignores fenced headings", () => {
    expect(
      projectDocumentSectionAnchors(
        [
          "## [Deploy](https://example.com)",
          "",
          "```md",
          "## Ignored",
          "```",
          "",
          "## ***Deploy***",
          "## [Runbook](weaver://document/11111111-1111-1111-1111-111111111111)",
          "## Empty",
          "## Empty",
        ].join("\n"),
      ),
    ).toEqual([
      {
        lineIndex: 0,
        level: 2,
        heading: "[Deploy](https://example.com)",
        anchor: "section-deploy-https-example-com",
      },
      {
        lineIndex: 6,
        level: 2,
        heading: "***Deploy***",
        anchor: "section-deploy",
      },
      {
        lineIndex: 7,
        level: 2,
        heading:
          "[Runbook](weaver://document/11111111-1111-1111-1111-111111111111)",
        anchor: "section-runbook-weaver-document-11111111-1111-1111-1111",
      },
      {
        lineIndex: 8,
        level: 2,
        heading: "Empty",
        anchor: "section-empty",
      },
      {
        lineIndex: 9,
        level: 2,
        heading: "Empty",
        anchor: "section-empty-2",
      },
    ]);
  });
});

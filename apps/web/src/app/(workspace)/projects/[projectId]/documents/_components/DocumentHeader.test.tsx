import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DocumentHeader } from "./DocumentHeader";

const document = {
  id: "d1",
  path: "ops.md",
  slug: "ops",
  title: "Truncate alert tables",
  kind: "markdown" as const,
  content: {
    kind: "markdown" as const,
    contentJson: { type: "doc", content: [] },
  },
  baseCommitSha: "a".repeat(40),
  lastEditedAt: new Date("2026-09-28T11:00:00Z"),
  lastEditedById: null,
  lastEditedBy: null,
  machineEditor: null,
  createdAt: new Date("2020-03-11T09:00:00Z"),
  createdBy: { id: null, name: "Sven Borkert" },
  updatedAt: new Date("2026-09-28T11:00:00Z"),
  updatedBy: { id: "u1", name: "Ada Lovelace" },
  appearance: null,
  review: null,
  properties: null,
};

describe("DocumentHeader", () => {
  it("shows who created and who last updated the document", () => {
    const html = renderToStaticMarkup(<DocumentHeader document={document} />);
    expect(html).toContain("Created");
    expect(html).toContain("by Sven Borkert");
    expect(html).toContain("Updated");
    expect(html).toContain("by Ada Lovelace");
  });

  it("names an unknown author for a document written before authorship", () => {
    const html = renderToStaticMarkup(
      <DocumentHeader document={{ ...document, createdBy: null }} />,
    );
    expect(html).toContain("by unknown author");
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ArtifactsTable } from "./ArtifactsTable";

const item = {
  id: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  filename: "Plan.docx",
  contentType:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  byteSize: 2048,
  contentDigest: "a".repeat(64),
  createdAt: new Date("2026-09-20T10:00:00Z"),
  updatedAt: new Date("2026-09-20T10:00:00Z"),
  uploadedBy: { id: "u", name: "Ada", email: "ada@test.local" },
  notebook: null,
};
const base = {
  items: [item],
  projectId: item.projectId,
  focusFilename: null,
  sort: "filename" as const,
  dir: "asc" as const,
  onSort: () => undefined,
  onRename: () => undefined,
  onDelete: () => undefined,
};

describe("ArtifactsTable", () => {
  it("links each row to the download route and shows size and uploader", () => {
    const html = renderToStaticMarkup(
      <ArtifactsTable {...base} canEdit={false} />,
    );
    expect(html).toContain(
      `/api/projects/${item.projectId}/artifacts/${item.id}/download`,
    );
    expect(html).toContain("2.0 KB");
    expect(html).toContain("Ada");
    expect(html).toContain("Word");
  });

  // Radix renders its dropdown content only when opened, so the trigger's
  // accessible name stands in for the row actions.
  it("offers row actions only to editors", () => {
    expect(
      renderToStaticMarkup(<ArtifactsTable {...base} canEdit={false} />),
    ).not.toContain("Actions for Plan.docx");
    expect(
      renderToStaticMarkup(<ArtifactsTable {...base} canEdit />),
    ).toContain("Actions for Plan.docx");
  });

  it("marks the sorted column and highlights the focused file", () => {
    const html = renderToStaticMarkup(
      <ArtifactsTable {...base} focusFilename="Plan.docx" canEdit />,
    );
    expect(html).toContain('aria-sort="ascending"');
    // Name is sorted; Size and Changed announce themselves as sortable.
    expect(html.match(/aria-sort="none"/g)).toHaveLength(2);
    expect(html).toContain("data-focused");
  });

  it("shows a notebook's preparation status under its type", () => {
    const notebook = {
      ...item,
      filename: "Ops.onepkg",
      contentType: "application/onenote",
      notebook: {
        status: "ready" as const,
        error: null,
        finishedAt: new Date("2026-09-20T10:05:00Z"),
        sectionCount: 30,
        pageCount: 1010,
        emptySectionCount: 13,
        unreadableSectionCount: 0,
      },
    };
    const html = renderToStaticMarkup(
      <ArtifactsTable {...base} items={[notebook]} canEdit />,
    );
    expect(html).toContain("Ready");
    expect(html).toContain("1,010 pages · 30 sections · 13 empty");
  });

  it("shows an empty state", () => {
    expect(
      renderToStaticMarkup(<ArtifactsTable {...base} items={[]} canEdit />),
    ).toContain("No files yet");
  });
});

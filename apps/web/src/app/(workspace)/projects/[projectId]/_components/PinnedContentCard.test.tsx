import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProjectPinView } from "@weaver/core/dashboard/schema";
import { PinnedContentCard } from "./PinnedContentCard";

const pins: ProjectPinView[] = [
  {
    pinId: "pin-1",
    kind: "document",
    available: true,
    content: {
      id: "d1",
      kind: "document",
      title: "Runbook",
      projectId: "p1",
      projectName: "Demo",
      lastEditedAt: "2026-09-09T08:00:00.000Z",
      editorName: null,
      isOwnChange: false,
      documentKind: "markdown",
      destination: { kind: "document", projectId: "p1", documentId: "d1" },
    },
  },
  { pinId: "pin-2", kind: "table", available: false },
];

describe("PinnedContentCard", () => {
  it("renders readable target links without curator controls", () => {
    const html = renderToStaticMarkup(
      <PinnedContentCard
        pins={pins}
        canManagePins={false}
        onManage={() => undefined}
      />,
    );
    expect(html).toContain('aria-label="Pinned content"');
    expect(html).toContain('href="/projects/p1/documents/d1"');
    expect(html).not.toContain("Manage pinned content");
    expect(html).not.toContain("Unavailable table");
  });
  it("lets curators manage unavailable identities", () => {
    const html = renderToStaticMarkup(
      <PinnedContentCard
        pins={pins}
        canManagePins
        onManage={() => undefined}
      />,
    );
    expect(html).toContain("Manage pinned content");
    expect(html).toContain("Unavailable table");
  });
});

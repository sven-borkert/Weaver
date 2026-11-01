import { describe, expect, it } from "vitest";
import type { CitationCard } from "@weaver/core/services/assistantCitations";
import { citationHref } from "./citationHref";

const base = {
  id: "c",
  messageId: "m",
  projectId: "p",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  access: "ok" as const,
  label: "L",
  excerpt: null,
};

// graphHref only preserves ids shaped as UUIDs (see ~/lib/knowledge/graphUrl.ts),
// so the graph-kind cases below use real UUIDs rather than the "p"/"e" shorthand
// used elsewhere in this file.
const GRAPH_PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const GRAPH_ENTITY_ID = "22222222-2222-4222-8222-222222222222";
const GRAPH_DOCUMENT_ID = "33333333-3333-4333-8333-333333333333";

describe("citationHref", () => {
  it("links a document citation to its section at the cited commit", () => {
    const card: CitationCard = {
      ...base,
      kind: "document",
      resourceId: "d",
      navigationAnchor: "section-deploy",
      headingPath: ["Deploy"],
    };
    expect(citationHref(card)).toBe(
      `/projects/p/documents/d?section=section-deploy&source=${base.commitSha}`,
    );
  });
  it("links a document citation without an anchor to the document", () => {
    expect(
      citationHref({
        ...base,
        kind: "document",
        resourceId: "d",
        navigationAnchor: null,
      }),
    ).toBe("/projects/p/documents/d");
  });
  it("links search citations by resource type and tables to the table page", () => {
    expect(
      citationHref({
        ...base,
        kind: "search",
        resourceId: "d",
        navigationAnchor: null,
      }),
    ).toBe("/projects/p/documents/d");
    expect(
      citationHref({
        ...base,
        kind: "table",
        resourceId: "t",
        rowIds: [],
        columnIds: [],
      }),
    ).toBe("/projects/p/tables/t");
  });
  it("links a table-search citation (no navigationAnchor) to the table page", () => {
    const card: CitationCard = {
      ...base,
      kind: "search",
      resourceId: "t",
    };
    expect("navigationAnchor" in card).toBe(false);
    expect(citationHref(card)).toBe("/projects/p/tables/t");
  });
  it("links graph citations to the focused entity, else to the provenance document", () => {
    expect(
      citationHref({
        ...base,
        projectId: GRAPH_PROJECT_ID,
        kind: "graph",
        resourceId: GRAPH_ENTITY_ID,
        entityId: GRAPH_ENTITY_ID,
        documentId: null,
      }),
    ).toBe(`/projects/${GRAPH_PROJECT_ID}/graph?focus=${GRAPH_ENTITY_ID}`);
    expect(
      citationHref({
        ...base,
        projectId: GRAPH_PROJECT_ID,
        kind: "graph",
        resourceId: GRAPH_DOCUMENT_ID,
        entityId: null,
        documentId: GRAPH_DOCUMENT_ID,
      }),
    ).toBe(`/projects/${GRAPH_PROJECT_ID}/documents/${GRAPH_DOCUMENT_ID}`);
  });
  it("returns null for unavailable sources", () => {
    expect(
      citationHref({
        id: "c",
        messageId: "m",
        kind: "document",
        projectId: "p",
        resourceId: "d",
        commitSha: null,
        access: "unavailable",
      }),
    ).toBeNull();
  });
});

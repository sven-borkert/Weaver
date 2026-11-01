import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CitationCard } from "@weaver/core/services/assistantCitations";

vi.mock("~/trpc/react", () => ({
  api: {
    assistant: { listCitations: { useQuery: () => ({ data: mockedCards }) } },
    document: { get: { useQuery: () => ({ data: mockedDocData }) } },
    table: { get: { useQuery: () => ({ data: mockedTableData }) } },
  },
}));
vi.mock("~/lib/use-mounted", () => ({ useMounted: () => true }));

import {
  CitationCards,
  dedupeCitations,
  isCitedAtEarlierRevision,
  orderByCitationIds,
} from "./CitationCard";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const base = {
  messageId: "m1",
  projectId: "p",
  commitSha: SHA,
  access: "ok" as const,
  excerpt: "Steps.",
};
let mockedCards: CitationCard[] = [];
// Kind-aware: document.get and table.get are separate procedures, so
// giving them independently controllable mock data (rather than a single
// shared value) is what lets a test catch RevisionNote reading the wrong
// one for a given card's kind.
let mockedDocData: { baseCommitSha: string } | undefined = undefined;
let mockedTableData: { baseCommitSha: string } | undefined = undefined;

describe("dedupeCitations", () => {
  it("merges repeated resources and counts them", () => {
    const cards: CitationCard[] = [
      {
        ...base,
        id: "1",
        kind: "document",
        resourceId: "d",
        label: "Doc",
        navigationAnchor: null,
      },
      {
        ...base,
        id: "2",
        kind: "document",
        resourceId: "d",
        label: "Doc",
        navigationAnchor: "section-x",
      },
      {
        ...base,
        id: "3",
        kind: "table",
        resourceId: "t",
        label: "Tbl",
        rowIds: [],
        columnIds: [],
      },
    ];
    const out = dedupeCitations(cards);
    expect(out.map((c) => [c.kind, c.resourceId, c.count])).toEqual([
      ["document", "d", 2],
      ["table", "t", 1],
    ]);
    // The first occurrence wins; a later anchor does not replace it.
    expect(out[0]!.navigationAnchor).toBeNull();
  });
});

describe("orderByCitationIds", () => {
  it("orders cards by the message's citationIds, unlisted ones falling back to server order after", () => {
    const cards: CitationCard[] = [
      { ...base, id: "10", kind: "document", resourceId: "a", label: "Alpha" },
      { ...base, id: "20", kind: "document", resourceId: "b", label: "Beta" },
      { ...base, id: "30", kind: "document", resourceId: "g", label: "Gamma" },
    ];
    // listCitations' server order is [Alpha, Beta, Gamma]; the message's own
    // emission order (citationIds) put Beta before Alpha, and never mentions
    // Gamma at all — Gamma must still appear, trailing after the listed two.
    const out = orderByCitationIds(cards, ["20", "10"]);
    expect(out.map((c) => c.label)).toEqual(["Beta", "Alpha", "Gamma"]);
  });

  it("is a no-op when citationIds is empty", () => {
    const cards: CitationCard[] = [
      { ...base, id: "10", kind: "document", resourceId: "a", label: "Alpha" },
      { ...base, id: "20", kind: "document", resourceId: "b", label: "Beta" },
    ];
    expect(orderByCitationIds(cards, []).map((c) => c.label)).toEqual([
      "Alpha",
      "Beta",
    ]);
  });
});

describe("isCitedAtEarlierRevision", () => {
  it("is true once the fetched head has moved past the cited commit", () => {
    expect(isCitedAtEarlierRevision("headsha", "oldsha")).toBe(true);
  });
  it("is false when the head matches the cited commit", () => {
    expect(isCitedAtEarlierRevision("samesha", "samesha")).toBe(false);
  });
  it("is false when nothing has been fetched yet", () => {
    expect(isCitedAtEarlierRevision(undefined, "oldsha")).toBe(false);
  });
  it("is false when the citation carries no commit", () => {
    expect(isCitedAtEarlierRevision("headsha", null)).toBe(false);
  });
});

describe("CitationCards", () => {
  it("orders settled cards by citationIds, not by listCitations' server order", () => {
    mockedCards = [
      { ...base, id: "10", kind: "document", resourceId: "a", label: "Alpha" },
      { ...base, id: "20", kind: "document", resourceId: "b", label: "Beta" },
    ];
    const html = renderToStaticMarkup(
      <CitationCards
        conversationId="c"
        messageId="m1"
        citationIds={["20", "10"]}
      />,
    );
    expect(html.indexOf("Beta")).toBeLessThan(html.indexOf("Alpha"));
  });

  it("renders linked cards for the message and an unlinked unavailable card", () => {
    mockedCards = [
      {
        ...base,
        id: "1",
        kind: "document",
        resourceId: "d",
        label: "Runbook › Deploy",
        navigationAnchor: "section-deploy",
        headingPath: ["Deploy"],
      },
      {
        id: "2",
        messageId: "m1",
        kind: "table",
        projectId: "p",
        resourceId: "t",
        commitSha: SHA,
        access: "unavailable",
      },
      {
        ...base,
        id: "3",
        messageId: "other",
        kind: "document",
        resourceId: "z",
        label: "Not mine",
        navigationAnchor: null,
      },
    ];
    const html = renderToStaticMarkup(
      <CitationCards conversationId="c" messageId="m1" />,
    );
    expect(html).toContain("Runbook › Deploy");
    expect(html).toContain(
      `href="/projects/p/documents/d?section=section-deploy&amp;source=${SHA}"`,
    );
    expect(html).toContain("Source no longer available");
    expect(html).not.toContain("Not mine");
  });

  it("renders live citation views before the settled list exists", () => {
    mockedCards = [];
    const html = renderToStaticMarkup(
      <CitationCards
        conversationId="c"
        messageId=""
        live={[
          {
            id: "l1",
            kind: "document",
            projectId: "p",
            resourceId: "d",
            commitSha: SHA,
            label: "Live doc",
            excerpt: null,
          },
        ]}
      />,
    );
    expect(html).toContain("Live doc");
    expect(html).toContain('href="/projects/p/documents/d"');
  });

  it("renders a live search citation unlinked, since it doesn't yet know whether it hit a document or a table", () => {
    mockedCards = [];
    const html = renderToStaticMarkup(
      <CitationCards
        conversationId="c"
        messageId=""
        live={[
          {
            id: "l2",
            kind: "search",
            projectId: "p",
            resourceId: "t",
            commitSha: SHA,
            label: "Live search hit",
            excerpt: "Some rows.",
          },
        ]}
      />,
    );
    expect(html).toContain("Live search hit");
    expect(html).toContain("Some rows.");
    expect(html).not.toMatch(/<a[^>]*>/);
  });

  it("still links a settled document-search card correctly", () => {
    mockedCards = [
      {
        ...base,
        id: "1",
        kind: "search",
        resourceId: "d",
        label: "Settled search hit",
        // listCitations sets navigationAnchor: null for a document-search hit.
        navigationAnchor: null,
      },
    ];
    const html = renderToStaticMarkup(
      <CitationCards conversationId="c" messageId="m1" />,
    );
    expect(html).toContain("Settled search hit");
    expect(html).toMatch(/<a[^>]*href="\/projects\/p\/documents\/d"[^>]*>/);
  });
});

describe("RevisionNote wiring", () => {
  it("reads the document query for a document card and the table query for a table card, not the other one's data", () => {
    // A document citing SHA matches document.get's cached head, so no note.
    mockedDocData = { baseCommitSha: SHA };
    // A table citing the same SHA does NOT match table.get's cached head —
    // if RevisionNote ever read the document query for a table card (or
    // vice versa), one of these two assertions would flip.
    mockedTableData = { baseCommitSha: OTHER_SHA };

    mockedCards = [
      { ...base, id: "1", kind: "document", resourceId: "d", label: "Doc" },
    ];
    const docHtml = renderToStaticMarkup(
      <CitationCards conversationId="c" messageId="m1" />,
    );
    expect(docHtml).not.toContain("Cited at an earlier revision");

    mockedCards = [
      {
        ...base,
        id: "2",
        kind: "table",
        resourceId: "t",
        label: "Tbl",
        rowIds: [],
        columnIds: [],
      },
    ];
    const tableHtml = renderToStaticMarkup(
      <CitationCards conversationId="c" messageId="m1" />,
    );
    expect(tableHtml).toContain("Cited at an earlier revision");
  });

  it("shows no note once the table card's cited commit matches the fetched head", () => {
    mockedTableData = { baseCommitSha: SHA };
    mockedCards = [
      {
        ...base,
        id: "3",
        kind: "table",
        resourceId: "t2",
        label: "Tbl2",
        rowIds: [],
        columnIds: [],
      },
    ];
    const html = renderToStaticMarkup(
      <CitationCards conversationId="c" messageId="m1" />,
    );
    expect(html).not.toContain("Cited at an earlier revision");
  });
});

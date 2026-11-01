import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProposalView } from "@weaver/core/services/assistantProposals";

type Mocked = {
  role: string | undefined;
  trainingRole: string | null;
  acceptPending: boolean;
  proposals: unknown[];
};
const mocked = vi.hoisted((): Mocked => ({
  role: "Editor",
  trainingRole: null,
  acceptPending: false,
  proposals: [],
}));

vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({
      assistant: {
        listProposals: { invalidate: vi.fn() },
        getConversation: { invalidate: vi.fn() },
      },
      project: { get: { invalidate: vi.fn() } },
    }),
    assistant: {
      getProposal: { useQuery: () => ({ data: undefined, isPending: false }) },
      listProposals: { useQuery: () => ({ data: mocked.proposals }) },
      acceptProposal: {
        useMutation: () => ({
          mutate: vi.fn(),
          isPending: mocked.acceptPending,
        }),
      },
      rejectProposal: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
    },
    project: {
      get: {
        useQuery: () => ({
          data: mocked.role
            ? {
                name: "Platform",
                myRole: mocked.role,
                myTrainingRole: mocked.trainingRole,
              }
            : undefined,
        }),
      },
    },
    document: {
      resolveRefs: {
        useQuery: () => ({ data: [{ exists: true, title: "Runbook" }] }),
      },
    },
    table: { get: { useQuery: () => ({ data: undefined }) } },
  },
}));
vi.mock("~/lib/use-mounted", () => ({ useMounted: () => true }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { ProposalCard, ProposalCards } from "./ProposalCard";

const future = new Date(Date.now() + 86_400_000);
const proposal: ProposalView = {
  id: "p1",
  conversationId: "c",
  runId: "r",
  projectId: "proj",
  kind: "document.edit",
  resourceId: "d",
  baseCommitSha: "abc1234",
  summary: "Add a rollback note",
  preview: {
    kind: "document",
    lines: [{ type: "add", text: "Rollback first" }],
    truncated: false,
  },
  status: "pending",
  resolution: null,
  createdAt: new Date(0),
  expiresAt: future,
  resolvedAt: null,
};

describe("ProposalCard", () => {
  beforeEach(() => {
    mocked.role = "Editor";
    mocked.trainingRole = null;
    mocked.acceptPending = false;
    mocked.proposals = [];
  });

  it("shows the diff with Accept and Reject for a pending proposal an Editor can accept", () => {
    const html = renderToStaticMarkup(<ProposalCard proposal={proposal} />);
    expect(html).toContain("Document edit");
    expect(html).toContain("Runbook");
    expect(html).toContain("Platform");
    expect(html).toContain("Add a rollback note");
    expect(html).toContain("Rollback first");
    expect(html).toContain(">Accept<");
    expect(html).toContain(">Reject<");
  });

  it("hides Accept and explains for a Viewer, who can still reject", () => {
    mocked.role = "Viewer";
    const html = renderToStaticMarkup(<ProposalCard proposal={proposal} />);
    expect(html).not.toContain(">Accept<");
    expect(html).toContain("You need Editor access to accept this.");
    expect(html).toContain(">Reject<");
    // The Viewer still sees the whole change they are being asked about.
    expect(html).toContain("Rollback first");
  });

  it("gates exam proposals on the trainer role and links the accepted exam", () => {
    const exam: ProposalView = {
      ...proposal,
      kind: "exam.create",
      resourceId: null,
      baseCommitSha: null,
      summary: "Create the onboarding exam",
      preview: {
        kind: "document",
        lines: [{ type: "add", text: "Title: Onboarding" }],
        truncated: false,
      },
    };
    let html = renderToStaticMarkup(<ProposalCard proposal={exam} />);
    expect(html).toContain("New exam");
    expect(html).toContain("Title: Onboarding");
    expect(html).not.toContain("Runbook");
    expect(html).not.toContain(">Accept<");
    expect(html).toContain("You need the trainer role to accept this.");
    mocked.role = "Viewer";
    mocked.trainingRole = "trainer";
    html = renderToStaticMarkup(<ProposalCard proposal={exam} />);
    expect(html).toContain(">Accept<");
    html = renderToStaticMarkup(
      <ProposalCard
        proposal={{
          ...exam,
          status: "accepted",
          resourceId: "e1",
          resolution: { revision: 1 },
        }}
      />,
    );
    expect(html).toContain("Accepted · revision 1");
    expect(html).toContain('href="/projects/proj/exams/e1"');
    expect(html).toContain("Open exam");
  });

  it("offers no Accept while the role is still unknown", () => {
    mocked.role = undefined;
    const html = renderToStaticMarkup(<ProposalCard proposal={proposal} />);
    expect(html).not.toContain(">Accept<");
  });

  it("marks the card busy and disables both actions while accepting", () => {
    mocked.acceptPending = true;
    const html = renderToStaticMarkup(<ProposalCard proposal={proposal} />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Applying…");
    expect(html.match(/<button[^>]*disabled/g)).toHaveLength(2);
  });

  it("renders each terminal state distinctly and without actions", () => {
    const accepted = renderToStaticMarkup(
      <ProposalCard
        proposal={{
          ...proposal,
          status: "accepted",
          resolution: { commitSha: "0123456789abcdef" },
        }}
      />,
    );
    expect(accepted).toContain("Accepted · commit 0123456");
    expect(accepted).toContain("Open document");
    expect(accepted).toContain('href="/projects/proj/documents/d"');
    expect(accepted).not.toContain(">Accept<");
    expect(accepted).not.toContain(">Reject<");

    const rejected = renderToStaticMarkup(
      <ProposalCard proposal={{ ...proposal, status: "rejected" }} />,
    );
    expect(rejected).toContain("Rejected");
    expect(rejected).not.toContain(">Reject<");

    const conflicted = renderToStaticMarkup(
      <ProposalCard proposal={{ ...proposal, status: "conflicted" }} />,
    );
    expect(conflicted).toContain(
      "The content changed since this was proposed, so nothing was written.",
    );
    expect(conflicted).toContain("Open current version");
    expect(conflicted).not.toContain(">Accept<");

    const expired = renderToStaticMarkup(
      <ProposalCard proposal={{ ...proposal, status: "expired" }} />,
    );
    expect(expired).toContain("Expired");
    expect(expired).not.toContain(">Accept<");

    // Each terminal state gets its own status chip, not one shared tone.
    const tone = (html: string) =>
      /data-proposal-status="[a-z]+" class="([^"]*)"/.exec(html)?.[1];
    expect(
      new Set([tone(accepted), tone(rejected), tone(conflicted), tone(expired)])
        .size,
    ).toBe(4);
  });

  it("withholds Accept once the proposal has outlived its expiry", () => {
    const html = renderToStaticMarkup(
      <ProposalCard
        proposal={{ ...proposal, expiresAt: new Date(Date.now() - 1_000) }}
      />,
    );
    expect(html).not.toContain(">Accept<");
    expect(html).toContain("Expired");
  });

  it("renders a table.create sample preview from the real backend shape", () => {
    const html = renderToStaticMarkup(
      <ProposalCard
        proposal={{
          ...proposal,
          kind: "table.create",
          resourceId: null,
          preview: {
            kind: "table",
            columns: [{ id: "c1", name: "Owner", type: "text" }],
            rowCount: 1,
            sampleRows: [{ id: "r1", cells: { c1: "Ada" } }],
          },
        }}
      />,
    );
    expect(html).toContain("New table");
    expect(html).toContain("Owner");
    expect(html).toContain("Ada");
  });

  it("links a table restore to the table, not to a document route", () => {
    const html = renderToStaticMarkup(
      <ProposalCard
        proposal={{
          ...proposal,
          kind: "content.restore.table",
          resourceId: "t1",
          status: "accepted",
          resolution: { commitSha: "0123456789abcdef" },
          preview: {
            kind: "table",
            columns: [{ id: "c1", name: "Owner", type: "text" }],
            rowCount: 1,
            sampleRows: [{ id: "r1", cells: { c1: "Ada" } }],
          },
        }}
      />,
    );
    expect(html).toContain("Restore table");
    expect(html).toContain("Open table");
    expect(html).toContain('href="/projects/proj/tables/t1"');
    expect(html).not.toContain("/documents/t1");
  });

  it("links a document restore to the document", () => {
    const html = renderToStaticMarkup(
      <ProposalCard
        proposal={{
          ...proposal,
          kind: "content.restore.document",
          status: "accepted",
          resolution: { commitSha: "0123456789abcdef" },
        }}
      />,
    );
    expect(html).toContain("Restore document");
    expect(html).toContain("Open document");
    expect(html).toContain('href="/projects/proj/documents/d"');
  });

  it("warns that an unreadable preview leaves nothing to review, and still offers the decision", () => {
    const html = renderToStaticMarkup(
      <ProposalCard proposal={{ ...proposal, preview: { truncated: true } }} />,
    );
    // The preview IS the confirmation in this panel; when it is missing the
    // card has to say so rather than read as a neutral absence.
    expect(html).toContain(
      "No preview is available — accepting will commit a change you cannot review here.",
    );
    // Blocking Accept would strand the proposal with no way to resolve it.
    expect(html).toContain("Add a rollback note");
    expect(html).toContain(">Accept<");
    expect(html).toContain(">Reject<");
  });

  it("renders a folder move with its source, destination and carried count", () => {
    const html = renderToStaticMarkup(
      <ProposalCard
        proposal={{
          ...proposal,
          kind: "content.lifecycle.folder_move",
          resourceId: null,
          preview: {
            kind: "lifecycle",
            action: "folder_move",
            resourceType: "document",
            from: "archive",
            to: "store/archive",
            title: null,
            affected: { documents: 3, tables: 0 },
          },
        }}
      />,
    );
    expect(html).toContain("Move folder");
    expect(html).toContain("archive");
    expect(html).toContain("store/archive");
    expect(html).toContain("3 documents");
  });

  it("offers no target link for a delete, whose resource will be gone", () => {
    const html = renderToStaticMarkup(
      <ProposalCard
        proposal={{
          ...proposal,
          kind: "content.lifecycle.item_delete.table",
          resourceId: "t1",
          preview: {
            kind: "lifecycle",
            action: "item_delete",
            resourceType: "table",
            from: "tables/roster.table",
            to: null,
            title: "Roster",
            affected: { documents: 0, tables: 1 },
          },
        }}
      />,
    );
    expect(html).toContain("Delete table");
    expect(html).toContain("Roster");
    expect(html).not.toContain(">Open table<");
    expect(html).not.toContain(">Open document<");
  });

  // The two tests above use the default pending status, under which the
  // footer link is withheld regardless of targetHref (see the `pending`
  // proposal cases elsewhere in this file) — so they cannot actually tell
  // the delete-specific guard in `targetHref` apart from ordinary pending
  // behavior. These accepted-status cases exercise that guard directly, and
  // confirm it does not also swallow the link for an item move.
  it("suppresses the target link once a delete has been accepted, unlike other accepted kinds", () => {
    const html = renderToStaticMarkup(
      <ProposalCard
        proposal={{
          ...proposal,
          kind: "content.lifecycle.item_delete.table",
          resourceId: "t1",
          status: "accepted",
          resolution: { commitSha: "0123456789abcdef" },
          preview: {
            kind: "lifecycle",
            action: "item_delete",
            resourceType: "table",
            from: "tables/roster.table",
            to: null,
            title: "Roster",
            affected: { documents: 0, tables: 1 },
          },
        }}
      />,
    );
    expect(html).toContain("Accepted · commit 0123456");
    expect(html).not.toContain(">Open table<");
    expect(html).not.toContain(">Open document<");
  });

  it("still offers the target link for an accepted item move", () => {
    const html = renderToStaticMarkup(
      <ProposalCard
        proposal={{
          ...proposal,
          kind: "content.lifecycle.item_move.table",
          resourceId: "t1",
          status: "accepted",
          resolution: { commitSha: "0123456789abcdef" },
          preview: {
            kind: "lifecycle",
            action: "item_move",
            resourceType: "table",
            from: "tables/roster.table",
            to: "tables/archive",
            title: "Roster",
            affected: { documents: 0, tables: 1 },
          },
        }}
      />,
    );
    expect(html).toContain("Open table");
    expect(html).toContain('href="/projects/proj/tables/t1"');
  });
});

describe("ProposalCards", () => {
  beforeEach(() => {
    mocked.role = "Editor";
    mocked.trainingRole = null;
    mocked.acceptPending = false;
  });

  it("renders only the proposals this message emitted, in the message's order", () => {
    mocked.proposals = [
      { ...proposal, id: "a", summary: "Alpha change" },
      { ...proposal, id: "b", summary: "Beta change" },
      { ...proposal, id: "c", summary: "Gamma change" },
    ];
    const html = renderToStaticMarkup(
      <ProposalCards
        conversationId="c"
        messageId="m1"
        proposalIds={["b", "a"]}
      />,
    );
    expect(html).not.toContain("Gamma change");
    expect(html.indexOf("Beta change")).toBeLessThan(
      html.indexOf("Alpha change"),
    );
  });

  it("renders nothing when the message emitted no proposals", () => {
    mocked.proposals = [{ ...proposal, id: "a" }];
    expect(
      renderToStaticMarkup(
        <ProposalCards conversationId="c" messageId="m1" proposalIds={[]} />,
      ),
    ).toBe("");
  });
});

it("offers retry and safe rejection recovery after a durable acceptance claim", () => {
  mocked.role = "Editor";
  mocked.acceptPending = false;
  const html = renderToStaticMarkup(
    <ProposalCard
      proposal={{ ...proposal, status: "accepting", expiresAt: new Date(0) }}
    />,
  );
  expect(html).toContain("Retry acceptance");
  expect(html).toContain('data-proposal-status="accepting"');
  expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Reject<\/button>/);
});

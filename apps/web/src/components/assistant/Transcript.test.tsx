import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { ExternalCallView } from "@weaver/core/externalMcp/types";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MockedState = {
  conversation: { data: unknown; error: unknown; isLoading: boolean };
  live: unknown;
  liveRun: unknown;
  liveStatus: unknown;
  calls: ExternalCallView[];
  approvals: { id: string; status: string }[];
  proposals: { id: string; runId: string; status: string }[];
  utils: {
    assistant: {
      getConversation: { invalidate: ReturnType<typeof vi.fn> };
      getConversationUsage: { invalidate: ReturnType<typeof vi.fn> };
    };
    externalMcp: { listApprovals: { invalidate: ReturnType<typeof vi.fn> } };
  };
  startLiveRun: ReturnType<typeof vi.fn>;
};
const mocked = vi.hoisted((): MockedState => ({
  conversation: {
    data: undefined,
    error: undefined,
    isLoading: false,
  },
  live: null,
  liveRun: null,
  liveStatus: null,
  calls: [],
  approvals: [],
  proposals: [],
  utils: {
    assistant: {
      getConversation: { invalidate: vi.fn() },
      getConversationUsage: { invalidate: vi.fn() },
    },
    externalMcp: { listApprovals: { invalidate: vi.fn() } },
  },
  startLiveRun: vi.fn(),
}));
vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => mocked.utils,
    account: { me: { useQuery: () => ({ data: undefined }) } },
    externalMcp: {
      listCalls: {
        useQuery: () => ({
          data: { calls: mocked.calls, nextAfter: null },
          refetch: vi.fn(),
        }),
      },
      listApprovals: { useQuery: () => ({ data: mocked.approvals }) },
    },
    assistant: {
      getConversationStatus: { useQuery: () => ({ data: undefined }) },
      getConversation: { useQuery: () => mocked.conversation },
      getConversationUsage: {
        useQuery: () => ({
          data: {
            model: "test-model",
            totals: {
              replies: 1,
              toolCalls: 2,
              inputTokens: 1200,
              outputTokens: 30,
            },
            runs: {
              r1: {
                model: "test-model",
                inputTokens: 1200,
                outputTokens: 30,
                toolCalls: 2,
                durationMs: 4000,
              },
            },
          },
        }),
      },
      listCitations: { useQuery: () => ({ data: [] }) },
      listProposals: { useQuery: () => ({ data: mocked.proposals }) },
    },
  },
}));
vi.mock("./ExternalToolApprovalCard", () => ({
  ExternalApproval: ({ id }: { id: string }) => (
    <div>Restored approval {id}</div>
  ),
}));
vi.mock("./AssistantProvider", () => ({
  useAssistant: () => ({
    live: mocked.live,
    liveRun: mocked.liveRun,
    // Independently settable so tests can simulate the ~250ms grace window
    // (AssistantProvider.tsx) where a terminal SSE event has already moved
    // `liveStatus` off "streaming" while `live`/`liveRun` are still held.
    liveStatus: mocked.liveStatus,
    startLiveRun: mocked.startLiveRun,
  }),
}));
vi.mock("~/lib/use-mounted", () => ({ useMounted: () => true }));

vi.mock("./ProposalCard", () => ({
  ProposalCards: ({ proposalIds }: { proposalIds: string[] }) => (
    <div>
      {proposalIds.map((id) => (
        <span key={id}>Proposal {id}</span>
      ))}
    </div>
  ),
}));
import { Transcript } from "./Transcript";

const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const snapshot = {
  kind: "project" as const,
  projectIds: ["22222222-2222-4222-8222-222222222222"],
  documentId: null,
  tableId: null,
  resolvedAt: "2026-09-03T00:00:00.000Z",
  truncated: false,
};

describe("Transcript", () => {
  beforeEach(() => {
    mocked.calls = [];
    mocked.approvals = [];
    mocked.proposals = [];
    mocked.live = null;
    mocked.liveRun = null;
    mocked.liveStatus = null;
    mocked.conversation = {
      data: undefined,
      error: undefined,
      isLoading: false,
    };
  });

  it("renders settled messages from their text, with the scope badge on user bubbles", () => {
    mocked.conversation.data = {
      id: CONVERSATION,
      title: "T",
      pinnedProjectId: null,
      lastMessageAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      activeRun: null,
      messages: [
        {
          id: "u1",
          position: 0,
          role: "user",
          status: "complete",
          text: "Hello?",
          citationIds: [],
          proposalIds: [],
          scopeSnapshot: snapshot,
          runId: "r1",
          createdAt: new Date(),
        },
        {
          id: "a1",
          position: 1,
          role: "assistant",
          status: "complete",
          text: "**Hi** there",
          citationIds: [],
          proposalIds: [],
          scopeSnapshot: null,
          runId: "r1",
          createdAt: new Date(),
        },
      ],
    };
    const html = renderToStaticMarkup(
      <Transcript
        conversationId={CONVERSATION}
        onScopeReuse={() => undefined}
      />,
    );
    expect(html).toContain("Hello?");
    expect(html).toContain("<strong>Hi</strong>");
    expect(html).toContain("Project");
  });

  it("renders the live message from the reducer state instead of the pending text", () => {
    mocked.conversation.data = {
      id: CONVERSATION,
      title: "T",
      pinnedProjectId: null,
      lastMessageAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      activeRun: { id: "r2", status: "running" },
      messages: [
        {
          id: "u2",
          position: 0,
          role: "user",
          status: "pending",
          text: "Go",
          citationIds: [],
          proposalIds: [],
          scopeSnapshot: snapshot,
          runId: "r2",
          createdAt: new Date(),
        },
      ],
    };
    mocked.liveRun = { runId: "r2", conversationId: CONVERSATION };
    mocked.liveStatus = "streaming";
    mocked.live = {
      text: "Streaming so far",
      attempt: 2,
      retrying: false,
      failure: null,
      tools: [],
      citations: [],
      proposals: [],
      terminal: null,
      lastSequence: 5,
    };
    const html = renderToStaticMarkup(
      <Transcript
        conversationId={CONVERSATION}
        onScopeReuse={() => undefined}
      />,
    );
    expect(html).toContain("Streaming so far");
    expect(html).toContain("attempt 2 of 3");
  });

  it("keeps showing the streamed answer through the post-terminal grace window, instead of flashing to a bare 'Thinking' state", () => {
    // AssistantProvider.tsx sets `liveStatus` away from "streaming" the
    // instant the terminal SSE event arrives, synchronously — well before
    // the invalidated `getConversation` refetch (which is what actually
    // flips `activeRun` to null) resolves. `conversation.activeRun` is still
    // the stale, truthy row here, exactly like that in-flight window.
    mocked.conversation.data = {
      id: CONVERSATION,
      title: "T",
      pinnedProjectId: null,
      lastMessageAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      activeRun: { id: "r2", status: "running" },
      messages: [
        {
          id: "u2",
          position: 0,
          role: "user",
          status: "pending",
          text: "Go",
          citationIds: [],
          proposalIds: [],
          scopeSnapshot: snapshot,
          runId: "r2",
          createdAt: new Date(),
        },
      ],
    };
    mocked.liveRun = { runId: "r2", conversationId: CONVERSATION };
    // The terminal frame already moved liveStatus off "streaming"...
    mocked.liveStatus = "ended";
    // ...but the provider is still holding the fully-streamed `live` state.
    mocked.live = {
      text: "The full streamed answer",
      attempt: 1,
      retrying: false,
      failure: null,
      tools: [],
      citations: [],
      proposals: [],
      terminal: "completed",
      lastSequence: 9,
    };
    const html = renderToStaticMarkup(
      <Transcript
        conversationId={CONVERSATION}
        onScopeReuse={() => undefined}
      />,
    );
    expect(html).toContain("The full streamed answer");
  });

  it("surfaces a failed run's terminal state under the user's own message", () => {
    // assistantRuns.ts never creates an assistant message row for a failed
    // or cancelled run — only the triggering *user* message's status flips
    // (see failRun/cancelRunFromWorker/requestRunCancel). The failure must
    // therefore render off the user bubble, not an (unreachable) assistant
    // one.
    mocked.conversation.data = {
      id: CONVERSATION,
      title: "T",
      pinnedProjectId: null,
      lastMessageAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      activeRun: null,
      messages: [
        {
          id: "u3",
          position: 0,
          role: "user",
          status: "failed",
          text: "Go",
          citationIds: [],
          proposalIds: [],
          scopeSnapshot: null,
          runId: "r3",
          createdAt: new Date(),
        },
      ],
    };
    const html = renderToStaticMarkup(
      <Transcript
        conversationId={CONVERSATION}
        onScopeReuse={() => undefined}
      />,
    );
    // The sr-only announcer coincidentally uses the same fallback copy for
    // "failed" (see liveAnnouncement.ts), so checking `html` as a whole
    // would pass even if the *visible* strip never rendered. Strip that
    // hidden region out first so the assertion is actually about the
    // visible UserBubble content.
    const visible = html.replace(/<div class="sr-only"[^>]*>.*?<\/div>/, "");
    expect(visible).toContain("Go");
    // RunStateStrip's fallback failure copy comes from runErrorCopy.ts
    // (frozen from Task 4), which spells "couldn't" with a plain ASCII
    // apostrophe — React HTML-escapes that to `&#x27;` in the raw markup
    // this test inspects, so match on a substring that sidesteps the
    // apostrophe rather than hard-coding either encoding.
    expect(visible).toContain("finish this answer");
    expect(visible).toContain("text-danger");
    expect(visible).toContain('role="status"');
  });

  it("surfaces a cancelled run's terminal state under the user's own message", () => {
    mocked.conversation.data = {
      id: CONVERSATION,
      title: "T",
      pinnedProjectId: null,
      lastMessageAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      activeRun: null,
      messages: [
        {
          id: "u4",
          position: 0,
          role: "user",
          status: "cancelled",
          text: "Go",
          citationIds: [],
          proposalIds: [],
          scopeSnapshot: null,
          runId: "r4",
          createdAt: new Date(),
        },
      ],
    };
    const html = renderToStaticMarkup(
      <Transcript
        conversationId={CONVERSATION}
        onScopeReuse={() => undefined}
      />,
    );
    const visible = html.replace(/<div class="sr-only"[^>]*>.*?<\/div>/, "");
    expect(visible).toContain("Go");
    expect(visible).toContain("Cancelled");
    expect(visible).toContain('role="status"');
  });

  it("shows a stored run failure's code copy and details after reload", () => {
    mocked.conversation.data = {
      id: CONVERSATION,
      title: "T",
      pinnedProjectId: null,
      lastMessageAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      activeRun: null,
      messages: [
        {
          id: "u5",
          position: 0,
          role: "user",
          status: "failed",
          text: "Go",
          citationIds: [],
          proposalIds: [],
          scopeSnapshot: null,
          runId: "r5",
          createdAt: new Date(),
          error: {
            code: "PROVIDER_UNAVAILABLE",
            message: "The model did not respond (ref 0123abcd)",
          },
        },
      ],
    };
    const html = renderToStaticMarkup(
      <Transcript
        conversationId={CONVERSATION}
        onScopeReuse={() => undefined}
      />,
    );
    const visible = html.replace(/<div class="sr-only"[^>]*>.*?<\/div>/, "");
    expect(visible).toContain("The model didn&#x27;t respond. Try again.");
    expect(visible).toContain("Details");
    expect(visible).toContain("The model did not respond");
  });

  it("still shows the CONTENT_CHANGE_APPLIED fallback when there is no stored error but a proposal was approved", () => {
    mocked.conversation.data = {
      id: CONVERSATION,
      title: "T",
      pinnedProjectId: null,
      lastMessageAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      activeRun: null,
      messages: [
        {
          id: "u6",
          position: 0,
          role: "user",
          status: "failed",
          text: "Go",
          citationIds: [],
          proposalIds: [],
          scopeSnapshot: null,
          runId: "r6",
          createdAt: new Date(),
          error: null,
        },
      ],
    };
    mocked.proposals = [{ id: "applied", runId: "r6", status: "accepted" }];
    const html = renderToStaticMarkup(
      <Transcript
        conversationId={CONVERSATION}
        onScopeReuse={() => undefined}
      />,
    );
    const visible = html.replace(/<div class="sr-only"[^>]*>.*?<\/div>/, "");
    expect(visible).toContain("The run stopped after a change was approved");
  });

  it("shows the unavailable state on NOT_FOUND without cached content", () => {
    mocked.conversation = {
      data: { messages: [{ id: "x", text: "stale" }] },
      error: { data: { code: "NOT_FOUND" } },
      isLoading: false,
    };
    const html = renderToStaticMarkup(
      <Transcript
        conversationId={CONVERSATION}
        onScopeReuse={() => undefined}
      />,
    );
    expect(html).toContain("This conversation isn’t available");
    expect(html).not.toContain("stale");
  });
});

it("restores current run approvals without any SSE replay", () => {
  mocked.live = null;
  mocked.liveRun = null;
  mocked.approvals = [{ id: "persisted-approval", status: "pending" }];
  mocked.conversation = {
    data: {
      id: CONVERSATION,
      activeRun: { id: "r", status: "running" },
      messages: [],
    },
    error: undefined,
    isLoading: false,
  };
  const html = renderToStaticMarkup(
    <Transcript conversationId={CONVERSATION} onScopeReuse={() => undefined} />,
  );
  expect(html).toContain("Restored approval persisted-approval");
  expect(html).toContain("Waiting for external tool approval");
});

it("refetches a run's approvals once that run ends, instead of reusing a stale list", () => {
  mocked.live = null;
  mocked.liveRun = null;
  mocked.approvals = [];
  mocked.utils.externalMcp.listApprovals.invalidate.mockClear();
  const conversation = (activeRun: { id: string; status: string } | null) => ({
    data: { id: CONVERSATION, activeRun, messages: [] },
    error: undefined,
    isLoading: false,
  });
  mocked.conversation = conversation({ id: "r-ended", status: "running" });
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <Transcript
        conversationId={CONVERSATION}
        onScopeReuse={() => undefined}
      />,
    );
  });
  expect(
    mocked.utils.externalMcp.listApprovals.invalidate,
  ).not.toHaveBeenCalled();
  mocked.conversation = conversation(null);
  act(() => {
    renderer.update(
      <Transcript
        conversationId={CONVERSATION}
        onScopeReuse={() => undefined}
      />,
    );
  });
  expect(
    mocked.utils.externalMcp.listApprovals.invalidate,
  ).toHaveBeenCalledWith({ runId: "r-ended" });
  act(() => renderer.unmount());
});

it("shows automatic write and unknown outcome activity without an approval card", () => {
  mocked.approvals = [];
  mocked.conversation = {
    data: {
      id: CONVERSATION,
      activeRun: { id: "r", status: "running" },
      messages: [],
    },
    error: undefined,
    isLoading: false,
  };
  mocked.liveRun = { runId: "r", conversationId: CONVERSATION };
  mocked.live = {
    text: "",
    tools: [
      {
        toolCallId: "t",
        callId: "external",
        toolName: "remote_write",
        externalStatus: "unknown",
        ok: false,
        input: null,
        summary: "Check the service",
      },
    ],
    citations: [],
    proposals: [],
    failure: null,
    retrying: false,
    attempt: 1,
  };
  const html = renderToStaticMarkup(
    <Transcript conversationId={CONVERSATION} onScopeReuse={() => undefined} />,
  );
  expect(html).toContain("External tool: remote_write");
  expect(html).toContain("outcome unknown");
  expect(html).not.toContain("Restored approval");
});

it.each(["complete", "failed", "cancelled"] as const)(
  "restores %s run outcomes in the mounted transcript after provider acknowledgement and reload",
  async (status) => {
    Object.assign(globalThis, {
      IS_REACT_ACT_ENVIRONMENT: true,
      requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
      cancelAnimationFrame: clearTimeout,
    });
    mocked.calls = [
      {
        callId: "call",
        toolCallId: "call",
        connectionId: "connection",
        connectionName: "Service",
        toolName: "write",
        status: "unknown",
        summary:
          "The remote operation may have completed. This call was not replayed automatically.",
        error: null,
      },
    ];
    mocked.conversation.data = {
      id: CONVERSATION,
      title: "T",
      activeRun: null,
      hasEarlierMessages: false,
      messages: [
        {
          id: "m",
          position: 0,
          role: status === "complete" ? "assistant" : "user",
          status,
          text: "Finished",
          scopeSnapshot: snapshot,
          contextProjectIds: snapshot.projectIds,
          citationIds: [],
          proposalIds: [],
          externalSources: [],
          hasExternalTools: true,
          hasExternalContext: true,
          runId: "run",
          createdAt: new Date(),
        },
      ],
    };
    mocked.live = null;
    mocked.liveRun = null;
    let renderer!: ReactTestRenderer;
    await act(() => {
      renderer = create(
        <Transcript conversationId={CONVERSATION} onScopeReuse={vi.fn()} />,
      );
    });
    expect(JSON.stringify(renderer.toJSON())).toContain(
      "not replayed automatically",
    );
    await act(() => renderer.unmount());
    await act(() => {
      renderer = create(
        <Transcript conversationId={CONVERSATION} onScopeReuse={vi.fn()} />,
      );
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("Service / write");
    expect(JSON.stringify(renderer.toJSON())).toContain(
      "not replayed automatically",
    );
    await act(() => renderer.unmount());
  },
);

it.each(["failed", "cancelled"])(
  "keeps accepted and interrupted changes visible after a %s run reload",
  (status) => {
    mocked.live = null;
    mocked.liveRun = null;
    mocked.conversation = {
      error: null,
      isLoading: false,
      data: {
        id: CONVERSATION,
        activeRun: null,
        messages: [
          {
            id: "u1",
            role: "user",
            position: 0,
            status,
            text: "Create notes",
            runId: "r1",
            proposalIds: [],
            citationIds: [],
            scopeSnapshot: null,
          },
        ],
      },
    };
    mocked.proposals = [
      { id: "applied", runId: "r1", status: "accepted" },
      { id: "recover", runId: "r1", status: "accepting" },
      { id: "rejected", runId: "r1", status: "rejected" },
      { id: "different", runId: "r2", status: "accepted" },
    ];
    const html = renderToStaticMarkup(
      <Transcript
        conversationId={CONVERSATION}
        onScopeReuse={() => undefined}
      />,
    );
    expect(html).toContain("Changes approved before this run stopped");
    expect(html).toContain("applied");
    expect(html).toContain("recover");
    expect(html).not.toContain("rejected");
    expect(html).not.toContain("different");
  },
);

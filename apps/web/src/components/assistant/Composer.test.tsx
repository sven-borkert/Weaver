import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, expect, it, vi } from "vitest";

type Callbacks = {
  onMutate: () => { draftRevision: number | null };
  onSuccess: (
    result: { run: { id: string } },
    variables: { conversationId: string; text: string },
    submitted: { draftRevision: number | null },
  ) => void;
  onError: (
    error: { data: { code: string } },
    variables: { conversationId: string },
  ) => void;
};
const mocked = vi.hoisted(() => ({
  callbacks: null as Callbacks | null,
  pending: false,
  startLiveRun: vi.fn(),
  clearComposerDraft: vi.fn(),
  invalidate: vi.fn(),
  mutate: vi.fn(),
  drafts: {},
  revisions: {},
}));
vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({
      assistant: {
        getConversation: { invalidate: mocked.invalidate },
        listConversations: { invalidate: vi.fn() },
      },
    }),
    assistant: {
      sendMessage: {
        useMutation: (callbacks: Callbacks) => {
          mocked.callbacks = callbacks;
          return { isPending: mocked.pending, mutate: mocked.mutate };
        },
      },
      cancelRun: { useMutation: () => ({ isPending: false, mutate: vi.fn() }) },
    },
  },
}));
vi.mock("./AssistantProvider", () => ({
  useAssistant: () => ({
    startLiveRun: mocked.startLiveRun,
    composerRef: { current: null },
    composerDrafts: mocked.drafts,
    composerDraftRevisions: mocked.revisions,
    setComposerDraft: vi.fn(),
    clearComposerDraft: mocked.clearComposerDraft,
  }),
}));
import { Composer } from "./Composer";

beforeEach(() => {
  mocked.pending = false;
  mocked.drafts = {};
  mocked.revisions = {};
  vi.clearAllMocks();
});
it("binds late send completion and conflict refresh to the submitted conversation", () => {
  renderToStaticMarkup(
    <Composer conversationId="a" scope={{ kind: "all" }} activeRunId={null} />,
  );
  renderToStaticMarkup(
    <Composer conversationId="b" scope={{ kind: "all" }} activeRunId={null} />,
  );
  mocked.callbacks!.onSuccess(
    { run: { id: "a-run" } },
    { conversationId: "a", text: "Sent message" },
    { draftRevision: 3 },
  );
  expect(mocked.startLiveRun).toHaveBeenCalledWith({
    runId: "a-run",
    conversationId: "a",
  });
  expect(mocked.clearComposerDraft).toHaveBeenCalledWith(
    "a",
    "Sent message",
    3,
  );
  expect(mocked.invalidate).toHaveBeenCalledWith({ conversationId: "a" });
  mocked.callbacks!.onError(
    { data: { code: "CONFLICT" } },
    { conversationId: "a" },
  );
  expect(mocked.invalidate).not.toHaveBeenCalledWith({ conversationId: "b" });
});

it("captures the submitted revision before later edits update mutation options", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocked.drafts = { a: "Submitted draft" };
  mocked.revisions = { a: 4 };
  const element = (
    <Composer conversationId="a" scope={{ kind: "all" }} activeRunId={null} />
  );
  let renderer!: ReactTestRenderer;
  await act(() => {
    renderer = create(element);
  });
  try {
    await act(() =>
      (
        renderer.root.findByType("form").props as {
          onSubmit: (event: { preventDefault: () => void }) => void;
        }
      ).onSubmit({ preventDefault: () => undefined }),
    );
    mocked.revisions = { a: 6 };
    await act(() =>
      renderer.update(
        <Composer
          conversationId="a"
          scope={{ kind: "all" }}
          activeRunId={null}
        />,
      ),
    );
    const submitted = mocked.callbacks!.onMutate();
    expect(submitted.draftRevision).toBe(4);
    await act(() =>
      mocked.callbacks!.onSuccess(
        { run: { id: "run" } },
        { conversationId: "a", text: "Submitted draft" },
        submitted,
      ),
    );
    expect(mocked.clearComposerDraft).toHaveBeenCalledWith(
      "a",
      "Submitted draft",
      4,
    );
  } finally {
    await act(() => renderer.unmount());
    vi.unstubAllGlobals();
  }
});
it("locks the draft while sending so success cannot erase newer typing", () => {
  mocked.pending = true;
  const html = renderToStaticMarkup(
    <Composer conversationId="a" scope={{ kind: "all" }} activeRunId={null} />,
  );
  expect(html).toMatch(/<textarea[^>]*disabled=""/);
});
it("offers no per-message external tool selection", () => {
  const html = renderToStaticMarkup(
    <Composer conversationId="a" scope={{ kind: "all" }} activeRunId={null} />,
  );
  expect(html).not.toContain("External connections");
});

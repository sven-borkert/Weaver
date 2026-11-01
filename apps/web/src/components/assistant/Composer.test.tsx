import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

type Callbacks = {
  onSuccess: (
    result: { run: { id: string } },
    variables: { conversationId: string },
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
  invalidate: vi.fn(),
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
          return { isPending: mocked.pending, mutate: vi.fn() };
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
  }),
}));
import { Composer } from "./Composer";

beforeEach(() => {
  mocked.pending = false;
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
    { conversationId: "a" },
  );
  expect(mocked.startLiveRun).toHaveBeenCalledWith({
    runId: "a-run",
    conversationId: "a",
  });
  expect(mocked.invalidate).toHaveBeenCalledWith({ conversationId: "a" });
  mocked.callbacks!.onError(
    { data: { code: "CONFLICT" } },
    { conversationId: "a" },
  );
  expect(mocked.invalidate).not.toHaveBeenCalledWith({ conversationId: "b" });
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

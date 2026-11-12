import { useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import type { createRunEventSubscription } from "~/lib/assistant/runEvents";

const mocked = vi.hoisted(() => ({
  subscribe: vi.fn(),
  close: vi.fn(),
  invalidate: vi.fn(),
  fetchConversation: vi.fn(),
  cachedConversation: undefined as
    { messages: { runId: string; role: string; status: string }[] } | undefined,
}));
vi.mock("~/lib/assistant/runEvents", () => ({
  createRunEventSubscription: mocked.subscribe,
}));
vi.mock("~/trpc/react", () => {
  const utils = {
    assistant: {
      getConversation: {
        invalidate: mocked.invalidate,
        fetch: mocked.fetchConversation,
      },
      getConversationUsage: { invalidate: mocked.invalidate },
      listProposals: { invalidate: mocked.invalidate },
      listCitations: { invalidate: mocked.invalidate },
      listConversations: { invalidate: mocked.invalidate },
    },
  };
  return {
    usePrincipalId: () => "user",
    api: {
      useUtils: () => utils,
      assistant: {
        getConversation: {
          useQuery: () => ({ data: mocked.cachedConversation }),
        },
      },
    },
  };
});
import { AssistantProvider, useAssistant } from "./AssistantProvider";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mocked.cachedConversation = undefined;
});

async function mountProvider() {
  let assistant!: ReturnType<typeof useAssistant>;
  let subscription!: Parameters<typeof createRunEventSubscription>[0];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", class {});
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: () => null,
      setItem: vi.fn(),
      removeItem: vi.fn(),
    },
  });
  mocked.subscribe.mockImplementation((input: typeof subscription) => {
    subscription = input;
    return { close: mocked.close, cursor: () => 0 };
  });
  function Harness() {
    const value = useAssistant();
    useEffect(() => {
      assistant = value;
    });
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(() => {
    renderer = create(
      <AssistantProvider>
        <Harness />
      </AssistantProvider>,
    );
  });
  return {
    assistant: () => assistant,
    subscription: () => subscription,
    renderer,
    rerender: () =>
      renderer.update(
        <AssistantProvider>
          <Harness />
        </AssistantProvider>,
      ),
  };
}

it("acknowledges a late cached outcome without restarting exhausted retries", async () => {
  vi.useFakeTimers();
  mocked.fetchConversation.mockResolvedValue({ messages: [] });
  const mounted = await mountProvider();
  try {
    await act(() => mounted.assistant().setActiveConversationId("a"));
    await act(() =>
      mounted.assistant().startLiveRun({ runId: "run", conversationId: "a" }),
    );
    await act(() => mounted.subscription().onEnd({ status: "completed" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120000);
    });
    expect(mounted.assistant().liveStatus).toBe("unconfirmed");
    mocked.cachedConversation = {
      messages: [{ runId: "run", role: "assistant", status: "complete" }],
    };
    await act(() => mounted.rerender());
    expect(mounted.assistant().liveRun).toBeNull();
    expect(mounted.assistant().live).toBeNull();
    expect(mounted.assistant().liveStatus).toBeNull();
    expect(mocked.fetchConversation).toHaveBeenCalledTimes(6);
  } finally {
    await act(() => mounted.renderer.unmount());
  }
});

it("does not acknowledge a newer live run from an older cached outcome", async () => {
  vi.useFakeTimers();
  mocked.fetchConversation.mockResolvedValue({ messages: [] });
  const mounted = await mountProvider();
  try {
    await act(() => mounted.assistant().setActiveConversationId("a"));
    await act(() =>
      mounted.assistant().startLiveRun({ runId: "new", conversationId: "a" }),
    );
    await act(() => mounted.subscription().onEnd({ status: "completed" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120000);
    });
    mocked.cachedConversation = {
      messages: [{ runId: "old", role: "assistant", status: "complete" }],
    };
    await act(() => mounted.rerender());
    expect(mounted.assistant().liveRun?.runId).toBe("new");
    expect(mounted.assistant().liveStatus).toBe("unconfirmed");
  } finally {
    await act(() => mounted.renderer.unmount());
  }
});

it("keeps the stream until its terminal handler records unseen completion", async () => {
  const mounted = await mountProvider();
  try {
    await act(() => mounted.assistant().setActiveConversationId("a"));
    await act(() =>
      mounted.assistant().startLiveRun({ runId: "run", conversationId: "a" }),
    );
    mocked.cachedConversation = {
      messages: [{ runId: "run", role: "assistant", status: "complete" }],
    };
    await act(() => mounted.rerender());
    expect(mounted.assistant().liveStatus).toBe("streaming");
    mocked.fetchConversation.mockResolvedValue(mocked.cachedConversation);
    await act(() => mounted.subscription().onEnd({ status: "completed" }));
    expect(mounted.assistant().unseenCompletion).toBe(true);
    expect(mounted.assistant().liveRun).toBeNull();
  } finally {
    await act(() => mounted.renderer.unmount());
  }
});

it("backs off and stops unacknowledged outcomes while retaining live text for a manual retry", async () => {
  vi.useFakeTimers();
  mocked.fetchConversation.mockResolvedValue({ messages: [] });
  const mounted = await mountProvider();
  try {
    await act(() => mounted.assistant().setActiveConversationId("a"));
    await act(() =>
      mounted.assistant().startLiveRun({ runId: "run", conversationId: "a" }),
    );
    await act(() =>
      mounted.subscription().onEvent({
        sequence: 1,
        event: { type: "text.delta", text: "Keep this answer" },
      }),
    );
    await act(() => mounted.subscription().onEnd({ status: "completed" }));
    expect(mocked.fetchConversation).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(mocked.fetchConversation).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(mocked.fetchConversation).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120000);
    });
    expect(mocked.fetchConversation).toHaveBeenCalledTimes(6);
    expect(mounted.assistant().liveStatus).toBe("unconfirmed");
    expect(mounted.assistant().live?.text).toBe("Keep this answer");
    mocked.fetchConversation.mockResolvedValue({
      messages: [{ runId: "run", role: "assistant", status: "complete" }],
    });
    await act(() => mounted.assistant().retryRunOutcome());
    expect(mounted.assistant().liveRun).toBeNull();
  } finally {
    await act(() => mounted.renderer.unmount());
  }
});

it("preserves a newer identical draft after navigating away and back during a send", async () => {
  const mounted = await mountProvider();
  try {
    await act(() => mounted.assistant().setComposerDraft("a", "First draft"));
    const submittedRevision = mounted.assistant().composerDraftRevisions.a!;
    await act(() => mounted.assistant().setActiveConversationId("b"));
    await act(() => mounted.assistant().setActiveConversationId("a"));
    await act(() =>
      mounted.assistant().setComposerDraft("a", "Different draft"),
    );
    await act(() => mounted.assistant().setComposerDraft("a", "First draft"));
    await act(() =>
      mounted
        .assistant()
        .clearComposerDraft("a", "First draft", submittedRevision),
    );
    expect(mounted.assistant().composerDrafts.a).toBe("First draft");
  } finally {
    await act(() => mounted.renderer.unmount());
  }
});

it("retains each conversation draft and prevents an older send from clearing newer text", async () => {
  const mounted = await mountProvider();
  try {
    await act(() => mounted.assistant().setComposerDraft("a", "First draft"));
    const submittedRevision = mounted.assistant().composerDraftRevisions.a!;
    await act(() => mounted.assistant().setActiveConversationId("b"));
    await act(() => mounted.assistant().setComposerDraft("b", "Other draft"));
    await act(() => mounted.assistant().setActiveConversationId("a"));
    expect(mounted.assistant().composerDrafts.a).toBe("First draft");
    await act(() => mounted.assistant().setComposerDraft("a", "Newer draft"));
    await act(() =>
      mounted
        .assistant()
        .clearComposerDraft("a", "First draft", submittedRevision),
    );
    expect(mounted.assistant().composerDrafts.a).toBe("Newer draft");
    await act(() =>
      mounted
        .assistant()
        .clearComposerDraft(
          "a",
          "Newer draft",
          mounted.assistant().composerDraftRevisions.a!,
        ),
    );
    expect(mounted.assistant().composerDrafts.a).toBeUndefined();
    expect(mounted.assistant().composerDrafts.b).toBe("Other draft");
  } finally {
    await act(() => mounted.renderer.unmount());
  }
});

it("keeps receiving a run while closed and records its unseen completion", async () => {
  let assistant: ReturnType<typeof useAssistant>;
  let initialize: FrameRequestCallback;
  let subscription: Parameters<typeof createRunEventSubscription>[0];
  const storage = new Map<string, string>();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", class {});
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    initialize = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
  mocked.subscribe.mockImplementation((input: typeof subscription) => {
    subscription = input;
    return { close: mocked.close, cursor: () => 0 };
  });
  mocked.fetchConversation.mockResolvedValue({
    messages: [{ runId: "run", role: "assistant", status: "complete" }],
  });
  function Harness() {
    const value = useAssistant();
    useEffect(() => {
      assistant = value;
    });
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(() => {
    renderer = create(
      <AssistantProvider>
        <Harness />
      </AssistantProvider>,
    );
  });
  try {
    await act(() => initialize(0));
    await act(() => assistant.setActiveConversationId("conversation"));
    await act(() => {
      assistant.setOpen(true);
      assistant.startLiveRun({ runId: "run", conversationId: "conversation" });
    });
    await act(() => assistant.setOpen(false));
    expect(mocked.close).not.toHaveBeenCalled();
    expect(mocked.subscribe).toHaveBeenCalledTimes(1);
    await act(() =>
      subscription.onEvent({
        sequence: 1,
        event: { type: "text.delta", text: "Still working" },
      }),
    );
    expect(assistant!.open).toBe(false);
    expect(assistant!.live?.text).toBe("Still working");
    await act(() => subscription.onEnd({ status: "completed" }));
    expect(assistant!.unseenCompletion).toBe(true);
    await act(() => assistant.setOpen(true));
    expect(assistant!.activeConversationId).toBe("conversation");
    expect(mocked.invalidate).toHaveBeenCalled();
  } finally {
    await act(() => renderer.unmount());
    vi.unstubAllGlobals();
  }
});

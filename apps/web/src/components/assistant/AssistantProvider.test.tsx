import { useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import type { createRunEventSubscription } from "~/lib/assistant/runEvents";

const mocked = vi.hoisted(() => ({
  subscribe: vi.fn(),
  close: vi.fn(),
  invalidate: vi.fn(),
  fetchConversation: vi.fn(),
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
  return { usePrincipalId: () => "user", api: { useUtils: () => utils } };
});
import { AssistantProvider, useAssistant } from "./AssistantProvider";

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

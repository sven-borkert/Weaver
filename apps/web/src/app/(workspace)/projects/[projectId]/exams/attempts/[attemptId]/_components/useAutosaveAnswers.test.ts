import { describe, it, expect, vi, afterEach } from "vitest";
import { create, act, type ReactTestRenderer } from "react-test-renderer";
import { createElement } from "react";
const mock = vi.hoisted(() => ({ save: vi.fn(), fetch: vi.fn() }));
vi.mock("~/trpc/react", () => ({
  api: {
    exam: { saveAnswer: { useMutation: () => ({ mutateAsync: mock.save }) } },
    useUtils: () => ({ exam: { getAttempt: { fetch: mock.fetch } } }),
  },
}));
import {
  useAutosaveAnswers,
  autosaveReducer,
  nextRetryDelayMs,
  hasUnacknowledgedAnswers,
} from "./useAutosaveAnswers";
const value = { selectedChoiceIds: [], text: "draft" };
const state = {
  q: {
    value,
    status: "saved" as const,
    sequence: 8,
    savedAt: null,
    attempts: 0,
  },
};
describe("answer saves", () => {
  it("starts above the stored sequence and ignores old acknowledgements", () => {
    const edited = autosaveReducer(state, {
      type: "edit",
      questionId: "q",
      value,
    });
    expect(edited.q?.sequence).toBe(9);
    expect(
      autosaveReducer(edited, {
        type: "saved",
        questionId: "q",
        sequence: 8,
        savedAt: new Date(),
      }),
    ).toBe(edited);
  });
  it("counts failures as unacknowledged work", () => {
    const edited = autosaveReducer(state, {
      type: "edit",
      questionId: "q",
      value,
    });
    const failed = autosaveReducer(edited, {
      type: "failed",
      questionId: "q",
      sequence: 9,
    });
    expect(hasUnacknowledgedAnswers(failed)).toBe(true);
    expect(hasUnacknowledgedAnswers(state)).toBe(false);
  });
  it("freezes closed slots", () => {
    const closed = autosaveReducer(state, { type: "closed" });
    expect(
      autosaveReducer(closed, { type: "edit", questionId: "q", value }),
    ).toBe(closed);
  });
  it("caps retry delays", () =>
    expect([1, 2, 3, 4, 5].map(nextRetryDelayMs)).toEqual([
      2000, 4000, 8000, 10000, 10000,
    ]));
});

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.clearAllMocks();
});
async function harness() {
  let hook: ReturnType<typeof useAutosaveAnswers> | undefined;
  function Harness() {
    hook = useAutosaveAnswers({
      attemptId: "attempt",
      initial: state,
      onTiming: vi.fn(),
      onExpired: vi.fn(),
    });
    return null;
  }
  await act(async () => {
    renderer = create(createElement(Harness));
  });
  return () => hook!;
}
it("debounces quick edits and flush waits for acknowledgement", async () => {
  vi.useFakeTimers();
  const timing = {
    startedAt: new Date(),
    deadlineAt: new Date(Date.now() + 60000),
    serverNow: new Date(),
    remainingMs: 60000,
  };
  mock.save.mockResolvedValue({
    outcome: "saved",
    savedAt: new Date(),
    timing,
  });
  const get = await harness();
  await act(async () => {
    get().setText("q", "a");
    get().setText("q", "ab");
    get().setText("q", "abc");
  });
  expect(mock.save).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(750);
  });
  expect(mock.save).toHaveBeenCalledTimes(1);
  expect(mock.save).toHaveBeenCalledWith(
    expect.objectContaining({ sequence: 11, text: "abc" }),
  );
  await act(async () => {
    await get().flush();
  });
  expect(get().pendingCount).toBe(0);
});
it("a failed save keeps flush pending and cannot authorize submission", async () => {
  vi.useFakeTimers();
  mock.save.mockRejectedValue(new Error("offline"));
  const get = await harness();
  await act(async () => get().setText("q", "unsaved"));
  let resolved = false;
  let rejected = false;
  let flushing: Promise<void>;
  await act(async () => {
    flushing = get()
      .flush()
      .then(
        () => {
          resolved = true;
        },
        () => {
          rejected = true;
        },
      );
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(resolved).toBe(false);
  expect(get().pendingCount).toBe(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(9000);
    await flushing;
  });
  expect(resolved).toBe(false);
  expect(rejected).toBe(true);
  expect(get().slots.q?.value.text).toBe("unsaved");
});
it("stale acknowledgements reload the canonical sequence and value", async () => {
  vi.useFakeTimers();
  mock.save.mockResolvedValue({
    outcome: "stale",
    timing: {
      startedAt: new Date(),
      deadlineAt: new Date(),
      serverNow: new Date(),
      remainingMs: 0,
    },
  });
  mock.fetch.mockResolvedValue({
    questions: [
      {
        id: "q",
        answer: {
          sequence: 30,
          selectedChoiceIds: [],
          text: "newer canonical",
          savedAt: new Date(),
        },
      },
    ],
  });
  const get = await harness();
  await act(async () => {
    get().setText("q", "local");
    await get().flush();
  });
  expect(get().slots.q?.sequence).toBe(30);
  expect(get().slots.q?.value.text).toBe("newer canonical");
});

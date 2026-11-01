import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import type { TraineeAttemptView } from "@weaver/core/services/examAttempts";

const mocks = vi.hoisted(() => ({
  flush: vi.fn(),
  submit: vi.fn(),
  expired: undefined as (() => void) | undefined,
  toast: vi.fn(),
}));
vi.mock("~/trpc/react", () => ({
  api: {
    exam: { submit: { useMutation: () => ({ mutateAsync: mocks.submit }) } },
    useUtils: () => ({ exam: { listAvailable: { invalidate: vi.fn() } } }),
  },
}));
vi.mock("sonner", () => ({ toast: { success: mocks.toast } }));
vi.mock("~/lib/use-unsaved-changes-guard", () => ({
  useUnsavedChangesGuard: vi.fn(),
}));
vi.mock(
  import("~/components/assistant/AssistantMarkdown"),
  async (importOriginal) => ({
    ...(await importOriginal()),
    AssistantMarkdown: () => <></>,
  }),
);
vi.mock("./AttemptTimer", () => ({
  AttemptTimer: ({ onExpired }: { onExpired: () => void }) => {
    mocks.expired = onExpired;
    return null;
  },
}));
vi.mock("./useAutosaveAnswers", () => ({
  useAutosaveAnswers: () => ({
    slots: {
      q: { value: { text: "pending", selectedChoiceIds: [] }, status: "error" },
    },
    pendingCount: 1,
    lastSavedAt: null,
    flush: mocks.flush,
    setText: vi.fn(),
    setChoices: vi.fn(),
  }),
}));
vi.mock("~/components/ui/dialog", () => {
  const Part = ({ children }: { children: ReactNode }) => children;
  return {
    Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? children : null,
    DialogContent: Part,
    DialogHeader: Part,
    DialogTitle: Part,
    DialogDescription: Part,
    DialogFooter: Part,
  };
});
import { TakeExam } from "./TakeExam";
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.clearAllMocks();
});
const attempt = {
  id: "attempt",
  examTitle: "Safety",
  attemptNumber: 1,
  instructions: "",
  timing: {
    deadlineAt: new Date(),
    serverNow: new Date(),
    startedAt: new Date(),
    remainingMs: 0,
  },
  questions: [
    { id: "q", kind: "free_text", prompt: "Explain", weight: 1, answer: null },
  ],
} as TraineeAttemptView;
it("expiry locks inputs and waits for every save before submitting", async () => {
  let acknowledge!: () => void;
  mocks.flush.mockReturnValue(
    new Promise<void>((resolve) => {
      acknowledge = resolve;
    }),
  );
  mocks.submit.mockResolvedValue({});
  const submitted = vi.fn();
  await act(async () => {
    renderer = create(<TakeExam attempt={attempt} onSubmitted={submitted} />);
  });
  await act(async () => mocks.expired?.());
  expect(renderer?.root.findByType("fieldset").props.disabled).toBe(true);
  expect(mocks.submit).not.toHaveBeenCalled();
  expect(mocks.toast).not.toHaveBeenCalled();
  await act(async () => acknowledge());
  expect(mocks.submit).toHaveBeenCalledWith({ attemptId: "attempt" });
  expect(submitted).toHaveBeenCalledOnce();
});
it("a failed expiry flush preserves the draft without claiming submission", async () => {
  mocks.flush.mockRejectedValue(new Error("offline"));
  await act(async () => {
    renderer = create(<TakeExam attempt={attempt} onSubmitted={vi.fn()} />);
  });
  await act(async () => mocks.expired?.());
  expect(mocks.submit).not.toHaveBeenCalled();
  expect(mocks.toast).not.toHaveBeenCalled();
  expect(renderer?.root.findByType("fieldset").props.disabled).toBe(true);
});

it("expiry remains locked if a manual flush was already running and then fails", async () => {
  let reject!: (reason: Error) => void;
  mocks.flush.mockReturnValue(
    new Promise<void>((_, failed) => {
      reject = failed;
    }),
  );
  await act(async () => {
    renderer = create(<TakeExam attempt={attempt} onSubmitted={vi.fn()} />);
  });
  function click(label: string) {
    const button = renderer!.root
      .findAllByType("button")
      .find(
        (node) => (node.props as { children: ReactNode }).children === label,
      )!;
    const props = button.props as { onClick: () => void };
    props.onClick();
  }
  await act(async () => click("Submit"));
  await act(async () => click("Submit exam"));
  await act(async () => mocks.expired?.());
  await act(async () => reject(new Error("offline")));
  expect(renderer!.root.findByType("fieldset").props.disabled).toBe(true);
  expect(mocks.submit).not.toHaveBeenCalled();
  expect(mocks.toast).not.toHaveBeenCalled();
});

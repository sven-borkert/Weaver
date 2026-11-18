import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import type { TraineeAttemptView } from "@weaver/core/services/examAttempts";

const mocks = vi.hoisted(() => ({
  flush: vi.fn(),
  submit: vi.fn(),
  expired: undefined as (() => void) | undefined,
  toast: vi.fn(),
  conflicting: false,
  useSavedAnswer: vi.fn(),
  keepDraftAnswer: vi.fn(),
}));
vi.mock("~/trpc/react", () => ({
  api: {
    exam: { submit: { useMutation: () => ({ mutateAsync: mocks.submit }) } },
    useUtils: () => ({
      exam: {
        listAvailable: { invalidate: vi.fn() },
        listOwnAttempts: { invalidate: vi.fn() },
      },
    }),
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
      q: {
        value: { text: "pending", selectedChoiceIds: [] },
        status: mocks.conflicting ? "conflict" : "error",
      },
    },
    pendingCount: 1,
    lastSavedAt: null,
    flush: mocks.flush,
    setText: vi.fn(),
    setChoices: vi.fn(),
    useSavedAnswer: mocks.useSavedAnswer,
    keepDraftAnswer: mocks.keepDraftAnswer,
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
  mocks.conflicting = false;
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

function button(label: string) {
  const match = renderer!.root
    .findAllByType("button")
    .find((node) => (node.props as { children: ReactNode }).children === label);
  if (!match) throw new Error(`Missing exam button: ${label}`);
  return match.props as { disabled?: boolean; onClick: () => void };
}

it("shows both resolution choices and blocks manual submission during a conflict", async () => {
  mocks.conflicting = true;
  await act(async () => {
    renderer = create(<TakeExam attempt={attempt} onSubmitted={vi.fn()} />);
  });
  expect(button("Submit").disabled).toBe(true);
  await act(async () => {
    button("Use saved answer").onClick();
    button("Keep my draft").onClick();
  });
  expect(mocks.useSavedAnswer).toHaveBeenCalledWith("q");
  expect(mocks.keepDraftAnswer).toHaveBeenCalledWith("q");
  expect(mocks.submit).not.toHaveBeenCalled();
});

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

it("resumes timeout submission when the last conflicting answer is resolved", async () => {
  mocks.conflicting = true;
  mocks.flush
    .mockRejectedValueOnce(new Error("Resolve conflicting answers first"))
    .mockResolvedValueOnce(undefined);
  mocks.submit.mockResolvedValue({});
  const onSubmitted = vi.fn();
  await act(async () => {
    renderer = create(<TakeExam attempt={attempt} onSubmitted={onSubmitted} />);
  });
  await act(async () => mocks.expired?.());
  expect(mocks.submit).not.toHaveBeenCalled();
  await act(async () => button("Use saved answer").onClick());
  expect(mocks.useSavedAnswer).toHaveBeenCalledWith("q");
  expect(mocks.submit).toHaveBeenCalledWith({ attemptId: "attempt" });
  expect(onSubmitted).toHaveBeenCalledOnce();
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
  await act(async () => button("Submit").onClick());
  await act(async () => button("Submit exam").onClick());
  await act(async () => mocks.expired?.());
  await act(async () => reject(new Error("offline")));
  expect(renderer!.root.findByType("fieldset").props.disabled).toBe(true);
  expect(mocks.submit).not.toHaveBeenCalled();
  expect(mocks.toast).not.toHaveBeenCalled();
});

import {
  QueryClientProvider,
  useQuery,
  type UseQueryOptions,
} from "@tanstack/react-query";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TraineeAttemptView } from "@weaver/core/services/examAttempts";
import { createQueryClient } from "~/trpc/query-client";

const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));
const queryKey = ["exam.getAttempt", { attemptId: "attempt" }];
vi.mock("~/trpc/react", () => ({
  api: {
    project: {
      get: { useQuery: () => ({ data: { myTrainingRole: "trainee" } }) },
    },
    exam: {
      getAttempt: {
        useQuery: (_: unknown, options?: UseQueryOptions<TraineeAttemptView>) =>
          useQuery({
            ...options,
            queryKey,
            queryFn: () => mocks.load() as Promise<TraineeAttemptView>,
            retry: false,
          }),
      },
      saveAnswer: { useMutation: () => ({ mutateAsync: mocks.save }) },
      submit: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    useUtils: () => ({ exam: { getAttempt: { fetch: mocks.load } } }),
  },
}));
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
vi.mock("./AttemptResult", () => ({ AttemptResult: () => null }));
vi.mock("./ReviewAttempt", () => ({ ReviewAttempt: () => null }));
import { AttemptScreen } from "./AttemptScreen";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: ReactTestRenderer | undefined;
let client: ReturnType<typeof createQueryClient>;
let attempt: TraineeAttemptView;
beforeEach(() => {
  client = createQueryClient();
  const now = new Date();
  attempt = {
    id: "attempt",
    status: "in_progress",
    examTitle: "Safety",
    attemptNumber: 1,
    instructions: "",
    timing: {
      startedAt: now,
      serverNow: now,
      deadlineAt: new Date(now.getTime() + 600000),
      remainingMs: 600000,
    },
    questions: [
      {
        id: "q",
        kind: "multiple_choice",
        prompt: "Choose",
        weight: 1,
        allowMultiple: false,
        choices: [
          { id: "a", text: "Answer A" },
          { id: "b", text: "Answer B" },
        ],
        answer: null,
      },
    ],
  } as TraineeAttemptView;
});
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  client.clear();
  vi.resetAllMocks();
});
function savedAttempt(): TraineeAttemptView {
  return {
    ...attempt,
    questions: attempt.questions.map((q) => ({
      ...q,
      answer: {
        selectedChoiceIds: ["a"],
        text: null,
        sequence: 1,
        savedAt: new Date(),
      },
    })),
  };
}
async function mount() {
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <AttemptScreen projectId="project" attemptId="attempt" />
      </QueryClientProvider>,
    );
  });
}
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
const choices = () => renderer!.root.findAllByType("input");

it.each([0, 31000])(
  "restores saved selections on the first return with a %ims-old cache",
  async (age) => {
    client.setQueryData(queryKey, attempt, { updatedAt: Date.now() - age });
    mocks.load.mockResolvedValue(savedAttempt());
    await mount();
    await settle();
    expect(choices()[0]?.props.checked).toBe(true);
  },
);

it("waits for saved answers before allowing edits on return", async () => {
  client.setQueryData(queryKey, attempt);
  let resolve!: (value: TraineeAttemptView) => void;
  mocks.load.mockReturnValue(
    new Promise<TraineeAttemptView>((done) => {
      resolve = done;
    }),
  );
  await mount();
  expect(choices()).toHaveLength(0);
  await act(async () => resolve(savedAttempt()));
  await settle();
  expect(choices()[0]?.props.checked).toBe(true);
});

it("keeps the cached blank form hidden if loading saved answers fails", async () => {
  client.setQueryData(queryKey, attempt);
  mocks.load.mockRejectedValue(new Error("offline"));
  await mount();
  await settle();
  expect(choices()).toHaveLength(0);
  expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(1);
});

it.each([false, true])(
  "preserves local edits during a later refresh (failed: %s)",
  async (failed) => {
    mocks.load.mockResolvedValue(savedAttempt());
    mocks.save.mockReturnValue(new Promise(() => undefined));
    await mount();
    await settle();
    const { onChange } = choices()[1]!.props as {
      onChange: (event: { target: { checked: boolean } }) => void;
    };
    await act(async () => onChange({ target: { checked: true } }));
    if (failed) mocks.load.mockRejectedValue(new Error("offline"));
    await act(async () => {
      await client.invalidateQueries({ queryKey });
    });
    await settle();
    expect(choices()[0]?.props.checked).toBe(false);
    expect(choices()[1]?.props.checked).toBe(true);
  },
);

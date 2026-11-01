import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { UseFormReturn } from "react-hook-form";
import { afterEach, expect, it, vi } from "vitest";
import type { ExamDetail } from "@weaver/core/services/exams";
import type { ExamFormValues } from "./examForm";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  form: undefined as UseFormReturn<ExamFormValues> | undefined,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("~/lib/use-unsaved-changes-guard", () => ({
  useUnsavedChangesGuard: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("./ExamPreview", () => ({ ExamPreview: () => null }));
vi.mock("./QuestionFields", () => ({
  QuestionFields: ({ form }: { form: UseFormReturn<ExamFormValues> }) => {
    mocks.form = form;
    return null;
  },
}));
vi.mock("~/trpc/react", () => ({
  api: {
    exam: {
      update: {
        useMutation: () => ({ mutate: mocks.mutate, isPending: false }),
      },
      delete: { useMutation: () => ({ isPending: false }) },
    },
    useUtils: () => ({}),
  },
}));
import { ExamDefinitionForm } from "./ExamDefinitionForm";
const initial: ExamDetail = {
  id: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  revision: 1,
  title: "Original",
  instructions: "",
  status: "draft",
  timeLimitMinutes: 5,
  passingPercent: null,
  questionCount: 1,
  maxScore: 1,
  attemptCounts: { inProgress: 0, inReview: 0, waiting: 0, released: 0 },
  createdAt: new Date(),
  updatedAt: new Date(),
  questions: [
    {
      id: "33333333-3333-4333-8333-333333333333",
      position: 0,
      kind: "free_text",
      prompt: "Explain",
      weight: 1,
      choices: null,
      allowMultiple: false,
      expectedAnswer: null,
    },
  ],
};
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.clearAllMocks();
});
it("preserves a dirty draft and its original expectedRevision after a background refresh", async () => {
  const reload = vi.fn();
  await act(async () => {
    renderer = create(<ExamDefinitionForm exam={initial} reload={reload} />);
  });
  await act(async () => {
    mocks.form!.setValue("title", "Local draft", { shouldDirty: true });
  });
  await act(async () => {
    renderer!.update(
      <ExamDefinitionForm
        exam={{ ...initial, revision: 2, title: "Remote edit" }}
        reload={reload}
      />,
    );
  });
  expect(mocks.form!.getValues("title")).toBe("Local draft");
  const { onSubmit } = renderer!.root.findByType("form").props as {
    onSubmit: () => Promise<void>;
  };
  await act(async () => {
    await onSubmit();
  });
  expect(mocks.mutate).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Local draft", expectedRevision: 1 }),
  );
});
it("accepts a newer canonical revision when the form is clean", async () => {
  const reload = vi.fn();
  await act(async () => {
    renderer = create(<ExamDefinitionForm exam={initial} reload={reload} />);
  });
  await act(async () => {
    renderer!.update(
      <ExamDefinitionForm
        exam={{ ...initial, revision: 2, title: "Remote edit" }}
        reload={reload}
      />,
    );
  });
  expect(mocks.form!.getValues("title")).toBe("Remote edit");
  const { onSubmit } = renderer!.root.findByType("form").props as {
    onSubmit: () => Promise<void>;
  };
  await act(async () => {
    await onSubmit();
  });
  expect(mocks.mutate).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Remote edit", expectedRevision: 2 }),
  );
});

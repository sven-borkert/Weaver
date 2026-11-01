import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const retentionData = {
  settings: {
    ingestionDays: 30,
    assistantConversationDays: 90,
    taskRunDays: 30,
    aiUsageDays: 90,
  },
};

type MutationCallOptions = { onSettled?: () => void };
type SaveMutation = (
  values: typeof retentionData.settings,
  options?: MutationCallOptions,
) => void;

const mocked = vi.hoisted(() => ({
  query: {
    data: undefined as typeof retentionData | undefined,
    error: undefined as { data?: { code?: string } } | undefined,
    isLoading: false,
    refetch: vi.fn(),
  },
  invalidate: vi.fn(),
  setMutation: { isPending: false, mutate: vi.fn<SaveMutation>() },
  setOptions: undefined as
    | {
        onSuccess?: (result: {
          settings: typeof retentionData.settings;
        }) => void;
        onError?: (error: {
          message?: string;
          data?: { field?: string };
        }) => void;
      }
    | undefined,
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: mocked.toastSuccess, error: mocked.toastError },
}));

vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({
      diagnostics: { getRetentionSettings: { invalidate: mocked.invalidate } },
    }),
    diagnostics: {
      getRetentionSettings: { useQuery: () => mocked.query },
      setRetentionSettings: {
        useMutation: (options: typeof mocked.setOptions) => {
          mocked.setOptions = options;
          return mocked.setMutation;
        },
      },
    },
  },
}));

import { RetentionCard } from "./RetentionCard";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

async function renderInteractive(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<RetentionCard />, {
      createNodeMock: (element) => (element.type === "input" ? {} : {}),
    });
  });
  return renderer!;
}

describe("RetentionCard", () => {
  beforeEach(() => {
    mocked.query.data = retentionData;
    mocked.query.error = undefined;
    mocked.query.isLoading = false;
    mocked.setMutation.isPending = false;
    mocked.setOptions = undefined;
    vi.clearAllMocks();
  });

  it("renders four labelled retention inputs and a save button", () => {
    const html = renderToStaticMarkup(<RetentionCard />);

    expect(html).toContain("Retention");
    expect(html).toContain("Import history (days)");
    expect(html).toContain("Idle assistant conversations (days, 0 = keep)");
    expect(html).toContain("Task run history (days)");
    expect(html).toContain("AI usage history (days)");
    expect(html).toContain("Save retention");
  });

  it("shows a loading skeleton before data arrives", () => {
    mocked.query.data = undefined;
    mocked.query.isLoading = true;

    const html = renderToStaticMarkup(<RetentionCard />);

    expect(html).not.toContain("Save retention");
  });

  it("shows a retryable error without cached data after an access failure", () => {
    mocked.query.data = undefined;
    mocked.query.error = { data: { code: "FORBIDDEN" } };

    const html = renderToStaticMarkup(<RetentionCard />);

    expect(html).toContain("Retention settings unavailable");
    expect(html).toContain("Retry");
    expect(html).not.toContain("Save retention");
  });

  it("submits the form values and toasts success on save", async () => {
    const renderer = await renderInteractive();

    await act(async () => {
      const onSubmit = renderer.root.findByType("form").props.onSubmit as (
        event: unknown,
      ) => void | Promise<void>;
      await onSubmit({ preventDefault: () => undefined });
    });

    expect(mocked.setMutation.mutate).toHaveBeenCalledOnce();
    expect(mocked.setMutation.mutate.mock.calls[0]?.[0]).toEqual(
      retentionData.settings,
    );

    mocked.setOptions?.onSuccess?.({ settings: retentionData.settings });
    expect(mocked.toastSuccess).toHaveBeenCalledWith(
      "Retention settings saved",
    );
    expect(mocked.invalidate).toHaveBeenCalledOnce();

    await act(async () => renderer.unmount());
  });
});

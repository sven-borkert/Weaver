import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const diagnosticData = {
  settings: {
    level: "standard" as "off" | "errors" | "standard" | "verbose",
    retentionDays: 7,
    verboseRetentionHours: 24,
    maxRows: 1_000_000,
  },
  stats: {
    rows: 42,
    verboseRows: 5,
    oldestAt: new Date("2026-09-01T08:00:00.000Z"),
    newestAt: new Date("2026-09-04T16:00:00.000Z"),
    writer: {
      started: true,
      runtime: "web" as const,
      queued: 0,
      written: 42,
      dropped: 3,
      flushes: 2,
      lastError: null,
    },
  },
};

type MutationCallOptions = { onSettled?: () => void };
type SaveMutation = (
  values: typeof diagnosticData.settings,
  options?: MutationCallOptions,
) => void;
type PruneMutation = (input?: undefined, options?: MutationCallOptions) => void;

const mocked = vi.hoisted(() => ({
  query: {
    data: undefined as typeof diagnosticData | undefined,
    error: undefined as { data?: { code?: string } } | undefined,
    isLoading: false,
    refetch: vi.fn(),
  },
  invalidate: vi.fn(),
  setMutation: { isPending: false, mutate: vi.fn<SaveMutation>() },
  pruneMutation: { isPending: false, mutate: vi.fn<PruneMutation>() },
  setOptions: undefined as
    | {
        onSuccess?: (result: {
          settings: typeof diagnosticData.settings;
        }) => void;
        onError?: (error: {
          message?: string;
          data?: { field?: string };
        }) => void;
      }
    | undefined,
  pruneOptions: undefined as
    | {
        onSuccess?: (result: {
          verboseRemoved: number;
          expiredRemoved: number;
          overflowRemoved: number;
          batches: number;
        }) => void;
        onError?: (error: { message?: string }) => void;
      }
    | undefined,
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  confirm: vi.fn(() => true),
}));

vi.mock("./ProcessingCard", () => ({ ProcessingCard: () => null }));

vi.mock("./RetentionCard", () => ({ RetentionCard: () => null }));

vi.mock("sonner", () => ({
  toast: { success: mocked.toastSuccess, error: mocked.toastError },
}));

vi.mock("~/lib/use-mounted", () => ({ useMounted: () => false }));

vi.mock("~/components/ui/select", () => ({
  Select: ({
    children,
    disabled,
    value,
  }: {
    children: ReactNode;
    disabled?: boolean;
    value?: string;
  }) => (
    <div data-slot="select-test" data-value={value} aria-disabled={disabled}>
      {children}
    </div>
  ),
  SelectContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <span data-value={value}>{children}</span>
  ),
  SelectTrigger: ({ children, ...props }: { children: ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  SelectValue: () => <span />,
}));

// The events panel has its own test; a marker keeps the settings-form
// assertions here from reaching into its controls.
vi.mock("./EventsPanel", () => ({
  EventsPanel: () => <div data-slot="events-panel-test" />,
}));

vi.mock("./ChangeSummariesCard", () => ({
  ChangeSummariesCard: () => <div data-slot="change-summaries-test" />,
}));

vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({
      diagnostics: { getSettings: { invalidate: mocked.invalidate } },
    }),
    diagnostics: {
      getSettings: { useQuery: () => mocked.query },
      setSettings: {
        useMutation: (options: typeof mocked.setOptions) => {
          mocked.setOptions = options;
          return mocked.setMutation;
        },
      },
      prune: {
        useMutation: (options: typeof mocked.pruneOptions) => {
          mocked.pruneOptions = options;
          return mocked.pruneMutation;
        },
      },
    },
  },
}));

import {
  DiagnosticsPage,
  diagnosticsSettingsFormSchema,
  requestDiagnosticsPrune,
} from "./DiagnosticsPage";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type InputNodeMock = {
  name: string;
  type: string;
  value: string;
  valueAsNumber: number;
  disabled: boolean;
  focus: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
};

type InputElementProps = {
  name?: string;
  type?: string;
  disabled?: boolean;
};

type InputChangeHandler = (event: {
  type: "change";
  target: InputNodeMock;
}) => void;

type FormSubmitHandler = (event: {
  preventDefault: () => void;
  persist: () => void;
}) => void | Promise<void>;

const inputNodes = new Map<string, InputNodeMock>();

async function renderInteractivePage(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  inputNodes.clear();
  await act(async () => {
    renderer = create(<DiagnosticsPage />, {
      createNodeMock: (element) => {
        if (element.type !== "input") return {};
        const props = element.props as InputElementProps;
        const node: InputNodeMock = {
          name: props.name ?? "",
          type: props.type ?? "text",
          value: "",
          valueAsNumber: Number.NaN,
          disabled: Boolean(props.disabled),
          focus: vi.fn(),
          select: vi.fn(),
        };
        inputNodes.set(node.name, node);
        return node;
      },
    });
  });
  return renderer!;
}

async function changeNumber(
  renderer: ReactTestRenderer,
  name: string,
  value: number,
) {
  const input = renderer.root.findByProps({ name });
  const node = inputNodes.get(name)!;
  const onChange = input.props.onChange as InputChangeHandler;
  node.value = String(value);
  node.valueAsNumber = value;
  await act(async () => {
    onChange({ type: "change", target: node });
  });
}

async function submit(renderer: ReactTestRenderer) {
  await act(async () => {
    await invokeSubmit(renderer);
  });
}

function invokeSubmit(renderer: ReactTestRenderer) {
  const onSubmit = renderer.root.findByType("form").props
    .onSubmit as FormSubmitHandler;
  return onSubmit({
    preventDefault: () => undefined,
    persist: () => undefined,
  });
}

function pruneClick(renderer: ReactTestRenderer): () => void {
  return renderer.root.findByProps({ children: "Prune now" }).props
    .onClick as () => void;
}

function onSettled(
  mutation:
    typeof mocked.setMutation.mutate | typeof mocked.pruneMutation.mutate,
  callIndex = 0,
): () => void {
  const settle = mutation.mock.calls[callIndex]?.[1]?.onSettled;
  expect(settle).toBeTypeOf("function");
  return settle!;
}

async function flushSameTickActions(
  actions: Array<() => void | Promise<void>>,
) {
  await act(async () => {
    const settlements = actions.map((action) => Promise.resolve(action()));
    await Promise.all(settlements);
  });
}

describe("DiagnosticsPage", () => {
  beforeEach(() => {
    mocked.query.data = diagnosticData;
    mocked.query.error = undefined;
    mocked.query.isLoading = false;
    mocked.setMutation.isPending = false;
    mocked.pruneMutation.isPending = false;
    mocked.setOptions = undefined;
    mocked.pruneOptions = undefined;
    vi.clearAllMocks();
    vi.stubGlobal("window", { confirm: mocked.confirm });
  });

  it("renders a named loading state until diagnostics data is available", () => {
    mocked.query.data = undefined;
    mocked.query.isLoading = true;

    const html = renderToStaticMarkup(<DiagnosticsPage />);

    expect(html).toContain('aria-label="Loading diagnostics settings"');
    expect(html).not.toContain("Maximum rows");
  });

  it("renders a retryable error without cached admin data after an access failure", () => {
    mocked.query.error = { data: { code: "FORBIDDEN" } };

    const html = renderToStaticMarkup(<DiagnosticsPage />);

    expect(html).toContain("Diagnostics unavailable");
    expect(html).toContain("Retry");
    expect(html).not.toContain("1000000");
    expect(html).not.toContain("42");
  });

  it("renders settings, statistics, and hydration-safe timestamp placeholders", () => {
    const html = renderToStaticMarkup(<DiagnosticsPage />);

    expect(html).toContain("Control the diagnostic log every runtime writes");
    expect(html).toContain("events-panel-test");
    expect(html).toContain("Standard");
    expect(html).toContain("Retention (days)");
    expect(html).toContain("Verbose retention (hours)");
    expect(html).toContain("Maximum rows");
    expect(html).toContain(">42<");
    expect(html).toContain(">5<");
    expect(html).toContain(">3<");
    expect(html).not.toContain("2026-09-01");
    expect(html).not.toContain("2026-09-04");
  });

  it("rejects empty, fractional, and out-of-range numeric save values", () => {
    const valid = {
      level: "verbose" as const,
      retentionDays: 1,
      verboseRetentionHours: 168,
      maxRows: 10_000,
    };

    expect(diagnosticsSettingsFormSchema.safeParse(valid).success).toBe(true);
    expect(
      diagnosticsSettingsFormSchema.safeParse({
        ...valid,
        retentionDays: Number.NaN,
      }).success,
    ).toBe(false);
    expect(
      diagnosticsSettingsFormSchema.safeParse({
        ...valid,
        verboseRetentionHours: 1.5,
      }).success,
    ).toBe(false);
    expect(
      diagnosticsSettingsFormSchema.safeParse({ ...valid, maxRows: 9_999 })
        .success,
    ).toBe(false);
  });

  it("shows pending save state and invalidates settings after a successful save", () => {
    mocked.setMutation.isPending = true;
    const html = renderToStaticMarkup(<DiagnosticsPage />);

    expect(html).toContain("Saving…");
    expect(html).toContain("disabled");

    mocked.setOptions?.onSuccess?.({ settings: diagnosticData.settings });
    expect(mocked.toastSuccess).toHaveBeenCalledWith(
      "Diagnostics settings saved",
    );
    expect(mocked.invalidate).toHaveBeenCalledOnce();
  });

  it("requires confirmation before pruning and invalidates after success", () => {
    const confirm = vi.fn(() => false);
    const prune = vi.fn();

    requestDiagnosticsPrune(confirm, prune);
    expect(prune).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledWith(
      expect.stringMatching(/retention.*maximum row cap/i),
    );

    confirm.mockReturnValue(true);
    requestDiagnosticsPrune(confirm, prune);
    expect(prune).toHaveBeenCalledOnce();

    renderToStaticMarkup(<DiagnosticsPage />);
    mocked.pruneOptions?.onSuccess?.({
      verboseRemoved: 2,
      expiredRemoved: 3,
      overflowRemoved: 4,
      batches: 1,
    });
    expect(mocked.toastSuccess).toHaveBeenCalledWith("Removed 9 rows");
    expect(mocked.invalidate).toHaveBeenCalledOnce();
  });

  it("preserves dirty retention while a refetch changes another setting", async () => {
    const renderer = await renderInteractivePage();
    await changeNumber(renderer, "retentionDays", 30);

    mocked.query.refetch.mockImplementationOnce(async () => {
      mocked.query.data = {
        ...diagnosticData,
        settings: { ...diagnosticData.settings, level: "verbose" },
      };
      return { data: mocked.query.data };
    });
    await mocked.query.refetch();
    await act(async () => {
      renderer.update(<DiagnosticsPage />);
    });
    await submit(renderer);

    expect(mocked.setMutation.mutate.mock.calls[0]?.[0]).toEqual({
      ...diagnosticData.settings,
      level: "verbose",
      retentionDays: 30,
    });
    await act(async () => renderer.unmount());
  });

  it("dispatches one save for two same-tick submissions", async () => {
    const renderer = await renderInteractivePage();

    await flushSameTickActions([
      () => invokeSubmit(renderer),
      () => invokeSubmit(renderer),
    ]);

    expect(mocked.setMutation.mutate).toHaveBeenCalledOnce();
    await act(async () => renderer.unmount());
  });

  it("blocks a same-tick prune after save submission starts", async () => {
    const renderer = await renderInteractivePage();
    const requestPrune = pruneClick(renderer);

    await flushSameTickActions([
      () => invokeSubmit(renderer),
      () => requestPrune(),
    ]);

    expect(mocked.setMutation.mutate).toHaveBeenCalledOnce();
    expect(mocked.confirm).not.toHaveBeenCalled();
    expect(mocked.pruneMutation.mutate).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });

  it("blocks a same-tick save after prune starts", async () => {
    const renderer = await renderInteractivePage();
    const requestPrune = pruneClick(renderer);

    await flushSameTickActions([
      () => requestPrune(),
      () => invokeSubmit(renderer),
    ]);

    expect(mocked.pruneMutation.mutate).toHaveBeenCalledOnce();
    expect(mocked.setMutation.mutate).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });

  it("releases the action lock after save validation fails", async () => {
    const renderer = await renderInteractivePage();
    await changeNumber(renderer, "retentionDays", 0);
    await submit(renderer);
    expect(mocked.setMutation.mutate).not.toHaveBeenCalled();

    await changeNumber(renderer, "retentionDays", 30);
    await submit(renderer);

    expect(mocked.setMutation.mutate).toHaveBeenCalledOnce();
    await act(async () => renderer.unmount());
  });

  it("releases the action lock when prune confirmation is cancelled", async () => {
    mocked.confirm.mockReturnValueOnce(false);
    const renderer = await renderInteractivePage();

    await act(async () => pruneClick(renderer)());
    await submit(renderer);

    expect(mocked.pruneMutation.mutate).not.toHaveBeenCalled();
    expect(mocked.setMutation.mutate).toHaveBeenCalledOnce();
    await act(async () => renderer.unmount());
  });

  it("releases a rejected save only when its mutation settles", async () => {
    const renderer = await renderInteractivePage();
    await submit(renderer);
    const settleRejectedSave = onSettled(mocked.setMutation.mutate);

    mocked.setOptions?.onError?.({ message: "Save rejected" });
    await submit(renderer);
    expect(mocked.setMutation.mutate).toHaveBeenCalledOnce();

    settleRejectedSave();
    await submit(renderer);

    expect(mocked.setMutation.mutate).toHaveBeenCalledTimes(2);
    await act(async () => renderer.unmount());
  });

  it("releases the action lock when prune dispatch throws synchronously", async () => {
    mocked.pruneMutation.mutate.mockImplementationOnce(() => {
      throw new Error("Synchronous prune failure");
    });
    const renderer = await renderInteractivePage();

    expect(() => pruneClick(renderer)()).toThrow("Synchronous prune failure");
    await submit(renderer);

    expect(mocked.setMutation.mutate).toHaveBeenCalledOnce();
    await act(async () => renderer.unmount());
  });

  it("does not let a stale settlement release another action's lock", async () => {
    const renderer = await renderInteractivePage();
    await submit(renderer);
    const settleSave = onSettled(mocked.setMutation.mutate);
    settleSave();

    await act(async () => pruneClick(renderer)());
    settleSave();
    await submit(renderer);

    expect(mocked.pruneMutation.mutate).toHaveBeenCalledOnce();
    expect(mocked.setMutation.mutate).toHaveBeenCalledOnce();
    await act(async () => renderer.unmount());
  });

  it("serializes save and prune and reconciles a save with its server result", async () => {
    const renderer = await renderInteractivePage();
    await changeNumber(renderer, "retentionDays", 30);
    await submit(renderer);
    expect(mocked.setMutation.mutate).toHaveBeenCalledOnce();

    mocked.setMutation.isPending = true;
    await act(async () => renderer.update(<DiagnosticsPage />));
    const pruneButton = renderer.root.findByProps({ children: "Prune now" });
    expect(pruneButton.props.disabled).toBe(true);
    expect(
      renderer.root
        .findAllByType("input")
        .every((input) => input.props.disabled === true),
    ).toBe(true);
    expect(
      renderer.root.findByProps({ "data-slot": "select-test" }).props[
        "aria-disabled"
      ],
    ).toBe(true);
    const requestPrune = pruneButton.props.onClick as () => void;
    await act(async () => requestPrune());
    expect(mocked.confirm).not.toHaveBeenCalled();
    expect(mocked.pruneMutation.mutate).not.toHaveBeenCalled();

    const settleSave = onSettled(mocked.setMutation.mutate);
    await act(async () => {
      mocked.setOptions?.onSuccess?.({
        settings: {
          ...diagnosticData.settings,
          level: "verbose",
          retentionDays: 31,
        },
      });
    });
    mocked.setMutation.isPending = false;
    await act(async () => renderer.update(<DiagnosticsPage />));
    await submit(renderer);
    expect(mocked.setMutation.mutate).toHaveBeenCalledOnce();

    settleSave();
    mocked.pruneMutation.isPending = true;
    await act(async () => renderer.update(<DiagnosticsPage />));
    const saveButton = renderer.root.findByProps({ children: "Save" });
    expect(saveButton.props.disabled).toBe(true);
    expect(
      renderer.root
        .findAllByType("input")
        .every((input) => input.props.disabled === true),
    ).toBe(true);
    await submit(renderer);
    expect(mocked.setMutation.mutate).toHaveBeenCalledOnce();

    mocked.pruneMutation.isPending = false;
    await act(async () => renderer.update(<DiagnosticsPage />));
    await submit(renderer);
    expect(mocked.setMutation.mutate.mock.calls.at(-1)?.[0]).toEqual({
      ...diagnosticData.settings,
      level: "verbose",
      retentionDays: 31,
    });
    await act(async () => renderer.unmount());
  });
});

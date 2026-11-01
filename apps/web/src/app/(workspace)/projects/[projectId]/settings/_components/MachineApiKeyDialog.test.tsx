import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

type DialogMocks = {
  createOptions: { gcTime?: number } | undefined;
  defaults: Record<string, unknown> | undefined;
  submitted: Record<string, unknown>;
  pending: boolean;
};
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  resetMutation: vi.fn(),
  invalidate: vi.fn(),
  resetForm: vi.fn(),
  setError: vi.fn(),
  toastError: vi.fn(),
  ...({
    createOptions: undefined,
    defaults: undefined,
    submitted: {},
    pending: false,
  } satisfies DialogMocks as DialogMocks),
}));

vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({
      projectApiKey: { list: { invalidate: mocks.invalidate } },
    }),
    projectApiKey: {
      create: {
        useMutation: (options: { gcTime?: number }) => {
          mocks.createOptions = options;
          return {
            isPending: mocks.pending,
            mutateAsync: mocks.create,
            reset: mocks.resetMutation,
          };
        },
      },
      update: {
        useMutation: () => ({ isPending: false, mutateAsync: mocks.update }),
      },
    },
  },
}));
vi.mock("react-hook-form", () => ({
  useForm: (options: { defaultValues: Record<string, unknown> }) => {
    mocks.defaults = options.defaultValues;
    return {
      register: () => ({}),
      control: {},
      setError: mocks.setError,
      reset: mocks.resetForm,
      formState: { errors: {}, isSubmitting: false },
      handleSubmit: (submit: (values: unknown) => Promise<void>) => () =>
        submit(mocks.submitted),
    };
  },
  Controller: () => null,
  useWatch: () => mocks.submitted.expiry,
}));
vi.mock("./MachineGrantFields", () => ({
  MAX_MACHINE_GRANTS: 100,
  MachineGrantFields: () => null,
  grantIdentity: (grant: { kind: string; root?: true; targetId?: string }) =>
    `${grant.kind}:${grant.root ? "root" : grant.targetId}`,
}));
vi.mock("~/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogContent: ({
    children,
    ...props
  }: {
    children: ReactNode;
    "aria-busy"?: boolean;
  }) => <div data-dialog-busy={String(props["aria-busy"])}>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
}));
vi.mock("~/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectValue: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: mocks.toastError },
}));

import { TRPCClientError } from "@trpc/client";
import { MachineApiKeyDialog } from "./MachineApiKeyDialog";

const SECRET = "wvr_project_test-once-secret";
const created = {
  secret: SECRET,
  key: { id: "key", grants: [] },
};
const existing = {
  id: "key-1",
  projectId: "project",
  name: "Daily audit",
  fingerprint: "abcd",
  status: "Active" as const,
  expiresAt: new Date("2026-12-01T00:00:00Z"),
  revokedAt: null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  lastUsedAt: null,
  policyVersion: 3,
  rateLimitPerMinute: 20,
  grants: [
    {
      kind: "document" as const,
      targetId: "11111111-1111-4111-8111-111111111111",
      root: false,
      actions: ["update" as const],
      available: false,
      label: "Unavailable target",
      location: "",
    },
  ],
};

const run = (fn: unknown) => (fn as () => Promise<void>)();
const text = (renderer: ReactTestRenderer) => JSON.stringify(renderer.toJSON());
const button = (renderer: ReactTestRenderer, label: string) =>
  renderer.root
    .findAllByType("button")
    .find((b) => b.findAll((n) => n.children.includes(label)).length > 0)!;

async function mount(element: ReactNode) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<>{element}</>);
  });
  return renderer;
}

describe("project API key dialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pending = false;
    mocks.submitted = {
      name: "Daily audit",
      grants: [{ kind: "documentFolder", root: true, actions: ["create"] }],
      expiry: "days",
      expiresInDays: 90,
      rateLimitPerMinute: 100,
    };
    mocks.create.mockResolvedValue(created);
    mocks.invalidate.mockResolvedValue(undefined);
  });

  it("starts with no permissions, a 90-day expiry and 100 requests per minute", async () => {
    await mount(<MachineApiKeyDialog projectId="project" baseUrl={null} />);
    expect(mocks.defaults).toMatchObject({
      grants: [],
      expiry: "days",
      expiresInDays: 90,
      rateLimitPerMinute: 100,
    });
    expect(mocks.createOptions?.gcTime).toBe(0);
  });

  it("keeps an accepted secret when the list refresh fails and retries only the refresh", async () => {
    mocks.invalidate.mockRejectedValueOnce(new Error("List unavailable"));
    const renderer = await mount(
      <MachineApiKeyDialog projectId="project" baseUrl={null} />,
    );
    await act(() => run(renderer.root.findByType("form").props.onSubmit));
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project", expiresInDays: 90 }),
    );
    expect(mocks.invalidate).toHaveBeenCalledWith(
      { projectId: "project" },
      undefined,
      { throwOnError: true },
    );
    expect(mocks.resetMutation).toHaveBeenCalled();
    expect(text(renderer)).toContain(SECRET);
    await act(() => run(button(renderer, "Retry list refresh").props.onClick));
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.invalidate).toHaveBeenCalledTimes(2);
    expect(text(renderer)).not.toContain("Retry list refresh");
    await act(() => run(button(renderer, "I saved the key").props.onClick));
    expect(text(renderer)).not.toContain(SECRET);
    await act(async () => renderer.unmount());
  });

  it("sends an explicit null for keys that never expire", async () => {
    mocks.submitted.expiry = "never";
    const renderer = await mount(
      <MachineApiKeyDialog projectId="project" baseUrl={null} />,
    );
    await act(() => run(renderer.root.findByType("form").props.onSubmit));
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ expiresInDays: null }),
    );
  });

  it("keeps the draft and pins field errors when saving fails", async () => {
    mocks.create.mockRejectedValueOnce(
      new TRPCClientError("Rate limit must be at most 10000", {
        result: {
          error: {
            code: -32600,
            message: "Rate limit must be at most 10000",
            data: { code: "BAD_REQUEST", field: "rateLimitPerMinute" },
          },
        },
      }),
    );
    const renderer = await mount(
      <MachineApiKeyDialog projectId="project" baseUrl={null} />,
    );
    await act(() => run(renderer.root.findByType("form").props.onSubmit));
    expect(mocks.setError).toHaveBeenCalledWith("rateLimitPerMinute", {
      message: "Rate limit must be at most 10000",
    });
    expect(mocks.resetForm).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(text(renderer)).not.toContain(SECRET);

    mocks.create.mockRejectedValueOnce(new Error("Connection failed"));
    await act(() => run(renderer.root.findByType("form").props.onSubmit));
    expect(mocks.toastError).toHaveBeenCalledWith("Connection failed");
    expect(mocks.resetForm).not.toHaveBeenCalled();
  });

  it("disables every control while a save is pending", async () => {
    mocks.pending = true;
    const renderer = await mount(
      <MachineApiKeyDialog projectId="project" baseUrl={null} />,
    );
    expect(text(renderer)).toContain('"data-dialog-busy":"true"');
    for (const label of ["Cancel", "Saving…"])
      expect(button(renderer, label).props.disabled).toBe(true);
  });

  it("edits a key while preserving its expiry and unavailable targets", async () => {
    mocks.submitted.expiry = "keep";
    const renderer = await mount(
      <MachineApiKeyDialog
        projectId="project"
        baseUrl={null}
        existing={existing}
      />,
    );
    expect(mocks.defaults).toMatchObject({
      name: "Daily audit",
      expiry: "keep",
      rateLimitPerMinute: 20,
      grants: [
        {
          kind: "document",
          targetId: existing.grants[0]!.targetId,
          actions: ["update"],
        },
      ],
    });
    expect(
      (mocks.defaults!.grants as Record<string, unknown>[])[0],
    ).not.toHaveProperty("root");
    await act(() => run(renderer.root.findByType("form").props.onSubmit));
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ keyId: "key-1", projectId: "project" }),
    );
    expect(mocks.update.mock.calls[0]![0]).not.toHaveProperty("expiresInDays");
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

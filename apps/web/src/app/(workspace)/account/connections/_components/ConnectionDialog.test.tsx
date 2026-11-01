import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  pending: false,
  updateMutate: vi.fn(),
  createMutate: vi.fn(),
  updateOptions: undefined as
    { onSuccess?: (saved: never) => void } | undefined,
  createOptions: undefined as
    | {
        onSuccess?: (saved: never) => void;
        onError?: (error: never) => void;
      }
    | undefined,
  invalidate: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("~/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children, ...props }: { children: ReactNode }) => (
    <div {...props}>{children}</div>
  ),
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogClose: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({
      externalMcp: {
        invalidate: mocked.invalidate,
        get: { fetch: mocked.fetch },
      },
    }),
    externalMcp: {
      create: {
        useMutation: (o: typeof mocked.createOptions) => {
          mocked.createOptions = o;
          return { isPending: mocked.pending, mutate: mocked.createMutate };
        },
      },
      update: {
        useMutation: (o: typeof mocked.updateOptions) => {
          mocked.updateOptions = o;
          return { isPending: mocked.pending, mutate: mocked.updateMutate };
        },
      },
    },
  },
}));
import { ConnectionDialog } from "./ConnectionDialog";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const base = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Original",
  endpoint: "https://example.test/mcp",
  enabled: true,
  authMode: "bearer" as const,
  revision: 1,
  timeoutMs: 30000,
  createdAt: new Date(),
  updatedAt: new Date(),
  lastDiscoveredAt: null,
  discoveryProtocol: null,
  discoveryServerName: null,
  discoveryToolCount: null,
  discoveryResourceCount: null,
  discoveryErrorCode: null,
  discoveryErrorSummary: null,
  tools: [],
  totalTools: 0,
  toolsTruncated: false,
};
type NodeMock = {
  name: string;
  type: string;
  value: string;
  valueAsNumber: number;
  checked: boolean;
  focus: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
};
const nodes = new Map<string, NodeMock>();
function dialogProps(
  connection: typeof base | null = base,
  open = true,
  extra: Record<string, unknown> = {},
) {
  return {
    open,
    connection: (connection ?? undefined) as never,
    onOpenChange: vi.fn(),
    returnFocusRef: { current: null },
    fallbackFocusRef: { current: null },
    ...extra,
  };
}
async function mount(
  connection: typeof base | null = base,
  extra: Record<string, unknown> = {},
) {
  let renderer!: ReactTestRenderer;
  nodes.clear();
  await act(async () => {
    renderer = create(
      <ConnectionDialog {...dialogProps(connection, true, extra)} />,
      {
        createNodeMock: (element) => {
          if (element.type !== "input" && element.type !== "select") return {};
          const p = element.props as { name?: string; type?: string };
          const node = {
            name: p.name ?? "",
            type: p.type ?? "text",
            value: "",
            valueAsNumber: Number.NaN,
            checked: false,
            focus: vi.fn(),
            select: vi.fn(),
          };
          nodes.set(node.name, node);
          return node;
        },
      },
    );
  });
  return renderer;
}
async function change(
  renderer: ReactTestRenderer,
  name: string,
  value: string,
) {
  const field = renderer.root.findByProps({ name });
  const node = nodes.get(name)!;
  node.value = value;
  const onChange = field.props.onChange as (event: {
    type: "change";
    target: NodeMock;
  }) => void;
  await act(async () => {
    onChange({ type: "change", target: node });
  });
}
async function submit(renderer: ReactTestRenderer) {
  const onSubmit = renderer.root.findByType("form").props.onSubmit as (event: {
    preventDefault(): void;
    persist(): void;
  }) => Promise<void> | void;
  await act(async () => {
    await onSubmit({ preventDefault: vi.fn(), persist: vi.fn() });
  });
}

describe("ConnectionDialog lifecycle", () => {
  it("warns that the assistant calls enabled tools on its own", async () => {
    const renderer = await mount();
    const text = renderer.root
      .findAll((node) => node.type === "p")
      .map((node) =>
        node.children
          .filter((child): child is string => typeof child === "string")
          .join(""),
      )
      .join(" ");
    expect(text).toContain(
      "The assistant calls enabled tools on its own and asks before a write tool unless Auto-approve is on in the conversation.",
    );
  });
  beforeEach(() => {
    mocked.pending = false;
    mocked.updateMutate.mockReset();
    mocked.createMutate.mockReset();
  });
  it("keeps the opened revision and RHF draft across a prop refresh", async () => {
    const renderer = await mount();
    await change(renderer, "name", "My draft");
    await act(async () => {
      renderer.update(
        <ConnectionDialog
          {...dialogProps({ ...base, revision: 2, name: "Remote edit" })}
        />,
      );
    });
    await submit(renderer);
    const submitted = mocked.updateMutate.mock.calls.at(-1)?.[0] as {
      expectedRevision: number;
      patch: { name?: string };
    };
    expect(submitted.expectedRevision).toBe(1);
    expect(submitted.patch.name).toBe("My draft");
  });
  it("clears the accepted token and resets RHF to latest values on a committed reopen", async () => {
    const renderer = await mount();
    await change(renderer, "token", "replacement-secret");
    await submit(renderer);
    const first = mocked.updateMutate.mock.calls.at(-1)?.[0] as {
      patch: { token?: string };
    };
    expect(first.patch.token).toBe("replacement-secret");
    await act(async () => {
      mocked.updateOptions?.onSuccess?.({ ...base, revision: 2 } as never);
    });
    await submit(renderer);
    const accepted = mocked.updateMutate.mock.calls.at(-1)?.[0] as {
      expectedRevision: number;
      patch: { token?: string };
    };
    expect(accepted.expectedRevision).toBe(2);
    expect(accepted.patch).not.toHaveProperty("token");
    await act(async () => {
      renderer.update(
        <ConnectionDialog {...dialogProps({ ...base, revision: 2 }, false)} />,
      );
    });
    const latest = {
      ...base,
      revision: 3,
      name: "Latest accepted name",
      endpoint: "https://latest.example.test/mcp",
      enabled: false,
      timeoutMs: 45000,
    };
    await act(async () => {
      renderer.update(<ConnectionDialog {...dialogProps(latest, true)} />);
    });
    await submit(renderer);
    const reopened = mocked.updateMutate.mock.calls.at(-1)?.[0] as {
      expectedRevision: number;
      patch: { token?: string };
    };
    expect(reopened.expectedRevision).toBe(3);
    expect(reopened.patch).toEqual({
      name: latest.name,
      endpoint: latest.endpoint,
      enabled: latest.enabled,
      timeoutMs: latest.timeoutMs,
      authMode: latest.authMode,
      allowInsecureTls: false,
    });
    expect(reopened.patch).not.toHaveProperty("token");
  });
  it("requires the bearer token again before saving a different endpoint origin", async () => {
    const renderer = await mount();
    await change(renderer, "endpoint", "https://other.test/mcp");
    await submit(renderer);
    expect(mocked.updateMutate).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer.toJSON())).toContain(
      "Re-enter the bearer token",
    );
    await change(renderer, "token", "other-secret");
    await submit(renderer);
    const submitted = mocked.updateMutate.mock.calls.at(-1)?.[0] as {
      patch: { endpoint?: string; token?: string };
    };
    expect(submitted.patch).toMatchObject({
      endpoint: "https://other.test/mcp",
      token: "other-secret",
    });
  });
  it("disables actual editable fields while pending", async () => {
    mocked.pending = true;
    const renderer = await mount();
    expect(renderer.root.findByType("fieldset").props.disabled).toBe(true);
  });
  it("creates enabled connections and hands the new one to onCreated", async () => {
    const onCreated = vi.fn();
    const renderer = await mount(null, { onCreated });
    await change(renderer, "name", "Mine");
    await change(renderer, "endpoint", "https://example.test/mcp");
    await submit(renderer);
    expect(mocked.createMutate.mock.calls.at(-1)?.[0]).toMatchObject({
      name: "Mine",
      enabled: true,
    });
    expect(mocked.createMutate.mock.calls.at(-1)?.[0]).not.toHaveProperty(
      "approvalPolicy",
    );
    await act(async () => {
      mocked.createOptions?.onSuccess?.({ ...base, id: "c1" } as never);
    });
    expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ id: "c1" }),
    );
  });
  it("pins a duplicate name to the Name field without the changed-connection banner", async () => {
    const renderer = await mount(null);
    await act(async () => {
      mocked.createOptions?.onError?.({
        message: "You already have a connection with this name",
        data: { code: "CONFLICT", field: "name" },
      } as never);
    });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("You already have a connection with this name");
    expect(text).not.toContain("This connection changed");
  });
});

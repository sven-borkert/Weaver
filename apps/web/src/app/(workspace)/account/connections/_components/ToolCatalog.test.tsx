import type { ReactNode } from "react";
import { act, create } from "react-test-renderer";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BulkReviewDialog,
  chunk,
  STATE_LABEL,
  TOOL_PAGE_SIZE,
  ToolCatalog,
  ToolTableRow,
} from "./ToolCatalog";

const mocked = vi.hoisted(() => ({
  mutate: vi.fn(),
  mutateAsync: vi.fn(),
  pending: false,
  options: undefined as
    | {
        onSuccess?: (saved: unknown[]) => void;
        onError?: (error: unknown) => void;
      }
    | undefined,
  invalidate: vi.fn(),
  fetchKeys: vi.fn(async () => ({ items: [] })),
  rows: null as unknown[] | null,
}));
vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({
      externalMcp: {
        invalidate: mocked.invalidate,
        toolKeys: { fetch: mocked.fetchKeys },
      },
    }),
    externalMcp: {
      tools: {
        useInfiniteQuery: () => ({
          data: {
            pages: [{ items: mocked.rows ?? [tool], nextCursor: null }],
          },
          isLoading: false,
          error: null,
          hasNextPage: false,
          isFetchingNextPage: false,
        }),
      },
      reviewTools: {
        useMutation: (options: typeof mocked.options) => {
          mocked.options = options;
          return {
            isPending: mocked.pending,
            mutate: mocked.mutate,
            mutateAsync: mocked.mutateAsync,
          };
        },
      },
    },
  },
}));
vi.mock("~/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
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
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const tool = {
  id: "11111111-1111-4111-8111-111111111111",
  connectionId: "22222222-2222-4222-8222-222222222222",
  remoteName: "nodes__list",
  description: "List Specified Nodes",
  presentInCatalog: true,
  reviewedRemoteDigest: null,
  discoveredRemoteDigest: "a".repeat(64),
  discoveredDefinition: { inputSchema: {}, supportStatus: { available: true } },
  effect: null,
  enabled: false,
};
const render = (row: Record<string, unknown> = tool) => {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <table>
        <tbody>
          <ToolTableRow tool={row as never} />
        </tbody>
      </table>,
    );
  });
  return renderer;
};

type Control = { onChange: (event: unknown) => void; checked?: boolean };
const control = (r: ReturnType<typeof create>, label: string) =>
  r.root.findByProps({ "aria-label": label }).props as Control;

beforeEach(() => {
  mocked.mutate.mockReset();
  mocked.mutateAsync.mockReset();
  vi.mocked(toast.error).mockReset();
  mocked.invalidate.mockReset();
});

describe("tool catalog table", () => {
  it("pages by 100, labels states, and chunks bulk work by 500", () => {
    expect(TOOL_PAGE_SIZE).toBe(100);
    expect(STATE_LABEL.new).toBe("New");
    expect(
      chunk(
        Array.from({ length: 1001 }, (_, i) => i),
        500,
      ).map((c) => c.length),
    ).toEqual([500, 500, 1]);
  });

  it("saves the checkbox immediately with the row digest", () => {
    const r = render();
    act(() => {
      control(r, "Enable nodes__list").onChange({
        target: { checked: true },
      });
    });
    expect(mocked.mutate).toHaveBeenCalledWith({
      connectionId: tool.connectionId,
      items: [
        {
          toolId: tool.id,
          expectedRemoteDigest: tool.discoveredRemoteDigest,
          enabled: true,
        },
      ],
    });
  });

  it("saves the effect select immediately", () => {
    const r = render();
    act(() => {
      control(r, "Effect of nodes__list").onChange({
        target: { value: "read" },
      });
    });
    expect(mocked.mutate).toHaveBeenCalledWith({
      connectionId: tool.connectionId,
      items: [
        {
          toolId: tool.id,
          expectedRemoteDigest: tool.discoveredRemoteDigest,
          effect: "read",
        },
      ],
    });
  });

  it("reverts the optimistic value and flags a conflict on CONFLICT", () => {
    const r = render();
    const box = () => control(r, "Enable nodes__list");
    act(() => {
      box().onChange({ target: { checked: true } });
    });
    expect(box().checked).toBe(true);
    act(() =>
      mocked.options!.onError!({
        message: "changed",
        data: { code: "CONFLICT" },
      }),
    );
    expect(box().checked).toBe(false);
    expect(JSON.stringify(r.toJSON())).toContain("Changed on server");
    expect(mocked.invalidate).toHaveBeenCalled();
  });

  it("disables controls for unavailable tools", () => {
    const r = render({ ...tool, presentInCatalog: false });
    expect(
      r.root.findByProps({ "aria-label": "Enable nodes__list" }).props.disabled,
    ).toBe(true);
    expect(
      r.root.findByProps({ "aria-label": "Effect of nodes__list" }).props
        .disabled,
    ).toBe(true);
  });
});

describe("bulk review dialog", () => {
  it("closes after a failed batch so a retry fetches fresh keys", async () => {
    mocked.mutateAsync
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("changed"));
    const onClose = vi.fn();
    const keys = Array.from({ length: 501 }, (_, i) => ({
      id: `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`,
      remoteName: `tool_${i}`,
      state: "reviewed",
      discoveredRemoteDigest: "a".repeat(64),
    }));
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <BulkReviewDialog
          connectionId={tool.connectionId}
          enabled
          keys={keys as never}
          onClose={onClose}
        />,
      );
    });
    const button = renderer.root.findAll(
      (node) => node.type === "button" && node.props.children === "Enable all",
    )[0]!.props as { onClick: () => void };
    await act(async () => {
      button.onClick();
    });
    expect(mocked.mutateAsync).toHaveBeenCalledTimes(2);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      expect.stringContaining("500 of 501"),
    );
    expect(onClose).toHaveBeenCalled();
  });
});

describe("Enable all read tools", () => {
  const quickAction = (totalTools: number) => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <ToolCatalog
          connectionId={tool.connectionId}
          totalTools={totalTools}
        />,
      );
    });
    return renderer.root
      .findAllByType("button")
      .find((node) =>
        JSON.stringify(node.props.children).includes("Enable all read tools"),
      )!;
  };

  it("stays available when the current filter shows no rows, unless the connection has no tools", () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    mocked.rows = [];
    try {
      expect(quickAction(3).props.disabled).toBe(false);
      expect(quickAction(0).props.disabled).toBe(true);
    } finally {
      mocked.rows = null;
      vi.unstubAllGlobals();
    }
  });

  it("collects the disabled read tools of the connection, ignoring the current filters", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const button = quickAction(1);
    await act(async () => {
      await (button.props as { onClick: () => Promise<void> }).onClick();
    });
    expect(mocked.fetchKeys).toHaveBeenCalledWith(
      {
        connectionId: tool.connectionId,
        search: undefined,
        reviewState: undefined,
        effect: "read",
        enabled: false,
        suggestedEffect: "read",
      },
      { staleTime: 0 },
    );
    vi.unstubAllGlobals();
  });
});

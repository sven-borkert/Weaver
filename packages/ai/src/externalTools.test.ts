import { afterEach, expect, it, vi } from "vitest";
import {
  FIND_EXTERNAL_TOOLS,
  createExternalToolkit,
  externalToolName,
  waitForExternalApproval,
} from "./externalTools";
import type { AvailableExternalTool } from "@weaver/core/externalMcp/types";
import type { ExternalToolSnapshot } from "@weaver/core/externalMcp/schema";
import { getExternalApproval } from "@weaver/core/services/externalMcp";
import type { ExternalRuntimeDeps } from "@weaver/core/externalMcp/types";
import type { UserSecurityContext } from "@weaver/core/security/context";
vi.mock("@weaver/core/services/externalMcp", () => ({
  getExternalApproval: vi.fn(),
}));
const deps = { now: () => new Date() } as ExternalRuntimeDeps;
const actor = {} as UserSecurityContext;
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});
it("uses stable provider-safe names", () => {
  expect(externalToolName("12345678-1234-4123-8123-123456789abc")).toBe(
    "ext_12345678123441238123123456789abc",
  );
});
it("polls an authorized pending approval until a decision", async () => {
  vi.useFakeTimers();
  vi.mocked(getExternalApproval)
    .mockResolvedValueOnce({ status: "pending" } as never)
    .mockResolvedValueOnce({ status: "approved" } as never);
  const pending = waitForExternalApproval(
    deps,
    actor,
    "approval",
    new AbortController().signal,
    new Date(Date.now() + 5000),
  );
  await vi.advanceTimersByTimeAsync(1000);
  await expect(pending).resolves.toBe("approved");
});
it("cancels a pending timer without another approval read", async () => {
  vi.useFakeTimers();
  vi.mocked(getExternalApproval).mockResolvedValue({
    status: "pending",
  } as never);
  const controller = new AbortController();
  const pending = waitForExternalApproval(
    deps,
    actor,
    "approval",
    controller.signal,
    new Date(Date.now() + 5000),
  );
  const assertion = expect(pending).rejects.toThrow("cancel wait");
  await vi.advanceTimersByTimeAsync(0);
  controller.abort(new Error("cancel wait"));
  await assertion;
  expect(vi.getTimerCount()).toBe(0);
});
it.each(["expired", "invalidated", "settled"])(
  "fails closed on %s approvals",
  async (status) => {
    vi.mocked(getExternalApproval).mockResolvedValue({ status } as never);
    await expect(
      waitForExternalApproval(
        deps,
        actor,
        "approval",
        new AbortController().signal,
        new Date(Date.now() + 5000),
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  },
);

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const available = (n: number, name: string): AvailableExternalTool => ({
  id: uuid(n),
  connectionId: uuid(900),
  name,
  description: `Tool ${name}`,
  effect: "read",
  inputSchema: { type: "object", properties: {} },
  configRevision: 3,
  reviewDigest: `digest-${n}`,
});
const snapshotOf = (t: AvailableExternalTool): ExternalToolSnapshot => ({
  connectionId: t.connectionId,
  toolId: t.id,
  configRevision: t.configRevision,
  toolDigest: t.reviewDigest,
});
const list = available(1, "list_applications");
const get = available(2, "get_application");
function toolkit(
  options: {
    reserveBytes?: number;
    stored?: ExternalToolSnapshot[];
    load?: (s: ExternalToolSnapshot[]) => Promise<{
      loaded: ExternalToolSnapshot[];
      refused: {
        toolId: string;
        reason: "UNKNOWN_TOOL" | "CHANGED" | "LIMIT_REACHED";
      }[];
    }>;
  } = {},
) {
  const load = vi.fn(
    options.load ??
      (async (snapshots: ExternalToolSnapshot[]) => ({
        loaded: snapshots,
        refused: [],
      })),
  );
  const kit = createExternalToolkit({
    deps,
    actor,
    run: { id: uuid(800), attemptId: uuid(801) },
    scope: {
      kind: "project",
      projectIds: [uuid(700)],
      documentId: null,
      tableId: null,
      resolvedAt: new Date(0).toISOString(),
      truncated: false,
    },
    available: {
      connections: [{ id: uuid(900), name: "Design Hub" }],
      tools: [list, get],
    },
    stored: options.stored ?? [],
    reserveBytes: options.reserveBytes ?? 100_000,
    load,
    collector: { externalSources: [] },
    onEvent: async () => undefined,
    signal: new AbortController().signal,
    deadline: new Date(Date.now() + 60_000),
  });
  const find = (input: Record<string, unknown>) =>
    kit.tools[FIND_EXTERNAL_TOOLS]!.execute!(input, {
      toolCallId: crypto.randomUUID(),
      messages: [],
    } as never) as Promise<Record<string, unknown>>;
  return { kit, find, load };
}

it("searches without loading", async () => {
  const { kit, find, load } = toolkit();
  const result = await find({ query: "applications" });
  expect(result.matches).toEqual([
    expect.objectContaining({
      name: externalToolName(list.id),
      tool: "list_applications",
      connection: "Design Hub",
      loaded: false,
    }),
  ]);
  expect(result.totalMatches).toBe(1);
  expect(load).not.toHaveBeenCalled();
  expect(kit.activeToolNames()).toEqual([FIND_EXTERNAL_TOOLS]);
});

it("loads named tools for later steps", async () => {
  const { kit, find, load } = toolkit();
  expect(kit.tools[externalToolName(list.id)]).toBeUndefined();
  const result = await find({ load: [externalToolName(list.id)] });
  expect(kit.tools[externalToolName(list.id)]).toBeDefined();
  expect(result.loaded).toEqual([externalToolName(list.id)]);
  expect(load).toHaveBeenCalledWith([snapshotOf(list)]);
  expect(kit.activeToolNames()).toEqual([
    FIND_EXTERNAL_TOOLS,
    externalToolName(list.id),
  ]);
  expect(kit.loadedAny()).toBe(true);
});

it("refuses unknown names and tools over the reserve without loading them", async () => {
  const bytes = Buffer.byteLength(
    JSON.stringify({
      name: externalToolName(list.id),
      description: list.description,
      inputSchema: list.inputSchema,
    }),
  );
  const { find, load } = toolkit({ reserveBytes: bytes + 1 });
  const result = await find({
    load: [
      externalToolName(list.id),
      externalToolName(get.id),
      `ext_${"f".repeat(32)}`,
    ],
  });
  expect(result.loaded).toEqual([externalToolName(list.id)]);
  expect(result.refused).toEqual([
    { name: externalToolName(get.id), reason: "BUDGET_EXCEEDED" },
    { name: `ext_${"f".repeat(32)}`, reason: "UNKNOWN_TOOL" },
  ]);
  expect(load).toHaveBeenCalledWith([snapshotOf(list)]);
});

it("keeps loader refusals inactive", async () => {
  const { kit, find } = toolkit({
    load: async (snapshots) => ({
      loaded: [],
      refused: snapshots.map((s) => ({
        toolId: s.toolId,
        reason: "LIMIT_REACHED" as const,
      })),
    }),
  });
  const result = await find({ load: [externalToolName(list.id)] });
  expect(result.refused).toEqual([
    { name: externalToolName(list.id), reason: "LIMIT_REACHED" },
  ]);
  expect(kit.activeToolNames()).toEqual([FIND_EXTERNAL_TOOLS]);
});

it("serializes concurrent loads so the reserve holds", async () => {
  const bytes = Buffer.byteLength(
    JSON.stringify({
      name: externalToolName(list.id),
      description: list.description,
      inputSchema: list.inputSchema,
    }),
  );
  const { kit, find } = toolkit({
    reserveBytes: bytes + 1,
    load: async (snapshots) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { loaded: snapshots, refused: [] };
    },
  });
  await Promise.all([
    find({ load: [externalToolName(list.id)] }),
    find({ load: [externalToolName(get.id)] }),
  ]);
  expect(kit.activeToolNames()).toHaveLength(2);
});

it("reactivates stored snapshots that still match and drops stale ones", () => {
  const { kit } = toolkit({
    stored: [snapshotOf(list), { ...snapshotOf(get), configRevision: 2 }],
  });
  expect(kit.activeToolNames()).toEqual([
    FIND_EXTERNAL_TOOLS,
    externalToolName(list.id),
  ]);
});

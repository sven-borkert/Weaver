import { afterEach, describe, expect, it, vi } from "vitest";
import { defineTool, type ToolContext } from "@weaver/assistant-tools/contract";
import { DEFAULT_DIAGNOSTICS_SETTINGS } from "@weaver/core/diagnostics/settings";
import {
  flushDiagnostics,
  startDiagnosticWriter,
  stopDiagnosticWriter,
  waitForDiagnosticWriterReady,
} from "@weaver/core/diagnostics/writer";
import { CoreError } from "@weaver/core/errors";
import {
  invalidateDiagnosticsSettingsCache,
  primeDiagnosticsSettingsCache,
} from "@weaver/core/services/diagnosticsSettings";
import type { Prisma, PrismaClient } from "@weaver/db/client";
import { z } from "zod";
import { citationResource } from "./resources";
import { readOneNoteTool } from "@weaver/assistant-tools/tools/artifactsNotebook";
import {
  citationLinks,
  executeContract,
  jsonSafeOutput,
  registerContractTools,
} from "./tools";

const ctxStub = {} as ToolContext;

function deps(overrides: Partial<Parameters<typeof executeContract>[3]> = {}) {
  return {
    context: async () => ctxStub,
    toolTimeoutMs: 1_000,
    onAudit: vi.fn(async () => true),
    ...overrides,
  };
}

type DiagnosticRow = Prisma.DiagnosticEventCreateManyInput;

async function captureDiagnostics(run: () => Promise<void>) {
  const rows: DiagnosticRow[] = [];
  const db = {
    diagnosticEvent: {
      createMany: vi.fn(async ({ data }: { data: DiagnosticRow[] }) => {
        rows.push(...data);
        return { count: data.length };
      }),
    },
  } as unknown as PrismaClient;
  primeDiagnosticsSettingsCache({
    ...DEFAULT_DIAGNOSTICS_SETTINGS,
    level: "standard",
  });
  startDiagnosticWriter({ db, runtime: "mcp", flushIntervalMs: 60_000 });
  await waitForDiagnosticWriterReady();
  await run();
  await flushDiagnostics(true);
  return rows;
}

afterEach(async () => {
  await stopDiagnosticWriter();
  invalidateDiagnosticsSettingsCache();
});

describe("tool adapter (spec §26.2 item 8, a4b5fae)", () => {
  it("turns Dates into JSON and mirrors the value as text", () => {
    const safe = jsonSafeOutput({
      when: new Date("2026-01-01T00:00:00.000Z"),
      n: 1,
    });
    expect(safe.value).toEqual({ when: "2026-01-01T00:00:00.000Z", n: 1 });
    expect(JSON.parse(safe.text)).toEqual(safe.value);
  });

  it("clamps oversized outputs to the shared tool budget", () => {
    const safe = jsonSafeOutput({
      text: '\\\"'.repeat(20_000),
    });
    expect(safe.value).toMatchObject({ truncated: true });
    expect(safe.text.length).toBeLessThanOrEqual(16_000);
    expect(JSON.stringify(safe.value).length).toBeLessThanOrEqual(16_000);
    expect(safe.text).toBe(JSON.stringify(safe.value));
  });

  it("clamps by UTF-8 bytes rather than characters", () => {
    const safe = jsonSafeOutput({ text: "漢".repeat(15_900) });
    expect(safe.value).toMatchObject({ truncated: true });
    expect(Buffer.byteLength(safe.text)).toBeLessThanOrEqual(16_000);
  });

  it("reports a busy reader as TOO_MANY_REQUESTS and audits it as an error", async () => {
    const tool = defineTool({
      name: "busy",
      kind: "read",
      capability: "content:read",
      description: "busy",
      inputSchema: z.object({}),
      async execute() {
        throw new CoreError("TOO_MANY_REQUESTS", "reader queue full");
      },
    });
    const d = deps();
    const result = await executeContract(
      tool,
      {},
      new AbortController().signal,
      d,
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: {
        code: "TOO_MANY_REQUESTS",
        message: "too many file reads are in progress; try again shortly",
      },
    });
    expect(d.onAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "error",
        errorCode: "TOO_MANY_REQUESTS",
      }),
    );
  });

  it("bounds final text and structured content after wrapper escaping", async () => {
    const tool = defineTool({
      name: "large_output",
      kind: "read",
      capability: "content:read",
      description: "large",
      inputSchema: z.object({}),
      async execute() {
        return { output: { text: '\\\"'.repeat(20_000) } };
      },
    });

    const result = await executeContract(
      tool,
      {},
      new AbortController().signal,
      deps(),
    );

    const first = result.content[0];
    expect(first?.type).toBe("text");
    if (first?.type !== "text") throw new Error("expected text content");
    expect(first.text.length).toBeLessThanOrEqual(16_000);
    expect(JSON.stringify(result.structuredContent).length).toBeLessThanOrEqual(
      16_000,
    );
    expect(first.text).toBe(JSON.stringify(result.structuredContent));
  });

  it("maps citations to weaver:// resource links without duplicates, including an aggregate deduping against its table", () => {
    expect(
      citationResource({
        kind: "aggregate",
        projectId: "11111111-1111-4111-8111-111111111111",
        tableId: "33333333-3333-4333-8333-333333333333",
        commitSha: "abcdef1",
        columnIds: [],
        query: { filters: [], groupBy: [], aggregates: [{ fn: "count" }] },
      }),
    ).toEqual({
      kind: "table",
      projectId: "11111111-1111-4111-8111-111111111111",
      tableId: "33333333-3333-4333-8333-333333333333",
    });
    const links = citationLinks([
      {
        kind: "document",
        projectId: "11111111-1111-4111-8111-111111111111",
        documentId: "22222222-2222-4222-8222-222222222222",
        commitSha: "abcdef1",
        headingPath: [],
        excerpt: null,
      },
      {
        kind: "document",
        projectId: "11111111-1111-4111-8111-111111111111",
        documentId: "22222222-2222-4222-8222-222222222222",
        commitSha: "abcdef1",
        headingPath: ["A"],
        excerpt: null,
      },
      {
        kind: "table",
        projectId: "11111111-1111-4111-8111-111111111111",
        tableId: "33333333-3333-4333-8333-333333333333",
        commitSha: "abcdef1",
        rowIds: [],
        columnIds: [],
      },
      {
        // An aggregate's citation points at the same table URI as the
        // "table" citation above — it must collapse into it, not add a
        // second link.
        kind: "aggregate",
        projectId: "11111111-1111-4111-8111-111111111111",
        tableId: "33333333-3333-4333-8333-333333333333",
        commitSha: "abcdef1",
        columnIds: [],
        query: { filters: [], groupBy: [], aggregates: [{ fn: "count" }] },
      },
      {
        kind: "graph",
        projectId: "11111111-1111-4111-8111-111111111111",
        entityId: "44444444-4444-4444-8444-444444444444",
        documentId: null,
        commitSha: null,
        excerpt: null,
      },
      {
        kind: "search",
        projectId: "11111111-1111-4111-8111-111111111111",
        resourceType: "table",
        resourceId: "33333333-3333-4333-8333-333333333333",
        commitSha: "abcdef1",
        excerpt: null,
        score: 1,
      },
    ]);
    expect(links.map((l) => l.uri)).toEqual([
      "weaver://projects/11111111-1111-4111-8111-111111111111/documents/22222222-2222-4222-8222-222222222222",
      "weaver://projects/11111111-1111-4111-8111-111111111111/tables/33333333-3333-4333-8333-333333333333",
      "weaver://projects/11111111-1111-4111-8111-111111111111/entities/44444444-4444-4444-8444-444444444444",
    ]);
    expect(links[0]).toMatchObject({
      type: "resource_link",
      mimeType: "text/markdown",
    });
  });

  it("returns structured output plus links and audits success", async () => {
    const tool = defineTool({
      name: "echo",
      kind: "read",
      capability: "content:read",
      description: "echo",
      inputSchema: z.object({ projectId: z.string() }),
      async execute(input) {
        return {
          output: {
            projectId: input.projectId,
            at: new Date("2026-01-01T00:00:00.000Z"),
          },
          citations: [
            {
              kind: "document",
              projectId: input.projectId,
              documentId: "22222222-2222-4222-8222-222222222222",
              commitSha: "abcdef1",
              headingPath: [],
              excerpt: null,
            },
          ],
        };
      },
    });
    const d = deps();
    const result = await executeContract(
      tool,
      { projectId: "p1" },
      new AbortController().signal,
      d,
    );
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      projectId: "p1",
      at: "2026-01-01T00:00:00.000Z",
    });
    expect(result.content[0]).toEqual({
      type: "text",
      text: JSON.stringify({
        projectId: "p1",
        at: "2026-01-01T00:00:00.000Z",
      }),
    });
    expect(result.content[1]).toMatchObject({ type: "resource_link" });
    expect(d.onAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "echo",
        projectId: "p1",
        outcome: "ok",
        errorCode: null,
        commitSha: null,
      }),
    );
  });

  it("correlates a successful validated project tool without copying arguments", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const privateMarker = "PROJECT-TOOL-ARGUMENT-MUST-NOT-PERSIST";
    const tool = defineTool({
      name: "project_echo",
      kind: "read",
      capability: "content:read",
      description: "echo",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        privateMarker: z.string(),
      }),
      async execute() {
        return { output: { ok: true } };
      },
    });

    const rows = await captureDiagnostics(async () => {
      await executeContract(
        tool,
        { projectId, privateMarker },
        new AbortController().signal,
        deps(),
      );
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: "mcp.tool.called",
      projectId,
      outcome: "ok",
      details: { tool: "project_echo", kind: "read" },
    });
    expect(JSON.stringify(rows[0])).not.toContain(privateMarker);
  });

  it("correlates a failed validated project tool without copying its error", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const privateMarker = "PROJECT-TOOL-ERROR-MUST-NOT-PERSIST";
    const tool = defineTool({
      name: "project_failure",
      kind: "read",
      capability: "content:read",
      description: "failure",
      inputSchema: z.object({ projectId: z.string().uuid() }),
      async execute() {
        throw new CoreError("NOT_FOUND", privateMarker);
      },
    });

    const rows = await captureDiagnostics(async () => {
      await executeContract(
        tool,
        { projectId },
        new AbortController().signal,
        deps(),
      );
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: "mcp.tool.called",
      projectId,
      outcome: "error",
      details: { tool: "project_failure", kind: "read", code: "NOT_FOUND" },
    });
    expect(JSON.stringify(rows[0])).not.toContain(privateMarker);
  });

  it("does not emit tool or admin diagnostics after losing audit ownership", async () => {
    const tool = defineTool({
      name: "admin_probe",
      kind: "read",
      capability: "system:admin",
      description: "admin",
      inputSchema: z.object({ safeName: z.string() }),
      async execute() {
        return { output: { ok: true } };
      },
    });

    const rows = await captureDiagnostics(async () => {
      await executeContract(
        tool,
        { safeName: "value-must-not-persist" },
        new AbortController().signal,
        deps({ onAudit: vi.fn(async () => false) }),
      );
    });

    expect(rows).toEqual([]);
  });

  it("reports tool failures as isError results with stable codes and audits them", async () => {
    const tool = defineTool({
      name: "missing",
      kind: "read",
      capability: "content:read",
      description: "missing",
      inputSchema: z.object({}),
      async execute() {
        throw new CoreError("NOT_FOUND");
      },
    });
    const d = deps();
    const result = await executeContract(
      tool,
      {},
      new AbortController().signal,
      d,
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: { code: "NOT_FOUND", message: "not found or not accessible" },
    });
    expect(d.onAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "error", errorCode: "NOT_FOUND" }),
    );
  });

  it("forwards an allowlisted structured reason to the model (spec §9)", async () => {
    const tool = defineTool({
      name: "bad_cursor",
      kind: "read",
      capability: "content:read",
      description: "bad cursor",
      inputSchema: z.object({}),
      async execute() {
        throw new CoreError("BAD_REQUEST", "bad cursor", {
          reason: "INVALID_CURSOR",
        });
      },
    });
    const result = await executeContract(
      tool,
      {},
      new AbortController().signal,
      deps(),
    );
    expect(result.structuredContent).toEqual({
      error: {
        code: "BAD_REQUEST",
        message: "bad cursor",
        reason: "INVALID_CURSOR",
      },
    });
  });

  it("omits reason for an error whose reason is not allowlisted", async () => {
    const tool = defineTool({
      name: "no_reason",
      kind: "read",
      capability: "content:read",
      description: "no reason",
      inputSchema: z.object({}),
      async execute() {
        throw new CoreError("BAD_REQUEST", "x", { reason: "SOMETHING_ELSE" });
      },
    });
    const result = await executeContract(
      tool,
      {},
      new AbortController().signal,
      deps(),
    );
    expect(result.structuredContent).toEqual({
      error: { code: "BAD_REQUEST", message: "x" },
    });
  });

  it("records authorization failures as denied without changing the stable tool error", async () => {
    const tool = defineTool({
      name: "forbidden",
      kind: "read",
      capability: "content:read",
      description: "forbidden",
      inputSchema: z.object({}),
      async execute() {
        throw new CoreError("FORBIDDEN");
      },
    });
    const d = deps();

    const result = await executeContract(
      tool,
      {},
      new AbortController().signal,
      d,
    );

    expect(result.structuredContent).toEqual({
      error: { code: "FORBIDDEN", message: "not permitted" },
    });
    expect(d.onAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "denied", errorCode: "FORBIDDEN" }),
    );
  });

  it("cancels a tool that ignores its signal and outlives the timeout", async () => {
    const tool = defineTool({
      name: "slow",
      kind: "read",
      capability: "content:read",
      description: "slow",
      inputSchema: z.object({}),
      execute() {
        return new Promise<never>(() => undefined);
      },
    });
    const d = deps({ toolTimeoutMs: 20 });
    const result = await executeContract(
      tool,
      {},
      new AbortController().signal,
      d,
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "CANCELLED" },
    });
  });

  it("does not enter a write executor when the request is already aborted", async () => {
    const execute = vi.fn(async () => ({ output: { committed: true } }));
    const tool = defineTool({
      name: "write_thing",
      kind: "write",
      capability: "content:write",
      description: "write",
      inputSchema: z.object({ projectId: z.string() }),
      execute,
    });
    const controller = new AbortController();
    controller.abort();
    const d = deps();

    const result = await executeContract(
      tool,
      { projectId: "p1" },
      controller.signal,
      d,
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({
      error: { code: "CANCELLED" },
    });
    expect(d.onAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "error", errorCode: "CANCELLED" }),
    );
  });

  it("awaits an admitted write after cancellation instead of reporting a false terminal result", async () => {
    let markAdmitted!: () => void;
    const admitted = new Promise<void>((resolve) => {
      markAdmitted = resolve;
    });
    let finishWrite!: () => void;
    const finish = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    const tool = defineTool({
      name: "write_thing",
      kind: "write",
      capability: "content:write",
      description: "write",
      inputSchema: z.object({ projectId: z.string() }),
      async execute(input) {
        markAdmitted();
        await finish;
        return {
          output: { projectId: input.projectId, commitSha: "a".repeat(40) },
        };
      },
    });
    const controller = new AbortController();
    const d = deps();
    const pending = executeContract(
      tool,
      { projectId: "p1" },
      controller.signal,
      d,
    );

    await admitted;
    controller.abort();
    let settled = false;
    void pending.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    finishWrite();
    const result = await pending;
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      commitSha: "a".repeat(40),
    });
    expect(d.onAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "ok", commitSha: "a".repeat(40) }),
    );
  });

  it("records the commit of a write result", async () => {
    const tool = defineTool({
      name: "write_thing",
      kind: "write",
      capability: "content:write",
      description: "w",
      inputSchema: z.object({ projectId: z.string() }),
      async execute(input) {
        return {
          output: {
            projectId: input.projectId,
            commitSha: "a".repeat(40),
            replayed: false,
          },
        };
      },
    });
    const d = deps();
    await executeContract(
      tool,
      { projectId: "p1" },
      new AbortController().signal,
      d,
    );
    expect(d.onAudit).toHaveBeenCalledWith(
      expect.objectContaining({ commitSha: "a".repeat(40) }),
    );
  });
});

describe("registerContractTools annotations", () => {
  function registered(
    contract: Parameters<typeof registerContractTools>[1][number],
  ) {
    const calls: Array<{ name: string; config: { annotations?: unknown } }> =
      [];
    const server = {
      registerTool: (name: string, config: { annotations?: unknown }) => {
        calls.push({ name, config });
      },
    } as unknown as Parameters<typeof registerContractTools>[0];
    registerContractTools(server, [contract], deps());
    expect(calls[0]!.config).not.toHaveProperty("title");
    return calls[0]!.config.annotations;
  }
  const base = {
    description: "d",
    capability: "content:read" as const,
    inputSchema: z.object({}),
    execute: async () => ({ output: null }),
  };

  it("derives the hints from the kind", () => {
    expect(
      registered(defineTool({ ...base, name: "r", kind: "read" })),
    ).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(
      registered(defineTool({ ...base, name: "w", kind: "write" })),
    ).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("lets a contract override the derived hints", () => {
    expect(
      registered(
        defineTool({
          ...base,
          name: "read_onenote",
          kind: "read",
          annotations: { readOnlyHint: false, idempotentHint: true },
        }),
      ),
    ).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("advertises read_onenote as not read-only, since it enqueues preparation", () => {
    expect(readOneNoteTool.annotations).toEqual({
      readOnlyHint: false,
      idempotentHint: true,
    });
    expect(registered(readOneNoteTool)).toMatchObject({ readOnlyHint: false });
  });
});

import type {
  CallToolResult,
  McpServer,
  ServerContext,
} from "@modelcontextprotocol/server";
import { defineTool, type ToolContext } from "@weaver/assistant-tools/contract";
import { DEFAULT_DIAGNOSTICS_SETTINGS } from "@weaver/core/diagnostics/settings";
import {
  flushDiagnostics,
  startDiagnosticWriter,
  stopDiagnosticWriter,
  waitForDiagnosticWriterReady,
} from "@weaver/core/diagnostics/writer";
import type { InboundExternalTool } from "@weaver/core/externalMcp/types";
import {
  invalidateDiagnosticsSettingsCache,
  primeDiagnosticsSettingsCache,
} from "@weaver/core/services/diagnosticsSettings";
import type { Prisma, PrismaClient } from "@weaver/db/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  innerToolArguments,
  innerToolName,
  isMetaToolName,
  registerMetaTools,
  searchCatalogue,
  type CatalogueEntry,
  type MetaToolDeps,
} from "./metaTools";

describe("meta-tool helpers", () => {
  it("ranks name matches above description matches and keeps catalogue order on ties", () => {
    const entries: CatalogueEntry[] = [
      {
        name: "read_document",
        description: "Reads a document",
        toolsets: ["core", "documents"],
        kind: "read",
        listed: true,
      },
      {
        name: "search_knowledge",
        description: "Hybrid search across documents",
        toolsets: ["core", "graph"],
        kind: "read",
        listed: true,
      },
      {
        name: "list_tables",
        description: "List tables",
        toolsets: ["core", "tables"],
        kind: "read",
        listed: true,
      },
    ];
    expect(
      searchCatalogue(entries, "document", 10).tools.map((t) => t.name),
    ).toEqual(["read_document", "search_knowledge"]);
    expect(
      searchCatalogue(entries, "tables", 10).tools.map((t) => t.name),
    ).toEqual(["list_tables"]);
    expect(searchCatalogue(entries, undefined, 2)).toMatchObject({
      hasMore: true,
    });
    expect(
      searchCatalogue(entries, undefined, 2).tools.map((t) => t.name),
    ).toEqual(["read_document", "search_knowledge"]);
    expect(searchCatalogue(entries, "zzz", 10).tools).toEqual([]);
  });

  it("clamps descriptions to 300 characters", () => {
    const [entry] = searchCatalogue(
      [
        {
          name: "long",
          description: "x".repeat(400),
          toolsets: [],
          kind: "read",
          listed: false,
        },
      ],
      undefined,
      10,
    ).tools;
    expect(entry!.description).toHaveLength(300);
  });

  it("extracts the inner tool name and arguments defensively", () => {
    expect(innerToolName({ name: "read_document" })).toBe("read_document");
    expect(innerToolName({ name: 7 })).toBeNull();
    expect(innerToolArguments({ arguments: { a: 1 } })).toEqual({ a: 1 });
    expect(innerToolArguments({ arguments: [1] })).toEqual({});
    expect(isMetaToolName("call_tool")).toBe(true);
    expect(isMetaToolName("read_document")).toBe(false);
  });
});

type Handler = (args: unknown, ctx: ServerContext) => Promise<CallToolResult>;
type Registered = {
  name: string;
  config: Record<string, unknown>;
  handler: Handler;
};

const readExecute = vi.fn(async (input: { projectId: string }) => ({
  output: { projectId: input.projectId, read: true },
}));
const readDocument = defineTool({
  name: "read_document",
  kind: "read",
  capability: "content:read",
  description: "Read a document",
  inputSchema: z.object({ projectId: z.string() }),
  execute: readExecute,
});
const writeExecute = vi.fn(async () => ({
  output: { commitSha: "a".repeat(40) },
}));
const createTable = defineTool({
  name: "create_table",
  kind: "write",
  capability: "content:write",
  description: "Create a table",
  inputSchema: z.object({ projectId: z.string() }),
  execute: writeExecute,
});
const externalTool: InboundExternalTool = {
  name: "ext_crm__find_contact",
  toolId: "t1",
  connectionId: "c1",
  connectionName: "crm",
  remoteName: "find_contact",
  description: "Find a CRM contact",
  effect: "read",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
  configRevision: 1,
  reviewDigest: "d",
  timeoutMs: 1_000,
};

function setup(overrides: Partial<MetaToolDeps> = {}) {
  const registered: Registered[] = [];
  const server = {
    registerTool: (
      name: string,
      config: Record<string, unknown>,
      handler: Handler,
    ) => {
      registered.push({ name, config, handler });
    },
  } as unknown as McpServer;
  const onAudit = vi.fn(async () => true);
  const call = vi.fn(async () => ({
    callId: "call-1",
    status: "completed" as const,
    output: { content: [{ type: "text", text: "found" }] },
    source: null,
    error: null,
  }));
  const deps: MetaToolDeps = {
    contracts: [readDocument, createTable],
    external: [externalTool],
    listed: new Set(["read_document"]),
    activeToolsets: ["core"],
    tool: {
      context: async () => ({}) as ToolContext,
      toolTimeoutMs: 1_000,
      onAudit,
    },
    externalDeps: { call, onAudit },
    ...overrides,
  };
  registerMetaTools(server, deps);
  const ctx = {
    mcpReq: { signal: new AbortController().signal },
  } as unknown as ServerContext;
  // Parse first, as the SDK does before calling a handler.
  const invoke = async (name: string, args: unknown) => {
    const tool = registered.find((r) => r.name === name)!;
    const parsed = await (tool.config.inputSchema as z.ZodType).parseAsync(
      args,
    );
    return tool.handler(parsed, ctx);
  };
  return { registered, invoke, onAudit, call };
}

const REFUSAL = {
  isError: true,
  content: [
    { type: "text", text: "NOT_FOUND: tool not found or not accessible" },
  ],
  structuredContent: {
    error: { code: "NOT_FOUND", message: "tool not found or not accessible" },
  },
};

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
  vi.clearAllMocks();
});

describe("registerMetaTools", () => {
  it("registers the three meta-tools in order with their hints and no title", () => {
    const { registered } = setup();
    expect(registered.map((r) => r.name)).toEqual([
      "search_tools",
      "describe_tool",
      "call_tool",
    ]);
    for (const r of registered) {
      expect(r.config).not.toHaveProperty("title");
      expect((r.config.description as string).length).toBeLessThanOrEqual(300);
    }
    expect(registered[0]!.config.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(registered[2]!.config.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it("searches the permitted catalogue, contracts first, with external entries", async () => {
    const { invoke, onAudit } = setup();
    const result = await invoke("search_tools", {});
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      tools: [
        {
          name: "read_document",
          description: "Read a document",
          toolsets: ["core", "documents"],
          kind: "read",
          listed: true,
        },
        {
          name: "create_table",
          description: "Create a table",
          toolsets: ["write"],
          kind: "write",
          listed: false,
        },
        {
          name: "ext_crm__find_contact",
          description: "Find a CRM contact",
          toolsets: ["external"],
          kind: "external",
          listed: false,
          connection: "crm",
        },
      ],
      activeToolsets: ["core"],
      availableToolsets: [
        "documents",
        "tables",
        "files",
        "graph",
        "write",
        "exams",
        "wiki",
        "connections",
        "admin",
        "external",
      ],
      hasMore: false,
    });
    expect(onAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "search_tools",
        outcome: "ok",
        projectId: null,
      }),
    );
  });

  it("filters by toolset, treating all as no filter", async () => {
    const { invoke } = setup();
    const names = async (toolset: string) =>
      (
        (await invoke("search_tools", { toolset })).structuredContent as {
          tools: { name: string }[];
        }
      ).tools.map((t) => t.name);
    expect(await names("write")).toEqual(["create_table"]);
    expect(await names("external")).toEqual(["ext_crm__find_contact"]);
    expect(await names("all")).toHaveLength(3);
  });

  it("describes a contract and an external tool", async () => {
    const { invoke, onAudit } = setup();
    const contract = await invoke("describe_tool", { name: "read_document" });
    expect(contract.structuredContent).toMatchObject({
      name: "read_document",
      description: "Read a document",
      inputSchema: { type: "object", required: ["projectId"] },
      annotations: { readOnlyHint: true, destructiveHint: false },
      toolsets: ["core", "documents"],
      kind: "read",
      listed: true,
    });
    const external = await invoke("describe_tool", {
      name: "ext_crm__find_contact",
    });
    expect(external.structuredContent).toEqual({
      name: "ext_crm__find_contact",
      description: "Find a CRM contact",
      inputSchema: externalTool.inputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      toolsets: ["external"],
      kind: "external",
      listed: false,
      connection: "crm",
    });
    expect(onAudit).toHaveBeenCalledWith(
      expect.objectContaining({ name: "describe_tool", outcome: "ok" }),
    );
  });

  it("refuses unknown, meta and unpermitted names identically", async () => {
    const { invoke, onAudit } = setup();
    for (const tool of ["describe_tool", "call_tool"]) {
      for (const name of ["nope", "call_tool", "list_diagnostic_events"]) {
        expect(await invoke(tool, { name, arguments: {} })).toEqual(REFUSAL);
        expect(onAudit).toHaveBeenLastCalledWith(
          expect.objectContaining({
            name: tool,
            projectId: null,
            outcome: "error",
            errorCode: "NOT_FOUND",
            commitSha: null,
          }),
        );
      }
    }
  });

  it("rejects invalid inner arguments without running the tool, audited under the inner name", async () => {
    const { invoke, onAudit } = setup();
    let result: CallToolResult | undefined;
    const rows = await captureDiagnostics(async () => {
      result = await invoke("call_tool", {
        name: "read_document",
        arguments: { projectId: 7 },
      });
    });
    expect(result!.isError).toBe(true);
    expect(result!.structuredContent).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect(
      (result!.structuredContent as { error: { message: string } }).error
        .message,
    ).toMatch(/^invalid tool arguments: /);
    expect(readExecute).not.toHaveBeenCalled();
    expect(onAudit).toHaveBeenCalledTimes(1);
    expect(onAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "read_document",
        outcome: "error",
        errorCode: "BAD_REQUEST",
        projectId: null,
      }),
    );
    expect(rows).toEqual([
      expect.objectContaining({
        event: "mcp.tool.called",
        outcome: "error",
        details: {
          tool: "read_document",
          kind: "read",
          code: "BAD_REQUEST",
          via: "call_tool",
        },
      }),
    ]);
  });

  it("emits a meta diagnostic for each meta-tool outcome, uniform for refusals", async () => {
    const { invoke } = setup();
    const rows = await captureDiagnostics(async () => {
      await invoke("search_tools", {});
      await invoke("describe_tool", { name: "read_document" });
      await invoke("describe_tool", { name: "list_diagnostic_events" });
      await invoke("call_tool", { name: "list_diagnostic_events" });
      await invoke("call_tool", { name: "nope" });
    });
    expect(rows.map((row) => row.details)).toEqual([
      { tool: "search_tools", kind: "meta" },
      { tool: "describe_tool", kind: "meta" },
      { tool: "describe_tool", kind: "meta", code: "NOT_FOUND" },
      { tool: "call_tool", kind: "meta", code: "NOT_FOUND" },
      { tool: "call_tool", kind: "meta", code: "NOT_FOUND" },
    ]);
    expect(rows.map((row) => row.event)).toEqual(
      Array(5).fill("mcp.tool.called"),
    );
  });

  it("emits no diagnostic when another callback owns the audit slot", async () => {
    const { invoke, onAudit } = setup();
    onAudit.mockResolvedValue(false);
    const rows = await captureDiagnostics(async () => {
      await invoke("search_tools", {});
      await invoke("call_tool", { name: "read_document", arguments: {} });
    });
    expect(rows).toEqual([]);
  });

  it("runs the inner contract and audits it under its own name with via", async () => {
    const { invoke, onAudit } = setup();
    let result: CallToolResult | undefined;
    const rows = await captureDiagnostics(async () => {
      result = await invoke("call_tool", {
        name: "read_document",
        arguments: { projectId: "p1" },
      });
    });
    expect(result!.structuredContent).toEqual({ projectId: "p1", read: true });
    expect(onAudit).toHaveBeenCalledTimes(1);
    expect(onAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "read_document",
        projectId: "p1",
        outcome: "ok",
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: "mcp.tool.called",
      details: { tool: "read_document", kind: "read", via: "call_tool" },
    });
  });

  it("runs a write contract on the shielded write signal", async () => {
    const write = new AbortController();
    write.abort();
    const { invoke } = setup({
      tool: {
        context: async () => ({}) as ToolContext,
        toolTimeoutMs: 1_000,
        writeRequestSignal: write.signal,
        onAudit: vi.fn(async () => true),
      },
    });
    const result = await invoke("call_tool", {
      name: "create_table",
      arguments: { projectId: "p1" },
    });
    expect(result.structuredContent).toMatchObject({
      error: { code: "CANCELLED" },
    });
    expect(writeExecute).not.toHaveBeenCalled();
  });

  it("forwards an external tool through its dependency with via", async () => {
    const { invoke, call, onAudit } = setup();
    let result: CallToolResult | undefined;
    const rows = await captureDiagnostics(async () => {
      result = await invoke("call_tool", {
        name: "ext_crm__find_contact",
        arguments: { q: "ada" },
      });
    });
    expect(result!.content).toEqual([{ type: "text", text: "found" }]);
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ tool: externalTool, arguments: { q: "ada" } }),
    );
    expect(onAudit).toHaveBeenCalledWith(
      expect.objectContaining({ name: "ext_crm__find_contact", outcome: "ok" }),
    );
    expect(rows[0]).toMatchObject({
      details: { tool: "ext_crm__find_contact", via: "call_tool" },
    });
  });

  it("refuses an external tool when no external dependency is wired", async () => {
    const { invoke } = setup({ externalDeps: undefined });
    expect(
      await invoke("call_tool", { name: "ext_crm__find_contact" }),
    ).toEqual(REFUSAL);
  });
});

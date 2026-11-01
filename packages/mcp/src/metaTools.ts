import type {
  CallToolResult,
  McpServer,
  ServerContext,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import {
  clampText,
  type AnyToolContract,
} from "@weaver/assistant-tools/contract";
import {
  MCP_TOOLSET_NAMES,
  type McpToolsetName,
} from "@weaver/assistant-tools/toolsetNames";
import { toolsetsOf } from "@weaver/assistant-tools/toolsets";
import type { InboundExternalTool } from "@weaver/core/externalMcp/types";
import { z } from "zod";
import {
  executeExternal,
  externalAnnotations,
  type ExternalToolDeps,
} from "./externalTools";
import {
  contractAnnotations,
  contractJsonSchema,
  emitMcpToolDiagnostic,
  executeContract,
  jsonSafeOutput,
  type ToolAuditEvent,
  type ToolDeps,
} from "./tools";

export const META_TOOL_NAMES = [
  "search_tools",
  "describe_tool",
  "call_tool",
] as const;
type MetaToolName = (typeof META_TOOL_NAMES)[number];

export function isMetaToolName(name: string): name is MetaToolName {
  return (META_TOOL_NAMES as readonly string[]).includes(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function innerToolName(args: unknown): string | null {
  return isRecord(args) && typeof args.name === "string" ? args.name : null;
}

export function innerToolArguments(args: unknown): Record<string, unknown> {
  return isRecord(args) && isRecord(args.arguments) ? args.arguments : {};
}

export type CatalogueEntry = {
  name: string;
  description: string;
  toolsets: McpToolsetName[];
  kind: "read" | "write" | "external";
  listed: boolean;
  connection?: string;
};

const MAX_SEARCH_DESCRIPTION_CHARS = 300;

export function searchCatalogue(
  entries: readonly CatalogueEntry[],
  query: string | undefined,
  limit: number,
): { tools: CatalogueEntry[]; hasMore: boolean } {
  const tokens = (query ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const scored = entries.map((entry) => {
    const name = entry.name.toLowerCase();
    const description = entry.description.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (name.includes(token)) score += 3;
      if (entry.toolsets.some((toolset) => toolset === token)) score += 2;
      if (description.includes(token)) score += 1;
    }
    return { entry, score };
  });
  const matches = tokens.length
    ? scored.filter((item) => item.score > 0).sort((a, b) => b.score - a.score)
    : scored;
  return {
    tools: matches.slice(0, limit).map(({ entry }) => ({
      ...entry,
      description: clampText(entry.description, MAX_SEARCH_DESCRIPTION_CHARS)
        .text,
    })),
    hasMore: matches.length > limit,
  };
}

export type MetaToolDeps = {
  contracts: readonly AnyToolContract[];
  external: readonly InboundExternalTool[];
  listed: ReadonlySet<string>;
  activeToolsets: readonly McpToolsetName[];
  tool: ToolDeps;
  externalDeps?: ExternalToolDeps;
};

const READ_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const NOT_ACCESSIBLE = "tool not found or not accessible";

function errorResult(code: string, message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `${code}: ${message}` }],
    structuredContent: { error: { code, message } },
  };
}

function okResult(output: unknown): CallToolResult {
  const { value, text } = jsonSafeOutput(output);
  return { content: [{ type: "text", text }], structuredContent: value };
}

type Resolved =
  | { kind: "contract"; contract: AnyToolContract }
  | { kind: "external"; tool: InboundExternalTool };

export function registerMetaTools(server: McpServer, deps: MetaToolDeps): void {
  const audit = async (
    name: MetaToolName,
    started: number,
    errorCode: string | null,
  ) => {
    const event: ToolAuditEvent = {
      name,
      projectId: null,
      outcome: errorCode ? "error" : "ok",
      errorCode,
      durationMs: Date.now() - started,
      commitSha: null,
    };
    const owns = await deps.tool.onAudit(event);
    if (owns)
      emitMcpToolDiagnostic({
        contract: undefined,
        toolName: name,
        toolKind: "meta",
        outcome: event.outcome,
        errorCode,
        durationMs: event.durationMs,
      });
    return owns;
  };
  const fail = async (
    name: MetaToolName,
    started: number,
    code: string,
    message: string,
  ) => {
    await audit(name, started, code);
    return errorResult(code, message);
  };
  // Only permitted tools resolve, so every other name gets the same refusal.
  const resolve = (name: string): Resolved | null => {
    if (isMetaToolName(name)) return null;
    const contract = deps.contracts.find((c) => c.name === name);
    if (contract) return { kind: "contract", contract };
    const tool = deps.external.find((t) => t.name === name);
    return tool ? { kind: "external", tool } : null;
  };
  const catalogue = (): CatalogueEntry[] => [
    ...deps.contracts.map((c): CatalogueEntry => ({
      name: c.name,
      description: c.description,
      toolsets: toolsetsOf(c.name),
      kind: c.kind as "read" | "write",
      listed: deps.listed.has(c.name),
    })),
    ...deps.external.map((t): CatalogueEntry => ({
      name: t.name,
      description: t.description,
      toolsets: ["external"],
      kind: "external",
      listed: deps.listed.has(t.name),
      connection: t.connectionName,
    })),
  ];

  server.registerTool(
    "search_tools",
    {
      description:
        "Find a Weaver tool by task. Lists tools this credential may call, including ones not in tools/list; describe_tool returns a tool's input schema and call_tool runs it.",
      inputSchema: z.object({
        query: z.string().max(200).optional(),
        toolset: z.enum(MCP_TOOLSET_NAMES).optional(),
        limit: z.number().int().min(1).max(20).default(10),
      }),
      annotations: READ_ANNOTATIONS,
    },
    async ({ query, toolset, limit }) => {
      const started = Date.now();
      const entries = catalogue().filter(
        (entry) =>
          !toolset || toolset === "all" || entry.toolsets.includes(toolset),
      );
      const { tools, hasMore } = searchCatalogue(entries, query, limit);
      await audit("search_tools", started, null);
      return okResult({
        tools,
        activeToolsets: deps.activeToolsets,
        availableToolsets: MCP_TOOLSET_NAMES.filter(
          (name) => name !== "all" && !deps.activeToolsets.includes(name),
        ),
        hasMore,
      });
    },
  );

  server.registerTool(
    "describe_tool",
    {
      description:
        "Describe a Weaver tool found with search_tools: returns its input schema, annotations and toolsets, so call_tool can run it.",
      inputSchema: z.object({ name: z.string().max(128) }),
      annotations: READ_ANNOTATIONS,
    },
    async ({ name }) => {
      const started = Date.now();
      const target = resolve(name);
      if (!target)
        return fail("describe_tool", started, "NOT_FOUND", NOT_ACCESSIBLE);
      const listed = deps.listed.has(name);
      const output =
        target.kind === "contract"
          ? {
              name,
              description: target.contract.description,
              inputSchema: contractJsonSchema(target.contract),
              annotations: contractAnnotations(target.contract),
              toolsets: toolsetsOf(name),
              kind: target.contract.kind,
              listed,
            }
          : {
              name,
              description: target.tool.description,
              inputSchema: target.tool.inputSchema,
              annotations: externalAnnotations(target.tool),
              toolsets: ["external"],
              kind: "external",
              listed,
              connection: target.tool.connectionName,
            };
      await audit("describe_tool", started, null);
      return okResult(output);
    },
  );

  server.registerTool(
    "call_tool",
    {
      description:
        "Run a Weaver tool by name with its arguments, including tools not in tools/list. The tool's own validation, permissions and write guards apply; use describe_tool first for its input schema.",
      inputSchema: z.object({
        name: z.string().max(128),
        arguments: z.record(z.string(), z.unknown()).default({}),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ name, arguments: innerArguments }, ctx: ServerContext) => {
      const started = Date.now();
      const target = resolve(name);
      if (target?.kind === "contract") {
        const { contract } = target;
        const parsed =
          await contract.inputSchema.safeParseAsync(innerArguments);
        if (!parsed.success) {
          // Audited like a direct call the SDK rejected: inner name, no project.
          const durationMs = Date.now() - started;
          const owns = await deps.tool.onAudit({
            name: contract.name,
            projectId: null,
            outcome: "error",
            errorCode: "BAD_REQUEST",
            durationMs,
            commitSha: null,
          });
          if (owns)
            emitMcpToolDiagnostic({
              contract,
              outcome: "error",
              errorCode: "BAD_REQUEST",
              durationMs,
              via: "call_tool",
            });
          return errorResult(
            "BAD_REQUEST",
            `invalid tool arguments: ${parsed.error.issues
              .map((issue) => issue.message)
              .join("; ")}`,
          );
        }
        const signal =
          contract.kind === "write"
            ? (deps.tool.writeRequestSignal ?? ctx.mcpReq.signal)
            : ctx.mcpReq.signal;
        return executeContract(contract, parsed.data, signal, deps.tool, {
          via: "call_tool",
        });
      }
      if (target?.kind === "external" && deps.externalDeps) {
        const signal =
          target.tool.effect === "write"
            ? (deps.externalDeps.writeRequestSignal ?? ctx.mcpReq.signal)
            : ctx.mcpReq.signal;
        return executeExternal(
          target.tool,
          innerArguments,
          signal,
          deps.externalDeps,
          { via: "call_tool" },
        );
      }
      return fail("call_tool", started, "NOT_FOUND", NOT_ACCESSIBLE);
    },
  );
}

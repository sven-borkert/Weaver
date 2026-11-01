import { z } from "zod";
import { toolFilterSchema } from "@weaver/core/externalMcp/schema";
import { externalToolState } from "@weaver/core/externalMcp/toolState";
import { encodePageCursor } from "@weaver/core/services/adminPaging";
import {
  getExternalConnection,
  getExternalTool,
  listExternalConnections,
  listExternalTools,
} from "@weaver/core/services/externalMcp";
import {
  MAX_TOOL_OUTPUT_CHARS,
  clampText,
  defineTool,
  utf8Bytes,
} from "../../contract";
import { pagedOutput } from "../admin/paging";

type ToolRow = Awaited<ReturnType<typeof getExternalTool>>;

const SUMMARY_DESCRIPTION_CHARS = 500;

export function externalToolSummary(tool: ToolRow) {
  const description =
    tool.description === null
      ? null
      : clampText(tool.description, SUMMARY_DESCRIPTION_CHARS);
  return {
    id: tool.id,
    remoteName: tool.remoteName,
    description: description?.text ?? null,
    descriptionTruncated: description?.truncated ?? false,
    state: externalToolState(tool),
    enabled: tool.enabled,
    effect: tool.effect,
    discoveredRemoteDigest: tool.discoveredRemoteDigest,
    reviewedAt: tool.reviewedAt,
  };
}

export const listExternalConnectionsTool = defineTool({
  name: "list_external_connections",
  description:
    "Your MCP connections with endpoint, auth mode, revision, and last discovery; never credential material.",
  kind: "read",
  capability: "external:manage",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().max(600).optional(),
    search: z.string().max(120).optional(),
  }),
  async execute(input, ctx) {
    const page = await listExternalConnections(ctx.db, ctx.actor, input);
    return {
      output: pagedOutput(page, (item) => encodePageCursor([item.id])),
    };
  },
});

export const getExternalConnectionTool = defineTool({
  name: "get_external_connection",
  description:
    "One of your MCP connections with its tool count and a preview of its first tools. Use list_external_tools for the full catalog.",
  kind: "read",
  capability: "external:manage",
  inputSchema: z.object({ id: z.uuid() }),
  async execute(input, ctx) {
    const { tools, ...connection } = await getExternalConnection(
      ctx.db,
      ctx.actor,
      input.id,
    );
    return {
      output: {
        connection: { ...connection, tools: tools.map(externalToolSummary) },
      },
    };
  },
});

export const listExternalToolsTool = defineTool({
  name: "list_external_tools",
  description:
    "A connection's tool catalog ordered by name: state (new/changed/reviewed/unavailable/unsupported), enabled, effect, and discoveredRemoteDigest for review_external_tools. Tools the server no longer offers appear only with reviewState=removed. Filter by search (name or description), reviewState, effect, enabled.",
  kind: "read",
  capability: "external:manage",
  inputSchema: toolFilterSchema.extend({
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().max(600).optional(),
  }),
  async execute(input, ctx) {
    const page = await listExternalTools(ctx.db, ctx.actor, input);
    return {
      output: pagedOutput(
        {
          items: page.items.map(externalToolSummary),
          nextCursor: page.nextCursor,
        },
        (item) => encodePageCursor([item.remoteName, item.id]),
      ),
    };
  },
});

export const getExternalToolTool = defineTool({
  name: "get_external_tool",
  description:
    "One external tool with its discovered input schema and support status.",
  kind: "read",
  capability: "external:manage",
  inputSchema: z.object({ toolId: z.uuid() }),
  async execute(input, ctx) {
    const tool = await getExternalTool(ctx.db, ctx.actor, input.toolId);
    const definition = tool.discoveredDefinition as {
      inputSchema?: unknown;
      supportStatus?: unknown;
    };
    const summary = externalToolSummary(tool);
    const full = {
      ...summary,
      description: tool.description,
      descriptionTruncated: false,
      inputSchema: definition.inputSchema ?? null,
      supportStatus: definition.supportStatus ?? null,
      inputSchemaTruncated: false,
    };
    const fits = (candidate: typeof full) =>
      utf8Bytes(JSON.stringify({ tool: candidate })) <= MAX_TOOL_OUTPUT_CHARS;
    if (fits(full)) return { output: { tool: full } };
    const withoutSchema = {
      ...full,
      inputSchema: null,
      inputSchemaTruncated: true,
    };
    if (fits(withoutSchema)) return { output: { tool: withoutSchema } };
    return {
      output: {
        tool: {
          ...withoutSchema,
          description: summary.description,
          descriptionTruncated: summary.descriptionTruncated,
        },
      },
    };
  },
});

export const CONNECTION_READ_TOOLS = [
  listExternalConnectionsTool,
  getExternalConnectionTool,
  listExternalToolsTool,
  getExternalToolTool,
] as const;

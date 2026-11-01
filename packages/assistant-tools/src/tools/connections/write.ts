import { z } from "zod";
import {
  connectionCreateSchema,
  connectionUpdateSchema,
  toolBulkReviewSchema,
} from "@weaver/core/externalMcp/schema";
import type { ExternalRuntimeDeps } from "@weaver/core/externalMcp/types";
import {
  createExternalConnection,
  deleteExternalConnection,
  discoverExternalConnection,
  reviewExternalTools,
  updateExternalConnection,
} from "@weaver/core/services/externalMcp";
import {
  ToolError,
  boundItems,
  defineTool,
  newPageBudget,
  type ToolContext,
} from "../../contract";
import { externalToolSummary } from "./read";

function externalDeps(ctx: ToolContext): ExternalRuntimeDeps {
  if (!ctx.external)
    throw new ToolError(
      "INTERNAL",
      "MCP connection management is unavailable on this transport",
    );
  return ctx.external;
}

const revisionInput = z.object({
  id: z.uuid(),
  expectedRevision: z.number().int().positive(),
});

export const createExternalConnectionTool = defineTool({
  name: "create_external_connection",
  description:
    "Create one of your MCP connections. A bearer token is encrypted at rest and never returned. Pass enabled: true to use it right away, then run discover_external_connection.",
  kind: "write",
  capability: "external:manage",
  inputSchema: connectionCreateSchema,
  async execute(input, ctx) {
    return {
      output: {
        connection: await createExternalConnection(
          externalDeps(ctx),
          ctx.actor,
          input,
        ),
      },
    };
  },
});

export const updateExternalConnectionTool = defineTool({
  name: "update_external_connection",
  description:
    "Change name, endpoint, auth mode, token (write-only; omit to keep), timeout, TLS check, or enabled. Needs the current revision. Changing the endpoint clears all tool reviews.",
  kind: "write",
  capability: "external:manage",
  inputSchema: revisionInput.extend({ patch: connectionUpdateSchema }),
  async execute(input, ctx) {
    return {
      output: {
        connection: await updateExternalConnection(
          externalDeps(ctx),
          ctx.actor,
          input,
        ),
      },
    };
  },
});

export const deleteExternalConnectionTool = defineTool({
  name: "delete_external_connection",
  description:
    "Delete one of your MCP connections with its tool catalog. Refused while one of your scheduled tasks uses its tools.",
  kind: "write",
  capability: "external:manage",
  inputSchema: revisionInput,
  async execute(input, ctx) {
    await deleteExternalConnection(ctx.db, ctx.actor, input);
    return { output: { deleted: true } };
  },
});

export const discoverExternalConnectionTool = defineTool({
  name: "discover_external_connection",
  description:
    "Fetch the remote tool catalog. New tools arrive disabled and unreviewed; changed tools are disabled until reviewed again.",
  kind: "write",
  capability: "external:manage",
  inputSchema: revisionInput,
  async execute(input, ctx) {
    const result = await discoverExternalConnection(
      externalDeps(ctx),
      ctx.actor,
      input,
    );
    return { output: result };
  },
});

export const reviewExternalToolsTool = defineTool({
  name: "review_external_tools",
  description:
    "Enable/disable and classify up to 500 tools of one of your connections atomically. Pass each tool's discoveredRemoteDigest from list_external_tools; any mismatch refuses the whole batch. Saving approves the current definition. Omitted enabled/effect keep their value; a tool never classified gets its suggested effect (read only when the server marks it readOnlyHint).",
  kind: "write",
  capability: "external:manage",
  inputSchema: toolBulkReviewSchema,
  async execute(input, ctx) {
    const tools = await reviewExternalTools(
      externalDeps(ctx),
      ctx.actor,
      input,
    );
    const bounded = boundItems(tools.map(externalToolSummary), newPageBudget());
    return {
      output: {
        reviewed: tools.length,
        tools: bounded.items,
        toolsTruncated: bounded.truncated,
      },
    };
  },
});

export const CONNECTION_WRITE_TOOLS = [
  createExternalConnectionTool,
  updateExternalConnectionTool,
  deleteExternalConnectionTool,
  discoverExternalConnectionTool,
  reviewExternalToolsTool,
] as const;

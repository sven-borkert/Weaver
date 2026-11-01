import { z } from "zod";
import {
  adminHealth,
  adminOverview,
} from "@weaver/core/services/adminOverview";
import {
  getQueueJob,
  listQueueJobs,
  QUEUE_JOB_STATES,
  queueSummary,
  type QueueJobRow,
} from "@weaver/core/services/queueInspection";
import {
  aiUsageSummary,
  listAiUsage,
  type AiUsageRow,
} from "@weaver/core/services/aiUsageQueries";
import { encodePageCursor } from "@weaver/core/services/adminPaging";
import { listMcpAuditEvents } from "@weaver/core/services/mcpAuditQueries";
import {
  MAX_TOOL_OUTPUT_CHARS,
  ToolError,
  boundItems,
  defineTool,
  newOutputBudget,
  utf8Bytes,
} from "../../contract";
import { isoDate, listInput, pagedOutput } from "./paging";

export const adminOverviewTool = defineTool({
  name: "admin_overview",
  description:
    "Application version, runtime facts, non-secret server configuration, encryption key versions, and table sizes.",
  kind: "read",
  capability: "system:admin",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    if (!ctx.runtime)
      throw new ToolError("INTERNAL", "runtime facts unavailable");
    return { output: await adminOverview(ctx.db, ctx.actor, ctx.runtime) };
  },
});

export const adminHealthTool = defineTool({
  name: "admin_health",
  description:
    "Database round trip, pg-boss version, schedules, per-queue state counts, last reconciliations, worker last-seen, expired assistant leases, and diagnostics writer stats.",
  kind: "read",
  capability: "system:admin",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    return { output: await adminHealth(ctx.db, ctx.actor) };
  },
});

export const listQueueJobsTool = defineTool({
  name: "list_queue_jobs",
  description:
    "pg-boss jobs newest first with state, retry counts, safe error details, payload ids, and timestamps.",
  kind: "read",
  capability: "system:admin",
  inputSchema: z.object({
    name: z.string().max(80).optional(),
    state: z.enum(QUEUE_JOB_STATES).optional(),
    since: isoDate.optional(),
    generationId: z.uuid().optional(),
    runId: z.uuid().optional(),
    ...listInput,
  }),
  async execute(input, ctx) {
    return {
      output: pagedOutput(
        await listQueueJobs(ctx.db, ctx.actor, input),
        (item: QueueJobRow) =>
          encodePageCursor([item.createdOn.toISOString(), item.id]),
      ),
    };
  },
});

export const getQueueJobTool = defineTool({
  name: "get_queue_job",
  description: "One pg-boss job by id with safe payload and error metadata.",
  kind: "read",
  capability: "system:admin",
  inputSchema: z.object({ id: z.uuid() }),
  async execute(input, ctx) {
    const job = await getQueueJob(ctx.db, ctx.actor, input.id);
    if (!job) throw new ToolError("NOT_FOUND", "not found or not accessible");
    return { output: job };
  },
});

export const queueSummaryTool = defineTool({
  name: "queue_summary",
  description:
    "Bounded counts per queue and state, oldest jobs, and cron schedules.",
  kind: "read",
  capability: "system:admin",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const summary = await queueSummary(ctx.db, ctx.actor);
    const envelopeLength = utf8Bytes(
      JSON.stringify({
        queues: [],
        schedules: [],
        truncated: false,
      }),
    );
    const budget = newOutputBudget(MAX_TOOL_OUTPUT_CHARS - envelopeLength);
    const queues = boundItems(summary.queues, budget);
    const schedules = boundItems(summary.schedules, budget);
    return {
      output: {
        queues: queues.items,
        schedules: schedules.items,
        truncated: summary.truncated || queues.truncated || schedules.truncated,
      },
    };
  },
});

const usageOutcomes = [
  "success",
  "provider_failure",
  "validation_failure",
  "stale_discarded",
] as const;

export const listAiUsageTool = defineTool({
  name: "list_ai_usage",
  description:
    "AI provider usage rows newest first: operation, model, tokens, duration, outcome, cost, and correlation ids. Unsafe-size integer costs are decimal strings.",
  kind: "read",
  capability: "system:admin",
  inputSchema: z.object({
    since: isoDate.optional(),
    until: isoDate.optional(),
    outcome: z.enum(usageOutcomes).optional(),
    operation: z.string().max(80).optional(),
    model: z.string().max(200).optional(),
    connectionId: z.uuid().optional(),
    projectId: z.uuid().optional(),
    jobId: z.string().max(64).optional(),
    runId: z.uuid().optional(),
    ...listInput,
  }),
  async execute(input, ctx) {
    return {
      output: pagedOutput(
        await listAiUsage(ctx.db, ctx.actor, input),
        (item: AiUsageRow) =>
          encodePageCursor([item.createdAt.toISOString(), item.id]),
      ),
    };
  },
});

export const aiUsageSummaryTool = defineTool({
  name: "ai_usage_summary",
  description:
    "Aggregated AI usage: calls, failures, tokens, cost, and average duration grouped by model, operation, outcome, or UTC day. Unsafe-size integer totals are decimal strings.",
  kind: "read",
  capability: "system:admin",
  inputSchema: z.object({
    since: isoDate.optional(),
    until: isoDate.optional(),
    groupBy: z.enum(["model", "operation", "outcome", "day"]),
  }),
  async execute(input, ctx) {
    const summary = await aiUsageSummary(ctx.db, ctx.actor, input);
    const envelopeLength = utf8Bytes(
      JSON.stringify({
        groups: [],
        truncated: false,
      }),
    );
    const bounded = boundItems(
      summary.groups,
      newOutputBudget(MAX_TOOL_OUTPUT_CHARS - envelopeLength),
    );
    return {
      output: {
        groups: bounded.items,
        truncated: summary.truncated || bounded.truncated,
      },
    };
  },
});

export const listMcpAuditEventsTool = defineTool({
  name: "list_mcp_audit_events",
  description:
    "MCP audit rows newest first: request id, credential, method, tool or resource name, outcome, error code, duration.",
  kind: "read",
  capability: "system:admin",
  inputSchema: z.object({
    since: isoDate.optional(),
    userId: z.uuid().optional(),
    outcome: z.enum(["ok", "error", "denied"]).optional(),
    name: z.string().max(500).optional(),
    ...listInput,
  }),
  async execute(input, ctx) {
    return {
      output: pagedOutput(
        await listMcpAuditEvents(ctx.db, ctx.actor, input),
        (item) => encodePageCursor([item.createdAt.toISOString(), item.id]),
      ),
    };
  },
});

export const OPERATIONS_ADMIN_TOOLS = [
  adminOverviewTool,
  adminHealthTool,
  listQueueJobsTool,
  getQueueJobTool,
  queueSummaryTool,
  listAiUsageTool,
  aiUsageSummaryTool,
  listMcpAuditEventsTool,
] as const;

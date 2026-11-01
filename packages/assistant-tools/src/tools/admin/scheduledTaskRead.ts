import { createHash } from "node:crypto";
import { z } from "zod";
import { encodePageCursor } from "@weaver/core/services/adminPaging";
import {
  getScheduledTaskForInspection,
  getScheduledTaskRunForInspection,
  listScheduledTasksForInspection,
  listScheduledTaskRunsForInspection,
} from "@weaver/core/services/scheduledTaskInspection";
import {
  MAX_TOOL_OUTPUT_CHARS,
  ToolError,
  defineTool,
  requireScope,
  utf8Bytes,
} from "../../contract";
import { isoDate, listInput, pagedOutput } from "./paging";

const detailInput = {
  expectedRevision: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  offset: z.number().int().min(0).optional(),
  maxChars: z.number().int().min(1).max(12000).optional(),
};

function detailOutput<T>(
  record: T,
  input: { offset?: number; maxChars?: number; expectedRevision?: string },
) {
  const json = JSON.stringify(record);
  const revision = createHash("sha256").update(json).digest("hex");
  if (
    input.expectedRevision !== undefined &&
    input.expectedRevision !== revision
  ) {
    throw new ToolError(
      "CONFLICT",
      "Record changed; restart reading from offset 0",
    );
  }
  if ((input.offset ?? 0) > 0 && input.expectedRevision === undefined) {
    throw new ToolError(
      "BAD_REQUEST",
      "Continuation requires expectedRevision from the first page",
    );
  }
  const full = { record, revision, truncated: false, nextOffset: null };
  if (
    input.offset === undefined &&
    input.maxChars === undefined &&
    utf8Bytes(JSON.stringify(full)) <= MAX_TOOL_OUTPUT_CHARS
  )
    return full;
  const offset = input.offset ?? 0;
  if (
    offset > json.length ||
    (offset > 0 && /[\uDC00-\uDFFF]/u.test(json.charAt(offset)))
  ) {
    throw new ToolError("BAD_REQUEST", "Invalid JSON character offset");
  }
  const build = (length: number) => {
    let end = Math.min(offset + length, json.length);
    if (end < json.length && /[\uD800-\uDBFF]/u.test(json.charAt(end - 1)))
      end--;
    return {
      record: null,
      revision,
      json: json.slice(offset, end),
      offset,
      nextOffset: end < json.length ? end : null,
      totalChars: json.length,
      truncated: end < json.length,
    };
  };
  let length = Math.min(input.maxChars ?? 12000, json.length - offset);
  let output = build(length);
  while (utf8Bytes(JSON.stringify(output)) > MAX_TOOL_OUTPUT_CHARS) {
    length = Math.floor(length / 2);
    output = build(length);
  }
  if (output.nextOffset === offset) {
    throw new ToolError(
      "BAD_REQUEST",
      "maxChars must fit at least one complete character",
    );
  }
  return output;
}

export const listScheduledTasksTool = defineTool({
  name: "list_scheduled_tasks",
  description:
    "Scheduled tasks writing to one project: owner, creation time, schedule cron/timezone, status, next/last run, failure count, and output id. Filter by owner/status; order oldest to find the first created task. Page with cursor; use get_scheduled_task for instructions and scope.",
  kind: "read",
  capability: "system:admin",
  inputSchema: z.object({
    projectId: z.uuid(),
    ownerId: z.uuid().optional(),
    status: z.enum(["active", "paused"]).optional(),
    order: z.enum(["oldest", "newest"]).optional(),
    ...listInput,
  }),
  async execute(input, ctx) {
    requireScope(ctx, input.projectId);
    return {
      output: pagedOutput(
        await listScheduledTasksForInspection(ctx.db, ctx.actor, input),
        (item) => encodePageCursor([item.createdAt.toISOString(), item.id]),
      ),
    };
  },
});

export const getScheduledTaskTool = defineTool({
  name: "get_scheduled_task",
  description:
    "Full stored task definition, instructions, requested/resolved scope, schedule, state, timestamps and output. Requires Maintainer on output and read access to every source project. Returns record; oversized records return JSON text pages: concatenate json using nextOffset as offset and revision as expectedRevision, then parse. maxChars forces JSON paging. Changed records return CONFLICT; restart from offset 0.",
  kind: "read",
  capability: "system:admin",
  inputSchema: z.object({
    projectId: z.uuid(),
    taskId: z.uuid(),
    ...detailInput,
  }),
  async execute(input, ctx) {
    requireScope(ctx, input.projectId);
    const detail = await getScheduledTaskForInspection(
      ctx.db,
      ctx.actor,
      input,
    );
    for (const projectId of detail.projectIds) requireScope(ctx, projectId);
    return { output: detailOutput(detail.record, input) };
  },
});

export const listScheduledTaskRunsTool = defineTool({
  name: "list_scheduled_task_runs",
  description:
    "Task runs newest first, including status, trigger, timing, tokens, worker/job/lease, error code and output revision. Filter by status and inclusive queued-time since/until; page with cursor. Use get_scheduled_task_run for context, revisions and error message.",
  kind: "read",
  capability: "system:admin",
  inputSchema: z.object({
    projectId: z.uuid(),
    taskId: z.uuid(),
    status: z
      .enum(["queued", "running", "succeeded", "failed", "skipped"])
      .optional(),
    since: isoDate.optional(),
    until: isoDate.optional(),
    ...listInput,
  }),
  async execute(input, ctx) {
    requireScope(ctx, input.projectId);
    return {
      output: pagedOutput(
        await listScheduledTaskRunsForInspection(ctx.db, ctx.actor, input),
        (item) => encodePageCursor([item.queuedAt.toISOString(), item.id]),
      ),
    };
  },
});

export const getScheduledTaskRunTool = defineTool({
  name: "get_scheduled_task_run",
  description:
    "Full stored task-run diagnostics: context summary, project Git heads, error message/code, tokens, duration, timestamps, worker/job/lease and output revision. Requires access to current and historical source projects. Correlate runId/jobId with diagnostic, usage and queue tools. Returns record; oversized records return JSON pages: concatenate json using nextOffset as offset and revision as expectedRevision, then parse. maxChars forces JSON paging. Changed records return CONFLICT; restart from offset 0.",
  kind: "read",
  capability: "system:admin",
  inputSchema: z.object({
    projectId: z.uuid(),
    runId: z.uuid(),
    ...detailInput,
  }),
  async execute(input, ctx) {
    requireScope(ctx, input.projectId);
    const detail = await getScheduledTaskRunForInspection(
      ctx.db,
      ctx.actor,
      input,
    );
    for (const projectId of detail.projectIds) requireScope(ctx, projectId);
    return { output: detailOutput(detail.record, input) };
  },
});

export const SCHEDULED_TASK_READ_ADMIN_TOOLS = [
  listScheduledTasksTool,
  getScheduledTaskTool,
  listScheduledTaskRunsTool,
  getScheduledTaskRunTool,
] as const;

import { z } from "zod";
import {
  getAssistantRunDetail,
  listAssistantRuns,
} from "@weaver/core/services/assistantInspection";
import { encodePageCursor } from "@weaver/core/services/adminPaging";
import {
  MAX_TOOL_OUTPUT_CHARS,
  ToolError,
  boundItems,
  defineTool,
  newOutputBudget,
  utf8Bytes,
} from "../../contract";
import { isoDate, listInput, pagedOutput } from "./paging";

const runStatuses = [
  "queued",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
] as const;

export const listAssistantRunsTool = defineTool({
  name: "list_assistant_runs",
  description:
    "Assistant runs newest first: status, attempts, error code and summary, route snapshot, timestamps; never message text.",
  kind: "read",
  capability: "system:admin",
  inputSchema: z.object({
    since: isoDate.optional(),
    status: z.enum(runStatuses).optional(),
    userId: z.uuid().optional(),
    ...listInput,
  }),
  async execute(input, ctx) {
    return {
      output: pagedOutput(
        await listAssistantRuns(ctx.db, ctx.actor, input),
        (item) => encodePageCursor([item.queuedAt.toISOString(), item.id]),
      ),
    };
  },
});

export const getAssistantRunTool = defineTool({
  name: "get_assistant_run",
  description:
    "One run with its attempts and its events reduced to sequence, type, time, and tool name; never payload text.",
  kind: "read",
  capability: "system:admin",
  inputSchema: z.object({ runId: z.uuid() }),
  async execute(input, ctx) {
    const detail = await getAssistantRunDetail(ctx.db, ctx.actor, input.runId);
    const { attempts, events, ...metadata } = detail;
    const envelopeLength = utf8Bytes(
      JSON.stringify({
        ...metadata,
        attempts: [],
        events: [],
        truncated: false,
      }),
    );
    const budget = newOutputBudget(MAX_TOOL_OUTPUT_CHARS - envelopeLength);
    const boundedAttempts = boundItems(attempts, budget);
    const boundedEvents = boundItems(events, budget);
    const output = {
      ...metadata,
      attempts: boundedAttempts.items,
      events: boundedEvents.items,
      truncated:
        detail.truncated ||
        boundedAttempts.truncated ||
        boundedEvents.truncated,
    };
    while (
      utf8Bytes(JSON.stringify(output)) > MAX_TOOL_OUTPUT_CHARS &&
      (output.events.length > 0 || output.attempts.length > 0)
    ) {
      if (output.events.length > 0) output.events.pop();
      else output.attempts.pop();
      output.truncated = true;
    }
    if (utf8Bytes(JSON.stringify(output)) > MAX_TOOL_OUTPUT_CHARS) {
      throw new ToolError("INTERNAL", "run metadata exceeds tool output limit");
    }
    return { output };
  },
});

export const ASSISTANT_READ_ADMIN_TOOLS = [
  listAssistantRunsTool,
  getAssistantRunTool,
] as const;

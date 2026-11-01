import { z } from "zod";

export const MAX_EVENT_PAYLOAD_CHARS = 8_000;

export const citationViewSchema = z.object({
  id: z.string(),
  kind: z.enum(["document", "table", "graph", "search"]),
  projectId: z.string(),
  resourceId: z.string(),
  commitSha: z.string().nullable(),
  label: z.string(),
  excerpt: z.string().nullable(),
});
export type CitationView = z.infer<typeof citationViewSchema>;

export const assistantEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("external.approval.required"),
    approvalId: z.string(),
    callId: z.string(),
  }),
  z.object({
    type: z.literal("external.approval.decided"),
    approvalId: z.string(),
    callId: z.string(),
    status: z.enum(["approved", "denied"]),
  }),
  z.object({
    type: z.literal("external.call.status"),
    toolCallId: z.string(),
    toolName: z.string(),
    connectionId: z.string().optional(),
    connectionName: z.string().max(200).optional(),
    summary: z.string().max(1000).nullable().optional(),
    callId: z.string(),
    status: z.enum([
      "prepared",
      "dispatched",
      "denied",
      "completed",
      "failed",
      "unknown",
    ]),
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
  }),
  z.object({ type: z.literal("run.queued") }),
  z.object({
    type: z.literal("run.started"),
    attempt: z.number().int().positive(),
  }),
  z.object({ type: z.literal("text.delta"), text: z.string() }),
  z.object({
    type: z.literal("tool.call"),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal("tool.result"),
    toolCallId: z.string(),
    toolName: z.string(),
    ok: z.boolean(),
    summary: z.string(),
  }),
  z.object({ type: z.literal("citation"), citation: citationViewSchema }),
  z.object({
    type: z.literal("proposal.created"),
    proposalId: z.string(),
    kind: z.string(),
    summary: z.string(),
  }),
  z.object({
    type: z.literal("usage"),
    inputTokens: z.number().nullable(),
    outputTokens: z.number().nullable(),
  }),
  z.object({ type: z.literal("run.completed"), messageId: z.string() }),
  z.object({
    type: z.literal("run.failed"),
    code: z.string(),
    message: z.string(),
    retrying: z.boolean(),
  }),
  z.object({ type: z.literal("run.cancelled") }),
]);
export type AssistantEvent = z.infer<typeof assistantEventSchema>;

/** Reserved for the truncation marker and estimation slack in `boundedJson`. */
export const BOUNDED_JSON_SLACK_CHARS = 64;

/** The final, guaranteed-small payload when even a shrunk value overflows the budget. */
const BOUNDED_JSON_FALLBACK = { truncated: true } as const;

function tryStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/** Truncate string content and, once the remaining budget runs out, drop
 * further array elements / object entries outright — the caller re-measures
 * the actual serialized result afterward, so this only needs to get close. */
function shrink(input: unknown, remaining: { chars: number }): unknown {
  if (typeof input === "string") {
    const quoteOverhead = 2;
    const available = Math.max(0, remaining.chars - quoteOverhead);
    const take = Math.min(input.length, available);
    remaining.chars = Math.max(0, remaining.chars - quoteOverhead - take);
    return input.length > take ? `${input.slice(0, take)}…` : input;
  }
  if (Array.isArray(input)) {
    const result: unknown[] = [];
    for (const item of input) {
      if (remaining.chars <= 1) break;
      remaining.chars -= 1; // comma/bracket overhead
      result.push(shrink(item, remaining));
    }
    return result;
  }
  if (input && typeof input === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(
      input as Record<string, unknown>,
    )) {
      const keyOverhead = key.length + 4; // quotes + colon + comma
      if (remaining.chars <= keyOverhead) break;
      remaining.chars -= keyOverhead;
      result[key] = shrink(item, remaining);
    }
    return result;
  }
  return input;
}

/**
 * Keep persisted payloads bounded: `JSON.stringify(boundedJson(v, max)).length`
 * never exceeds `max`. Strings are cut and arrays/objects are cut off once
 * the budget runs out; if the shrunk-and-marked value still overflows (e.g.
 * structural overhead outran the estimate), the content is dropped entirely
 * in favor of a small fixed marker — never an unbounded payload.
 */
export function boundedJson(
  value: unknown,
  maxChars = MAX_EVENT_PAYLOAD_CHARS,
): unknown {
  const serialized = tryStringify(value);
  if (serialized !== undefined && serialized.length <= maxChars) return value;

  const budget = Math.max(0, maxChars - BOUNDED_JSON_SLACK_CHARS);
  const shrunk = shrink(value, { chars: budget });
  const marked =
    shrunk && typeof shrunk === "object" && !Array.isArray(shrunk)
      ? { ...(shrunk as Record<string, unknown>), truncated: true }
      : { value: shrunk, truncated: true };

  const markedSerialized = tryStringify(marked);
  if (markedSerialized !== undefined && markedSerialized.length <= maxChars) {
    return marked;
  }
  return BOUNDED_JSON_FALLBACK;
}

export type RunReduction = {
  text: string;
  terminal: "completed" | "failed" | "cancelled" | null;
  proposalIds: string[];
  citationCount: number;
};

export function reduceRunEvents(
  events: readonly AssistantEvent[],
): RunReduction {
  let text = "";
  let terminal: RunReduction["terminal"] = null;
  const proposalIds: string[] = [];
  let citationCount = 0;
  for (const event of events) {
    switch (event.type) {
      case "run.started":
        proposalIds.length = 0;
        citationCount = 0;
        terminal = null;
        text = "";
        break;
      case "text.delta":
        text += event.text;
        break;
      case "proposal.created":
        proposalIds.push(event.proposalId);
        break;
      case "citation":
        citationCount += 1;
        break;
      case "run.completed":
        terminal = "completed";
        break;
      case "run.failed":
        if (!event.retrying) terminal = "failed";
        break;
      case "run.cancelled":
        terminal = "cancelled";
        break;
      default:
        break;
    }
  }
  return { text, terminal, proposalIds, citationCount };
}

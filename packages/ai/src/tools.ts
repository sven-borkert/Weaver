import { tool, type ToolSet } from "ai";
import type { z } from "zod";
import {
  MAX_TOOL_OUTPUT_CHARS,
  toolErrorFromUnknown,
  truncatedToolOutput,
  type AnyToolContract,
  type ToolContext,
} from "@weaver/assistant-tools/contract";
import {
  boundedJson,
  type AssistantEvent,
} from "@weaver/core/assistant/events";
import { emitDiagnostic } from "@weaver/core/diagnostics/writer";

export type ToolCollector = {
  citations: unknown[];
  proposals: Array<{ proposalId: string; kind: string; summary: string }>;
};

const MAX_INPUT_EVENT_CHARS = 2_000;
const MAX_SUMMARY_CHARS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function summarize(output: unknown): string {
  const text = JSON.stringify(output) ?? "";
  return text.length > MAX_SUMMARY_CHARS
    ? `${text.slice(0, MAX_SUMMARY_CHARS - 1)}…`
    : text;
}

export function toAiToolSet(
  contracts: readonly AnyToolContract[],
  options: {
    context: () => Promise<ToolContext>;
    onEvent: (event: AssistantEvent) => Promise<void>;
    collector: ToolCollector;
  },
): ToolSet {
  const set: ToolSet = {};
  for (const contract of contracts) {
    set[contract.name] = tool({
      description: contract.description,
      inputSchema: contract.inputSchema as z.ZodType<Record<string, unknown>>,
      async execute(input: unknown, { toolCallId, abortSignal }) {
        try {
          await options.onEvent({
            type: "tool.call",
            toolCallId,
            toolName: contract.name,
            input: boundedJson(input, MAX_INPUT_EVENT_CHARS),
          });
          // The emit above is where a cancelled or abandoned attempt learns it
          // lost the run. Without this check the tool still runs, so Cancel
          // could leave a pending proposal the user is then able to accept.
          abortSignal?.throwIfAborted();
          const ctx = { ...(await options.context()), signal: abortSignal };
          const toolStarted = Date.now();
          let outcome: Awaited<ReturnType<typeof contract.execute>>;
          try {
            outcome = await contract.execute(input, ctx);
            emitDiagnostic({
              event: "assistant.tool.called",
              message: `${contract.name} ok`,
              durationMs: Date.now() - toolStarted,
              outcome: "ok",
              details: { tool: contract.name },
            });
          } catch (error) {
            const toolError = toolErrorFromUnknown(error);
            emitDiagnostic({
              event: "assistant.tool.called",
              severity: "warn",
              message: `${contract.name} failed: ${toolError.code}`,
              durationMs: Date.now() - toolStarted,
              outcome: "error",
              details: { tool: contract.name, code: toolError.code },
            });
            throw error;
          }
          if (outcome.citations)
            options.collector.citations.push(...outcome.citations);
          if (
            contract.kind === "propose" &&
            isRecord(outcome.output) &&
            typeof outcome.output.proposalId === "string"
          ) {
            const proposal = {
              proposalId: outcome.output.proposalId,
              kind: stringField(outcome.output, "kind"),
              summary: stringField(outcome.output, "summary"),
            };
            options.collector.proposals.push(proposal);
            await options.onEvent({ type: "proposal.created", ...proposal });
          }
          await options.onEvent({
            type: "tool.result",
            toolCallId,
            toolName: contract.name,
            ok: true,
            summary: summarize(outcome.output),
          });
          const serialized = JSON.stringify(outcome.output) ?? "null";
          // Bytes: the prompt budget charges tool results in UTF-8 bytes.
          if (Buffer.byteLength(serialized, "utf8") > MAX_TOOL_OUTPUT_CHARS)
            return truncatedToolOutput(serialized);
          // The SDK stores this verbatim as the tool result's `output.value` and
          // validates the whole message array against ModelMessage[] on the next
          // step, where JSONValue rejects a Date. Prisma rows carry Dates, so
          // hand back the serialized form rather than the raw object.
          return JSON.parse(serialized) as unknown;
        } catch (error) {
          if (abortSignal?.aborted) throw error;
          const toolError = toolErrorFromUnknown(error);
          await options.onEvent({
            type: "tool.result",
            toolCallId,
            toolName: contract.name,
            ok: false,
            summary: `${toolError.code}: ${toolError.message}`,
          });
          return {
            error: {
              code: toolError.code,
              message: toolError.message,
              ...(toolError.reason ? { reason: toolError.reason } : {}),
            },
          };
        }
      },
    });
  }
  return set;
}

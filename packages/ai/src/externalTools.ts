import { bindDiagnosticContext } from "@weaver/core/diagnostics/context";
import { setTimeout as sleep } from "node:timers/promises";
import { jsonSchema, tool, type ToolSet } from "ai";
import { validateArguments } from "@weaver/external-mcp";
import { CoreError } from "@weaver/core/errors";
import type { ScopeSnapshot } from "@weaver/core/assistant/scope";
import type { AssistantEvent } from "@weaver/core/assistant/events";
import type { SecurityContext } from "@weaver/core/security/context";
import type {
  ExternalInvocation,
  ExternalResult,
  ExternalRuntimeDeps,
  ExternalSource,
  JsonObject,
} from "@weaver/core/externalMcp/types";
import {
  executeExternalCall,
  getExternalApproval,
  prepareExternalCall,
} from "@weaver/core/services/externalMcp";
import { z } from "zod";
import { toolErrorFromUnknown } from "@weaver/assistant-tools/contract";
import { boundedJson } from "@weaver/core/assistant/events";
import type { ExternalToolSnapshot } from "@weaver/core/externalMcp/schema";
import type { AvailableExternalTool } from "@weaver/core/externalMcp/types";
import type { ExternalLoadRefusal } from "@weaver/core/services/externalMcp";
import { RunTimeoutError } from "./errors";
import {
  MAX_FIND_DESCRIPTION_CHARS,
  externalDefinitionBytes,
  rankExternalTools,
} from "./externalToolSearch";

export function externalToolName(id: string): string {
  return `ext_${id.replaceAll("-", "")}`;
}

export async function waitForExternalApproval(
  deps: ExternalRuntimeDeps,
  actor: SecurityContext,
  approvalId: string,
  signal: AbortSignal,
  deadline: Date,
): Promise<"approved" | "denied"> {
  for (;;) {
    signal.throwIfAborted();
    const remaining = deadline.getTime() - deps.now().getTime();
    if (remaining <= 0) throw new RunTimeoutError();
    const approval = await getExternalApproval(deps, actor, approvalId);
    signal.throwIfAborted();
    if (deps.now().getTime() >= deadline.getTime()) throw new RunTimeoutError();
    if (approval.status === "approved" || approval.status === "denied")
      return approval.status;
    if (approval.status !== "pending")
      throw new CoreError(
        "PRECONDITION_FAILED",
        "External tool approval expired or is no longer available. Send a new message to retry.",
      );
    try {
      await sleep(Math.min(1000, remaining), undefined, { signal });
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    }
  }
}

export const FIND_EXTERNAL_TOOLS = "find_external_tools";
const FIND_DESCRIPTION =
  "Find and load tools from the user's external MCP connections. Pass query (optionally connection) to search; results list each tool's callable name without its schema. Pass load with up to 5 names from results to make them callable from the next step. At most 20 tools can be loaded per message.";
const findInputSchema = z
  .object({
    query: z.string().trim().min(1).max(200).optional(),
    connection: z.string().trim().min(1).max(100).optional(),
    load: z
      .array(z.string().regex(/^ext_[0-9a-f]{32}$/))
      .min(1)
      .max(5)
      .optional(),
  })
  .refine((v) => Boolean(v.query ?? v.connection ?? v.load), {
    message: "Pass query, connection or load.",
  });

export function findToolDefinition() {
  return {
    name: FIND_EXTERNAL_TOOLS,
    description: FIND_DESCRIPTION,
    inputSchema: z.toJSONSchema(findInputSchema),
  };
}

export type ExternalLoader = (snapshots: ExternalToolSnapshot[]) => Promise<{
  loaded: ExternalToolSnapshot[];
  refused: ExternalLoadRefusal[];
}>;

export type ExternalToolkit = {
  tools: ToolSet;
  activeToolNames: () => string[];
  loadedAny: () => boolean;
  executionFailed: () => boolean;
};

export function createExternalToolkit(input: {
  deps: ExternalRuntimeDeps;
  actor: SecurityContext;
  run: { id: string; attemptId: string };
  scope: ScopeSnapshot;
  available: {
    connections: Array<{ id: string; name: string }>;
    tools: AvailableExternalTool[];
  };
  stored: ExternalToolSnapshot[];
  reserveBytes: number;
  tools?: ToolSet;
  load: ExternalLoader;
  beforeTool?: () => Promise<void>;
  collector: { externalSources: ExternalSource[] };
  onEvent: (event: AssistantEvent) => Promise<void>;
  signal: AbortSignal;
  deadline: Date;
}): ExternalToolkit {
  const { deps, actor, run, scope, signal, deadline, onEvent } = input;
  const connectionNames = new Map(
    input.available.connections.map((c) => [c.id, c.name]),
  );
  const byName = new Map(
    input.available.tools.map((t) => [externalToolName(t.id), t]),
  );
  const definitionOf = (t: AvailableExternalTool) => ({
    name: externalToolName(t.id),
    description: t.description,
    inputSchema: t.inputSchema,
  });
  const snapshotOf = (t: AvailableExternalTool): ExternalToolSnapshot => ({
    connectionId: t.connectionId,
    toolId: t.id,
    configRevision: t.configRevision,
    toolDigest: t.reviewDigest,
  });
  const active = new Map<string, ExternalToolSnapshot>();
  let usedBytes = 0;
  for (const stored of input.stored) {
    const t = input.available.tools.find((x) => x.id === stored.toolId);
    if (
      t?.connectionId !== stored.connectionId ||
      t.configRevision !== stored.configRevision ||
      t.reviewDigest !== stored.toolDigest
    )
      continue;
    const bytes = externalDefinitionBytes(definitionOf(t));
    if (usedBytes + bytes > input.reserveBytes) continue;
    usedBytes += bytes;
    active.set(externalToolName(t.id), stored);
  }

  const tools: ToolSet = input.tools ?? {};
  let tail: Promise<unknown> = Promise.resolve();
  let failed = false;
  const install = (available: AvailableExternalTool) => {
    const name = externalToolName(available.id);
    const definition = {
      name: available.name,
      inputSchema: available.inputSchema,
      supportStatus: { available: true as const },
    };
    tools[name] = tool({
      description: available.description,
      inputSchema: jsonSchema<JsonObject>(available.inputSchema, {
        validate: (value) => {
          try {
            validateArguments(definition, value);
            return { success: true, value };
          } catch {
            return {
              success: false,
              error: new Error("Invalid external tool arguments."),
            };
          }
        },
      }),
      execute: bindDiagnosticContext((args, { toolCallId }) => {
        const execute = async (): Promise<ExternalResult> => {
          signal.throwIfAborted();
          if (failed)
            throw new CoreError(
              "PRECONDITION_FAILED",
              "External tool execution is no longer available.",
            );
          const snapshot = active.get(name);
          if (!snapshot)
            throw new CoreError(
              "PRECONDITION_FAILED",
              "External tool is not loaded.",
            );
          validateArguments(definition, args);
          const invocation: ExternalInvocation = {
            owner: {
              kind: "assistant",
              runId: run.id,
              attemptId: run.attemptId,
              toolCallId,
            },
            scope,
            toolId: available.id,
            expectedConfigRevision: snapshot.configRevision,
            expectedToolDigest: snapshot.toolDigest,
            arguments: args,
            deadline,
          };
          const prepared = await prepareExternalCall(deps, actor, invocation);
          await onEvent({
            type: "external.call.status",
            toolCallId,
            toolName: available.name,
            callId: prepared.callId,
            connectionId: prepared.activity.connectionId,
            connectionName: prepared.activity.connectionName,
            status: prepared.activity.status,
            error: null,
          });
          signal.throwIfAborted();
          let denied = prepared.status === "denied";
          if (prepared.approvalId && !denied) {
            await onEvent({
              type: "external.approval.required",
              approvalId: prepared.approvalId,
              callId: prepared.callId,
            });
            signal.throwIfAborted();
            const decision = await waitForExternalApproval(
              deps,
              actor,
              prepared.approvalId,
              signal,
              deadline,
            );
            await onEvent({
              type: "external.approval.decided",
              approvalId: prepared.approvalId,
              callId: prepared.callId,
              status: decision,
            });
            signal.throwIfAborted();
            denied = decision === "denied";
          }
          if (!denied) signal.throwIfAborted();
          const result: ExternalResult = denied
            ? {
                callId: prepared.callId,
                status: "denied",
                output: null,
                source: null,
                error: {
                  code: "EXTERNAL_TOOL_DENIED",
                  message: "The user denied this tool call.",
                },
              }
            : await executeExternalCall(deps, actor, {
                callId: prepared.callId,
                invocation,
                signal,
                onDispatched: async (activity) =>
                  onEvent({ type: "external.call.status", ...activity }),
              });
          if (result.source)
            input.collector.externalSources.push(result.source);
          await onEvent({
            type: "external.call.status",
            toolCallId,
            toolName: available.name,
            callId: result.callId,
            connectionId: prepared.activity.connectionId,
            connectionName: prepared.activity.connectionName,
            summary: result.summary,
            status: result.status,
            error: result.error,
          });
          signal.throwIfAborted();
          return result;
        };
        const guarded = async () => {
          try {
            return await execute();
          } catch (error) {
            failed = true;
            throw error;
          }
        };
        const result = tail.then(guarded);
        tail = result.catch(() => undefined);
        return result;
      }),
    });
  };

  for (const name of active.keys()) install(byName.get(name)!);

  let findTail: Promise<unknown> = Promise.resolve();
  tools[FIND_EXTERNAL_TOOLS] = tool({
    description: FIND_DESCRIPTION,
    inputSchema: findInputSchema,
    execute: bindDiagnosticContext((args, { toolCallId }) => {
      const find = async () => {
        await onEvent({
          type: "tool.call",
          toolCallId,
          toolName: FIND_EXTERNAL_TOOLS,
          input: boundedJson(args, 2_000),
        });
        signal.throwIfAborted();
        try {
          await input.beforeTool?.();
          const output: Record<string, unknown> = {};
          let matched = 0;
          let loadedCount = 0;
          if (args.load) {
            const loaded: string[] = [];
            const refused: Array<{ name: string; reason: string }> = [];
            const candidates: Array<{
              name: string;
              snapshot: ExternalToolSnapshot;
              bytes: number;
            }> = [];
            let pending = 0;
            for (const name of new Set(args.load)) {
              const t = byName.get(name);
              if (!t) {
                refused.push({ name, reason: "UNKNOWN_TOOL" });
                continue;
              }
              if (active.has(name)) {
                loaded.push(name);
                continue;
              }
              const bytes = externalDefinitionBytes(definitionOf(t));
              if (usedBytes + pending + bytes > input.reserveBytes) {
                refused.push({ name, reason: "BUDGET_EXCEEDED" });
                continue;
              }
              pending += bytes;
              candidates.push({ name, snapshot: snapshotOf(t), bytes });
            }
            const result = candidates.length
              ? await input.load(candidates.map((c) => c.snapshot))
              : { loaded: [], refused: [] };
            for (const c of candidates) {
              if (result.loaded.some((s) => s.toolId === c.snapshot.toolId)) {
                active.set(c.name, c.snapshot);
                install(byName.get(c.name)!);
                usedBytes += c.bytes;
                loaded.push(c.name);
              } else
                refused.push({
                  name: c.name,
                  reason:
                    result.refused.find((r) => r.toolId === c.snapshot.toolId)
                      ?.reason ?? "CHANGED",
                });
            }
            output.loaded = loaded;
            loadedCount = loaded.length;
            if (refused.length) output.refused = refused;
          }
          if (args.query || args.connection) {
            const searchable = input.available.tools.map((t) => ({
              name: externalToolName(t.id),
              tool: t.name,
              connection: connectionNames.get(t.connectionId) ?? "",
              description: t.description,
              effect: t.effect,
            }));
            const { matches, total } = rankExternalTools(searchable, args);
            output.matches = matches.map((m) => ({
              ...m,
              description: m.description.slice(0, MAX_FIND_DESCRIPTION_CHARS),
              loaded: active.has(m.name),
            }));
            output.totalMatches = total;
            matched = total;
          }
          await onEvent({
            type: "tool.result",
            toolCallId,
            toolName: FIND_EXTERNAL_TOOLS,
            ok: true,
            summary: `matched ${matched}, loaded ${loadedCount}`,
          });
          return output;
        } catch (error) {
          if (signal.aborted) throw error;
          const toolError = toolErrorFromUnknown(error);
          await onEvent({
            type: "tool.result",
            toolCallId,
            toolName: FIND_EXTERNAL_TOOLS,
            ok: false,
            summary: `${toolError.code}: ${toolError.message}`,
          });
          return {
            error: { code: toolError.code, message: toolError.message },
          };
        }
      };
      const result = findTail.then(find);
      findTail = result.catch(() => undefined);
      return result;
    }),
  });

  return {
    tools,
    activeToolNames: () => [FIND_EXTERNAL_TOOLS, ...active.keys()],
    loadedAny: () => active.size > 0,
    executionFailed: () => failed,
  };
}

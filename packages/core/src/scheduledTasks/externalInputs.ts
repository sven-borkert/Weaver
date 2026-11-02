import { externalError } from "../externalMcp/errors";
import type { Prisma, PrismaClient } from "@weaver/db/client";
import { parseToolDefinitions, validateArguments } from "@weaver/external-mcp";
import type { ScopeSnapshot } from "../assistant/scopeSchema";
import { canonicalDigest } from "../externalMcp/digest";
import { externalInputSchema } from "../externalMcp/schema";
import type {
  ArgumentBinding,
  ExternalInput,
  ExternalInvocation,
  ExternalRuntimeDeps,
  ExternalSource,
  JsonObject,
} from "../externalMcp/types";
import { CoreError, isCoreError } from "../errors";
import {
  createTaskSecurityContext,
  type UserSecurityContext,
} from "../security/context";
import {
  authorizeExternalInvocation,
  executeExternalCall,
  prepareExternalCall,
} from "../services/externalMcp";
import { assertProjectRole } from "../services/projectAccess";
import { cutToBytes } from "./context";
import type { TaskFailureCode } from "./scheduleSchema";

export type SavedExternalInput = ExternalInput & { id: string };
export type ExternalInputSummary = {
  inputId: string;
  name: string;
  connectionId: string;
  toolName: string;
  status: "completed" | "failed";
  retrievedAt: string | null;
  durationMs: number;
  truncated: boolean;
  errorCode: TaskFailureCode | null;
  outcome?: "completed" | "denied" | "failed" | "unknown";
};
export class ExternalInputFailure extends Error {
  constructor(readonly code: TaskFailureCode) {
    super(code);
    this.name = "ExternalInputFailure";
  }
}
export function resolveExternalArguments(
  bindings: Record<string, ArgumentBinding>,
  period: { start: string; end: string },
): JsonObject {
  return Object.fromEntries(
    Object.entries(bindings).map(([key, binding]) => [
      key,
      binding.kind === "literal"
        ? structuredClone(binding.value)
        : binding.kind === "period_start"
          ? period.start
          : period.end,
    ]),
  );
}
export function escapeExternalMarkdown(value: string): string {
  return value
    .replace(/[\r\n\u0000-\u001f]/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_{}[\]()#+.!|~-]/g, "\\$&");
}
export function appendExternalProvenance(
  markdown: string,
  sources: ExternalSource[],
): string {
  if (!sources.length) return markdown;
  return (
    markdown +
    "\n\n## External sources\n\n" +
    sources
      .map(
        (source) =>
          `- ${escapeExternalMarkdown(source.connectionName)} / ${escapeExternalMarkdown(source.toolName)} — retrieved ${source.retrievedAt}; call ${source.callId}${source.truncated ? "; truncated" : ""}.`,
      )
      .join("\n")
  );
}

export function parseSavedExternalInputs(
  rows: Array<{
    id: string;
    name: string;
    toolId: string;
    argumentBindings: unknown;
  }>,
): SavedExternalInput[] {
  const definitions = externalInputSchema.parse(
    rows.map((row) => ({
      name: row.name,
      toolId: row.toolId,
      arguments: row.argumentBindings,
    })),
  );
  return definitions.map((input, index) => ({ ...input, id: rows[index]!.id }));
}

export async function validateTaskExternalInputs(
  db: PrismaClient | Prisma.TransactionClient,
  ownerId: string,
  scope: ScopeSnapshot,
  outputProjectId: string,
  raw: unknown,
): Promise<ExternalInput[]> {
  const parsed = externalInputSchema.safeParse(raw);
  if (!parsed.success)
    throw new CoreError("BAD_REQUEST", "Invalid external inputs", {
      field: "externalInputs",
    });
  if (!parsed.data.length) return [];
  const owner = await db.user.findUnique({
    where: { id: ownerId },
    select: {
      role: true,
      banned: true,
      banExpires: true,
      mustChangePassword: true,
    },
  });
  if (
    !owner ||
    owner.mustChangePassword ||
    (owner.banned && (!owner.banExpires || owner.banExpires > new Date()))
  )
    throw new CoreError("FORBIDDEN", "Task owner is not active");
  const actor = createTaskSecurityContext({
    userId: ownerId,
    globalRole: owner.role === "Admin" ? "Admin" : "User",
    runId: "definition",
  });
  for (const id of scope.projectIds)
    await assertProjectRole(db, id, actor, "Viewer");
  await assertProjectRole(db, outputProjectId, actor, "Editor");
  for (const input of parsed.data) {
    const tool = await db.externalMcpTool.findUnique({
      where: { id: input.toolId },
      include: { connection: true },
    });
    if (
      tool?.connection.ownerId !== ownerId ||
      !tool.enabled ||
      !tool.presentInCatalog ||
      tool.effect !== "read" ||
      !tool.reviewedDefinition ||
      !tool.reviewDigest ||
      tool.discoveredRemoteDigest !== tool.reviewedRemoteDigest ||
      !tool.connection.enabled
    )
      throw new CoreError(
        "PRECONDITION_FAILED",
        "External inputs need your own enabled read tools",
        { field: "externalInputs" },
      );
    try {
      const definition = parseToolDefinitions([tool.reviewedDefinition])[0]!;
      if (
        !definition.supportStatus.available ||
        canonicalDigest(definition) !== tool.reviewedRemoteDigest ||
        canonicalDigest({
          remoteDigest: tool.reviewedRemoteDigest,
          effect: tool.effect,
        }) !== tool.reviewDigest
      )
        throw new Error();
      validateArguments(
        definition,
        resolveExternalArguments(input.arguments, {
          start: "2026-01-01T00:00:00.000Z",
          end: "2026-01-02T00:00:00.000Z",
        }),
      );
    } catch {
      throw new CoreError(
        "BAD_REQUEST",
        "External input arguments do not match the reviewed schema",
        { field: "externalInputs" },
      );
    }
  }
  return parsed.data;
}

function inputFailure(error: unknown, signal: AbortSignal): TaskFailureCode {
  if (error instanceof ExternalInputFailure) return error.code;
  if (signal.aborted) return "EXTERNAL_TIMEOUT";
  if (isCoreError(error)) {
    if (error.code === "BAD_REQUEST") return "EXTERNAL_INPUT_INVALID";
    if (["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"].includes(error.code))
      return "EXTERNAL_AUTH_FAILED";
    if (error.code === "PRECONDITION_FAILED") return "EXTERNAL_UNAVAILABLE";
  }
  return "EXTERNAL_INPUT_FAILED";
}
export async function taskExternalInvocation(
  deps: Pick<ExternalRuntimeDeps, "db" | "now">,
  actor: UserSecurityContext,
  input: {
    runId: string;
    scope: ScopeSnapshot;
    outputProjectId: string;
    inputId: string;
    period: { start: string; end: string };
    deadline: Date;
  },
): Promise<ExternalInvocation> {
  const saved = await deps.db.scheduledTaskExternalInput.findFirst({
    where: {
      id: input.inputId,
      task: {
        runs: { some: { id: input.runId } },
        outputProjectId: input.outputProjectId,
      },
    },
    include: { tool: { include: { connection: true } } },
  });
  if (!saved) throw new ExternalInputFailure("EXTERNAL_INPUT_INVALID");
  let parsed: SavedExternalInput;
  try {
    parsed = parseSavedExternalInputs([saved])[0]!;
  } catch {
    throw new ExternalInputFailure("EXTERNAL_INPUT_INVALID");
  }
  const invocation: ExternalInvocation = {
    owner: { kind: "task", runId: input.runId, inputId: saved.id },
    scope: input.scope,
    toolId: saved.toolId,
    expectedConfigRevision: saved.tool.connection.revision,
    expectedToolDigest: saved.tool.reviewDigest ?? "",
    arguments: resolveExternalArguments(parsed.arguments, input.period),
    deadline: input.deadline,
  };
  await authorizeExternalInvocation(deps, actor, invocation);
  return invocation;
}

export async function fetchTaskExternalInputs(
  deps: ExternalRuntimeDeps,
  actor: UserSecurityContext,
  input: {
    runId: string;
    scope: ScopeSnapshot;
    outputProjectId: string;
    inputs: SavedExternalInput[];
    period: { start: string; end: string };
    budgetBytes: number;
    signal: AbortSignal;
    deadline?: Date;
  },
): Promise<{
  blocks: string[];
  sources: ExternalSource[];
  summaries: ExternalInputSummary[];
}> {
  const blocks: string[] = [],
    sources: ExternalSource[] = [],
    summaries: ExternalInputSummary[] = [];
  const share = Math.floor(
    input.budgetBytes / Math.max(1, input.inputs.length),
  );
  const deadline =
    input.deadline ?? new Date(deps.now().getTime() + 15 * 60000);
  for (const configured of input.inputs) {
    const started = deps.now().getTime();
    const saved = await deps.db.scheduledTaskExternalInput.findUnique({
      where: { id: configured.id },
      include: { tool: true },
    });
    const summary: ExternalInputSummary = {
      inputId: configured.id,
      name: saved?.name ?? configured.name,
      connectionId: saved?.tool.connectionId ?? "",
      toolName: saved?.tool.remoteName ?? "",
      status: "failed",
      retrievedAt: null,
      durationMs: 0,
      truncated: false,
      errorCode: null,
    };
    summaries.push(summary);
    try {
      input.signal.throwIfAborted();
      const invocation = await taskExternalInvocation(deps, actor, {
        ...input,
        inputId: configured.id,
        deadline,
      });
      const prepared = await prepareExternalCall(deps, actor, invocation);
      const result = await executeExternalCall(deps, actor, {
        callId: prepared.callId,
        invocation,
        signal: input.signal,
      });
      summary.outcome = result.status;
      if (
        result.status !== "completed" ||
        !result.source ||
        result.output === null
      ) {
        throw new ExternalInputFailure(externalError(result.error?.code).code);
      }
      const source = { ...result.source };
      summary.retrievedAt = source.retrievedAt;
      const prefix = `\n<external-input untrusted="true">\n${externalInputJson({ name: summary.name, ...source })}\n`;
      const suffix = "\n</external-input>\n";
      const room = share - Buffer.byteLength(prefix + suffix);
      const raw = externalInputJson(result.output);
      const body = cutToBytes(raw, room);
      if (!body || (body !== raw && !body.replace(/\s*_\[truncated\]_$/, "")))
        throw new ExternalInputFailure("EXTERNAL_CONTEXT_LIMIT");
      source.truncated ||= body !== raw;
      summary.truncated = source.truncated;
      blocks.push(
        `\n<external-input untrusted="true">\n${externalInputJson({ name: summary.name, ...source })}\n` +
          body +
          suffix,
      );
      sources.push(source);
      summary.status = "completed";
    } catch (error) {
      summary.errorCode = inputFailure(error, input.signal);
      throw new ExternalInputFailure(summary.errorCode);
    } finally {
      summary.durationMs = Math.max(0, deps.now().getTime() - started);
      await deps.db.scheduledTaskRun.updateMany({
        where: { id: input.runId, status: "running" },
        data: {
          contextSummary: {
            projects: input.scope.projectIds.map((projectId) => ({
              projectId,
            })),
            externalInputs: summaries,
            period: input.period,
          },
        },
      });
    }
  }
  return { blocks, sources, summaries };
}

export function externalInputJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
}

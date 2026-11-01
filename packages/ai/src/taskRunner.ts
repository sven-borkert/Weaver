import {
  createExternalMcpTransport,
  type ExternalMcpTransport,
} from "@weaver/external-mcp";
import {
  appendExternalProvenance,
  escapeExternalMarkdown,
  ExternalInputFailure,
  fetchTaskExternalInputs,
  taskExternalInvocation,
} from "@weaver/core/scheduledTasks/externalInputs";
import { createHash, randomUUID } from "node:crypto";
import { generateText, type LanguageModel } from "ai";
import type { PrismaClient } from "@weaver/db/client";
import { emptyUsage } from "@weaver/core/ai/http";
import { createDbCredentialSource } from "@weaver/core/ai/registry";
import { effectiveScope } from "@weaver/core/assistant/scope";
import { withDiagnosticContext } from "@weaver/core/diagnostics/context";
import {
  emitDiagnostic,
  reserveDiagnosticEvent,
} from "@weaver/core/diagnostics/writer";
import { withReference } from "@weaver/core/diagnostics/reference";
import { summarizeError } from "@weaver/core/diagnostics/errorSummary";
import { MAX_MARKDOWN_CHARS } from "@weaver/core/documents/limits";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import { isCoreError } from "@weaver/core/errors";
import type { TaskRunner } from "@weaver/core/jobs/types";
import {
  assembleTaskContext,
  cutToBytes,
  computeTaskBudget,
} from "@weaver/core/scheduledTasks/context";
import type {
  TaskFailureCode,
  TaskSkipReason,
} from "@weaver/core/scheduledTasks/scheduleSchema";
import { createTaskSecurityContext } from "@weaver/core/security/context";
import type { EncryptionKeyRing } from "@weaver/core/security/encryption";
import { recordAiUsageSafely } from "@weaver/core/services/aiUsageBestEffort";
import { modelOutputFailure } from "./completion";
import {
  documentContentText,
  getDocument,
  writeDocumentInRepo,
  type DocumentProvenance,
  type DocumentResult,
  type EnrichedActor,
} from "@weaver/core/services/documents";
import {
  resolveLlmRoute,
  type LlmModelSnapshot,
} from "@weaver/core/services/llmRoutes";
import { withProjectRepo } from "@weaver/core/services/projectRepo";
import { assertProjectRole } from "@weaver/core/services/projectAccess";
import { notifyProjectContentChanged } from "@weaver/core/services/projectGitRemoteJobs";
import {
  failTaskRun,
  heartbeatTaskRun,
  leaseTaskRun,
  skipTaskRun,
  succeedTaskRun,
  withTaskOutputLease,
  type LeasedTaskRun,
} from "@weaver/core/services/scheduledTasks";
import { classifyRunError, redactSecrets } from "./errors";
import { createAssistantLanguageModel } from "./model";
import {
  buildTaskPrompt,
  TASK_SYSTEM_PROMPT,
  EXTERNAL_TASK_SYSTEM_PROMPT,
} from "./taskPrompt";
import { usageFromSdk, usageFromError } from "./usage";

export type ScheduledTaskRunnerDeps = {
  db: PrismaClient;
  ring: EncryptionKeyRing | null;
  workerId: string;
  fetchImpl?: typeof fetch;
  externalTransport?: ExternalMcpTransport;
  modelFactory?: (snapshot: LlmModelSnapshot) => LanguageModel;
  leaseMs?: number;
  heartbeatMs?: number;
  runTimeoutMs?: number;
};

export const TASK_LEASE_MS = 60_000;
export const TASK_HEARTBEAT_MS = 15_000;
export const TASK_RUN_TIMEOUT_MS = 15 * 60_000;
const TASK_PROMPT_VERSION = "task-v1";

export class TaskRunFailure extends Error {
  constructor(
    readonly code: TaskFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "TaskRunFailure";
  }
}

export function createScheduledTaskRunner(
  deps: ScheduledTaskRunnerDeps,
): TaskRunner {
  return (payload, execution) =>
    executeScheduledTaskRun(deps, payload.runId, execution.signal);
}

function skipReasonFor(owner: LeasedTaskRun["owner"]): TaskSkipReason | null {
  if (owner.banned && (!owner.banExpires || owner.banExpires > new Date()))
    return "owner_inactive";
  if (owner.mustChangePassword) return "owner_password_change";
  return null;
}

// Output and scope failures are classified where they happen; a CoreError that
// reaches here belongs to neither, so it must not borrow an OUTPUT_* meaning.
function toFailure(error: unknown): { code: TaskFailureCode; message: string } {
  if (error instanceof ExternalInputFailure)
    return { code: error.code, message: error.message };
  if (isCoreError(error) && error.details?.reason === "TASK_LEASE_LOST")
    return { code: "ABANDONED", message: "the worker lease expired" };
  if (error instanceof TaskRunFailure)
    return { code: error.code, message: error.message };
  if (isCoreError(error))
    return { code: "PROVIDER_ERROR", message: redactSecrets(error.message) };
  return { code: "PROVIDER_ERROR", message: classifyRunError(error).message };
}

function routeFingerprint(snapshot: LlmModelSnapshot): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        snapshot.providerType,
        snapshot.endpoint,
        snapshot.providerModelId,
        TASK_PROMPT_VERSION,
      ]),
    )
    .digest("hex");
}

/** The target's present Markdown for an `update` task; null when there is nothing to revise yet. */
async function readCurrentOutput(
  db: PrismaClient,
  task: LeasedTaskRun["task"],
  actor: EnrichedActor,
  inputBytes: number,
): Promise<{ text: string; truncated: boolean } | null> {
  if (!task.outputDocumentId) return null;
  try {
    const current = await getDocument(
      db,
      { projectId: task.outputProjectId, documentId: task.outputDocumentId },
      actor,
    );
    const body = documentContentText(current.content);
    // A quarter of the input at most, so the document cannot crowd out the material.
    const cut = cutToBytes(body, Math.max(1_024, Math.floor(inputBytes / 4)));
    return { text: cut, truncated: cut !== body };
  } catch (error) {
    if (isCoreError(error) && error.code === "NOT_FOUND") return null;
    throw error;
  }
}

async function writeOutput(
  db: PrismaClient,
  task: LeasedTaskRun["task"],
  actor: EnrichedActor,
  contentJson: ReturnType<typeof parseDocumentBody>,
  provenance: DocumentProvenance,
  summary: string,
  repo: Parameters<typeof writeDocumentInRepo>[1],
): Promise<DocumentResult> {
  const create = async () => {
    try {
      const result = await writeDocumentInRepo(
        db,
        repo,
        task.outputProjectId,
        {
          kind: "create",
          id: randomUUID(),
          folderPath: task.outputFolderPath,
          title: task.outputTitle ?? task.name,
          content: { kind: "markdown", contentJson },
          createdAt: new Date().toISOString(),
        },
        actor,
        { operation: "create", ...provenance },
      );
      return result;
    } catch (error) {
      if (isCoreError(error) && error.code === "NOT_FOUND")
        throw new TaskRunFailure(
          "OUTPUT_MISSING",
          "the output folder no longer exists",
        );
      throw error;
    }
  };
  if (!task.outputDocumentId) return create();
  let current: Awaited<ReturnType<typeof getDocument>>;
  try {
    current = await getDocument(
      db,
      { projectId: task.outputProjectId, documentId: task.outputDocumentId },
      actor,
    );
  } catch (error) {
    // The previous output was deleted: start a fresh document in the same folder.
    if (isCoreError(error) && error.code === "NOT_FOUND") return create();
    throw error;
  }
  try {
    const result = await writeDocumentInRepo(
      db,
      repo,
      task.outputProjectId,
      {
        kind: "update",
        documentId: task.outputDocumentId,
        baseCommitSha: current.baseCommitSha,
        content: { kind: "markdown", contentJson },
        changeSummary: summary,
      },
      actor,
      {
        operation: "update",
        ...provenance,
        message: (path) => `update: ${path} — ${summary}`,
      },
    );
    return result;
  } catch (error) {
    if (isCoreError(error) && error.code === "CONFLICT")
      throw new TaskRunFailure(
        "OUTPUT_CONFLICT",
        "the output document changed underneath the run",
      );
    if (isCoreError(error) && error.code === "NOT_FOUND")
      throw new TaskRunFailure(
        "OUTPUT_MISSING",
        "the output folder or document no longer exists",
      );
    if (isCoreError(error) && error.code === "FORBIDDEN")
      throw new TaskRunFailure(
        "OUTPUT_FORBIDDEN",
        "the owner can no longer write to the output project",
      );
    throw error;
  }
}

async function runTask(
  deps: ScheduledTaskRunnerDeps,
  leased: LeasedTaskRun,
  actor: EnrichedActor,
  signal: AbortSignal,
  deadline: Date,
) {
  const { db } = deps;
  const { task } = leased;
  const runId = leased.run.id;
  const snapshot = await resolveLlmRoute(db, "jobs");
  if (!snapshot)
    throw new TaskRunFailure(
      "ROUTE_MISSING",
      "no model is routed to Scheduled tasks in Administration › AI",
    );
  const hasExternal = task.externalInputs.length > 0;
  const scope = hasExternal
    ? task.scopeSnapshot
    : await effectiveScope(db, actor, task.scopeSnapshot);
  if (scope.projectIds.length === 0)
    throw new TaskRunFailure(
      "SCOPE_EMPTY",
      "the owner can no longer read anything in this task's scope",
    );
  try {
    await assertProjectRole(db, task.outputProjectId, actor, "Editor");
  } catch {
    throw new TaskRunFailure(
      "OUTPUT_FORBIDDEN",
      "the owner can no longer write to the output project",
    );
  }
  const systemPrompt = hasExternal
    ? EXTERNAL_TASK_SYSTEM_PROMPT
    : TASK_SYSTEM_PROMPT;
  const budget = computeTaskBudget({
    contextWindow: snapshot.contextWindow,
    maxOutputTokens: snapshot.maxOutputTokens ?? null,
    systemPrompt,
    instruction: task.instruction,
  });
  const now = new Date();
  const period = {
    start: (
      leased.previousPeriodEnd ?? new Date(now.getTime() - 7 * 86400000)
    ).toISOString(),
    end: now.toISOString(),
  };
  const externalBytes = hasExternal ? Math.floor(budget.inputBytes / 2) : 0;
  const externalDeps = {
    db,
    ring: deps.ring!,
    transport:
      deps.externalTransport ??
      createExternalMcpTransport({ fetchImpl: deps.fetchImpl ?? fetch }),
    now: () => new Date(),
  };
  const external = hasExternal
    ? await fetchTaskExternalInputs(externalDeps, actor, {
        runId,
        scope,
        outputProjectId: task.outputProjectId,
        inputs: task.externalInputs,
        period,
        budgetBytes: externalBytes,
        signal,
        deadline,
      })
    : { blocks: [], sources: [], summaries: [] };
  const footer = appendExternalProvenance("", external.sources);
  const outputTokens =
    budget.maxOutputTokens - Math.ceil(Buffer.byteLength(footer) / 4);
  if (outputTokens < 1)
    throw new ExternalInputFailure("EXTERNAL_CONTEXT_LIMIT");
  const currentDocument =
    task.outputMode === "update"
      ? await readCurrentOutput(db, task, actor, budget.inputBytes)
      : null;
  let context: Awaited<ReturnType<typeof assembleTaskContext>>;
  try {
    context = await assembleTaskContext(db, actor, {
      scope,
      excludeDocumentId: task.outputDocumentId,
      previousHeads: leased.previousHeads,
      inputBytes:
        budget.inputBytes -
        externalBytes -
        (currentDocument ? Buffer.byteLength(currentDocument.text) + 512 : 0),
      now,
      ...(hasExternal ? { period } : {}),
    });
  } catch (error) {
    if (
      isCoreError(error) &&
      (error.code === "NOT_FOUND" || error.code === "FORBIDDEN")
    )
      throw new TaskRunFailure(
        "SCOPE_EMPTY",
        "a document or table in this task's scope no longer exists or is not readable",
      );
    throw error;
  }
  const model = deps.modelFactory
    ? deps.modelFactory(snapshot)
    : createAssistantLanguageModel(
        snapshot,
        createDbCredentialSource(db, deps.ring),
        deps.fetchImpl,
      );
  const accounting = {
    projectId: task.outputProjectId,
    operation: "task.run",
    runId,
    connectionId: snapshot.connectionId,
    provider: snapshot.providerType,
    model: snapshot.providerModelId,
    configFingerprint: routeFingerprint(snapshot),
    pricing: {
      inputCostMicrosPerMillion: snapshot.inputCostMicrosPerMillion,
      outputCostMicrosPerMillion: snapshot.outputCostMicrosPerMillion,
    },
    currency: snapshot.currency,
  };
  const callStarted = Date.now();
  let result: Awaited<ReturnType<typeof generateText>>;
  let providerStarted = false;
  try {
    result = await generateText({
      model,
      onLanguageModelCallStart: () => {
        providerStarted = true;
      },
      system: systemPrompt,
      prompt: buildTaskPrompt({
        taskName: task.name,
        instruction: task.instruction,
        digest: context.digest,
        content: context.content,
        period: context.period,
        truncated:
          context.summary.truncated ||
          external.sources.some((source) => source.truncated),
        externalBlocks: external.blocks,
        currentDocument,
      }),
      abortSignal: signal,
      maxOutputTokens: outputTokens,
    });
  } catch (error) {
    if (providerStarted)
      await recordAiUsageSafely(db, {
        ...accounting,
        usage:
          usageFromError(error, Date.now() - callStarted) ??
          emptyUsage(Date.now() - callStarted),
        outcome: "provider_failure",
      });
    throw error;
  }
  const usage = usageFromSdk(result.usage, Date.now() - callStarted);
  const outputFailure = modelOutputFailure(result);
  await recordAiUsageSafely(db, {
    ...accounting,
    usage,
    outcome: outputFailure ? "validation_failure" : "success",
  });
  const markdown = result.text.trim();
  if (outputFailure) throw new TaskRunFailure("CONTENT_INVALID", outputFailure);
  if (markdown.length + footer.length > MAX_MARKDOWN_CHARS)
    throw new TaskRunFailure(
      "CONTENT_INVALID",
      "the model's output exceeds the document size limit",
    );
  const covering = context.period.from
    ? `, covering ${context.period.from.toISOString().slice(0, 10)} to ${now.toISOString().slice(0, 10)}`
    : "";
  const note = `> Generated by scheduled task "${escapeExternalMarkdown(task.name)}" on ${now.toISOString().slice(0, 10)}${covering}.\n\n`;
  let contentJson: ReturnType<typeof parseDocumentBody>;
  try {
    const finalMarkdown =
      note + appendExternalProvenance(markdown, external.sources);
    if (finalMarkdown.length > MAX_MARKDOWN_CHARS) throw new Error();
    contentJson = parseDocumentBody(finalMarkdown);
  } catch {
    throw new TaskRunFailure(
      "CONTENT_INVALID",
      "the model's output could not be parsed as a document",
    );
  }
  signal.throwIfAborted();
  try {
    await assertProjectRole(db, task.outputProjectId, actor, "Editor");
  } catch {
    throw new TaskRunFailure(
      "OUTPUT_FORBIDDEN",
      "the owner can no longer write to the output project",
    );
  }
  for (const input of task.externalInputs) {
    try {
      await taskExternalInvocation(externalDeps, actor, {
        runId,
        scope,
        outputProjectId: task.outputProjectId,
        inputId: input.id,
        period,
        deadline,
      });
    } catch (error) {
      if (error instanceof ExternalInputFailure) throw error;
      throw new ExternalInputFailure("EXTERNAL_AUTH_FAILED");
    }
  }
  const receipt = {
    outputProjectId: task.outputProjectId,
    projectHeads: context.heads,
    contextSummary: {
      ...context.summary,
      ...(hasExternal ? { externalInputs: external.summaries, period } : {}),
    },
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
  const written = await withProjectRepo(task.outputProjectId, (repo) =>
    withTaskOutputLease(
      db,
      runId,
      async () => {
        signal.throwIfAborted();
        try {
          await assertProjectRole(db, task.outputProjectId, actor, "Editor");
          return await writeOutput(
            db,
            task,
            actor,
            contentJson,
            { operationId: `task-run:${runId}`, runId },
            `Scheduled task "${task.name}" run ${now.toISOString().slice(0, 10)}`,
            repo,
          );
        } catch (error) {
          if (
            isCoreError(error) &&
            (error.code === "FORBIDDEN" || error.code === "NOT_FOUND")
          ) {
            throw new TaskRunFailure(
              "OUTPUT_FORBIDDEN",
              "the owner can no longer write to the output project",
            );
          }
          throw error;
        }
      },
      receipt,
    ),
  );
  // The dispatch takes the repository's shared read lock, so it must run
  // after withProjectRepo released the write lock (M4).
  void notifyProjectContentChanged(db, task.outputProjectId);
  return {
    outputDocumentId: written.id,
    outputCommitSha: written.headCommitSha,
    projectHeads: context.heads,
    contextSummary: {
      ...context.summary,
      ...(hasExternal ? { externalInputs: external.summaries, period } : {}),
    },
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
}

export async function executeScheduledTaskRun(
  deps: ScheduledTaskRunnerDeps,
  runId: string,
  externalSignal?: AbortSignal,
): Promise<void> {
  const leaseMs = deps.leaseMs ?? TASK_LEASE_MS;
  const leased = await leaseTaskRun(deps.db, {
    runId,
    workerId: deps.workerId,
    leaseMs,
  });
  if (!leased) return;
  const { db } = deps;
  const { task, owner } = leased;
  return withDiagnosticContext(
    {
      suppressProviderBodies: task.externalInputs.length > 0,
      runId,
      userId: owner.id,
      credentialId: `task-run:${runId}`,
      projectId: task.outputProjectId,
    },
    async () => {
      const started = Date.now();
      emitDiagnostic({
        event: "task.run.started",
        message: `scheduled task "${task.name}" run started`,
        details: { taskId: task.id, workerId: deps.workerId },
      });
      const skip = skipReasonFor(owner);
      if (skip) {
        await skipTaskRun(db, { runId, reason: skip });
        emitDiagnostic({
          event: "task.run.skipped",
          message: `scheduled task "${task.name}" run skipped: ${skip}`,
          details: { taskId: task.id, reason: skip },
        });
        return;
      }
      const actor: EnrichedActor = {
        ...createTaskSecurityContext({
          userId: owner.id,
          globalRole: owner.role,
          runId,
        }),
        name: owner.name,
        email: owner.email,
      };
      const controller = new AbortController();
      let timedOut = false;
      let leaseLost = false;
      const onAbort = () => controller.abort();
      if (externalSignal?.aborted) controller.abort();
      externalSignal?.addEventListener("abort", onAbort, { once: true });
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, deps.runTimeoutMs ?? TASK_RUN_TIMEOUT_MS);
      const heartbeat = setInterval(() => {
        void heartbeatTaskRun(db, { runId, leaseMs }).then(
          (alive) => {
            if (!alive) {
              leaseLost = true;
              controller.abort();
            }
          },
          () => undefined,
        );
      }, deps.heartbeatMs ?? TASK_HEARTBEAT_MS);
      let published = false;
      try {
        const outcome = await runTask(
          deps,
          leased,
          actor,
          controller.signal,
          new Date(started + (deps.runTimeoutMs ?? TASK_RUN_TIMEOUT_MS)),
        );
        published = true;
        let transitioned = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            transitioned = await succeedTaskRun(db, {
              runId,
              ...outcome,
              durationMs: Date.now() - started,
            });
            break;
          } catch (error) {
            if (attempt === 2) throw error;
          }
        }
        // The lease expired while the run was past its last abort check: the tick
        // already owns this run's ABANDONED transition, so claim nothing here.
        if (!transitioned) {
          emitDiagnostic({
            event: "task.run.failed",
            severity: "warn",
            message: `scheduled task "${task.name}" finished after its lease expired; the run is recorded as abandoned`,
            durationMs: Date.now() - started,
            details: {
              taskId: task.id,
              code: "ABANDONED",
              outputDocumentId: outcome.outputDocumentId,
            },
          });
          return;
        }
        emitDiagnostic({
          event: "task.run.succeeded",
          message: `scheduled task "${task.name}" run succeeded`,
          durationMs: Date.now() - started,
          details: {
            taskId: task.id,
            outputDocumentId: outcome.outputDocumentId,
            outputCommitSha: outcome.outputCommitSha,
            inputTokens: outcome.inputTokens,
            outputTokens: outcome.outputTokens,
            documents: outcome.contextSummary.documents,
            tables: outcome.contextSummary.tables,
            commits: outcome.contextSummary.commits,
            truncated: outcome.contextSummary.truncated,
            fallback: outcome.contextSummary.fallback,
            projects: outcome.contextSummary.projects,
          },
        });
      } catch (error) {
        if (published) {
          emitDiagnostic({
            event: "task.run.failed",
            severity: "warn",
            message:
              "Published scheduled report awaits acknowledgement reconciliation",
            details: { taskId: task.id, runId },
          });
          return;
        }
        // A lost lease or a pg-boss abort belongs to the tick: it marks the run ABANDONED.
        if (leaseLost || (externalSignal?.aborted && !timedOut)) return;
        const failure =
          timedOut && !(error instanceof ExternalInputFailure)
            ? {
                code: "TIMEOUT" as const,
                message: "the run exceeded 15 minutes",
              }
            : toFailure(error);
        const reserved = reserveDiagnosticEvent("warn");
        const external = task.externalInputs.length > 0;
        const userMessage =
          external && failure.code === "PROVIDER_ERROR"
            ? "scheduled task generation failed"
            : failure.message;
        await failTaskRun(db, {
          runId,
          code: failure.code,
          message: withReference(userMessage, reserved?.reference ?? null, 300),
        });
        emitDiagnostic({
          id: reserved?.id,
          event: "task.run.failed",
          severity: "warn",
          message: `scheduled task "${task.name}" run failed: ${failure.code}`,
          durationMs: Date.now() - started,
          outcome: "error",
          details: {
            taskId: task.id,
            code: failure.code,
            reference: reserved?.reference ?? null,
            // External input content may appear in the error, as in the
            // generic user message above.
            ...(external ? {} : { error: summarizeError(error) }),
          },
        });
      } finally {
        clearTimeout(timeout);
        clearInterval(heartbeat);
        externalSignal?.removeEventListener("abort", onAbort);
      }
    },
  );
}

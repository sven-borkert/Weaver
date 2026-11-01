import { createHash } from "node:crypto";
import type { AiUsageOutcome, PrismaClient } from "@weaver/db/client";
import { openProjectRepo, type ProjectRepoReader } from "@weaver/git-store";
import { emptyUsage } from "../ai/http";
import {
  createAdapterForSnapshot,
  createDbCredentialSource,
} from "../ai/registry";
import {
  AiProviderError,
  type AiUsageSample,
  type TextCompletionResult,
} from "../ai/types";
import { withDiagnosticContext } from "../diagnostics/context";
import { safeErrorClass } from "../diagnostics/errorClass";
import { emitDiagnostic } from "../diagnostics/writer";
import {
  buildChangeSummaryPrompt,
  CHANGE_SUMMARY_SYSTEM,
  changeSummaryBudget,
  classifyChangeSummaryFailure,
  usableSummary,
  type ChangeSummarySide,
} from "../documents/changeSummary";
import { parseDocumentFile } from "../documents/frontmatter";
import { documentKindOfPath } from "../documents/kinds";
import { requestKnowledgeJob, type JobExecution } from "../jobs/queue";
import type { KnowledgeJobPayloads } from "../jobs/types";
import { parseKnowledgeConfig } from "../knowledge/config";
import type { EncryptionKeyRing } from "../security/encryption";
import { recordAiUsage } from "./aiUsage";
import {
  saveDocument,
  type DocumentResult,
  type EnrichedActor,
} from "./documents";
import { resolveLlmRoute, type LlmModelSnapshot } from "./llmRoutes";

export type ChangeSummaryPayload =
  KnowledgeJobPayloads["document.change-summary"];

type SummaryEvent =
  "completed" | "skipped" | "retrying" | "failed" | "usage_failed";

const SEVERITY = {
  completed: "info",
  skipped: "info",
  retrying: "warn",
  failed: "error",
  usage_failed: "warn",
} as const;

export function emitSummaryEvent(
  kind: SummaryEvent,
  source: Pick<ChangeSummaryPayload, "projectId" | "documentId" | "commitSha">,
  details: {
    reason?: string;
    attempt?: number;
    attempts?: number;
    outcome?: string;
    errorClass?: string;
  },
  metrics: { durationMs?: number; statusCode?: number | null } = {},
): void {
  emitDiagnostic({
    event: `document.summary.${kind}`,
    severity: SEVERITY[kind],
    message: details.reason
      ? `document change summary ${kind}: ${details.reason}`
      : `document change summary ${kind}`,
    outcome:
      kind === "completed" || kind === "skipped"
        ? "ok"
        : details.reason === "timeout"
          ? "timeout"
          : "error",
    projectId: source.projectId,
    documentId: source.documentId,
    durationMs: metrics.durationMs ?? null,
    statusCode: metrics.statusCode ?? null,
    details: { commitSha: source.commitSha, ...details },
  });
}

export async function queueDocumentChangeSummary(
  db: PrismaClient,
  payload: ChangeSummaryPayload,
  options: { basePathAtSha?: string | null } = {},
): Promise<void> {
  try {
    if (!parseKnowledgeConfig(process.env).jobsEnabled) return;
    if (!(await resolveLlmRoute(db, "document_summary"))) return;
    const now = new Date();
    await db.documentChangeSummary.create({
      data: {
        ...payload,
        basePathAtSha: options.basePathAtSha ?? null,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      },
    });
  } catch {
    emitSummaryEvent("failed", payload, { reason: "enqueue", attempts: 0 });
    return;
  }
  try {
    await requestKnowledgeJob("document.change-summary", payload);
  } catch {
    emitSummaryEvent("retrying", payload, { reason: "enqueue", attempt: 0 });
  }
}

export async function saveDocumentAndQueueSummary(
  db: PrismaClient,
  input: Omit<Parameters<typeof saveDocument>[1], "changeSummary"> & {
    changeSummary?: string;
  },
  actor: EnrichedActor,
): Promise<DocumentResult> {
  if (input.changeSummary !== undefined)
    return saveDocument(
      db,
      { ...input, changeSummary: input.changeSummary },
      actor,
    );
  // The path before saving is the base version's path; git rename detection is only a fallback.
  const before = await db.document.findFirst({
    where: { id: input.documentId, projectId: input.projectId },
    select: { path: true },
  });
  const result = await saveDocument(db, { ...input, changeSummary: "" }, actor);
  await queueDocumentChangeSummary(
    db,
    {
      projectId: input.projectId,
      documentId: result.id,
      commitSha: result.headCommitSha,
      baseCommitSha: input.baseCommitSha,
      pathAtSha: result.path,
    },
    { basePathAtSha: before?.path ?? null },
  );
  return result;
}

export type ChangeSummaryJobDeps = {
  ring: EncryptionKeyRing | null;
  fetchImpl?: typeof fetch;
};

export const MAX_CHANGE_SUMMARY_ATTEMPTS = 3;
const REQUEUE_AFTER_MS = 15 * 60_000;
const ABANDON_AFTER_MS = 24 * 60 * 60_000;
const RECONCILE_BATCH_SIZE = 500;

type ChangeSummaryFailureReason =
  | "timeout"
  | "provider"
  | "validation"
  | "source_missing"
  | "abandoned"
  | "no_route"
  | "no_change";

function isChangeSummaryFailureReason(
  value: string | null,
): value is ChangeSummaryFailureReason {
  switch (value) {
    case "timeout":
    case "provider":
    case "validation":
    case "source_missing":
    case "abandoned":
    case "no_route":
    case "no_change":
      return true;
    default:
      return false;
  }
}

type Terminal =
  | { status: "ready"; summary: string }
  | {
      status: "failed" | "skipped";
      failureReason: ChangeSummaryFailureReason;
      errorClass?: string;
    };

async function finish(
  db: PrismaClient,
  source: Pick<ChangeSummaryPayload, "projectId" | "commitSha">,
  attempts: number,
  outcome: Terminal,
): Promise<boolean> {
  const now = new Date();
  const result = await db.documentChangeSummary.updateMany({
    where: {
      projectId: source.projectId,
      commitSha: source.commitSha,
      status: "pending",
      attempts,
    },
    data: {
      status: outcome.status,
      summary: outcome.status === "ready" ? outcome.summary : null,
      failureReason: outcome.status === "ready" ? null : outcome.failureReason,
      ...(outcome.status === "ready"
        ? { lastErrorClass: null }
        : outcome.errorClass
          ? { lastErrorClass: outcome.errorClass }
          : {}),
      updatedAt: now,
      completedAt: now,
    },
  });
  return result.count === 1;
}

async function noteErrorClass(
  db: PrismaClient,
  source: Pick<ChangeSummaryPayload, "projectId" | "commitSha">,
  attempts: number,
  error: unknown,
): Promise<void> {
  await db.documentChangeSummary
    .updateMany({
      where: {
        projectId: source.projectId,
        commitSha: source.commitSha,
        status: "pending",
        attempts,
      },
      data: { lastErrorClass: safeErrorClass(error), updatedAt: new Date() },
    })
    .catch(() => undefined);
}

async function readSide(
  repo: ProjectRepoReader,
  sha: string,
  path: string,
  documentId: string,
): Promise<ChangeSummarySide | null> {
  const file = await repo.readCommittedFileAt(sha, path).catch(() => null);
  if (!file) return null;
  try {
    const parsed = parseDocumentFile(file.content, documentKindOfPath(path));
    return parsed.meta.id === documentId
      ? { title: parsed.meta.title, markdown: parsed.body }
      : null;
  } catch {
    return null;
  }
}

async function readSides(
  payload: ChangeSummaryPayload,
  basePathAtSha: string | null,
) {
  const repo = await openProjectRepo(payload.projectId);
  if (!repo) return null;
  const after = await readSide(
    repo,
    payload.commitSha,
    payload.pathAtSha,
    payload.documentId,
  );
  if (!after) return null;
  const basePath =
    basePathAtSha ??
    (await repo.renamedPathBetween(
      payload.commitSha,
      payload.baseCommitSha,
      payload.pathAtSha,
    )) ??
    payload.pathAtSha;
  const before = await readSide(
    repo,
    payload.baseCommitSha,
    basePath,
    payload.documentId,
  );
  return before ? { before, after } : null;
}

function recordUsage(
  db: PrismaClient,
  payload: ChangeSummaryPayload,
  model: LlmModelSnapshot,
  execution: JobExecution,
  usage: AiUsageSample,
  outcome: AiUsageOutcome,
): Promise<void> {
  return recordAiUsage(db, {
    projectId: payload.projectId,
    documentId: payload.documentId,
    jobId: execution.jobId,
    operation: "document.change_summary",
    connectionId: model.connectionId,
    provider: model.providerType,
    model: model.providerModelId,
    configFingerprint: createHash("sha256")
      .update(
        JSON.stringify([
          "document-summary-v2",
          model.connectionId,
          model.providerModelId,
        ]),
      )
      .digest("hex"),
    usage,
    outcome,
    pricing: model,
    currency: model.currency,
  }).then(
    () => undefined,
    (error: unknown) => {
      emitSummaryEvent("usage_failed", payload, {
        outcome,
        errorClass: safeErrorClass(error),
      });
    },
  );
}

export async function runDocumentChangeSummary(
  db: PrismaClient,
  payload: ChangeSummaryPayload,
  execution: JobExecution,
  deps: ChangeSummaryJobDeps,
): Promise<void> {
  const row = await db.documentChangeSummary.findUnique({
    where: {
      projectId_commitSha: {
        projectId: payload.projectId,
        commitSha: payload.commitSha,
      },
    },
  });
  if (row?.status !== "pending") return;
  if (row.attempts >= MAX_CHANGE_SUMMARY_ATTEMPTS) {
    const reason = isChangeSummaryFailureReason(row.failureReason)
      ? row.failureReason
      : "abandoned";
    if (
      await finish(db, payload, row.attempts, {
        status: "failed",
        failureReason: reason,
      })
    )
      emitSummaryEvent("failed", payload, { reason, attempts: row.attempts });
    return;
  }
  const attempts = row.attempts + 1;
  const claimed = await db.documentChangeSummary.updateMany({
    where: {
      projectId: payload.projectId,
      commitSha: payload.commitSha,
      status: "pending",
      attempts: row.attempts,
    },
    data: { attempts, lastJobId: execution.jobId, updatedAt: new Date() },
  });
  if (claimed.count === 0) return;
  try {
    await summarizeClaimedRow(
      db,
      payload,
      execution,
      deps,
      attempts,
      row.basePathAtSha,
    );
  } catch (error) {
    await noteErrorClass(db, payload, attempts, error);
    throw error;
  }
}

async function summarizeClaimedRow(
  db: PrismaClient,
  payload: ChangeSummaryPayload,
  execution: JobExecution,
  deps: ChangeSummaryJobDeps,
  attempts: number,
  basePathAtSha: string | null,
): Promise<void> {
  const stop = async (
    kind: "failed" | "skipped",
    reason: ChangeSummaryFailureReason,
    metrics: { durationMs?: number; statusCode?: number | null } = {},
    errorClass?: string,
  ) => {
    if (
      await finish(db, payload, attempts, {
        status: kind,
        failureReason: reason,
        ...(errorClass ? { errorClass } : {}),
      })
    )
      emitSummaryEvent(
        kind,
        payload,
        kind === "failed" ? { reason, attempts } : { reason },
        metrics,
      );
  };

  const model = await resolveLlmRoute(db, "document_summary");
  if (!model) return stop("skipped", "no_route");
  const sides = await readSides(payload, basePathAtSha);
  if (!sides) return stop("failed", "source_missing");
  if (
    sides.before.title === sides.after.title &&
    sides.before.markdown === sides.after.markdown
  )
    return stop("skipped", "no_change");
  const budget = changeSummaryBudget(model);
  if (!budget) return stop("failed", "validation");
  const prompt = buildChangeSummaryPrompt(
    sides.before,
    sides.after,
    budget.maxPromptBytes,
  );

  const started = Date.now();
  let completion: TextCompletionResult;
  try {
    completion = await withDiagnosticContext(
      { suppressProviderBodies: true, bodyProjectIds: [payload.projectId] },
      () =>
        createAdapterForSnapshot(
          model,
          createDbCredentialSource(db, deps.ring),
          deps.fetchImpl,
        ).completeText(
          model.providerModelId,
          {
            system: CHANGE_SUMMARY_SYSTEM,
            prompt,
            maxOutputTokens: budget.maxOutputTokens,
          },
          { signal: execution.signal, reasoning: model.reasoningMode },
        ),
    );
  } catch (error) {
    if (execution.signal.aborted) throw error;
    // Non-provider errors (credential/DB/etc.) retry via job.failed, not a stored failure.
    if (!(error instanceof AiProviderError)) throw error;
    const failure = classifyChangeSummaryFailure(error);
    const errorClass = safeErrorClass(error);
    await recordUsage(
      db,
      payload,
      model,
      execution,
      error.usage ?? emptyUsage(Date.now() - started),
      failure.reason === "validation"
        ? "validation_failure"
        : "provider_failure",
    );
    const metrics = {
      durationMs: Date.now() - started,
      statusCode: failure.statusCode,
    };
    if (failure.retryable && attempts < MAX_CHANGE_SUMMARY_ATTEMPTS) {
      const kept = await db.documentChangeSummary.updateMany({
        where: {
          projectId: payload.projectId,
          commitSha: payload.commitSha,
          status: "pending",
          attempts,
        },
        data: {
          failureReason: failure.reason,
          lastErrorClass: errorClass,
          updatedAt: new Date(),
        },
      });
      // A newer claim owns the row, or it already turned terminal; nothing to report.
      if (kept.count === 0) return;
      emitSummaryEvent(
        "retrying",
        payload,
        { reason: failure.reason, attempt: attempts },
        metrics,
      );
      throw error;
    }
    return stop("failed", failure.reason, metrics, errorClass);
  }
  // Accounting and persistence stay outside the provider try so DB errors are not misclassified.
  const summary = usableSummary(completion.text);
  await recordUsage(
    db,
    payload,
    model,
    execution,
    completion.usage,
    summary ? "success" : "validation_failure",
  );
  const durationMs = Date.now() - started;
  if (!summary) return stop("failed", "validation", { durationMs });
  if (await finish(db, payload, attempts, { status: "ready", summary }))
    emitSummaryEvent("completed", payload, { attempts }, { durationMs });
}

export async function reconcileDocumentChangeSummaries(
  db: PrismaClient,
  now: Date,
): Promise<{ requeued: number; abandoned: number }> {
  const select = {
    projectId: true,
    documentId: true,
    commitSha: true,
    baseCommitSha: true,
    pathAtSha: true,
    attempts: true,
  } as const;
  const expired = await db.documentChangeSummary.findMany({
    where: {
      status: "pending",
      createdAt: { lt: new Date(now.getTime() - ABANDON_AFTER_MS) },
    },
    orderBy: { createdAt: "asc" },
    take: RECONCILE_BATCH_SIZE,
    select,
  });
  let abandoned = 0;
  for (const row of expired) {
    if (
      await finish(db, row, row.attempts, {
        status: "failed",
        failureReason: "abandoned",
      })
    ) {
      abandoned += 1;
      emitSummaryEvent("failed", row, {
        reason: "abandoned",
        attempts: row.attempts,
      });
    }
  }
  const stale = await db.documentChangeSummary.findMany({
    where: {
      status: "pending",
      updatedAt: { lt: new Date(now.getTime() - REQUEUE_AFTER_MS) },
    },
    orderBy: { updatedAt: "asc" },
    take: RECONCILE_BATCH_SIZE,
    select,
  });
  let requeued = 0;
  for (const { attempts, ...payload } of stale) {
    try {
      if (
        (await requestKnowledgeJob("document.change-summary", payload)) !== null
      )
        requeued += 1;
    } catch {
      emitSummaryEvent("retrying", payload, {
        reason: "enqueue",
        attempt: attempts,
      });
    }
  }
  return { requeued, abandoned };
}

const PRUNE_AFTER_MS = 30 * 24 * 60 * 60_000;
const PRUNE_BATCH_SIZE = 1_000;
const PRUNE_MAX_BATCHES = 5;

export async function pruneDocumentChangeSummaries(
  db: PrismaClient,
  now: Date,
  options: { batchSize?: number; maxBatches?: number } = {},
): Promise<number> {
  const batchSize = options.batchSize ?? PRUNE_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? PRUNE_MAX_BATCHES;
  const where = {
    status: { in: ["failed" as const, "skipped" as const] },
    completedAt: { lt: new Date(now.getTime() - PRUNE_AFTER_MS) },
  };
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const keys = await db.documentChangeSummary.findMany({
      where,
      orderBy: { completedAt: "asc" },
      take: batchSize,
      select: { projectId: true, commitSha: true },
    });
    if (keys.length === 0) break;
    const result = await db.documentChangeSummary.deleteMany({
      where: { ...where, OR: keys },
    });
    deleted += result.count;
    if (keys.length < batchSize) break;
  }
  return deleted;
}

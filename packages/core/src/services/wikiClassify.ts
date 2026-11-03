import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@weaver/db/client";
import { emitDiagnostic } from "../diagnostics/writer";
import { CoreError } from "../errors";
import type { UserSecurityContext } from "../security/context";
import {
  CLASSIFY_MAX_PAGES,
  classifyPlanDigest,
  parseStoredClassifyPlan,
  type ClassifyCandidate,
  type ClassifyPlan,
} from "../wiki/classifyPlan";
import { WIKI_RUN_CAPS } from "../wiki/caps";
import { WIKI_ACTIVE_RUN_STATUSES } from "../wiki/states";
import { assertProjectRole } from "./projectAccess";
import { getLiveWikiAgent } from "./wikiAgents";
import {
  isUniqueViolation,
  lockEnabledSettings,
  runActive,
} from "./wikiInputs";
import { WikiRunSession } from "./wikiRunSession";
import {
  assertLiveWikiRun,
  assertWikiLiveness,
  endRun,
  heartbeatWikiRun,
  isClosedFence,
  leaseWikiRun,
  WIKI_RUN_HEARTBEAT_MS,
  WIKI_RUN_LEASE_MS,
} from "./wikiRuns";

type Actor = UserSecurityContext;

export const WIKI_CLASSIFY_PREVIEW_ATTEMPTS = 3;
export const WIKI_CLASSIFY_PLAN_TTL_MS = 24 * 60 * 60_000;

function sessionOwner(actor: Actor): void {
  if (actor.authenticationMethod !== "session")
    throw new CoreError("FORBIDDEN");
}

async function assertOwner(
  db: PrismaClient | Prisma.TransactionClient,
  actor: Actor,
  projectId: string,
): Promise<void> {
  sessionOwner(actor);
  await assertProjectRole(db, projectId, actor, "Owner", {
    capability: "content:write",
  });
}

/** Task outputs and the guide are never classified; source pages are excluded by the projection marker. */
async function protectedDocumentIds(
  db: PrismaClient,
  projectId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const [settings, tasks, runs] = await Promise.all([
    db.projectWikiSettings.findUnique({
      where: { projectId },
      select: { guideDocumentId: true },
    }),
    db.scheduledTask.findMany({
      where: { outputProjectId: projectId, outputDocumentId: { in: [...ids] } },
      select: { outputDocumentId: true },
    }),
    db.scheduledTaskRun.findMany({
      where: { outputDocumentId: { in: [...ids] } },
      select: { outputDocumentId: true },
    }),
  ]);
  const out = new Set<string>();
  if (settings?.guideDocumentId) out.add(settings.guideDocumentId);
  for (const row of [...tasks, ...runs])
    if (row.outputDocumentId) out.add(row.outputDocumentId);
  return out;
}

/** Markdown pages that lack a type or a summary, minus the guide, source pages, task outputs and exempt pages. */
export async function loadClassifyCandidates(
  db: PrismaClient,
  projectId: string,
  limit: number = CLASSIFY_MAX_PAGES,
): Promise<ClassifyCandidate[]> {
  const rows = await db.document.findMany({
    where: {
      projectId,
      kind: "markdown",
      wikiSourceItemId: null,
      reviewExempt: false,
      OR: [{ wikiType: null }, { wikiSummary: null }],
    },
    orderBy: [{ path: "asc" }, { id: "asc" }],
    take: limit + 20,
    select: {
      id: true,
      path: true,
      title: true,
      excerpt: true,
      headCommitSha: true,
      wikiType: true,
      wikiSummary: true,
    },
  });
  const blocked = await protectedDocumentIds(
    db,
    projectId,
    rows.map((row) => row.id),
  );
  return rows
    .filter((row) => !blocked.has(row.id))
    .slice(0, limit)
    .map((row) => ({
      documentId: row.id,
      path: row.path,
      title: row.title,
      excerpt: row.excerpt,
      headCommitSha: row.headCommitSha,
      hasType: row.wikiType !== null,
      hasSummary: row.wikiSummary !== null,
    }));
}

/** Owner only. The run waits in `preparing` for its preview, then for the Owner's decision. */
export async function startClassify(
  db: PrismaClient,
  actor: Actor,
  input: { projectId: string },
): Promise<{ runId: string }> {
  await assertOwner(db, actor, input.projectId);
  try {
    const runId = await db.$transaction(async (tx) => {
      await assertOwner(tx, actor, input.projectId);
      await lockEnabledSettings(tx, input.projectId);
      const agent = await getLiveWikiAgent(tx, input.projectId);
      if (!agent)
        throw new CoreError("CONFLICT", "The wiki agent has been revoked", {
          reason: "WIKI_DISABLED",
        });
      const active = await tx.wikiRun.count({
        where: {
          projectId: input.projectId,
          status: { in: [...WIKI_ACTIVE_RUN_STATUSES] },
        },
      });
      if (active > 0) throw runActive();
      const settings = await tx.projectWikiSettings.findUniqueOrThrow({
        where: { projectId: input.projectId },
        select: { destructivePausedAt: true },
      });
      if (settings.destructivePausedAt)
        throw new CoreError(
          "CONFLICT",
          "Wiki runs are paused: changes in the last 24 hours exceed the project's budget",
          { reason: "DESTRUCTIVE_PAUSED" },
        );
      const run = await tx.wikiRun.create({
        data: {
          projectId: input.projectId,
          agentId: agent.id,
          kind: "classify",
          trigger: "manual",
          startedById: actor.userId,
          status: "preparing",
        },
        select: { id: true },
      });
      return run.id;
    });
    emitDiagnostic({
      event: "wiki.run.started",
      message: "wiki classify run started",
      outcome: "ok",
      projectId: input.projectId,
      details: { runId, kind: "classify" },
    });
    return { runId };
  } catch (error) {
    if (isUniqueViolation(error)) throw runActive();
    throw error;
  }
}

/** What the Owner reviews; null until the preview has stored a plan. */
export async function readClassifyPlan(
  db: PrismaClient,
  actor: Actor,
  input: { projectId: string; runId: string },
): Promise<{ plan: ClassifyPlan; digest: string } | null> {
  await assertOwner(db, actor, input.projectId);
  const run = await db.wikiRun.findFirst({
    where: { id: input.runId, projectId: input.projectId, kind: "classify" },
    select: { plan: true, planDigest: true },
  });
  if (!run) throw new CoreError("NOT_FOUND", "Wiki run not found");
  if (!run.plan || !run.planDigest) return null;
  const plan = parseStoredClassifyPlan(run.plan);
  if (!plan || classifyPlanDigest(plan) !== run.planDigest) return null;
  return { plan, digest: run.planDigest };
}

/** The Owner accepts the exact plan they saw: a changed digest is refused and nothing starts. */
export async function acceptClassifyPlan(
  db: PrismaClient,
  actor: Actor,
  input: { projectId: string; runId: string; expectedPlanDigest: string },
  now: Date = new Date(),
): Promise<void> {
  await assertOwner(db, actor, input.projectId);
  await db.$transaction(async (tx) => {
    await assertOwner(tx, actor, input.projectId);
    await lockEnabledSettings(tx, input.projectId);
    await tx.$queryRaw`SELECT 1 FROM "WikiRun" WHERE "id" = ${input.runId}::uuid FOR UPDATE`;
    const run = await tx.wikiRun.findFirst({
      where: { id: input.runId, projectId: input.projectId, kind: "classify" },
      select: { status: true, plan: true, planDigest: true },
    });
    if (!run) throw new CoreError("NOT_FOUND", "Wiki run not found");
    if (run.status !== "preparing" || !run.plan || !run.planDigest)
      throw new CoreError(
        "CONFLICT",
        "This plan is not waiting for a decision",
        {
          reason: "PLAN_NOT_READY",
        },
      );
    const plan = parseStoredClassifyPlan(run.plan);
    if (
      !plan ||
      classifyPlanDigest(plan) !== run.planDigest ||
      run.planDigest !== input.expectedPlanDigest
    )
      throw new CoreError(
        "CONFLICT",
        "The plan changed since you reviewed it. Reload and review it again.",
        { reason: "PLAN_CHANGED" },
      );
    const settings = await tx.projectWikiSettings.findUniqueOrThrow({
      where: { projectId: input.projectId },
      select: { destructivePausedAt: true },
    });
    if (settings.destructivePausedAt)
      throw new CoreError(
        "CONFLICT",
        "Wiki runs are paused: changes in the last 24 hours exceed the project's budget",
        { reason: "DESTRUCTIVE_PAUSED" },
      );
    const { count } = await tx.wikiRun.updateMany({
      where: {
        id: input.runId,
        status: "preparing",
        planDigest: input.expectedPlanDigest,
      },
      data: { status: "queued", queuedAt: now },
    });
    if (count !== 1)
      throw new CoreError(
        "CONFLICT",
        "This plan is not waiting for a decision",
        {
          reason: "PLAN_NOT_READY",
        },
      );
  });
}

export async function rejectClassifyPlan(
  db: PrismaClient,
  actor: Actor,
  input: { projectId: string; runId: string },
): Promise<void> {
  await assertOwner(db, actor, input.projectId);
  const run = await db.wikiRun.findFirst({
    where: { id: input.runId, projectId: input.projectId, kind: "classify" },
    select: { id: true },
  });
  if (!run) throw new CoreError("NOT_FOUND", "Wiki run not found");
  const ended = await endRun(db, run.id, ["preparing"], {
    status: "cancelled",
    stopReason: "plan_rejected",
    note: "The classification plan was rejected.",
  });
  if (!ended)
    throw new CoreError("CONFLICT", "The plan is no longer waiting", {
      reason: "RUN_ENDED",
    });
}

export type ClassifyPreviewClaim = {
  id: string;
  projectId: string;
  agentId: string;
  leaseToken: string;
  attempt: number;
};

/** One worker previews a run; the conditional update leaves a second delivery nothing to claim. */
export async function claimClassifyPreview(
  db: PrismaClient,
  input: { runId: string; workerId: string; leaseMs?: number; now?: Date },
): Promise<ClassifyPreviewClaim | null> {
  const now = input.now ?? new Date();
  const leaseToken = randomUUID();
  const [row] = await db.wikiRun.updateManyAndReturn({
    where: {
      id: input.runId,
      kind: "classify",
      status: "preparing",
      plan: { equals: Prisma.DbNull },
      leaseToken: null,
    },
    data: {
      leaseToken,
      leaseExpiresAt: new Date(
        now.getTime() + (input.leaseMs ?? WIKI_RUN_LEASE_MS),
      ),
      workerId: input.workerId.slice(0, 128),
      attempts: { increment: 1 },
    },
    select: { id: true, projectId: true, agentId: true, attempts: true },
  });
  return row
    ? {
        id: row.id,
        projectId: row.projectId,
        agentId: row.agentId,
        leaseToken,
        attempt: row.attempts,
      }
    : null;
}

export async function heartbeatClassifyPreview(
  db: PrismaClient,
  claim: Pick<ClassifyPreviewClaim, "id" | "leaseToken">,
  leaseMs: number = WIKI_RUN_LEASE_MS,
): Promise<boolean> {
  const { count } = await db.wikiRun.updateMany({
    where: {
      id: claim.id,
      status: "preparing",
      leaseToken: claim.leaseToken,
    },
    data: { leaseExpiresAt: new Date(Date.now() + leaseMs) },
  });
  return count === 1;
}

/** Feature on, agent the run's own, run still preparing under this claim. */
export async function assertClassifyPreviewFence(
  db: PrismaClient,
  claim: ClassifyPreviewClaim,
): Promise<void> {
  await assertWikiLiveness(db, claim);
  const run = await db.wikiRun.findFirst({
    where: { id: claim.id, projectId: claim.projectId },
    select: { status: true, leaseToken: true },
  });
  if (run?.status !== "preparing" || run.leaseToken !== claim.leaseToken)
    throw new CoreError("CONFLICT", "The preview is no longer running", {
      reason: "WIKI_FENCE_CLOSED",
    });
}

/** The plan and its digest are written together, only by the claim that holds the lease. */
export async function storeClassifyPlan(
  db: PrismaClient,
  claim: ClassifyPreviewClaim,
  plan: ClassifyPlan,
): Promise<boolean> {
  const { count } = await db.wikiRun.updateMany({
    where: {
      id: claim.id,
      status: "preparing",
      leaseToken: claim.leaseToken,
    },
    data: {
      plan,
      planDigest: classifyPlanDigest(plan),
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
  return count === 1;
}

type ApplyResult = { applied: number; skipped: number };

async function applyPlan(
  db: PrismaClient,
  session: WikiRunSession,
  plan: ClassifyPlan,
  signal: AbortSignal,
): Promise<ApplyResult> {
  const result: ApplyResult = { applied: 0, skipped: 0 };
  const blocked = await protectedDocumentIds(
    db,
    session.projectId,
    plan.entries.map((entry) => entry.documentId),
  );
  for (const entry of plan.entries.slice(0, CLASSIFY_MAX_PAGES)) {
    signal.throwIfAborted();
    await session.assertLive();
    const row = await db.document.findFirst({
      where: { id: entry.documentId, projectId: session.projectId },
      select: {
        kind: true,
        wikiSourceItemId: true,
        reviewExempt: true,
        headCommitSha: true,
      },
    });
    // A page that changed since the preview is skipped: the plan was made from its older text.
    if (
      row?.kind !== "markdown" ||
      row.wikiSourceItemId !== null ||
      row.reviewExempt ||
      blocked.has(entry.documentId) ||
      row.headCommitSha !== entry.headCommitSha
    ) {
      result.skipped += 1;
      continue;
    }
    try {
      await session.classifyPage({
        documentId: entry.documentId,
        baseCommitSha: entry.headCommitSha,
        properties: {
          ...(entry.type !== undefined ? { type: entry.type } : {}),
          ...(entry.summary !== undefined ? { summary: entry.summary } : {}),
        },
      });
      result.applied += 1;
    } catch (error) {
      if (isClosedFence(error) || signal.aborted) throw error;
      if (
        error instanceof CoreError &&
        ["CONFLICT", "BAD_REQUEST", "FORBIDDEN", "NOT_FOUND"].includes(
          error.code,
        )
      ) {
        result.skipped += 1;
        continue;
      }
      throw error;
    }
  }
  return result;
}

/** The write phase: deterministic code applies exactly the stored plan, no model and no tools. */
export async function executeWikiClassify(
  db: PrismaClient,
  runId: string,
  options: { workerId: string; signal?: AbortSignal; heartbeatMs?: number },
): Promise<void> {
  const lease = await leaseWikiRun(db, { runId, workerId: options.workerId });
  if (!lease) return;
  const controller = new AbortController();
  let shutdown = false;
  const onExternal = () => {
    shutdown = true;
    controller.abort(new Error("worker shutting down"));
  };
  if (options.signal?.aborted) onExternal();
  options.signal?.addEventListener("abort", onExternal, { once: true });
  const heartbeat = setInterval(() => {
    void heartbeatWikiRun(db, lease).then(
      (held) => {
        if (!held) controller.abort(new Error("lease lost"));
      },
      () => undefined,
    );
  }, options.heartbeatMs ?? WIKI_RUN_HEARTBEAT_MS);
  const wall = setTimeout(
    () => controller.abort(new Error("wall clock")),
    WIKI_RUN_CAPS.classify.wallClockMs,
  );
  const end = (
    status: "succeeded" | "failed" | "stopped" | "cancelled",
    detail: {
      errorCode?: string;
      errorMessage?: string;
      stopReason?: string;
      summary?: string;
    },
  ) =>
    endRun(db, lease.id, ["running"], {
      status,
      leaseToken: lease.leaseToken,
      note: "The classification ended.",
      ...detail,
    });
  try {
    await assertLiveWikiRun(db, lease);
    const run = await db.wikiRun.findUniqueOrThrow({
      where: { id: lease.id },
      select: { plan: true, planDigest: true, startedById: true },
    });
    const plan = parseStoredClassifyPlan(run.plan);
    if (!plan || classifyPlanDigest(plan) !== run.planDigest) {
      await end("failed", {
        errorCode: "PLAN_INVALID",
        errorMessage: "The stored classification plan failed validation",
      });
      return;
    }
    const session = new WikiRunSession(db, lease);
    const { applied, skipped } = await applyPlan(
      db,
      session,
      plan,
      controller.signal,
    );
    await end("succeeded", {
      summary: `Set properties on ${applied} pages; skipped ${skipped} that changed or are no longer eligible.`,
    });
    emitDiagnostic({
      event: "wiki.run.succeeded",
      message: "wiki classify applied",
      outcome: "ok",
      projectId: lease.projectId,
      details: { runId: lease.id, applied, skipped },
    });
  } catch (error) {
    if (shutdown) return;
    if (controller.signal.aborted || isClosedFence(error)) {
      await end("stopped", { stopReason: "classify_interrupted" });
      return;
    }
    const message =
      error instanceof CoreError ? error.message : "the classification failed";
    await end("failed", {
      errorCode: "CLASSIFY_FAILED",
      errorMessage: message,
    });
    if (!(error instanceof CoreError)) throw error;
  } finally {
    clearInterval(heartbeat);
    clearTimeout(wall);
    options.signal?.removeEventListener("abort", onExternal);
  }
}

/** Preview claims whose worker vanished are released for another delivery; the third loss fails the run. */
export async function reapClassifyRuns(
  db: PrismaClient,
  now: Date,
): Promise<{ released: number; expired: number }> {
  const outcome = { released: 0, expired: 0 };
  const lost = await db.wikiRun.findMany({
    where: {
      kind: "classify",
      status: "preparing",
      leaseToken: { not: null },
      leaseExpiresAt: { lte: now },
    },
    select: { id: true, attempts: true, leaseToken: true },
  });
  for (const run of lost) {
    if (run.attempts >= WIKI_CLASSIFY_PREVIEW_ATTEMPTS) {
      const ended = await endRun(
        db,
        run.id,
        ["preparing"],
        {
          status: "failed",
          errorCode: "LEASE_LOST",
          errorMessage: "the worker previewing this plan stopped responding",
          note: "The classification ended.",
        },
        now,
      );
      if (ended) outcome.expired += 1;
      continue;
    }
    const { count } = await db.wikiRun.updateMany({
      where: {
        id: run.id,
        status: "preparing",
        leaseToken: run.leaseToken,
        leaseExpiresAt: { lte: now },
      },
      data: { leaseToken: null, leaseExpiresAt: null },
    });
    outcome.released += count;
  }
  const stale = await db.wikiRun.findMany({
    where: {
      kind: "classify",
      status: "preparing",
      leaseToken: null,
      startedAt: { lte: new Date(now.getTime() - WIKI_CLASSIFY_PLAN_TTL_MS) },
    },
    select: { id: true },
  });
  for (const run of stale) {
    const ended = await endRun(
      db,
      run.id,
      ["preparing"],
      {
        status: "cancelled",
        stopReason: "plan_expired",
        note: "The classification plan was not accepted in time.",
      },
      now,
    );
    if (ended) outcome.expired += 1;
  }
  return outcome;
}

/** Runs waiting for a preview, or for a model-free apply, that no worker has been asked about. */
export async function classifyRunsToDispatch(
  db: PrismaClient,
): Promise<string[]> {
  const rows = await db.wikiRun.findMany({
    where: {
      kind: "classify",
      OR: [
        {
          status: "preparing",
          plan: { equals: Prisma.DbNull },
          leaseToken: null,
        },
      ],
    },
    orderBy: [{ startedAt: "asc" }, { id: "asc" }],
    take: 100,
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

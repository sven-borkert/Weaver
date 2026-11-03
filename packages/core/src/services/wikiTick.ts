import { Prisma, type PrismaClient } from "@weaver/db/client";
import { emitDiagnostic } from "../diagnostics/writer";
import { requestKnowledgeJob } from "../jobs/queue";
import {
  afterPreparation,
  WIKI_NO_WORKER_LIMIT_MS,
  WIKI_PREPARING_LIMIT_MS,
} from "../wiki/states";
import { rollingDestructiveChars } from "./wikiRunSession";
import { retireWikiIngestionFile } from "./ingestion";
import { claimDueLintRuns } from "./wikiLint";
import { classifyRunsToDispatch, reapClassifyRuns } from "./wikiClassify";
import { prepareRunItems } from "./wikiPrepare";
import {
  emitRunEnded,
  endRun,
  endRunInTx,
  WIKI_NO_WORKER,
  WIKI_NO_WORKER_MESSAGE,
} from "./wikiRuns";

type PreparingRun = {
  id: string;
  projectId: string;
  agentId: string;
  startedAt: Date;
};

export type WikiTickOptions = {
  now?: Date;
  /** Replaces the pg-boss lookup in tests. */
  hasActiveRunJob?: () => Promise<boolean>;
};

/** Runs of one project still being prepared; the tick drives them in order. */
const PREPARING_BATCH = 50;
const PREPARE_TIMEOUT_MESSAGE =
  "Preparation did not finish within 75 minutes. Retry this input, or check that a worker is running.";

/** An active job proves a consumer is alive; a created one only proves a publisher was. */
export async function hasActiveWikiRunJob(db: PrismaClient): Promise<boolean> {
  const [schema] = await db.$queryRaw<Array<{ present: boolean }>>(Prisma.sql`
    SELECT to_regclass('pgboss.job') IS NOT NULL AS present
  `);
  if (!schema?.present) return false;
  const [row] = await db.$queryRaw<Array<{ active: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1 FROM pgboss.job WHERE name = 'wiki.run' AND state = 'active'
    ) AS active
  `);
  return row?.active === true;
}

async function concludePreparation(
  db: PrismaClient,
  run: PreparingRun,
  now: Date,
): Promise<void> {
  const items = await db.wikiInputItem.findMany({
    where: { runId: run.id },
    select: { status: true },
  });
  const next = afterPreparation(items);
  if (next === "queued") {
    await db.wikiRun.updateMany({
      where: { id: run.id, status: "preparing" },
      data: { status: "queued", queuedAt: now },
    });
  } else if (next === "stopped") {
    await endRun(
      db,
      run.id,
      ["preparing"],
      {
        status: "stopped",
        stopReason: "no_ready_items",
        note: "The run ended before this input was prepared.",
      },
      now,
    );
  }
}

async function failUnparsedAtLimit(
  db: PrismaClient,
  run: PreparingRun,
  now: Date,
): Promise<void> {
  if (now.getTime() - run.startedAt.getTime() < WIKI_PREPARING_LIMIT_MS) return;
  const failed = await db.$transaction(async (tx) => {
    const items = await tx.wikiInputItem.updateManyAndReturn({
      where: { runId: run.id, status: "preparing" },
      data: {
        status: "failed",
        errorCode: "PREPARE_TIMEOUT",
        errorMessage: PREPARE_TIMEOUT_MESSAGE,
        revision: { increment: 1 },
      },
      select: { id: true, ingestionFileId: true },
    });
    for (const item of items)
      if (item.ingestionFileId)
        await retireWikiIngestionFile(tx, item.ingestionFileId);
    return items;
  });
  for (const item of failed)
    emitDiagnostic({
      event: "wiki.input.failed",
      severity: "warn",
      message: "wiki input preparation timed out",
      outcome: "error",
      projectId: run.projectId,
      details: { itemId: item.id, code: "PREPARE_TIMEOUT" },
    });
}

const WIKI_MAX_ATTEMPTS = 3;
/** An input live in this many lost leases is treated as the cause and set aside. */
const WIKI_QUARANTINE_ATTEMPTS = 2;
const WIKI_OPERATION_RETENTION_MS = 90 * 24 * 60 * 60_000;
const QUARANTINE_MESSAGE =
  "The worker stopped twice while processing this input. Retry it, or remove it if it keeps failing.";
const LEASE_LOST_MESSAGE =
  "the worker running this wiki run stopped responding";

/** Restarts a lost run at most twice; the conversation is rebuilt from the ledger. */
export async function expireWikiRunLeases(
  db: PrismaClient,
  now: Date,
): Promise<{ restarted: number; failed: number }> {
  const lost = await db.wikiRun.findMany({
    where: { status: "running", leaseExpiresAt: { lte: now } },
    select: { id: true, projectId: true, attempts: true, leaseToken: true },
  });
  const outcome = { restarted: 0, failed: 0 };
  for (const run of lost) {
    let quarantined: string[] = [];
    const ended = await db.$transaction(async (tx) => {
      // The token check keeps a late heartbeat's renewed lease safe from this sweep.
      const { count } = await tx.wikiRun.updateMany({
        where: {
          id: run.id,
          status: "running",
          leaseToken: run.leaseToken,
          leaseExpiresAt: { lte: now },
        },
        data:
          run.attempts < WIKI_MAX_ATTEMPTS
            ? {
                status: "queued",
                queuedAt: now,
                leaseToken: null,
                leaseExpiresAt: null,
              }
            : { leaseExpiresAt: now },
      });
      if (count === 0) return "skipped" as const;
      const live = await tx.wikiInputItem.updateManyAndReturn({
        where: { runId: run.id, status: "processing" },
        data: { lostLeases: { increment: 1 } },
        select: { id: true, lostLeases: true },
      });
      quarantined = live
        .filter((item) => item.lostLeases >= WIKI_QUARANTINE_ATTEMPTS)
        .map((item) => item.id);
      if (quarantined.length > 0)
        await tx.wikiInputItem.updateMany({
          where: { id: { in: quarantined } },
          data: {
            status: "failed",
            errorCode: "QUARANTINED",
            errorMessage: QUARANTINE_MESSAGE,
            revision: { increment: 1 },
          },
        });
      if (run.attempts >= WIKI_MAX_ATTEMPTS)
        return endRunInTx(
          tx,
          run.id,
          ["running"],
          {
            status: "failed",
            errorCode: "LEASE_LOST",
            errorMessage: LEASE_LOST_MESSAGE,
            note: `This input was returned to the queue: ${LEASE_LOST_MESSAGE}.`,
          },
          now,
        );
      const remaining = await tx.wikiInputItem.count({
        where: { runId: run.id, status: { in: ["ready", "processing"] } },
      });
      if (remaining > 0) return "restarted" as const;
      return endRunInTx(
        tx,
        run.id,
        ["queued"],
        {
          status: "stopped",
          stopReason: "no_ready_items",
          note: "The run ended before this input was finished.",
        },
        now,
      );
    });
    for (const id of quarantined)
      emitDiagnostic({
        event: "wiki.input.failed",
        severity: "warn",
        message: "wiki input quarantined after repeated lost leases",
        outcome: "error",
        projectId: run.projectId,
        details: { itemId: id, code: "QUARANTINED" },
      });
    if (ended === "restarted") outcome.restarted += 1;
    else if (ended && ended !== "skipped") {
      emitRunEnded(ended);
      outcome.failed += 1;
    }
  }
  return outcome;
}

/** The 24-hour pause clears by itself once the rolling sum falls. */
async function clearDestructivePauses(db: PrismaClient, now: Date) {
  const paused = await db.projectWikiSettings.findMany({
    where: { destructivePausedAt: { not: null } },
    select: { projectId: true, destructiveBudget24h: true },
  });
  for (const row of paused) {
    const total = await rollingDestructiveChars(db, row.projectId, now);
    if (total >= row.destructiveBudget24h) continue;
    await db.projectWikiSettings.updateMany({
      where: { projectId: row.projectId, destructivePausedAt: { not: null } },
      data: { destructivePausedAt: null },
    });
  }
}

/** Notifies once a day and never stops anything. */
async function checkSpendAlerts(db: PrismaClient, now: Date) {
  const since = new Date(now.getTime() - 24 * 60 * 60_000);
  const alerts = await db.projectWikiSettings.findMany({
    where: {
      enabled: true,
      spendAlertCentsPerDay: { not: null },
      OR: [{ spendAlertedAt: null }, { spendAlertedAt: { lt: since } }],
    },
    select: { projectId: true, spendAlertCentsPerDay: true },
  });
  for (const row of alerts) {
    const { _sum: sum } = await db.aiUsage.aggregate({
      where: {
        projectId: row.projectId,
        operation: "wiki.run",
        createdAt: { gte: since },
      },
      _sum: { costMicros: true },
    });
    const limitMicros = BigInt(row.spendAlertCentsPerDay!) * 10_000n;
    if ((sum.costMicros ?? 0n) <= limitMicros) continue;
    await db.projectWikiSettings.updateMany({
      where: { projectId: row.projectId },
      data: { spendAlertedAt: now },
    });
    emitDiagnostic({
      event: "wiki.settings.changed",
      severity: "warn",
      message: "wiki spend alert reached; runs continue",
      outcome: "ok",
      projectId: row.projectId,
      details: { change: "spend_alert" },
    });
  }
}

async function pruneRunOperations(db: PrismaClient, now: Date) {
  await db.wikiRunOperation.deleteMany({
    where: {
      createdAt: { lt: new Date(now.getTime() - WIKI_OPERATION_RETENTION_MS) },
      run: { status: { in: ["succeeded", "stopped", "failed", "cancelled"] } },
    },
  });
}

/** Survives a role with no consumer: system.reconcile runs this on every worker. */
export async function reapWikiRuns(
  db: PrismaClient,
  options: WikiTickOptions = {},
): Promise<{ cancelled: number; timedOut: number }> {
  const now = options.now ?? new Date();
  await expireWikiRunLeases(db, now);
  await clearDestructivePauses(db, now);
  await checkSpendAlerts(db, now);
  await pruneRunOperations(db, now);
  await reapClassifyRuns(db, now);
  const overdue = await db.wikiRun.findMany({
    where: {
      kind: "ingest",
      status: "preparing",
      startedAt: { lte: new Date(now.getTime() - WIKI_PREPARING_LIMIT_MS) },
    },
    select: { id: true, projectId: true, agentId: true, startedAt: true },
  });
  for (const run of overdue) {
    await failUnparsedAtLimit(db, run, now);
    await concludePreparation(db, run, now);
  }
  const stale = await db.wikiRun.findMany({
    where: {
      status: "queued",
      queuedAt: { lte: new Date(now.getTime() - WIKI_NO_WORKER_LIMIT_MS) },
    },
    select: { id: true },
  });
  let cancelled = 0;
  if (stale.length > 0) {
    const active = await (
      options.hasActiveRunJob ?? (() => hasActiveWikiRunJob(db))
    )();
    if (!active)
      for (const run of stale) {
        const ended = await db.$transaction((tx) =>
          endRunInTx(
            tx,
            run.id,
            ["queued"],
            {
              status: "cancelled",
              stopReason: "no_worker",
              errorCode: WIKI_NO_WORKER,
              errorMessage: WIKI_NO_WORKER_MESSAGE,
              note: `This input was returned to the queue: ${WIKI_NO_WORKER_MESSAGE}.`,
            },
            now,
          ),
        );
        if (ended) {
          emitRunEnded(ended);
          cancelled += 1;
        }
      }
  }
  return { cancelled, timedOut: overdue.length };
}

/** Oldest first; each project holds at most one run, so this is round-robin by project. */
async function dispatchQueuedRuns(db: PrismaClient): Promise<number> {
  const queued = await db.wikiRun.findMany({
    where: { status: "queued" },
    orderBy: [{ queuedAt: "asc" }, { id: "asc" }],
    select: { id: true },
    take: 100,
  });
  for (const run of queued)
    await requestKnowledgeJob("wiki.run", { runId: run.id });
  const previews = await classifyRunsToDispatch(db);
  for (const runId of previews)
    await requestKnowledgeJob("wiki.run", { runId });
  return queued.length + previews.length;
}

/** One minute delivery; every transition is conditional, so several workers may run it at once. */
export async function runWikiTick(
  db: PrismaClient,
  options: WikiTickOptions = {},
): Promise<{ prepared: number; dispatched: number; cancelled: number }> {
  const now = options.now ?? new Date();
  const preparing = await db.wikiRun.findMany({
    where: { status: "preparing", kind: "ingest" },
    orderBy: [{ startedAt: "asc" }, { id: "asc" }],
    take: PREPARING_BATCH,
    select: { id: true, projectId: true, agentId: true, startedAt: true },
  });
  const errors: unknown[] = [];
  for (const run of preparing) {
    try {
      await prepareRunItems(db, run);
      await failUnparsedAtLimit(db, run, now);
      await concludePreparation(db, run, now);
    } catch (error) {
      errors.push(error);
    }
  }
  const { cancelled } = await reapWikiRuns(db, options);
  try {
    await claimDueLintRuns(db, now);
  } catch (error) {
    errors.push(error);
  }
  const dispatched = await dispatchQueuedRuns(db);
  if (errors.length)
    throw new AggregateError(errors, "wiki.tick failed for some runs");
  return { prepared: preparing.length, dispatched, cancelled };
}

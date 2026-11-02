import { Prisma, type PrismaClient } from "@weaver/db/client";
import { emitDiagnostic } from "../diagnostics/writer";
import { requestKnowledgeJob } from "../jobs/queue";
import {
  afterPreparation,
  WIKI_NO_WORKER_LIMIT_MS,
  WIKI_PREPARING_LIMIT_MS,
} from "../wiki/states";
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
  const failed = await db.wikiInputItem.updateManyAndReturn({
    where: { runId: run.id, status: "preparing" },
    data: {
      status: "failed",
      errorCode: "PREPARE_TIMEOUT",
      errorMessage: PREPARE_TIMEOUT_MESSAGE,
      revision: { increment: 1 },
    },
    select: { id: true },
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

/** Survives a role with no consumer: system.reconcile runs this on every worker. */
export async function reapWikiRuns(
  db: PrismaClient,
  options: WikiTickOptions = {},
): Promise<{ cancelled: number; timedOut: number }> {
  const now = options.now ?? new Date();
  const overdue = await db.wikiRun.findMany({
    where: {
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
  return queued.length;
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
  const dispatched = await dispatchQueuedRuns(db);
  if (errors.length)
    throw new AggregateError(errors, "wiki.tick failed for some runs");
  return { prepared: preparing.length, dispatched, cancelled };
}

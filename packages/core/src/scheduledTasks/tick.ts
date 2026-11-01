import type { PrismaClient } from "@weaver/db/client";
import {
  claimDueTasks,
  dispatchTaskRun,
  expireAbandonedRuns,
  listStaleQueuedRuns,
} from "../services/scheduledTasks";

const STALE_QUEUED_MS = 2 * 60_000;

/** One minute-tick delivery (spec §6): claim, dispatch, re-dispatch stale, expire abandoned. Safe to run from several workers at once. */
export async function runTaskTick(
  db: PrismaClient,
  now: Date = new Date(),
): Promise<{ claimed: number; redispatched: number; expired: number }> {
  const claimed = await claimDueTasks(db, now);
  for (const run of claimed) await dispatchTaskRun(db, run);
  const stale = await listStaleQueuedRuns(
    db,
    new Date(now.getTime() - STALE_QUEUED_MS),
  );
  for (const run of stale) await dispatchTaskRun(db, run);
  const expired = await expireAbandonedRuns(db, now);
  return { claimed: claimed.length, redispatched: stale.length, expired };
}

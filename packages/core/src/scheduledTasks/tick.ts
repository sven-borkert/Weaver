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
  const errors: unknown[] = [];
  const attempt = async <T>(
    work: () => Promise<T>,
    fallback: T,
  ): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      errors.push(error);
      return fallback;
    }
  };
  const claimed = await attempt(() => claimDueTasks(db, now), []);
  for (const run of claimed)
    await attempt(() => dispatchTaskRun(db, run), null);
  const stale = await attempt(
    () => listStaleQueuedRuns(db, new Date(now.getTime() - STALE_QUEUED_MS)),
    [],
  );
  for (const run of stale) await attempt(() => dispatchTaskRun(db, run), null);
  const expired = await attempt(() => expireAbandonedRuns(db, now), 0);
  if (errors.length)
    throw new AggregateError(
      errors,
      "Scheduled task tick failed for some tasks",
    );
  return { claimed: claimed.length, redispatched: stale.length, expired };
}

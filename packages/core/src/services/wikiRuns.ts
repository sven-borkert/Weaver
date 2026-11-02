import type { Prisma, PrismaClient, WikiRunStatus } from "@weaver/db/client";
import { emitDiagnostic } from "../diagnostics/writer";
import { CoreError } from "../errors";
import { redactSecrets } from "../security/redactSecrets";
import type { UserSecurityContext } from "../security/context";
import {
  WIKI_ACTIVE_RUN_STATUSES,
  WIKI_IN_RUN_ITEM_STATUSES,
} from "../wiki/states";
import { assertProjectRole, notDeleted } from "./projectAccess";

type Tx = Prisma.TransactionClient;

export const WIKI_RUNNER_UNAVAILABLE = "RUNNER_UNAVAILABLE";
export const WIKI_NO_WORKER = "NO_WORKER";
export const WIKI_NO_WORKER_MESSAGE = "no worker is consuming wiki runs";
const RUNNER_UNAVAILABLE_MESSAGE =
  "This version of Weaver prepares sources but does not run the wiki agent yet.";

export type WikiRunEnd = {
  status: Extract<
    WikiRunStatus,
    "succeeded" | "stopped" | "failed" | "cancelled"
  >;
  stopReason?: string;
  errorCode?: string;
  errorMessage?: string;
  /** Shown on every item handed back to the queue. */
  note: string;
};

export type WikiRunEnded = {
  projectId: string;
  runId: string;
  status: WikiRunEnd["status"];
  errorCode: string | null;
  stopReason: string | null;
  returned: number;
};

/** Ends a run only from an expected status and returns its unfinished items to the queue. */
export async function endRunInTx(
  tx: Tx,
  runId: string,
  from: readonly WikiRunStatus[],
  end: WikiRunEnd,
  now: Date = new Date(),
): Promise<WikiRunEnded | null> {
  const errorMessage = end.errorMessage
    ? redactSecrets(end.errorMessage).slice(0, 500)
    : null;
  const ended = await tx.wikiRun.updateManyAndReturn({
    where: { id: runId, status: { in: [...from] } },
    data: {
      status: end.status,
      endedAt: now,
      stopReason: end.stopReason ?? null,
      errorCode: end.errorCode ?? null,
      errorMessage,
      leaseToken: null,
      leaseExpiresAt: null,
    },
    select: { id: true, projectId: true },
  });
  const run = ended[0];
  if (!run) return null;
  const returned = await tx.wikiInputItem.updateMany({
    where: { runId, status: { in: [...WIKI_IN_RUN_ITEM_STATUSES] } },
    data: {
      status: "queued",
      runId: null,
      outcomeNote: redactSecrets(end.note).slice(0, 2_000),
      revision: { increment: 1 },
    },
  });
  return {
    projectId: run.projectId,
    runId,
    status: end.status,
    errorCode: end.errorCode ?? null,
    stopReason: end.stopReason ?? null,
    returned: returned.count,
  };
}

/** Called after the transaction commits, so the log never reports a rolled-back end. */
export function emitRunEnded(ended: WikiRunEnded): void {
  emitDiagnostic({
    event: `wiki.run.${ended.status}`,
    severity: ended.status === "failed" ? "warn" : "info",
    message: `wiki run ${ended.status}`,
    outcome: ended.status === "failed" ? "error" : "ok",
    projectId: ended.projectId,
    details: {
      runId: ended.runId,
      errorCode: ended.errorCode,
      stopReason: ended.stopReason,
      returnedItems: ended.returned,
    },
  });
}

export async function endRun(
  db: PrismaClient,
  runId: string,
  from: readonly WikiRunStatus[],
  end: WikiRunEnd,
  now?: Date,
): Promise<WikiRunEnded | null> {
  const ended = await db.$transaction((tx) =>
    endRunInTx(tx, runId, from, end, now),
  );
  if (ended) emitRunEnded(ended);
  return ended;
}

export function cancelActiveRunsInTx(
  tx: Tx,
  projectId: string,
  note: string,
): Promise<WikiRunEnded[]> {
  return cancelRunsInStatuses(tx, projectId, ["queued", "preparing"], note);
}

// A running run is left to its own fence, which sees the disabled feature within one step.
async function cancelRunsInStatuses(
  tx: Tx,
  projectId: string,
  statuses: readonly WikiRunStatus[],
  note: string,
): Promise<WikiRunEnded[]> {
  const runs = await tx.wikiRun.findMany({
    where: { projectId, status: { in: [...statuses] } },
    select: { id: true },
  });
  const ended: WikiRunEnded[] = [];
  for (const run of runs) {
    const result = await endRunInTx(tx, run.id, statuses, {
      status: "cancelled",
      stopReason: "wiki_disabled",
      note,
    });
    if (result) ended.push(result);
  }
  return ended;
}

export async function cancelRun(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: { projectId: string; runId: string },
): Promise<void> {
  if (actor.authenticationMethod !== "session")
    throw new CoreError("FORBIDDEN");
  await assertProjectRole(db, input.projectId, actor, "Editor", {
    capability: "content:write",
  });
  const ended = await db.$transaction(async (tx) => {
    const run = await tx.wikiRun.findFirst({
      where: { id: input.runId, projectId: input.projectId },
      select: { id: true },
    });
    if (!run) throw new CoreError("NOT_FOUND", "Wiki run not found");
    return endRunInTx(tx, run.id, WIKI_ACTIVE_RUN_STATUSES, {
      status: "cancelled",
      stopReason: "user",
      note: "The run was cancelled before this input was finished.",
    });
  });
  if (!ended)
    throw new CoreError("CONFLICT", "The run has already ended", {
      reason: "RUN_ENDED",
    });
  emitRunEnded(ended);
}

/** The slice's whole run consumer: a delivered run ends visibly instead of hanging. */
export async function failRunWithoutRunner(
  db: PrismaClient,
  runId: string,
): Promise<boolean> {
  const ended = await endRun(db, runId, ["queued"], {
    status: "failed",
    errorCode: WIKI_RUNNER_UNAVAILABLE,
    errorMessage: RUNNER_UNAVAILABLE_MESSAGE,
    note: `${RUNNER_UNAVAILABLE_MESSAGE} Prepared sources are kept and reused the next time this input is processed.`,
  });
  return ended !== null;
}

export function closedFence(message: string): CoreError {
  return new CoreError("CONFLICT", message, { reason: "WIKI_FENCE_CLOSED" });
}

export function isClosedFence(error: unknown): boolean {
  return (
    error instanceof CoreError && error.details?.reason === "WIKI_FENCE_CLOSED"
  );
}

/** Feature on, agent live and the run's own, project live, run preparing, item preparing for this run. */
export async function assertPreparingFence(
  db: PrismaClient,
  input: {
    projectId: string;
    runId: string;
    agentId: string;
    itemId: string;
    /** Files: the item's pinned digest must still be the artifact's content. */
    fileDigest?: string;
  },
): Promise<void> {
  const [settings, agent, project, run, item] = await Promise.all([
    db.projectWikiSettings.findUnique({
      where: { projectId: input.projectId },
      select: { enabled: true, agentId: true },
    }),
    db.wikiAgent.findFirst({
      where: { id: input.agentId, projectId: input.projectId, revokedAt: null },
      select: { id: true },
    }),
    db.project.findFirst({
      where: { id: input.projectId, ...notDeleted },
      select: { id: true },
    }),
    db.wikiRun.findFirst({
      where: {
        id: input.runId,
        projectId: input.projectId,
        agentId: input.agentId,
      },
      select: { status: true },
    }),
    db.wikiInputItem.findFirst({
      where: {
        id: input.itemId,
        projectId: input.projectId,
        runId: input.runId,
      },
      select: {
        status: true,
        artifactDigest: true,
        artifact: { select: { contentDigest: true } },
      },
    }),
  ]);
  if (!settings?.enabled || settings.agentId !== input.agentId || !agent)
    throw closedFence("The wiki is disabled or its agent changed");
  if (!project) throw closedFence("The project was deleted");
  if (run?.status !== "preparing")
    throw closedFence("The run is not preparing");
  if (item?.status !== "preparing")
    throw closedFence("The input is no longer being prepared");
  if (
    input.fileDigest !== undefined &&
    (item.artifactDigest !== input.fileDigest ||
      item.artifact?.contentDigest !== input.fileDigest)
  )
    throw closedFence("The input file no longer matches its pinned digest");
}

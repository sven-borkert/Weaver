export { sweepStaleGitRemoteKeys } from "@weaver/git-store/remote";
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@weaver/db/client";
import type { CommitAuthor } from "@weaver/git-store";
import {
  fetchRemoteBranch,
  GitRemoteError,
  pushProjectToRemote,
} from "@weaver/git-store/remote";
import { captureError } from "../diagnostics/writer";
import { parseKnowledgeConfig } from "../knowledge/config";
import { requestKnowledgeJob, type JobQueue } from "../jobs/queue";
import type { KnowledgeJobPayloads } from "../jobs/types";
import {
  loadEncryptionKeyRing,
  type EncryptionKeyRing,
} from "../security/encryption";
import { decryptProjectGitRemoteKey } from "./projectGitRemote";
import { mergeFetchedBranch } from "./projectGitRemoteMerge";
import { withExistingProjectRepo } from "./projectRepo";
import { lockProjectMembershipWrites } from "./projectMembers";
import {
  discoverProjectGitProjectionRepairs,
  markProjectGitProjectionRepairs,
  repairProjectAfterGitPull,
} from "./projectGitProjectionRepairs";

/** A zero-uuid sentinel for the "Weaver-User-Id" commit trailer when neither
 * the requesting user nor any real id is available (never the
 * ProjectGitRemote row's own id, which is not a user). */
/** Weaver-User-Id for commits no user made (system maintenance). */
export const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

export const PROJECT_GIT_LEASE_MS = 180_000;
export const PROJECT_GIT_QUEUE_TTL_MS = 120_000;
const CHECK_INTERVAL_MS = 60_000;
const RETRY_MINUTES = [1, 5, 15, 60];

function retryAt(now: Date, failureCount: number): Date {
  return new Date(
    now.getTime() + (RETRY_MINUTES[Math.min(failureCount, 3)] ?? 60) * 60_000,
  );
}

/** Records a failed remote attempt for administrators; the stored error code is all a project member sees. */
function captureRemoteFailure(
  event: "git.remote.push_failed" | "git.remote.pull_failed",
  row: { projectId: string; remoteUrl: string; branch: string },
  code: string,
  error: unknown,
): void {
  captureError({
    event,
    message: `Git ${event === "git.remote.push_failed" ? "push" : "pull"} failed: ${code}`,
    error,
    projectId: row.projectId,
    details: {
      code,
      remoteUrl: row.remoteUrl,
      branch: row.branch,
      cause: error instanceof GitRemoteError ? error.detail : null,
    },
  });
}

function availableLease(now: Date): Prisma.ProjectGitRemoteWhereInput {
  return { OR: [{ leaseToken: null }, { leaseExpiresAt: { lte: now } }] };
}

const eligible: Prisma.ProjectGitRemoteWhereInput = {
  enabled: true,
  credentialCiphertext: { not: null },
  credentialNonce: { not: null },
  credentialTag: { not: null },
  credentialKeyVersion: { not: null },
  project: { deletedAt: null },
};

/** A pull needs a decryptable key and a live project, but never the `enabled`
 * automatic-push flag — pulling existing remote content is available even
 * when automatic pushes are off. */
const eligibleForPull: Prisma.ProjectGitRemoteWhereInput = {
  credentialCiphertext: { not: null },
  credentialNonce: { not: null },
  credentialTag: { not: null },
  credentialKeyVersion: { not: null },
  project: { deletedAt: null },
};

async function claimAndSend(
  db: PrismaClient,
  queue: Pick<JobQueue, "send">,
  row: {
    id: string;
    projectId: string;
    revision: number;
    failureCount: number;
  },
  now: Date,
  due: Prisma.ProjectGitRemoteWhereInput,
): Promise<boolean> {
  const queueToken = randomUUID();
  const claimed = await db.projectGitRemote.updateMany({
    where: { ...due, id: row.id, revision: row.revision },
    data: {
      queueToken,
      queuedAt: now,
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
  if (!claimed.count) return false;
  try {
    const jobId = await queue.send("project.git-push", {
      projectId: row.projectId,
      queueToken,
    });
    if (!jobId) throw new Error("Publication declined");
    return true;
  } catch {
    await db.projectGitRemote.updateMany({
      where: {
        id: row.id,
        revision: row.revision,
        queueToken,
        leaseToken: null,
      },
      data: {
        queueToken: null,
        queuedAt: null,
        lastErrorCode: "QUEUE_UNAVAILABLE",
        failureCount: Math.min(row.failureCount + 1, 2_147_483_647),
        nextAttemptAt: retryAt(now, row.failureCount),
      },
    });
    return false;
  }
}

export async function discoverProjectGitRemotes(input: {
  db: PrismaClient;
  queue: Pick<JobQueue, "send">;
  now?: Date;
}): Promise<number> {
  const now = input.now ?? new Date();
  const due: Prisma.ProjectGitRemoteWhereInput = {
    ...eligible,
    nextAttemptAt: { lte: now },
    AND: [
      availableLease(now),
      {
        OR: [
          { queueToken: null },
          {
            queuedAt: {
              lte: new Date(now.getTime() - PROJECT_GIT_QUEUE_TTL_MS),
            },
          },
        ],
      },
    ],
  };
  const rows = await input.db.projectGitRemote.findMany({
    where: due,
    orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
    take: 100,
    select: { id: true, projectId: true, revision: true, failureCount: true },
  });
  await discoverProjectGitProjectionRepairs(input.db, input.queue);
  let dispatched = 0;
  for (const row of rows) {
    if (await claimAndSend(input.db, input.queue, row, now, due))
      dispatched += 1;
  }
  return dispatched;
}

/** Claims and sends one push for a single project outside the minute tick —
 * called right after remote configuration or content changes so a push does
 * not wait for the next discovery pass. */
export async function dispatchProjectGitRemote(input: {
  db: PrismaClient;
  queue?: Pick<JobQueue, "send">;
  projectId: string;
  now?: Date;
}): Promise<boolean> {
  // Only the default (queue-less) path depends on WEAVER_JOBS_ENABLED — an
  // explicitly passed queue (e.g. the minute tick's) is always used, and
  // requestKnowledgeJob returning null when jobs are disabled would otherwise
  // be read as a real send failure and mark the row QUEUE_UNAVAILABLE.
  if (!input.queue && !parseKnowledgeConfig(process.env).jobsEnabled) {
    return false;
  }
  const now = input.now ?? new Date();
  const queue = input.queue ?? { send: requestKnowledgeJob };
  const due: Prisma.ProjectGitRemoteWhereInput = {
    ...eligible,
    projectId: input.projectId,
    AND: [
      availableLease(now),
      {
        OR: [
          { queueToken: null },
          {
            queuedAt: {
              lte: new Date(now.getTime() - PROJECT_GIT_QUEUE_TTL_MS),
            },
          },
        ],
      },
    ],
  };
  const row = await input.db.projectGitRemote.findFirst({
    where: due,
    select: { id: true, projectId: true, revision: true, failureCount: true },
  });
  if (!row) return false;
  return claimAndSend(input.db, queue, row, now, due);
}

/** Best-effort: marks a due-now eligible remote and dispatches immediately after
 * a content commit. Never throws — the minute discovery tick remains the
 * fallback if this fails or a push is not yet due. */
export async function notifyProjectContentChanged(
  db: PrismaClient,
  projectId: string,
): Promise<void> {
  try {
    const now = new Date();
    const marked = await db.projectGitRemote.updateMany({
      where: {
        ...eligible,
        projectId,
        queueToken: null,
        failureCount: 0,
        AND: [availableLease(now)],
      },
      data: { nextAttemptAt: now },
    });
    if (marked.count) await dispatchProjectGitRemote({ db, projectId, now });
  } catch (error) {
    captureError({
      event: "git.remote.dispatch_failed",
      message: "git push dispatch after content change failed",
      error,
      projectId,
    });
  }
}

export async function pushProjectGitRemote(input: {
  db: PrismaClient;
  payload: KnowledgeJobPayloads["project.git-push"];
  ring?: EncryptionKeyRing | null;
  now?: Date;
  signal?: AbortSignal;
  transport?: typeof pushProjectToRemote;
}): Promise<void> {
  if (input.signal?.aborted) return;
  const now = input.now ?? new Date();
  const leaseToken = randomUUID();
  const row = await input.db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${input.payload.projectId}::uuid FOR UPDATE`;
    const current = await tx.projectGitRemote.findFirst({
      where: {
        ...eligible,
        projectId: input.payload.projectId,
        queueToken: input.payload.queueToken,
      },
    });
    if (!current) return null;
    const admitted = await tx.projectGitRemote.updateMany({
      where: {
        ...eligible,
        id: current.id,
        revision: current.revision,
        queueToken: input.payload.queueToken,
        AND: [availableLease(now)],
      },
      data: {
        leaseToken,
        leaseExpiresAt: new Date(now.getTime() + PROJECT_GIT_LEASE_MS),
        queueToken: null,
        queuedAt: null,
        lastAttemptAt: now,
      },
    });
    return admitted.count ? current : null;
  });
  if (!row) return;
  const fence = { id: row.id, revision: row.revision, leaseToken };
  try {
    let privateKey: string;
    try {
      privateKey = decryptProjectGitRemoteKey(
        row,
        input.ring === undefined ? loadEncryptionKeyRing() : input.ring,
      );
    } catch (error) {
      await input.db.projectGitRemote.updateMany({
        where: fence,
        data: {
          lastErrorCode: "KEY_UNAVAILABLE",
          failureCount: Math.min(row.failureCount + 1, 2_147_483_647),
          nextAttemptAt: retryAt(now, row.failureCount),
        },
      });
      captureRemoteFailure(
        "git.remote.push_failed",
        row,
        "KEY_UNAVAILABLE",
        error,
      );
      return;
    }
    const deadline = AbortSignal.timeout(120_000);
    const signal = input.signal
      ? AbortSignal.any([input.signal, deadline])
      : deadline;
    try {
      const result = await (input.transport ?? pushProjectToRemote)({
        projectId: row.projectId,
        remoteUrl: row.remoteUrl,
        branch: row.branch,
        privateKey,
        knownHosts: row.knownHosts,
        lastPushedSha: row.lastPushedSha,
        signal,
      });
      const finishedAt = input.now ?? new Date();
      await input.db.projectGitRemote.updateMany({
        where: fence,
        data: {
          lastPushedSha: result.commitSha,
          ...(result.skipped ? {} : { lastPushedAt: finishedAt }),
          knownHosts: result.knownHosts,
          lastErrorCode: null,
          failureCount: 0,
          nextAttemptAt: new Date(finishedAt.getTime() + CHECK_INTERVAL_MS),
        },
      });
    } catch (error) {
      const finishedAt = input.now ?? new Date();
      const code =
        deadline.aborted && !input.signal?.aborted
          ? "TIMEOUT"
          : error instanceof GitRemoteError
            ? error.code
            : "PUSH_FAILED";
      captureRemoteFailure("git.remote.push_failed", row, code, error);
      await input.db.projectGitRemote.updateMany({
        where: fence,
        data: {
          lastErrorCode: code,
          ...(error instanceof GitRemoteError && error.knownHosts
            ? { knownHosts: error.knownHosts }
            : {}),
          failureCount: Math.min(row.failureCount + 1, 2_147_483_647),
          nextAttemptAt: retryAt(finishedAt, row.failureCount),
        },
      });
    }
  } finally {
    // A changed configuration must still release the admitted attempt's own lease.
    await input.db.projectGitRemote.updateMany({
      where: { id: row.id, leaseToken },
      data: { leaseToken: null, leaseExpiresAt: null },
    });
  }
}

export async function pullProjectGitRemote(input: {
  db: PrismaClient;
  payload: KnowledgeJobPayloads["project.git-pull"];
  ring?: EncryptionKeyRing | null;
  now?: Date;
  signal?: AbortSignal;
  fetch?: typeof fetchRemoteBranch;
}): Promise<void> {
  if (input.signal?.aborted) return;
  const now = input.now ?? new Date();
  const leaseToken = randomUUID();
  const row = await input.db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${input.payload.projectId}::uuid FOR UPDATE`;
    const current = await tx.projectGitRemote.findFirst({
      where: {
        ...eligibleForPull,
        projectId: input.payload.projectId,
        pullQueueToken: input.payload.pullToken,
      },
    });
    if (!current) return null;
    const admitted = await tx.projectGitRemote.updateMany({
      where: {
        ...eligibleForPull,
        id: current.id,
        revision: current.revision,
        pullQueueToken: input.payload.pullToken,
        AND: [availableLease(now)],
      },
      data: {
        leaseToken,
        leaseExpiresAt: new Date(now.getTime() + PROJECT_GIT_LEASE_MS),
        pullQueueToken: null,
        // As push admission does: an abandoned queued push must not block
        // this job's own follow-up dispatch for the queue TTL.
        queueToken: null,
        queuedAt: null,
        lastAttemptAt: now,
      },
    });
    return admitted.count ? current : null;
  });
  if (!row) return;
  const fence = { id: row.id, revision: row.revision, leaseToken };
  // dispatchProjectGitRemote requires this row's own lease to be free, so it
  // must run only after the `finally` below has released it.
  let dispatchAfterRelease = false;
  try {
    let privateKey: string;
    try {
      privateKey = decryptProjectGitRemoteKey(
        row,
        input.ring === undefined ? loadEncryptionKeyRing() : input.ring,
      );
    } catch {
      await input.db.projectGitRemote.updateMany({
        where: fence,
        data: { lastPullErrorCode: "KEY_UNAVAILABLE" },
      });
      return;
    }

    // Only the fetch is bounded — the merge itself performs no network I/O.
    const deadline = AbortSignal.timeout(60_000);
    const signal = input.signal
      ? AbortSignal.any([input.signal, deadline])
      : deadline;
    let fetched: Awaited<ReturnType<typeof fetchRemoteBranch>>;
    try {
      fetched = await (input.fetch ?? fetchRemoteBranch)({
        remoteUrl: row.remoteUrl,
        branch: row.branch,
        privateKey,
        knownHosts: row.knownHosts,
        signal,
      });
    } catch (error) {
      const code =
        deadline.aborted && !input.signal?.aborted
          ? "TIMEOUT"
          : error instanceof GitRemoteError
            ? error.code
            : "MERGE_FAILED";
      captureRemoteFailure("git.remote.pull_failed", row, code, error);
      await input.db.projectGitRemote.updateMany({
        where: fence,
        data: {
          lastPullErrorCode: code,
          ...(error instanceof GitRemoteError && error.knownHosts
            ? { knownHosts: error.knownHosts }
            : {}),
        },
      });
      return;
    }

    try {
      // The fetch may have consumed most of the lease; the merge scans both
      // trees, so it starts with a full window rather than expiring midway
      // and leaving a merge commit whose outcome no fenced update can record.
      const renewedForMerge = await input.db.projectGitRemote.updateMany({
        where: fence,
        data: {
          leaseExpiresAt: new Date(
            (input.now ?? new Date()).getTime() + PROJECT_GIT_LEASE_MS,
          ),
        },
      });
      if (!renewedForMerge.count) return;
      const requester = row.pullRequestedById
        ? await input.db.user.findUnique({
            where: { id: row.pullRequestedById },
            select: { id: true, name: true, email: true },
          })
        : null;
      // Fallback commit author when the requester is gone: a fixed sentinel
      // id, never the ProjectGitRemote row's own id (M4 — that id is not a
      // user and must not end up in the Weaver-User-Id trailer).
      const author: CommitAuthor = requester
        ? {
            name: requester.name,
            email: requester.email,
            userId: requester.id,
          }
        : {
            name: "Weaver",
            email: "weaver@local",
            userId: row.pullRequestedById ?? SYSTEM_USER_ID,
          };

      let merged: { mergedSha: string } | null;
      let durableMergeSha: string | null = null;
      try {
        merged = await withExistingProjectRepo(row.projectId, async (repo) => {
          if (
            !(await markProjectGitProjectionRepairs(
              input.db,
              row.projectId,
              fence,
            ))
          )
            return null;
          return input.db.$transaction(
            async (tx) => {
              await lockProjectMembershipWrites(tx, row.projectId);
              await tx.$queryRaw`SELECT "id" FROM "ProjectGitRemote" WHERE "id" = ${row.id}::uuid FOR UPDATE`;
              if (
                !(await tx.projectGitRemote.findFirst({
                  where: { ...eligibleForPull, ...fence },
                }))
              )
                return null;
              const localHeadBefore = await repo.resolveHead();
              const outcome = await mergeFetchedBranch(tx, repo, {
                projectId: row.projectId,
                bareDirectory: fetched.bareDirectory,
                branch: row.branch,
                remoteHead: fetched.remoteHead,
                author,
              });
              durableMergeSha = outcome.mergedSha;
              const noOp = outcome.mergedSha === localHeadBefore;
              const needsReview = !noOp && !outcome.fastForward;
              const finishedAt = input.now ?? new Date();
              // Settings cannot re-enable pushes between publication and this pause.
              const recorded = await tx.projectGitRemote.updateMany({
                where: fence,
                data: {
                  lastPullSha: outcome.mergedSha,
                  lastPullAt: finishedAt,
                  lastPullErrorCode: null,
                  ...(fetched.knownHosts?.trim()
                    ? { knownHosts: fetched.knownHosts }
                    : {}),
                  ...(noOp ? {} : { lastPushedSha: null }),
                  ...(needsReview
                    ? { enabled: false, revision: { increment: 1 } }
                    : {}),
                  nextAttemptAt: finishedAt,
                },
              });
              if (!recorded.count) return null;
              if (needsReview) fence.revision += 1;
              dispatchAfterRelease = noOp || outcome.fastForward;
              return { mergedSha: outcome.mergedSha };
            },
            { timeout: PROJECT_GIT_LEASE_MS },
          );
        });
      } catch (error) {
        if (durableMergeSha) {
          // Git cannot roll back with PostgreSQL; retain the outcome and pause safely.
          const recovered = await input.db.projectGitRemote.updateMany({
            where: { id: row.id, leaseToken },
            data: {
              enabled: false,
              revision: { increment: 1 },
              lastPullSha: durableMergeSha,
              lastPullAt: input.now ?? new Date(),
              lastPullErrorCode: null,
              lastPushedSha: null,
            },
          });
          captureError({
            event: "git.remote.pull_rebuild_failed",
            message: "pull outcome transaction failed after Git commit",
            error,
            projectId: row.projectId,
          });
          if (!recovered.count) return;
          const recoveredRow = await input.db.projectGitRemote.findUnique({
            where: { id: row.id },
          });
          if (!recoveredRow) return;
          fence.revision = recoveredRow.revision;
          dispatchAfterRelease = false;
          merged = { mergedSha: durableMergeSha };
        } else {
          await input.db.projectGitRemote.updateMany({
            where: fence,
            data: {
              lastPullErrorCode:
                error instanceof GitRemoteError ? error.code : "MERGE_FAILED",
              ...(fetched.knownHosts?.trim()
                ? { knownHosts: fetched.knownHosts }
                : {}),
            },
          });
          return;
        }
      }
      if (!merged) {
        // The project has no committed repository to merge into.
        await input.db.projectGitRemote.updateMany({
          where: fence,
          data: {
            lastPullErrorCode: "MERGE_FAILED",
            ...(fetched.knownHosts?.trim()
              ? { knownHosts: fetched.knownHosts }
              : {}),
          },
        });
        return;
      }
    } finally {
      await fetched.dispose();
    }
  } finally {
    await input.db.projectGitRemote.updateMany({
      where: { id: row.id, leaseToken },
      data: { leaseToken: null, leaseExpiresAt: null },
    });
  }
  await repairProjectAfterGitPull(
    input.db,
    row.projectId,
    leaseToken,
    input.signal,
  );
  if (dispatchAfterRelease) {
    await dispatchProjectGitRemote({
      db: input.db,
      projectId: row.projectId,
      now: input.now ?? new Date(),
    }).catch(() => false);
  }
}

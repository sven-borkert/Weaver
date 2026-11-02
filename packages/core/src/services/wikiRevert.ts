import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@weaver/db/client";
import { emitDiagnostic } from "../diagnostics/writer";
import { CoreError } from "../errors";
import { requestKnowledgeJob } from "../jobs/queue";
import {
  createTaskSecurityContext,
  type UserSecurityContext,
} from "../security/context";
import { formatWikiOperationId } from "../wiki/budget";
import { WIKI_RUN_CAPS } from "../wiki/caps";
import {
  recoverCheckApply,
  matchesRecoveryIdentity,
  type AppliedOperation,
  type ContentOperation,
  type RecoveryIdentity,
} from "./contentOperations";
import {
  deleteDocumentInRepo,
  restoreDocumentInRepo,
  type EnrichedActor,
} from "./documents";
import { assertProjectRole, notDeleted } from "./projectAccess";
import { notifyProjectContentChanged } from "./projectGitRemoteJobs";
import { withProjectRepo } from "./projectRepo";
import {
  closedFence,
  endRun,
  heartbeatWikiRun,
  isClosedFence,
  leaseWikiRun,
  WIKI_RUN_HEARTBEAT_MS,
  type LeasedWikiRun,
} from "./wikiRuns";

const HISTORY_WALK_LIMIT = 500;
const REVERT_SUMMARY = "Revert of a wiki run";
const TERMINAL = ["succeeded", "stopped", "failed", "cancelled"] as const;
const RETENTION_MS = 90 * 24 * 60 * 60_000;

export type WikiRevertSkip = {
  documentId: string;
  path: string | null;
  reason: "edited_after_run" | "later_run" | "gone" | "source_page";
};
export type WikiRevertReport = {
  restored: string[];
  deleted: string[];
  skipped: WikiRevertSkip[];
};

/** Terminal runs only, within the operation window; refused for a run already reverted. */
export async function startRevert(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: { projectId: string; runId: string },
): Promise<{ runId: string }> {
  if (actor.authenticationMethod !== "session")
    throw new CoreError("FORBIDDEN");
  await assertProjectRole(db, input.projectId, actor, "Editor", {
    capability: "content:write",
  });
  let created: string;
  try {
    created = await db.$transaction(async (tx) => {
      const source = await tx.wikiRun.findFirst({
        where: { id: input.runId, projectId: input.projectId },
        select: { id: true, kind: true, status: true, agentId: true },
      });
      if (!source) throw new CoreError("NOT_FOUND", "Wiki run not found");
      if (source.kind === "revert")
        throw new CoreError("CONFLICT", "A revert cannot be reverted", {
          reason: "NOT_REVERTIBLE",
        });
      if (!(TERMINAL as readonly string[]).includes(source.status))
        throw new CoreError("CONFLICT", "The run has not ended", {
          reason: "RUN_ACTIVE",
        });
      const operations = await tx.wikiRunOperation.count({
        where: { runId: source.id, status: "committed" },
      });
      if (operations === 0)
        throw new CoreError(
          "CONFLICT",
          "This run has nothing left to revert; its operations are gone or it wrote nothing",
          { reason: "NOT_REVERTIBLE" },
        );
      const previous = await tx.wikiRun.count({
        where: { revertsRunId: source.id, status: "succeeded" },
      });
      if (previous > 0)
        throw new CoreError("CONFLICT", "This run was already reverted", {
          reason: "ALREADY_REVERTED",
        });
      const run = await tx.wikiRun.create({
        data: {
          projectId: input.projectId,
          agentId: source.agentId,
          kind: "revert",
          trigger: "manual",
          startedById: actor.userId,
          status: "queued",
          queuedAt: new Date(),
          revertsRunId: source.id,
        },
        select: { id: true },
      });
      return run.id;
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    )
      throw new CoreError("CONFLICT", "A wiki run is already active", {
        reason: "RUN_ACTIVE",
      });
    throw error;
  }
  await requestKnowledgeJob("wiki.run", { runId: created });
  return { runId: created };
}

/** Not the agent's fence: a revert runs while the feature is disabled, the agent revoked or paused. */
async function assertRevertFence(
  db: PrismaClient,
  lease: Pick<LeasedWikiRun, "id" | "projectId" | "leaseToken">,
): Promise<void> {
  const [project, run] = await Promise.all([
    db.project.findFirst({
      where: { id: lease.projectId, ...notDeleted },
      select: { id: true },
    }),
    db.wikiRun.findUnique({
      where: { id: lease.id },
      select: { status: true, leaseToken: true },
    }),
  ]);
  if (!project) throw closedFence("The project was deleted");
  if (run?.status !== "running" || run.leaseToken !== lease.leaseToken)
    throw closedFence("The revert's lease is gone");
}

function revertHash(parts: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify(["wiki-revert", ...parts]))
    .digest("hex");
}

/** The two kinds a revert may write. Unreachable from tool dispatch: only this module calls it. */
async function applyRevertWrite(
  db: PrismaClient,
  lease: LeasedWikiRun,
  actor: EnrichedActor,
  write:
    | {
        kind: "restore";
        documentId: string;
        toSha: string;
        expectedHead: string;
      }
    | { kind: "delete"; documentId: string; expectedHead: string },
): Promise<void> {
  const requestHash = revertHash([
    write.kind,
    write.documentId,
    write.expectedHead,
    write.kind === "restore" ? write.toSha : "",
  ]);
  const { n, operationId } = await db.$transaction(async (tx) => {
    const [run] = await tx.wikiRun.updateManyAndReturn({
      where: {
        id: lease.id,
        status: "running",
        leaseToken: lease.leaseToken,
      },
      data: { operationCounter: { increment: 1 }, writes: { increment: 1 } },
      select: { operationCounter: true },
    });
    if (!run) throw closedFence("The revert's lease is gone");
    const allocated = run.operationCounter;
    const id = formatWikiOperationId("wiki-revert", lease.id, allocated);
    await tx.wikiRunOperation.create({
      data: {
        runId: lease.id,
        n: allocated,
        toolName: write.kind === "restore" ? "revert_restore" : "revert_delete",
        requestHash,
        operationId: id,
        documentId: write.documentId,
        baseCommitSha: write.expectedHead,
      },
    });
    return { n: allocated, operationId: id };
  });
  const identity: RecoveryIdentity = { wikiRevertRequestHash: requestHash };
  const audit = {
    operationId,
    wikiRequestHash: requestHash,
    beforeCommit: async () => {
      await assertRevertFence(db, lease);
      await assertProjectRole(db, lease.projectId, actor, "Editor");
    },
  };
  const operation: ContentOperation =
    write.kind === "restore"
      ? ({
          kind: "content.restore",
          projectId: lease.projectId,
          resourceType: "document",
          resourceId: write.documentId,
          mode: "version",
          sourceSha: write.toSha,
          expectedHeadCommitSha: write.expectedHead,
        } as ContentOperation)
      : ({
          kind: "content.lifecycle",
          action: "item_delete",
          projectId: lease.projectId,
          resourceType: "document",
          resourceId: write.documentId,
          expectedHeadCommitSha: write.expectedHead,
        } as ContentOperation);
  try {
    const outcome = await withProjectRepo(lease.projectId, (repo) =>
      recoverCheckApply({
        db,
        repo,
        operation,
        operationId,
        identity,
        apply: async (): Promise<AppliedOperation> => {
          if (write.kind === "restore") {
            const result = await restoreDocumentInRepo(
              db,
              repo,
              {
                projectId: lease.projectId,
                documentId: write.documentId,
                sha: write.toSha,
                expectedHeadCommitSha: write.expectedHead,
                restoreProperties: true,
              },
              actor,
              audit,
            );
            return {
              commitSha: result.headCommitSha,
              resourceId: result.id,
              path: result.path,
            };
          }
          const result = await deleteDocumentInRepo(
            db,
            repo,
            { projectId: lease.projectId, documentId: write.documentId },
            actor,
            audit,
          );
          return {
            commitSha: result.headCommitSha,
            resourceId: result.id,
            path: result.path,
          };
        },
      }),
    );
    await db.wikiRunOperation.update({
      where: { runId_n: { runId: lease.id, n } },
      data: {
        status: "committed",
        commitSha: outcome.applied.commitSha,
        committedAt: new Date(),
        path: outcome.applied.path.slice(0, 1_024),
      },
    });
    if (outcome.committed)
      void notifyProjectContentChanged(db, lease.projectId);
  } catch (error) {
    await db.wikiRunOperation
      .update({
        where: { runId_n: { runId: lease.id, n } },
        data: { status: "failed" },
      })
      .catch(() => undefined);
    throw error;
  }
}

/** Runs before any new decision, so a crashed revert never writes a page twice. */
async function reconcileReservedRevertOperations(
  db: PrismaClient,
  lease: LeasedWikiRun,
): Promise<void> {
  const reserved = await db.wikiRunOperation.findMany({
    where: { runId: lease.id, status: "reserved" },
  });
  if (reserved.length === 0) return;
  await withProjectRepo(lease.projectId, async (repo) => {
    for (const operation of reserved) {
      const entries = await repo.logForPath(".", {
        skip: 0,
        limit: 2,
        operationId: operation.operationId,
      });
      const entry = entries.find(
        (candidate) => candidate.operationId === operation.operationId,
      );
      const verified =
        entry &&
        entries.length === 1 &&
        matchesRecoveryIdentity(entry, {
          wikiRevertRequestHash: operation.requestHash,
        });
      await db.wikiRunOperation.update({
        where: { runId_n: { runId: lease.id, n: operation.n } },
        data: verified
          ? {
              status: "committed",
              commitSha: entry.sha,
              committedAt: new Date(),
            }
          : { status: "failed" },
      });
    }
  });
}

type PagePlan = {
  documentId: string;
  created: boolean;
  firstCommit: string;
  firstBase: string | null;
};

function planPages(
  operations: ReadonlyArray<{
    documentId: string | null;
    toolName: string;
    commitSha: string | null;
    baseCommitSha: string | null;
  }>,
): PagePlan[] {
  const pages = new Map<string, PagePlan>();
  for (const operation of operations) {
    if (!operation.documentId || !operation.commitSha) continue;
    if (!pages.has(operation.documentId))
      pages.set(operation.documentId, {
        documentId: operation.documentId,
        created: operation.toolName === "wiki_create_page",
        firstCommit: operation.commitSha,
        firstBase: operation.baseCommitSha,
      });
  }
  return [...pages.values()];
}

/** The whole path from the run's first commit to head must be this run's, or this revert's own. */
async function decidePage(
  repo: {
    logForPath: Parameters<
      Parameters<typeof withProjectRepo>[1]
    >[0]["logForPath"];
  },
  page: PagePlan,
  path: string,
  source: { id: string; agentId: string },
  revertRunId: string,
): Promise<
  | { action: "skip"; reason: WikiRevertSkip["reason"] }
  | { action: "done" }
  | { action: "write"; head: string }
> {
  const history = await repo.logForPath(path, {
    skip: 0,
    limit: HISTORY_WALK_LIMIT,
  });
  const head = history[0];
  if (!head) return { action: "skip", reason: "gone" };
  const own = (entry: (typeof history)[number]) =>
    entry.trustedAuthor === true &&
    entry.operationId?.startsWith(`wiki-revert:${revertRunId}:`) === true;
  if (own(head)) return { action: "done" };
  const firstIndex = history.findIndex(
    (entry) => entry.sha === page.firstCommit,
  );
  if (firstIndex === -1) return { action: "skip", reason: "edited_after_run" };
  let laterRun = false;
  for (const entry of history.slice(0, firstIndex + 1)) {
    const ofRun =
      entry.trustedAuthor === true &&
      entry.wikiAgentId === source.agentId &&
      entry.runId === source.id &&
      entry.operationId?.startsWith(`wiki-run:${source.id}:`) === true;
    if (ofRun || own(entry)) continue;
    if (
      entry.trustedAuthor === true &&
      entry.operationId?.startsWith("wiki-run:") === true
    ) {
      laterRun = true;
      continue;
    }
    return { action: "skip", reason: "edited_after_run" };
  }
  if (laterRun) return { action: "skip", reason: "later_run" };
  return { action: "write", head: head.sha };
}

async function runRevert(
  db: PrismaClient,
  lease: LeasedWikiRun,
  signal: AbortSignal,
): Promise<WikiRevertReport> {
  const run = await db.wikiRun.findUniqueOrThrow({
    where: { id: lease.id },
    select: { revertsRunId: true },
  });
  if (!run.revertsRunId || !lease.startedById)
    throw new CoreError(
      "PRECONDITION_FAILED",
      "The revert has no run or no person to act for",
      { reason: "REVERT_UNAVAILABLE" },
    );
  const source = await db.wikiRun.findUniqueOrThrow({
    where: { id: run.revertsRunId },
    select: { id: true, agentId: true },
  });
  const starter = await db.user.findUniqueOrThrow({
    where: { id: lease.startedById },
    select: { id: true, role: true, name: true, email: true },
  });
  const actor: EnrichedActor = {
    ...createTaskSecurityContext({
      userId: starter.id,
      globalRole: starter.role,
      runId: lease.id,
    }),
    name: starter.name,
    email: starter.email,
  };
  await assertProjectRole(db, lease.projectId, actor, "Editor");
  await reconcileReservedRevertOperations(db, lease);
  const operations = await db.wikiRunOperation.findMany({
    where: { runId: source.id, status: "committed" },
    orderBy: { n: "asc" },
    select: {
      documentId: true,
      toolName: true,
      commitSha: true,
      baseCommitSha: true,
    },
  });
  const report: WikiRevertReport = { restored: [], deleted: [], skipped: [] };
  const pages = planPages(operations);
  const reverted = await db.wikiRunOperation.findMany({
    where: { runId: lease.id, status: "committed" },
    select: { documentId: true, toolName: true },
  });
  for (const page of pages) {
    signal.throwIfAborted();
    await assertRevertFence(db, lease);
    const done = reverted.find((op) => op.documentId === page.documentId);
    if (done) {
      (done.toolName === "revert_delete"
        ? report.deleted
        : report.restored
      ).push(page.documentId);
      continue;
    }
    const row = await db.document.findFirst({
      where: { id: page.documentId, projectId: lease.projectId },
      select: { path: true, wikiSourceItemId: true },
    });
    if (!row) {
      report.skipped.push({
        documentId: page.documentId,
        path: null,
        reason: "gone",
      });
      continue;
    }
    // Source pages are never touched, whatever the ledger says.
    if (row.wikiSourceItemId !== null) {
      report.skipped.push({
        documentId: page.documentId,
        path: row.path,
        reason: "source_page",
      });
      continue;
    }
    const decision = await withProjectRepo(lease.projectId, (repo) =>
      decidePage(repo, page, row.path, source, lease.id),
    );
    if (decision.action === "skip") {
      report.skipped.push({
        documentId: page.documentId,
        path: row.path,
        reason: decision.reason,
      });
      continue;
    }
    if (decision.action === "done") {
      (page.created ? report.deleted : report.restored).push(page.documentId);
      continue;
    }
    // A first version has nothing to restore, so a created page is soft-deleted instead.
    if (page.created || !page.firstBase) {
      await applyRevertWrite(db, lease, actor, {
        kind: "delete",
        documentId: page.documentId,
        expectedHead: decision.head,
      });
      report.deleted.push(page.documentId);
    } else {
      await applyRevertWrite(db, lease, actor, {
        kind: "restore",
        documentId: page.documentId,
        toSha: page.firstBase,
        expectedHead: decision.head,
      });
      report.restored.push(page.documentId);
    }
  }
  return report;
}

/** The whole of a revert run: no model and no tools. */
export async function executeWikiRevert(
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
    WIKI_RUN_CAPS.revert.wallClockMs,
  );
  const end = (
    status: "succeeded" | "failed" | "stopped",
    detail: { errorCode?: string; errorMessage?: string; stopReason?: string },
  ) =>
    endRun(db, lease.id, ["running"], {
      status,
      leaseToken: lease.leaseToken,
      note: "The revert ended.",
      ...detail,
    });
  try {
    const report = await runRevert(db, lease, controller.signal);
    const sourceRun = (
      await db.wikiRun.findUniqueOrThrow({
        where: { id: lease.id },
        select: { revertsRunId: true },
      })
    ).revertsRunId!;
    await db.$transaction(async (tx) => {
      await tx.wikiRun.update({
        where: { id: lease.id },
        data: {
          report,
          summary: `Restored ${report.restored.length} and removed ${report.deleted.length} pages; skipped ${report.skipped.length}.`,
        },
      });
      await tx.wikiInputItem.updateMany({
        where: {
          runId: sourceRun,
          projectId: lease.projectId,
          status: "processed",
        },
        data: {
          status: "reverted",
          outcomeNote: "The run that processed this input was reverted.",
          revision: { increment: 1 },
        },
      });
    });
    await end("succeeded", {});
    emitDiagnostic({
      event: "wiki.revert.completed",
      message: "wiki revert completed",
      outcome: "ok",
      projectId: lease.projectId,
      details: {
        runId: lease.id,
        revertsRunId: sourceRun,
        restored: report.restored.length,
        deleted: report.deleted.length,
        skipped: report.skipped.length,
      },
    });
  } catch (error) {
    if (shutdown) return;
    if (controller.signal.aborted || isClosedFence(error)) {
      await end("stopped", { stopReason: "revert_interrupted" });
      return;
    }
    const message =
      error instanceof CoreError ? error.message : "the revert failed";
    await end("failed", { errorCode: "REVERT_FAILED", errorMessage: message });
    if (!(error instanceof CoreError)) throw error;
  } finally {
    clearInterval(heartbeat);
    clearTimeout(wall);
    options.signal?.removeEventListener("abort", onExternal);
  }
}

/** The tick and Runs tab ask this; a run's operations are kept for 90 days. */
export function isWithinRevertWindow(endedAt: Date | null, now: Date): boolean {
  return endedAt !== null && now.getTime() - endedAt.getTime() <= RETENTION_MS;
}

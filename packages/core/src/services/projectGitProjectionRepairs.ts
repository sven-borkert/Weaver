import { Prisma, type PrismaClient } from "@weaver/db/client";
import { captureError } from "../diagnostics/writer";
import { requestKnowledgeJob, type JobQueue } from "../jobs/queue";
import {
  knowledgeJobSendOptions,
  type KnowledgeJobPayloads,
} from "../jobs/types";
import { toOrganizationRole } from "../roles";
import { createSessionSecurityContext } from "../security/context";
import { rebuildIndex } from "./documents";
import { rebuildTableIndex } from "./tables";
import { notDeleted } from "./projectAccess";

const JOB = "project.git-rebuild";
type Repair = KnowledgeJobPayloads[typeof JOB];
const KINDS = ["document", "table"] as const;
const tokenFields = {
  document: "gitDocumentRepairToken",
  table: "gitTableRepairToken",
} as const;

export async function markProjectGitProjectionRepairs(
  db: PrismaClient,
  projectId: string,
  fence: { id: string; revision: number; leaseToken: string },
): Promise<boolean> {
  // Commit the repair intent independently of the pull's outcome transaction.
  const updated = await db.$executeRaw`
    UPDATE "Project"
    SET "gitDocumentRepairToken" = ${fence.leaseToken}::uuid,
        "gitTableRepairToken" = ${fence.leaseToken}::uuid
    WHERE "id" = ${projectId}::uuid AND "deletedAt" IS NULL
      AND EXISTS (
        SELECT 1 FROM "ProjectGitRemote"
        WHERE "id" = ${fence.id}::uuid AND "revision" = ${fence.revision}
          AND "leaseToken" = ${fence.leaseToken}::uuid
      )
  `;
  return updated === 1;
}

export async function runProjectGitProjectionRepair(
  db: PrismaClient,
  repair: Repair,
  signal?: AbortSignal,
): Promise<void> {
  const { projectId, kind, token } = repair;
  const current = await db.project.findFirst({
    where: { id: projectId, ...notDeleted, [tokenFields[kind]]: token },
    select: {
      organization: {
        select: {
          members: {
            where: { role: toOrganizationRole("Owner") },
            orderBy: [{ createdAt: "asc" }, { userId: "asc" }],
            take: 1,
            select: { userId: true, user: { select: { role: true } } },
          },
        },
      },
    },
  });
  if (!current) return;
  const owner = current.organization.members[0];
  if (!owner)
    throw new Error("No project Owner available to rebuild after Git pull");
  signal?.throwIfAborted();
  const rebuild = kind === "document" ? rebuildIndex : rebuildTableIndex;
  await rebuild(
    db,
    { projectId },
    createSessionSecurityContext({
      userId: owner.userId,
      globalRole: owner.user.role,
      sessionId: "git-pull",
    }),
  );
  signal?.throwIfAborted();
  const column =
    kind === "document"
      ? Prisma.sql`"gitDocumentRepairToken"`
      : Prisma.sql`"gitTableRepairToken"`;
  await db.$executeRaw`
    UPDATE "Project" SET ${column} = NULL
    WHERE "id" = ${projectId}::uuid AND ${column} = ${token}::uuid
  `;
}

async function publishRepair(
  repair: Repair,
  queue: Pick<JobQueue, "send">,
): Promise<void> {
  try {
    await queue.send(JOB, repair, knowledgeJobSendOptions(JOB, repair));
  } catch (error) {
    captureError({
      event: "git.remote.pull_rebuild_failed",
      message: "Could not queue projection repair after Git pull",
      projectId: repair.projectId,
      error,
      details: { kind: repair.kind },
    });
  }
}

export async function repairProjectAfterGitPull(
  db: PrismaClient,
  projectId: string,
  token: string,
  signal?: AbortSignal,
): Promise<void> {
  await Promise.all(
    KINDS.map(async (kind) => {
      const repair = { projectId, kind, token };
      try {
        await runProjectGitProjectionRepair(db, repair, signal);
      } catch (error) {
        captureError({
          event: "git.remote.pull_rebuild_failed",
          message: "Projection repair after Git pull will retry",
          projectId,
          error,
          details: { kind },
        });
        await publishRepair(repair, { send: requestKnowledgeJob });
      }
    }),
  );
}

export async function discoverProjectGitProjectionRepairs(
  db: PrismaClient,
  queue: Pick<JobQueue, "send">,
): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const pending = await db.project.findMany({
      where: {
        ...notDeleted,
        ...(cursor ? { id: { gt: cursor } } : {}),
        OR: [
          { gitDocumentRepairToken: { not: null } },
          { gitTableRepairToken: { not: null } },
        ],
      },
      orderBy: { id: "asc" },
      take: 100,
      select: {
        id: true,
        gitDocumentRepairToken: true,
        gitTableRepairToken: true,
      },
    });
    for (const project of pending)
      for (const kind of KINDS) {
        const token = project[tokenFields[kind]];
        if (token)
          await publishRepair({ projectId: project.id, kind, token }, queue);
      }
    if (pending.length < 100) return;
    cursor = pending.at(-1)!.id;
  }
}

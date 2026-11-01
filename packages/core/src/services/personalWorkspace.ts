import { withProjectRepo } from "./projectRepo";
import { rm } from "node:fs/promises";
import { Prisma, type PrismaClient } from "@weaver/db/client";
import { createSessionSecurityContext } from "@weaver/core/security/context";
import { captureError } from "@weaver/core/diagnostics/writer";
import { toOrganizationRole } from "@weaver/core/roles";
import { repoDir } from "@weaver/git-store";
import { notDeleted } from "./projectAccess";
import { createProject } from "./projects";
import { syncProjectMetadataQuietly } from "./projectMetadata";
import { linkUserToProjectReview } from "./projectReviewerLinks";

const MAX_PROJECT_NAME = 120;
const LOCK_KEY = "weaver:personal-workspace";

export function personalWorkspaceName(user: {
  name: string;
  email: string;
}): string {
  const base = user.name.trim() || user.email.split("@")[0]!.trim() || "My";
  return `${base}'s workspace`.slice(0, MAX_PROJECT_NAME);
}

/** Returns the user's live personal workspace id, creating it when missing. */
export async function ensurePersonalWorkspace(
  db: PrismaClient,
  userId: string,
): Promise<string | null> {
  const existing = await db.project.findFirst({
    where: { personalOwnerId: userId, ...notDeleted },
    select: { id: true, organizationId: true },
  });
  if (existing) {
    await ensureOwnerMembership(
      db,
      userId,
      existing.id,
      existing.organizationId,
    );
    return existing.id;
  }
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, role: true, banned: true },
  });
  if (!user || user.banned) return null;

  // One creation per user: concurrent landings wait here, then re-check.
  const claimed = await db.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${`${LOCK_KEY}:${userId}`}, 0))::text
    `);
    // The unique index is not partial: a soft-deleted holder still occupies
    // personalOwnerId, so a fresh workspace's claim below would 404 into it.
    await tx.project.updateMany({
      where: { personalOwnerId: userId, deletedAt: { not: null } },
      data: { personalOwnerId: null },
    });
    const again = await tx.project.findFirst({
      where: { personalOwnerId: userId, ...notDeleted },
      select: { id: true },
    });
    return again?.id ?? null;
  });
  if (claimed) return claimed;

  const actor = createSessionSecurityContext({
    userId: user.id,
    globalRole: user.role,
    sessionId: "personal-workspace",
  });
  const project = await createProject(db, actor, {
    name: personalWorkspaceName(user),
  });
  try {
    await db.project.update({
      where: { id: project.id },
      data: { personalOwnerId: userId },
    });
  } catch (error) {
    // A parallel creation won the unique index; keep that one and clean up
    // the orphaned loser (its own fresh project, organization, and repo).
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const winner = await db.project.findFirst({
        where: { personalOwnerId: userId, ...notDeleted },
        select: { id: true },
      });
      if (winner) {
        try {
          await withProjectRepo(project.id, async () => {
            await db.project.delete({ where: { id: project.id } });
            await db.organization.delete({
              where: { id: project.organizationId },
            });
            await rm(repoDir(project.id), { recursive: true, force: true });
          });
        } catch (cleanupError) {
          captureError({
            event: "personal_workspace.orphan_cleanup_failed",
            message: "failed to clean up an orphaned personal workspace loser",
            error: cleanupError,
            projectId: project.id,
            userId,
          });
        }
        return winner.id;
      }
    }
    throw error;
  }
  return project.id;
}

/**
 * A live personal workspace can outlive its owner's Member row (e.g. an
 * admin membership edit, or a direct removal) even though personalOwnerId
 * still points at them — restore the Owner membership rather than leaving
 * the owner locked out of their own workspace.
 */
async function ensureOwnerMembership(
  db: PrismaClient,
  userId: string,
  projectId: string,
  organizationId: string,
): Promise<void> {
  const member = await db.member.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
  });
  if (member) return;
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true },
  });
  if (!user) return;
  await db.$transaction(async (tx) => {
    await tx.member.create({
      data: { organizationId, userId, role: toOrganizationRole("Owner") },
    });
    await linkUserToProjectReview(tx, projectId, userId);
  });
  const actor = createSessionSecurityContext({
    userId: user.id,
    globalRole: user.role,
    sessionId: "personal-workspace",
  });
  await syncProjectMetadataQuietly(db, projectId, actor);
}

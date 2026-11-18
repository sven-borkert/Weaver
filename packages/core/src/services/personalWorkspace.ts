import type { PrismaClient } from "@weaver/db/client";
import { createSessionSecurityContext } from "@weaver/core/security/context";
import { toOrganizationRole } from "@weaver/core/roles";
import { notDeleted } from "./projectAccess";
import { createProject } from "./projects";
import { syncProjectMetadataQuietly } from "./projectMetadata";
import { linkUserToProjectReview } from "./projectReviewerLinks";

const MAX_PROJECT_NAME = 120;

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

  const actor = createSessionSecurityContext({
    userId: user.id,
    globalRole: user.role,
    sessionId: "personal-workspace",
  });
  const project = await createProject(
    db,
    actor,
    {
      name: personalWorkspaceName(user),
    },
    { personal: true },
  );
  await ensureOwnerMembership(db, userId, project.id, project.organizationId);
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
  const restored = await db.$transaction(async (tx) => {
    const result = await tx.member.createMany({
      data: { organizationId, userId, role: toOrganizationRole("Owner") },
      skipDuplicates: true,
    });
    if (!result.count) return false;
    await linkUserToProjectReview(tx, projectId, userId);
    return true;
  });
  if (!restored) return;
  const actor = createSessionSecurityContext({
    userId: user.id,
    globalRole: user.role,
    sessionId: "personal-workspace",
  });
  await syncProjectMetadataQuietly(db, projectId, actor);
}

import type { PrismaClient } from "@weaver/db/client";

import {
  assertProjectRole,
  notDeleted,
  type ProjectActor,
} from "./projectAccess";
import { ensurePersonalWorkspace } from "./personalWorkspace";

export async function recordLastOpenedProject(
  db: PrismaClient,
  actor: ProjectActor,
  projectId: string,
): Promise<void> {
  await assertProjectRole(db, projectId, actor, "Viewer");
  await db.user.update({
    where: { id: actor.userId },
    data: { lastOpenedProjectId: projectId },
  });
}

/** The stored project when still live and joined, else the newest membership, else the personal workspace (created on demand). */
export async function resolveLandingProjectId(
  db: PrismaClient,
  userId: string,
): Promise<string | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { lastOpenedProjectId: true },
  });
  const stored = user?.lastOpenedProjectId ?? null;
  if (stored) {
    const live = await db.project.findFirst({
      where: {
        id: stored,
        ...notDeleted,
        organization: { members: { some: { userId } } },
      },
      select: { id: true },
    });
    if (live) return live.id;
  }
  const fallback = await db.project.findFirst({
    where: { ...notDeleted, organization: { members: { some: { userId } } } },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  if (fallback) return fallback.id;
  return ensurePersonalWorkspace(db, userId);
}

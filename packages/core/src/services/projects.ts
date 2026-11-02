import { trainingRoleFor } from "./projectTraining";
import { withProjectRepo } from "./projectRepo";
import { rm } from "node:fs/promises";
import { repoDir } from "@weaver/git-store";
import { parseServerEnv } from "@weaver/config/server";
import { randomUUID } from "node:crypto";
import { CoreError } from "@weaver/core/errors";
import {
  fromOrganizationRole,
  toOrganizationRole,
  type ProjectRoleName,
} from "@weaver/core/roles";
import {
  hasCapability,
  type SecurityContext,
} from "@weaver/core/security/context";
import type {
  Prisma,
  PrismaClient,
  Project,
  TrainingRole,
} from "@weaver/db/client";
import {
  assertProjectRole,
  notDeleted,
  resolveProjectAccess,
} from "./projectAccess";
import type { ProjectActor } from "./projectAccess";
import {
  syncProjectMetadata,
  syncProjectMetadataQuietly,
} from "./projectMetadata";

type Db = PrismaClient | Prisma.TransactionClient;

export function organizationSlugForProject(projectId: string): string {
  return `project-${projectId}`;
}

export async function listProjectsForUser(
  db: Db,
  actor: SecurityContext,
): Promise<Array<Project & { myRole: ProjectRoleName }>> {
  if (!hasCapability(actor, "content:read")) {
    throw new CoreError("FORBIDDEN");
  }
  return listProjectMembershipsForActor(db, actor);
}

// Enumerate membership/restrictions without imposing an operation capability.
export async function listProjectMembershipsForActor(
  db: Db,
  actor: SecurityContext,
): Promise<Array<Project & { myRole: ProjectRoleName }>> {
  if (actor.kind === "wikiAgent") {
    try {
      const access = await resolveProjectAccess(db, actor.projectId, actor);
      return [{ ...access.project, myRole: access.effectiveRole }];
    } catch (error) {
      if (error instanceof CoreError && error.code === "NOT_FOUND") return [];
      throw error;
    }
  }
  const projects = await db.project.findMany({
    where: {
      ...notDeleted,
      organization: { members: { some: { userId: actor.userId } } },
      ...(actor.allowedProjectIds === "all-accessible"
        ? {}
        : { id: { in: [...actor.allowedProjectIds] } }),
    },
    include: {
      organization: {
        include: {
          members: { where: { userId: actor.userId }, select: { role: true } },
        },
      },
    },
    orderBy: { updatedAt: "desc" },
  });
  return projects.map(({ organization, ...project }) => {
    const member = organization.members[0];
    if (!member) throw new CoreError("NOT_FOUND");
    return {
      ...project,
      myRole: fromOrganizationRole(member.role),
    };
  });
}

export async function getProjectForActor(
  db: Db,
  projectId: string,
  actor: ProjectActor,
): Promise<
  Project & { myRole: ProjectRoleName; myTrainingRole: TrainingRole | null }
> {
  const access = await assertProjectRole(db, projectId, actor, "Viewer");
  return {
    ...access.project,
    myRole: access.effectiveRole,
    myTrainingRole: await trainingRoleFor(db, projectId, actor.userId),
  };
}

export async function createProject(
  db: PrismaClient,
  actor: ProjectActor,
  input: { name: string; description?: string },
): Promise<Project> {
  if (!hasCapability(actor, "content:write")) {
    throw new CoreError("FORBIDDEN");
  }
  // A restricted credential cannot create projects outside its restriction.
  if (actor.allowedProjectIds !== "all-accessible") {
    throw new CoreError("FORBIDDEN");
  }
  const projectId = randomUUID();
  const { WEAVER_GIT_LOCK_TIMEOUT_MS: lockTimeout } = parseServerEnv(
    process.env,
  );
  try {
    return await db.$transaction(
      async (tx) => {
        const organization = await tx.organization.create({
          data: {
            name: input.name,
            slug: organizationSlugForProject(projectId),
          },
        });
        const project = await tx.project.create({
          data: {
            id: projectId,
            name: input.name,
            description: input.description,
            organizationId: organization.id,
          },
        });
        await tx.member.create({
          data: {
            organizationId: organization.id,
            userId: actor.userId,
            role: toOrganizationRole("Owner"),
          },
        });
        await tx.projectDefaultReviewer.create({
          data: { projectId, userId: actor.userId },
        });
        // Git storage is part of creation: a failed init rolls the rows back.
        await syncProjectMetadata(tx, projectId, actor, { dispatch: false });
        return project;
      },
      { maxWait: lockTimeout, timeout: lockTimeout + 60_000 },
    );
  } catch (error) {
    // Preserve storage if a lost commit acknowledgement leaves the DB outcome uncertain.
    const persisted = await db.project
      .findFirst({ where: { id: projectId }, select: { id: true } })
      .catch(() => undefined);
    if (persisted === null)
      await rm(repoDir(projectId), { recursive: true, force: true }).catch(
        () => undefined,
      );
    throw error;
  }
}

export async function updateProject(
  db: Db,
  projectId: string,
  actor: ProjectActor,
  input: { name?: string; description?: string | null },
): Promise<Project> {
  await assertProjectRole(db, projectId, actor, "Editor");
  const project = await db.project.update({
    where: { id: projectId },
    data: {
      ...(input.name !== undefined
        ? { name: input.name, organization: { update: { name: input.name } } }
        : {}),
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
    },
  });
  await syncProjectMetadataQuietly(db, projectId, actor);
  return project;
}

export async function softDeleteProject(
  db: Db,
  projectId: string,
  actor: ProjectActor,
): Promise<void> {
  const access = await assertProjectRole(db, projectId, actor, "Owner");
  if (access.project.personalOwnerId) {
    throw new CoreError(
      "PRECONDITION_FAILED",
      "Personal workspaces cannot be deleted",
    );
  }
  await withProjectRepo(projectId, async () => {
    await assertProjectRole(db, projectId, actor, "Owner");
    await db.project.update({
      where: { id: projectId },
      data: {
        deletedAt: new Date(),
        scheduledTasks: {
          updateMany: {
            where: { status: "active" },
            data: { status: "paused", pauseReason: "manual", nextRunAt: null },
          },
        },
      },
    });
  });
}

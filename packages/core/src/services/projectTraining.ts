import { CoreError } from "@weaver/core/errors";
import {
  hasCapability,
  isHumanPrincipal,
  type Capability,
  type SecurityContext,
} from "@weaver/core/security/context";
import type { Prisma, PrismaClient, TrainingRole } from "@weaver/db/client";
import { emitDiagnostic } from "../diagnostics/writer";
import {
  assertProjectRole,
  resolveProjectAccess,
  type ProjectAccess,
  type ProjectActor,
} from "./projectAccess";
import { lockProjectMembershipWrites } from "./projectMembers";
import { syncProjectMetadataQuietly } from "./projectMetadata";

type Db = PrismaClient | Prisma.TransactionClient;
export type TrainerAccess = ProjectAccess & { trainingRole: "trainer" };
export async function trainingRoleFor(
  db: Db,
  projectId: string,
  userId: string,
): Promise<TrainingRole | null> {
  return (
    (
      await db.projectTrainingRole.findUnique({
        where: { projectId_userId: { projectId, userId } },
      })
    )?.role ?? null
  );
}
export async function trainingRolesByUser(
  db: Db,
  projectId: string,
): Promise<Map<string, TrainingRole>> {
  return new Map(
    (await db.projectTrainingRole.findMany({ where: { projectId } })).map(
      (row) => [row.userId, row.role],
    ),
  );
}
export async function unlinkUserFromProjectTraining(
  tx: Prisma.TransactionClient,
  projectId: string,
  userId: string,
): Promise<void> {
  await tx.projectTrainingRole.deleteMany({ where: { projectId, userId } });
}
export function assertSessionPrincipal(actor: ProjectActor): void {
  if (actor.authenticationMethod !== "session")
    throw new CoreError("FORBIDDEN");
}
export async function assertTrainer(
  db: Db,
  projectId: string,
  actor: SecurityContext,
  options?: { capability?: Capability },
): Promise<TrainerAccess> {
  if (!isHumanPrincipal(actor)) {
    await resolveProjectAccess(db, projectId, actor);
    throw new CoreError("FORBIDDEN", "Exam access is not permitted");
  }
  const access = await resolveProjectAccess(db, projectId, actor);
  if (
    actor.authenticationMethod === "task" ||
    !hasCapability(actor, options?.capability ?? "content:write") ||
    (await trainingRoleFor(db, projectId, actor.userId)) !== "trainer"
  )
    throw new CoreError("FORBIDDEN", "Exam access is not permitted");
  return { ...access, trainingRole: "trainer" };
}
export async function assertTrainee(
  db: Db,
  projectId: string,
  actor: ProjectActor,
  options?: { capability?: Capability },
): Promise<ProjectAccess> {
  const access = await resolveProjectAccess(db, projectId, actor);
  assertSessionPrincipal(actor);
  if (
    !hasCapability(actor, options?.capability ?? "content:read") ||
    (await trainingRoleFor(db, projectId, actor.userId)) !== "trainee"
  )
    throw new CoreError("FORBIDDEN", "Exam access is not permitted");
  return access;
}
export async function trainerProjectIds(
  db: Db,
  actor: SecurityContext,
  candidates: readonly string[],
): Promise<string[]> {
  if (
    !isHumanPrincipal(actor) ||
    actor.authenticationMethod === "task" ||
    !hasCapability(actor, "content:read")
  )
    return [];
  const rows = await db.projectTrainingRole.findMany({
    where: {
      userId: actor.userId,
      role: "trainer",
      projectId: { in: [...candidates] },
      project: {
        deletedAt: null,
        organization: { members: { some: { userId: actor.userId } } },
      },
    },
    select: { projectId: true },
  });
  return rows
    .map((row) => row.projectId)
    .filter(
      (id) =>
        actor.allowedProjectIds === "all-accessible" ||
        actor.allowedProjectIds.has(id),
    );
}
export async function setTrainingRole(
  db: PrismaClient,
  actor: ProjectActor,
  input: { projectId: string; userId: string; role: TrainingRole | null },
): Promise<{ userId: string; role: TrainingRole | null }> {
  await db.$transaction(async (tx) => {
    await lockProjectMembershipWrites(tx, input.projectId);
    const access = await assertProjectRole(
      tx,
      input.projectId,
      actor,
      "Maintainer",
    );
    const target = await tx.member.findUnique({
      where: {
        organizationId_userId: {
          organizationId: access.project.organizationId,
          userId: input.userId,
        },
      },
    });
    if (!target)
      throw new CoreError("NOT_FOUND", "Not a member of this project", {
        field: "userId",
      });
    if (input.role === null)
      await unlinkUserFromProjectTraining(tx, input.projectId, input.userId);
    else
      await tx.projectTrainingRole.upsert({
        where: {
          projectId_userId: {
            projectId: input.projectId,
            userId: input.userId,
          },
        },
        create: { ...input, role: input.role, assignedById: actor.userId },
        update: { role: input.role, assignedById: actor.userId },
      });
  });
  emitDiagnostic({
    event: "exam.training.changed",
    message: "Project training role changed",
    projectId: input.projectId,
    details: { targetUserId: input.userId, role: input.role },
  });
  await syncProjectMetadataQuietly(db, input.projectId, actor);
  return { userId: input.userId, role: input.role };
}

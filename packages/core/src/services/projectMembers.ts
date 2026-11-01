import {
  trainingRolesByUser,
  unlinkUserFromProjectTraining,
} from "./projectTraining";
import { CoreError } from "@weaver/core/errors";
import {
  fromOrganizationRole,
  toOrganizationRole,
  type ProjectRoleName,
} from "@weaver/core/roles";
import {
  Prisma,
  type Member,
  type PrismaClient,
  type User,
  type TrainingRole,
} from "@weaver/db/client";
import {
  assertProjectRole,
  PROJECT_ROLE_RANK,
  type ProjectActor,
} from "./projectAccess";
import { syncProjectMetadataQuietly } from "./projectMetadata";
import {
  linkUserToProjectReview,
  unlinkUserFromProjectReview,
} from "./projectReviewerLinks";

type Db = PrismaClient | Prisma.TransactionClient;

const memberUserSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
} as const;

type MemberWithUser = Member & {
  user: Pick<User, "id" | "email" | "name" | "role">;
};

export type MemberRow = {
  id: string;
  projectId: string;
  userId: string;
  role: ProjectRoleName;
  trainingRole?: TrainingRole | null;
  createdAt: Date;
  user: Pick<User, "id" | "email" | "name" | "role">;
};

/** List rows additionally surface the member's email at the top level. */
export type MemberListItem = MemberRow & { email: string };

function toMemberRow(projectId: string, member: MemberWithUser): MemberRow {
  return {
    id: member.id,
    projectId,
    userId: member.userId,
    role: fromOrganizationRole(member.role),
    createdAt: member.createdAt,
    user: member.user,
  };
}

export async function listMembers(
  db: Db,
  projectId: string,
  actor: ProjectActor,
): Promise<MemberListItem[]> {
  const access = await assertProjectRole(db, projectId, actor, "Viewer");
  const members = await db.member.findMany({
    where: { organizationId: access.project.organizationId },
    include: { user: { select: memberUserSelect } },
  });
  const training = await trainingRolesByUser(db, projectId);
  return members
    .map((member) => toMemberRow(projectId, member))
    .sort(
      (a, b) =>
        PROJECT_ROLE_RANK[b.role] - PROJECT_ROLE_RANK[a.role] ||
        a.user.email.localeCompare(b.user.email),
    )
    .map((member) => ({
      ...member,
      trainingRole: training.get(member.userId) ?? null,
      email: member.user.email,
    }));
}

function assertCanGrantOwner(actorEffectiveRole: ProjectRoleName) {
  if (actorEffectiveRole !== "Owner") {
    throw new CoreError("FORBIDDEN", "Only Owners can grant the Owner role");
  }
}

/**
 * Grant rules (spec §6): Owner may grant Owner; any other role may only be
 * granted when it is strictly below the actor's effective rank, so members
 * cannot create peers of their own rank.
 */
function assertCanGrantRole(
  actorEffectiveRole: ProjectRoleName,
  newRole: ProjectRoleName,
) {
  if (newRole === "Owner") {
    assertCanGrantOwner(actorEffectiveRole);
    return;
  }
  if (PROJECT_ROLE_RANK[actorEffectiveRole] <= PROJECT_ROLE_RANK[newRole]) {
    throw new CoreError(
      "FORBIDDEN",
      "Cannot grant a role equal to or above your own",
    );
  }
}

export async function addMember(
  db: PrismaClient,
  input: { projectId: string; email: string; role: ProjectRoleName },
  actor: ProjectActor,
): Promise<MemberRow> {
  const created = await db.$transaction(async (tx) => {
    await lockProjectMembershipWrites(tx, input.projectId);
    const access = await assertProjectRole(
      tx,
      input.projectId,
      actor,
      "Maintainer",
    );
    assertCanGrantRole(access.effectiveRole, input.role);
    const organizationId = access.project.organizationId;
    const target = await tx.user.findUnique({ where: { email: input.email } });
    if (!target)
      throw new CoreError("NOT_FOUND", "No user with this email", {
        field: "email",
      });
    const existing = await tx.member.findUnique({
      where: { organizationId_userId: { organizationId, userId: target.id } },
    });
    if (existing)
      throw new CoreError("CONFLICT", "Already a member", { field: "email" });
    const created = await tx.member.create({
      data: {
        organizationId,
        userId: target.id,
        role: toOrganizationRole(input.role),
      },
      include: { user: { select: memberUserSelect } },
    });
    await linkUserToProjectReview(tx, input.projectId, target.id);
    return created;
  });
  await syncProjectMetadataQuietly(db, input.projectId, actor);
  return toMemberRow(input.projectId, created);
}

async function loadMembershipOrThrow(
  db: Db,
  organizationId: string,
  userId: string,
): Promise<Member & { projectRole: ProjectRoleName }> {
  const membership = await db.member.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
  });
  if (!membership) throw new CoreError("NOT_FOUND");
  return { ...membership, projectRole: fromOrganizationRole(membership.role) };
}

async function countOwners(db: Db, organizationId: string): Promise<number> {
  return db.member.count({
    where: { organizationId, role: toOrganizationRole("Owner") },
  });
}

export async function updateMemberRole(
  db: PrismaClient,
  input: { projectId: string; userId: string; role: ProjectRoleName },
  actor: ProjectActor,
): Promise<MemberRow> {
  const row = await db.$transaction(async (tx) => {
    await lockProjectMembershipWrites(tx, input.projectId);
    const access = await assertProjectRole(
      tx,
      input.projectId,
      actor,
      "Maintainer",
    );
    if (input.userId === actor.userId) {
      throw new CoreError(
        "BAD_REQUEST",
        "You cannot change your own membership",
      );
    }
    assertCanGrantRole(access.effectiveRole, input.role);
    const organizationId = access.project.organizationId;
    const membership = await loadMembershipOrThrow(
      tx,
      organizationId,
      input.userId,
    );
    if (
      access.project.personalOwnerId === input.userId &&
      input.role !== "Owner"
    ) {
      throw new CoreError(
        "PRECONDITION_FAILED",
        "The workspace owner keeps the Owner role",
      );
    }
    if (
      access.effectiveRole !== "Owner" &&
      PROJECT_ROLE_RANK[access.effectiveRole] <=
        PROJECT_ROLE_RANK[membership.projectRole]
    ) {
      throw new CoreError(
        "FORBIDDEN",
        "Cannot change a member with a role equal to or above your own",
      );
    }
    if (
      membership.projectRole === "Owner" &&
      input.role !== "Owner" &&
      (await countOwners(tx, organizationId)) <= 1
    ) {
      throw new CoreError(
        "PRECONDITION_FAILED",
        "A project must keep at least one Owner",
      );
    }
    const updated = await tx.member.update({
      where: { id: membership.id },
      data: { role: toOrganizationRole(input.role) },
      include: { user: { select: memberUserSelect } },
    });
    return toMemberRow(input.projectId, updated);
  });
  await syncProjectMetadataQuietly(db, input.projectId, actor);
  return row;
}

export async function removeMember(
  db: PrismaClient,
  input: { projectId: string; userId: string },
  actor: ProjectActor,
): Promise<void> {
  await db.$transaction(async (tx) => {
    await lockProjectMembershipWrites(tx, input.projectId);
    const access = await assertProjectRole(
      tx,
      input.projectId,
      actor,
      "Maintainer",
    );
    if (input.userId === actor.userId) {
      throw new CoreError(
        "BAD_REQUEST",
        "You cannot remove yourself; ask another Owner",
      );
    }
    const organizationId = access.project.organizationId;
    const membership = await loadMembershipOrThrow(
      tx,
      organizationId,
      input.userId,
    );
    if (access.project.personalOwnerId === input.userId) {
      throw new CoreError(
        "PRECONDITION_FAILED",
        "The workspace owner keeps the Owner role",
      );
    }
    if (
      access.effectiveRole !== "Owner" &&
      PROJECT_ROLE_RANK[access.effectiveRole] <=
        PROJECT_ROLE_RANK[membership.projectRole]
    ) {
      throw new CoreError(
        "FORBIDDEN",
        "Cannot remove a member with a role equal to or above your own",
      );
    }
    if (
      membership.projectRole === "Owner" &&
      (await countOwners(tx, organizationId)) <= 1
    ) {
      throw new CoreError(
        "PRECONDITION_FAILED",
        "A project must keep at least one Owner",
      );
    }
    await tx.member.delete({ where: { id: membership.id } });
    await unlinkUserFromProjectReview(tx, input.projectId, input.userId);
    await unlinkUserFromProjectTraining(tx, input.projectId, input.userId);
  });
  await syncProjectMetadataQuietly(db, input.projectId, actor);
}

export async function lockProjectMembershipWrites(
  db: Prisma.TransactionClient,
  projectId: string,
): Promise<void> {
  await db.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${projectId}, 0))::text
  `);
}

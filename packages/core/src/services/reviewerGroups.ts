import { CoreError } from "../errors";
import { toOrganizationRole } from "../roles";
import {
  canonicalReviewers,
  REVIEW_MONTHS_MAX,
  REVIEW_MONTHS_MIN,
  type DocumentReview,
  type ReviewerRef,
} from "../documents/review";
import { authorForUser } from "../documents/frontmatter";
import { Prisma, type PrismaClient } from "@weaver/db/client";
import {
  assertProjectRole,
  notDeleted,
  type ProjectActor,
} from "./projectAccess";
import { lockProjectMembershipWrites } from "./projectMembers";
import { syncProjectMetadataQuietly } from "./projectMetadata";

type Db = PrismaClient | Prisma.TransactionClient;

export type ReviewerTarget = { type: "user" | "group"; id: string };
export type ReviewerGroupView = {
  id: string;
  name: string;
  members: { userId: string; name: string }[];
};

const GROUP_NAME_MAX = 80;
const MAX_GROUPS = 50;
const MAX_GROUP_MEMBERS = 200;

function groupName(raw: string): string {
  const name = raw.trim();
  if (
    !name ||
    [...name].length > GROUP_NAME_MAX ||
    /[\p{Cc}\u2028\u2029]/u.test(name)
  )
    throw new CoreError(
      "BAD_REQUEST",
      "Enter a group name of at most 80 characters",
      { field: "name" },
    );
  return name;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

async function projectMembers(db: Db, projectId: string) {
  const project = await db.project.findFirst({
    where: { id: projectId, ...notDeleted },
    select: {
      defaultReviewEveryMonths: true,
      organization: {
        select: {
          members: {
            select: {
              userId: true,
              role: true,
              user: { select: { id: true, name: true, email: true } },
            },
          },
        },
      },
    },
  });
  if (!project) throw new CoreError("NOT_FOUND");
  return project;
}

async function validatedMemberIds(
  db: Db,
  projectId: string,
  memberIds: readonly string[],
): Promise<string[]> {
  const unique = [...new Set(memberIds)];
  if (unique.length > MAX_GROUP_MEMBERS)
    throw new CoreError("BAD_REQUEST", "A group can have at most 200 members", {
      field: "memberIds",
    });
  const project = await projectMembers(db, projectId);
  const members = new Set(project.organization.members.map((m) => m.userId));
  if (unique.some((id) => !members.has(id)))
    throw new CoreError(
      "BAD_REQUEST",
      "A group member is not a member of this project",
      { field: "memberIds" },
    );
  return unique;
}

async function loadGroupOrThrow(db: Db, projectId: string, groupId: string) {
  const group = await db.reviewerGroup.findFirst({
    where: { id: groupId, projectId },
    select: { id: true },
  });
  if (!group) throw new CoreError("NOT_FOUND");
}

export async function listReviewerGroups(
  db: Db,
  input: { projectId: string },
  actor: ProjectActor,
): Promise<ReviewerGroupView[]> {
  await assertProjectRole(db, input.projectId, actor, "Viewer");
  const groups = await db.reviewerGroup.findMany({
    where: { projectId: input.projectId },
    select: {
      id: true,
      name: true,
      members: {
        select: {
          user: { select: { id: true, name: true, email: true } },
        },
      },
    },
  });
  return groups
    .map((group) => ({
      id: group.id,
      name: group.name,
      members: group.members
        .map((m) => ({
          userId: m.user.id,
          name: authorForUser(m.user).name,
        }))
        .sort(
          (a, b) =>
            a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId),
        ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export async function createReviewerGroup(
  db: PrismaClient,
  input: { projectId: string; name: string; memberIds: string[] },
  actor: ProjectActor,
): Promise<ReviewerGroupView> {
  let id: string;
  try {
    id = await db.$transaction(async (tx) => {
      await lockProjectMembershipWrites(tx, input.projectId);
      await assertProjectRole(tx, input.projectId, actor, "Owner");
      const name = groupName(input.name);
      const memberIds = await validatedMemberIds(
        tx,
        input.projectId,
        input.memberIds,
      );
      if (
        (await tx.reviewerGroup.count({
          where: { projectId: input.projectId },
        })) >= MAX_GROUPS
      )
        throw new CoreError(
          "BAD_REQUEST",
          "A project can have at most 50 reviewer groups",
        );
      const group = await tx.reviewerGroup.create({
        data: {
          projectId: input.projectId,
          name,
          members: { create: memberIds.map((userId) => ({ userId })) },
        },
        select: { id: true },
      });
      return group.id;
    });
  } catch (error) {
    if (isUniqueViolation(error))
      throw new CoreError("CONFLICT", "A group with this name already exists", {
        field: "name",
      });
    throw error;
  }
  await syncProjectMetadataQuietly(db, input.projectId, actor);
  const created = (
    await listReviewerGroups(db, { projectId: input.projectId }, actor)
  ).find((group) => group.id === id);
  return created!;
}

export async function renameReviewerGroup(
  db: PrismaClient,
  input: { projectId: string; groupId: string; name: string },
  actor: ProjectActor,
): Promise<void> {
  await assertProjectRole(db, input.projectId, actor, "Owner");
  const name = groupName(input.name);
  await loadGroupOrThrow(db, input.projectId, input.groupId);
  try {
    await db.reviewerGroup.update({
      where: { id: input.groupId },
      data: { name },
    });
  } catch (error) {
    if (isUniqueViolation(error))
      throw new CoreError("CONFLICT", "A group with this name already exists", {
        field: "name",
      });
    throw error;
  }
  await syncProjectMetadataQuietly(db, input.projectId, actor);
}

export async function setReviewerGroupMembers(
  db: PrismaClient,
  input: { projectId: string; groupId: string; memberIds: string[] },
  actor: ProjectActor,
): Promise<void> {
  await db.$transaction(async (tx) => {
    await lockProjectMembershipWrites(tx, input.projectId);
    await assertProjectRole(tx, input.projectId, actor, "Owner");
    await loadGroupOrThrow(tx, input.projectId, input.groupId);
    const memberIds = await validatedMemberIds(
      tx,
      input.projectId,
      input.memberIds,
    );
    await tx.reviewerGroupMember.deleteMany({
      where: { groupId: input.groupId },
    });
    await tx.reviewerGroupMember.createMany({
      data: memberIds.map((userId) => ({ groupId: input.groupId, userId })),
    });
  });
  await syncProjectMetadataQuietly(db, input.projectId, actor);
}

export async function deleteReviewerGroup(
  db: PrismaClient,
  input: { projectId: string; groupId: string },
  actor: ProjectActor,
): Promise<void> {
  await assertProjectRole(db, input.projectId, actor, "Owner");
  await loadGroupOrThrow(db, input.projectId, input.groupId);
  await db.reviewerGroup.delete({ where: { id: input.groupId } });
  await syncProjectMetadataQuietly(db, input.projectId, actor);
}

export async function getReviewDefaults(
  db: Db,
  input: { projectId: string },
  actor: ProjectActor,
): Promise<{
  everyMonths: number;
  reviewers: ReviewerRef[];
  canManage: boolean;
}> {
  const access = await assertProjectRole(db, input.projectId, actor, "Viewer");
  const review = await defaultReviewFor(
    db,
    input.projectId,
    new Date().toISOString(),
  );
  return {
    everyMonths: review.everyMonths,
    reviewers: review.reviewers,
    canManage: access.effectiveRole === "Owner",
  };
}

export async function setReviewDefaults(
  db: PrismaClient,
  input: {
    projectId: string;
    everyMonths: number;
    reviewers: ReviewerTarget[];
  },
  actor: ProjectActor,
): Promise<void> {
  await db.$transaction(async (tx) => {
    await lockProjectMembershipWrites(tx, input.projectId);
    await assertProjectRole(tx, input.projectId, actor, "Owner");
    if (
      !Number.isInteger(input.everyMonths) ||
      input.everyMonths < REVIEW_MONTHS_MIN ||
      input.everyMonths > REVIEW_MONTHS_MAX
    )
      throw new CoreError(
        "BAD_REQUEST",
        `Enter a review interval of ${REVIEW_MONTHS_MIN} to ${REVIEW_MONTHS_MAX} months`,
        { field: "everyMonths" },
      );
    const reviewers = await resolveReviewerTargets(
      tx,
      input.projectId,
      input.reviewers,
    );
    await tx.project.update({
      where: { id: input.projectId },
      data: { defaultReviewEveryMonths: input.everyMonths },
    });
    await tx.projectDefaultReviewer.deleteMany({
      where: { projectId: input.projectId },
    });
    await tx.projectDefaultReviewer.createMany({
      data: reviewers.map((ref) => ({
        projectId: input.projectId,
        userId: ref.type === "user" ? ref.id : null,
        groupId: ref.type === "group" ? ref.id : null,
      })),
    });
  });
  await syncProjectMetadataQuietly(db, input.projectId, actor);
}

/** Refs with current names for targets that are members/groups of the project; unknown targets throw BAD_REQUEST. */
export async function resolveReviewerTargets(
  db: Db,
  projectId: string,
  targets: readonly ReviewerTarget[],
): Promise<ReviewerRef[]> {
  const project = await projectMembers(db, projectId);
  const users = new Map(
    project.organization.members.map((m) => [m.userId, m.user]),
  );
  const groups = new Map(
    (
      await db.reviewerGroup.findMany({
        where: { projectId },
        select: { id: true, name: true },
      })
    ).map((g) => [g.id, g.name]),
  );
  return canonicalReviewers(
    targets.map((target): ReviewerRef => {
      if (target.type === "user") {
        const user = users.get(target.id);
        if (!user)
          throw new CoreError(
            "BAD_REQUEST",
            "A reviewer is not a member of this project",
            { field: "reviewers" },
          );
        return { type: "user", id: user.id, name: authorForUser(user).name };
      }
      const name = groups.get(target.id);
      if (name === undefined)
        throw new CoreError(
          "BAD_REQUEST",
          "A reviewer group does not exist in this project",
          { field: "reviewers" },
        );
      return { type: "group", id: target.id, name };
    }),
  );
}

/** Configured project refs retain an empty selection instead of materializing Owners. */
export async function getConfiguredProjectReviewers(
  db: Db,
  projectId: string,
): Promise<ReviewerRef[]> {
  const rows = await db.projectDefaultReviewer.findMany({
    where: { projectId },
    include: {
      user: { select: { id: true, name: true, email: true } },
      group: { select: { id: true, name: true } },
    },
  });
  return canonicalReviewers(
    rows.flatMap((row): ReviewerRef[] =>
      row.group
        ? [{ type: "group", id: row.group.id, name: row.group.name }]
        : row.user
          ? [
              {
                type: "user",
                id: row.user.id,
                name: authorForUser(row.user).name,
              },
            ]
          : [],
    ),
  );
}

/** Fresh project interval and resolved defaults, using Owners when no target is effective. */
export async function defaultReviewFor(
  db: Db,
  projectId: string,
  now: string,
  storedReviewers?: readonly ReviewerRef[],
): Promise<DocumentReview> {
  return reviewFromConfiguredDefaults(db, projectId, now, {
    reviewers:
      storedReviewers ?? (await getConfiguredProjectReviewers(db, projectId)),
    source: storedReviewers === undefined ? "project" : "folder",
  });
}

/** Resolves one chosen configuration without rereading its project setting. */
export async function reviewFromConfiguredDefaults(
  db: Db,
  projectId: string,
  now: string,
  configured: {
    reviewers: readonly ReviewerRef[];
    source: "project" | "folder";
  },
): Promise<DocumentReview> {
  const project = await projectMembers(db, projectId);
  const memberIds = new Set(project.organization.members.map((m) => m.userId));
  let targets: ReviewerTarget[] = configured.reviewers.filter(
    (ref) => ref.type === "group" || memberIds.has(ref.id),
  );
  if (configured.source === "folder") {
    const groups = await db.reviewerGroup.findMany({
      where: { projectId },
      select: { id: true, members: { select: { userId: true } } },
    });
    const effectiveGroups = new Set(
      groups
        .filter((group) =>
          group.members.some((member) => memberIds.has(member.userId)),
        )
        .map((group) => group.id),
    );
    const groupIds = new Set(groups.map((group) => group.id));
    targets = configured.reviewers.filter((ref) =>
      ref.type === "user" ? memberIds.has(ref.id) : groupIds.has(ref.id),
    );
    if (
      !targets.some((ref) => ref.type === "user" || effectiveGroups.has(ref.id))
    )
      targets = [];
  }
  const fallback: ReviewerTarget[] = project.organization.members
    .filter((m) => m.role === toOrganizationRole("Owner"))
    .map((m) => ({ type: "user" as const, id: m.userId }));
  return {
    reviewers: await resolveReviewerTargets(
      db,
      projectId,
      targets.length ? targets : fallback,
    ),
    everyMonths: project.defaultReviewEveryMonths,
    since: now,
    lastReviewed: null,
    reviewedBy: null,
  };
}

/** Keeps only an imported block's reviewers known here and its interval; the clock restarts at import. */
export async function resolveImportedReview(
  db: Db,
  projectId: string,
  imported: DocumentReview | null,
  now: string,
  defaults?: DocumentReview,
): Promise<DocumentReview> {
  defaults ??= await defaultReviewFor(db, projectId, now);
  if (!imported) return defaults;
  const project = await projectMembers(db, projectId);
  const memberIds = new Set(project.organization.members.map((m) => m.userId));
  const groupIds = new Set(
    (
      await db.reviewerGroup.findMany({
        where: { projectId },
        select: { id: true },
      })
    ).map((g) => g.id),
  );
  const known = imported.reviewers.filter((ref) =>
    ref.type === "user" ? memberIds.has(ref.id) : groupIds.has(ref.id),
  );
  const reviewers = known.length
    ? await resolveReviewerTargets(db, projectId, known)
    : defaults.reviewers;
  return {
    reviewers,
    everyMonths: imported.everyMonths,
    since: now,
    lastReviewed: null,
    reviewedBy: null,
  };
}

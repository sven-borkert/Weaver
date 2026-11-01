import { trainingRolesByUser } from "./projectTraining";
import {
  fromOrganizationRole,
  PROJECT_ROLE_RANK,
  type ProjectRoleName,
} from "@weaver/core/roles";
import type { Prisma, PrismaClient } from "@weaver/db/client";
import { notDeleted, type ProjectActor } from "./projectAccess";
import { notifyProjectContentChanged } from "./projectGitRemoteJobs";
import { withProjectRepo } from "./projectRepo";
import { captureError } from "../diagnostics/writer";

type Db = PrismaClient | Prisma.TransactionClient;

/** Root-level repository file mirroring the project's name, description, and permissions. */
export const PROJECT_METADATA_PATH = "project.json";

export type ProjectMetadataMember = {
  userId: string;
  email: string;
  name: string | null;
  role: ProjectRoleName;
  training?: "trainer" | "trainee";
};

export type ProjectMetadata = {
  id: string;
  name: string;
  description: string | null;
  created: string;
  members: ProjectMetadataMember[];
  documentReview: {
    everyMonths: number;
    defaultReviewers: { type: "user" | "group"; id: string }[];
  };
  reviewerGroups: { id: string; name: string; members: string[] }[];
};

export function composeProjectMetadataFile(metadata: ProjectMetadata): string {
  return `${JSON.stringify(metadata, null, 2)}\n`;
}

export async function loadProjectMetadata(
  db: Db,
  projectId: string,
): Promise<ProjectMetadata | null> {
  const project = await db.project.findFirst({
    where: { id: projectId, ...notDeleted },
    include: {
      organization: {
        include: {
          members: {
            include: { user: { select: { email: true, name: true } } },
          },
        },
      },
    },
  });
  if (!project) return null;
  const training = await trainingRolesByUser(db, projectId);
  const members = project.organization.members
    .map((member) => ({
      userId: member.userId,
      email: member.user.email,
      name: member.user.name ?? null,
      role: fromOrganizationRole(member.role),
      ...(training.has(member.userId)
        ? { training: training.get(member.userId)! }
        : {}),
    }))
    .sort(
      (a, b) =>
        PROJECT_ROLE_RANK[b.role] - PROJECT_ROLE_RANK[a.role] ||
        a.email.localeCompare(b.email) ||
        a.userId.localeCompare(b.userId),
    );
  const groups = await db.reviewerGroup.findMany({
    where: { projectId },
    orderBy: { id: "asc" },
    select: { id: true, name: true, members: { select: { userId: true } } },
  });
  const defaults = await db.projectDefaultReviewer.findMany({
    where: { projectId },
    select: { userId: true, groupId: true },
  });
  const defaultReviewers = defaults
    .map((row) =>
      row.groupId
        ? { type: "group" as const, id: row.groupId }
        : { type: "user" as const, id: row.userId! },
    )
    .sort((a, b) =>
      a.type !== b.type
        ? a.type < b.type
          ? -1
          : 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0,
    );
  return {
    id: project.id,
    name: project.name,
    description: project.description ?? null,
    created: project.createdAt.toISOString(),
    members,
    documentReview: {
      everyMonths: project.defaultReviewEveryMonths,
      defaultReviewers,
    },
    reviewerGroups: groups.map((group) => ({
      id: group.id,
      name: group.name,
      members: group.members.map((m) => m.userId).sort(),
    })),
  };
}

/** The `project.json` file content for a project, or null when it no longer exists. */
export async function composeProjectMetadataFor(
  db: Db,
  projectId: string,
): Promise<string | null> {
  const metadata = await loadProjectMetadata(db, projectId);
  return metadata ? composeProjectMetadataFile(metadata) : null;
}

/**
 * Write the current database truth for the project into `project.json` and
 * commit it as the acting user. Initializes the repository when needed and
 * returns the commit SHA, or null when the file was already up to date.
 */
export async function syncProjectMetadata(
  db: Db,
  projectId: string,
  actor: ProjectActor,
  options?: { dispatch?: boolean },
): Promise<string | null> {
  if (!(await loadProjectMetadata(db, projectId))) return null;
  const user = await db.user.findUnique({
    where: { id: actor.userId },
    select: { email: true, name: true },
  });
  const author = {
    userId: actor.userId,
    email: user?.email ?? "unknown@local",
    name: user?.name ?? null,
  };
  const sha = await withProjectRepo(projectId, async (repo) => {
    const file = await composeProjectMetadataFor(db, projectId);
    if (!file) return null;
    const exists = await repo.fileExistsInWorktree(PROJECT_METADATA_PATH);
    if (
      exists &&
      (await repo.readFileFromWorktree(PROJECT_METADATA_PATH)) === file
    ) {
      return null;
    }
    await repo.writeFileAtomic(PROJECT_METADATA_PATH, file);
    return repo.commitAll(
      `${exists ? "update" : "create"}: ${PROJECT_METADATA_PATH}`,
      author,
    );
  });
  // Callers that are still inside their own DB transaction (e.g. createProject)
  // pass `dispatch: false`: the row a push would need may not be visible yet,
  // and the next metadata change or the minute tick picks it up regardless.
  if (sha && (options?.dispatch ?? true)) {
    void notifyProjectContentChanged(db as PrismaClient, projectId);
  }
  return sha;
}

// Settings and membership truth is the database; a failed mirror is logged and
// rewritten by the next metadata-affecting change.
export async function syncProjectMetadataQuietly(
  db: Db,
  projectId: string,
  actor: ProjectActor,
  options?: { dispatch?: boolean },
): Promise<void> {
  try {
    await syncProjectMetadata(db, projectId, actor, options);
  } catch (error) {
    const reference = captureError({
      event: "content.projection.failed",
      message: "project metadata sync failed after database commit",
      error,
      projectId,
      details: { kind: "project-metadata" },
    });
    console.error(
      `Project metadata sync failed after database commit (ref ${reference ?? "none"})`,
      { projectId },
    );
  }
}

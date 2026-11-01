import { CoreError } from "../errors";
import { toOrganizationRole } from "../roles";
import {
  composeDocumentFile,
  parseDocumentFile,
  authorForUser,
  type DocumentAuthor,
} from "../documents/frontmatter";
import { documentKindOfPath } from "../documents/kinds";
import {
  MAX_REVIEWERS,
  REVIEW_MONTHS_MAX,
  REVIEW_MONTHS_MIN,
  type DocumentReview,
} from "../documents/review";
import { hasCapability } from "../security/context";
import type { Prisma, PrismaClient } from "@weaver/db/client";
import {
  author,
  assertDocumentFileSize,
  presentAuthor,
  repairDocumentProjectionInRepo,
  reportProjectionFailureAndReconcile,
  type EnrichedActor,
} from "./documents";
import {
  assertProjectRole,
  notDeleted,
  projectRoleAtLeast,
  resolveProjectAccess,
  type ProjectActor,
} from "./projectAccess";
import { withProjectRepo } from "./projectRepo";
import { notifyProjectContentChanged } from "./projectGitRemoteJobs";
import { invalidCursorError } from "./contentCursors";
import {
  defaultReviewFor,
  resolveReviewerTargets,
  type ReviewerTarget,
} from "./reviewerGroups";

type Db = PrismaClient | Prisma.TransactionClient;

const DUE_PAGE_DEFAULT = 50;
const DUE_PAGE_MAX = 100;
const OWNER = toOrganizationRole("Owner");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A row counts while its user is a member or its group still has members. */
const RESOLVABLE = {
  OR: [{ userId: { not: null } }, { group: { members: { some: {} } } }],
} satisfies Prisma.DocumentReviewerWhereInput;

/** The one definition of "effective reviewer"; callers also constrain the project's membership. */
function reviewerFilter(userId: string): Prisma.DocumentWhereInput {
  return {
    OR: [
      { reviewers: { some: { userId } } },
      { reviewers: { some: { group: { members: { some: { userId } } } } } },
      {
        reviewers: { none: RESOLVABLE },
        project: {
          organization: { members: { some: { userId, role: OWNER } } },
        },
      },
    ],
  };
}

function accessibleProjects(actor: ProjectActor): Prisma.ProjectWhereInput {
  return {
    ...notDeleted,
    organization: { members: { some: { userId: actor.userId } } },
    ...(actor.allowedProjectIds === "all-accessible"
      ? {}
      : { id: { in: [...actor.allowedProjectIds] } }),
  };
}

export async function isEffectiveReviewer(
  db: Db,
  projectId: string,
  documentId: string,
  userId: string,
): Promise<boolean> {
  return (
    (await db.document.count({
      where: {
        id: documentId,
        projectId,
        project: { organization: { members: { some: { userId } } } },
        ...reviewerFilter(userId),
      },
    })) > 0
  );
}

/** Of the given documents, those the user is an effective reviewer of. */
export async function effectiveReviewerDocumentIds(
  db: Db,
  projectId: string,
  documentIds: string[],
  userId: string,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (let start = 0; start < documentIds.length; start += 5000) {
    const rows = await db.document.findMany({
      where: {
        id: { in: documentIds.slice(start, start + 5000) },
        projectId,
        project: { organization: { members: { some: { userId } } } },
        ...reviewerFilter(userId),
      },
      select: { id: true, path: true },
    });
    for (const row of rows) found.set(row.id, row.path);
  }
  return found;
}

async function writeReview(
  db: PrismaClient,
  input: {
    projectId: string;
    documentId: string;
    expectedHeadCommitSha: string;
  },
  actor: EnrichedActor,
  change: (review: DocumentReview, now: string) => DocumentReview,
  subject: (path: string) => string,
  authorize: () => Promise<unknown>,
): Promise<{ headCommitSha: string }> {
  let changed = false;
  const result = await withProjectRepo(input.projectId, async (repo) => {
    await authorize();
    const row = await db.document.findFirst({
      where: { id: input.documentId, projectId: input.projectId },
    });
    if (!row) throw new CoreError("NOT_FOUND");
    const head = await repo.lastCommitForPath(row.path);
    if (!head) throw new CoreError("NOT_FOUND");
    if (head !== input.expectedHeadCommitSha)
      throw new CoreError(
        "CONFLICT",
        "The document changed. Reload and try again.",
        { headCommitSha: head },
      );
    const currentFile = await repo.readFileFromWorktree(row.path);
    const { meta, body } = parseDocumentFile(
      currentFile,
      documentKindOfPath(row.path),
    );
    const now = new Date().toISOString();
    const current =
      meta.review ?? (await defaultReviewFor(db, input.projectId, now));
    const file = composeDocumentFile(
      { ...meta, review: change(current, now) },
      body,
      documentKindOfPath(row.path),
    );
    assertDocumentFileSize(file, row.path);
    if (file === currentFile) return { headCommitSha: head };
    await repo.writeFileAtomic(row.path, file);
    const sha = await repo.commitAll(subject(row.path), author(actor));
    changed = true;
    try {
      await repairDocumentProjectionInRepo(
        db,
        repo,
        input.projectId,
        row.id,
        row.path,
      );
    } catch (error) {
      await reportProjectionFailureAndReconcile({
        projectId: input.projectId,
        documentId: row.id,
        headCommitSha: sha,
        error,
      });
    }
    return { headCommitSha: sha };
  });
  if (changed) void notifyProjectContentChanged(db, input.projectId);
  return result;
}

export async function markDocumentReviewed(
  db: PrismaClient,
  input: {
    projectId: string;
    documentId: string;
    expectedHeadCommitSha: string;
  },
  actor: EnrichedActor,
): Promise<{ headCommitSha: string }> {
  // Membership first so a non-member cannot probe document ids.
  await resolveProjectAccess(db, input.projectId, actor);
  if (!hasCapability(actor, "content:write")) throw new CoreError("FORBIDDEN");
  const isReviewer = () =>
    isEffectiveReviewer(db, input.projectId, input.documentId, actor.userId);
  if (!(await isReviewer())) {
    const exists = await db.document.count({
      where: { id: input.documentId, projectId: input.projectId },
    });
    throw new CoreError(exists ? "FORBIDDEN" : "NOT_FOUND");
  }
  const self = authorForUser({
    id: actor.userId,
    name: actor.name,
    email: actor.email,
  });
  return writeReview(
    db,
    input,
    actor,
    (review, now) => ({ ...review, lastReviewed: now, reviewedBy: self }),
    (path) => `review: ${path}`,
    async () => {
      if (!(await isReviewer())) throw new CoreError("FORBIDDEN");
    },
  );
}

export async function setDocumentReview(
  db: PrismaClient,
  input: {
    projectId: string;
    documentId: string;
    expectedHeadCommitSha: string;
    reviewers?: ReviewerTarget[];
    everyMonths?: number;
  },
  actor: EnrichedActor,
): Promise<{ headCommitSha: string }> {
  await assertProjectRole(db, input.projectId, actor, "Maintainer");
  if (input.reviewers === undefined && input.everyMonths === undefined)
    throw new CoreError("BAD_REQUEST", "Nothing to change");
  if (
    input.everyMonths !== undefined &&
    (!Number.isInteger(input.everyMonths) ||
      input.everyMonths < REVIEW_MONTHS_MIN ||
      input.everyMonths > REVIEW_MONTHS_MAX)
  )
    throw new CoreError(
      "BAD_REQUEST",
      "Review interval must be 1 to 120 months",
      { field: "everyMonths" },
    );
  if (input.reviewers && input.reviewers.length > MAX_REVIEWERS)
    throw new CoreError(
      "BAD_REQUEST",
      "A document may have at most 50 reviewers",
      { field: "reviewers" },
    );
  const reviewers = input.reviewers
    ? await resolveReviewerTargets(db, input.projectId, input.reviewers)
    : undefined;
  return writeReview(
    db,
    input,
    actor,
    (review) => ({
      ...review,
      ...(reviewers && { reviewers }),
      ...(input.everyMonths !== undefined && {
        everyMonths: input.everyMonths,
      }),
    }),
    (path) => `review settings: ${path}`,
    () => assertProjectRole(db, input.projectId, actor, "Maintainer"),
  );
}

export async function reviewPermissions(
  db: Db,
  projectId: string,
  documentId: string,
  actor: ProjectActor,
): Promise<{ canMarkReviewed: boolean; canEditReview: boolean }> {
  const access = await resolveProjectAccess(db, projectId, actor);
  return {
    canMarkReviewed: await isEffectiveReviewer(
      db,
      projectId,
      documentId,
      actor.userId,
    ),
    canEditReview: projectRoleAtLeast(access.effectiveRole, "Maintainer"),
  };
}

export type DueDocument = {
  id: string;
  title: string;
  path: string;
  projectId: string;
  projectName: string;
  dueAt: Date;
  lastReviewedAt: Date | null;
};

function encodeCursor(at: Date, id: string): string {
  return Buffer.from(JSON.stringify([at.toISOString(), id])).toString(
    "base64url",
  );
}

function decodeCursor(cursor: string): { at: Date; id: string } {
  try {
    const [iso, id] = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as unknown[];
    const at = new Date(iso as string);
    if (
      typeof iso !== "string" ||
      Number.isNaN(at.getTime()) ||
      at.toISOString() !== iso ||
      typeof id !== "string" ||
      !UUID.test(id)
    )
      throw new Error("invalid");
    return { at, id };
  } catch {
    throw invalidCursorError();
  }
}

function dueWhere(actor: ProjectActor): Prisma.DocumentWhereInput {
  return {
    reviewDueAt: { lte: new Date() },
    project: accessibleProjects(actor),
    ...reviewerFilter(actor.userId),
  };
}

function pageWindow(input: { cursor?: string; limit?: number }) {
  if (
    input.limit !== undefined &&
    (!Number.isInteger(input.limit) || input.limit < 1)
  )
    throw new CoreError("BAD_REQUEST", "Limit must be a positive integer");
  return {
    limit: Math.min(input.limit ?? DUE_PAGE_DEFAULT, DUE_PAGE_MAX),
    after: input.cursor === undefined ? null : decodeCursor(input.cursor),
  };
}

export async function listDocumentsToReview(
  db: PrismaClient,
  input: { cursor?: string; limit?: number },
  actor: ProjectActor,
): Promise<{ items: DueDocument[]; nextCursor: string | null }> {
  const { limit, after } = pageWindow(input);
  const rows = await db.document.findMany({
    where: {
      AND: [
        dueWhere(actor),
        ...(after
          ? [
              {
                OR: [
                  { reviewDueAt: { gt: after.at } },
                  { reviewDueAt: after.at, id: { gt: after.id } },
                ],
              },
            ]
          : []),
      ],
    },
    orderBy: [{ reviewDueAt: "asc" }, { id: "asc" }],
    take: limit + 1,
    select: {
      id: true,
      title: true,
      path: true,
      projectId: true,
      reviewDueAt: true,
      lastReviewedAt: true,
      project: { select: { name: true } },
    },
  });
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => ({
      id: row.id,
      title: row.title,
      path: row.path,
      projectId: row.projectId,
      projectName: row.project.name,
      dueAt: row.reviewDueAt!,
      lastReviewedAt: row.lastReviewedAt,
    })),
    nextCursor:
      rows.length > limit && last
        ? encodeCursor(last.reviewDueAt!, last.id)
        : null,
  };
}

export type RecentlyReviewedDocument = {
  id: string;
  title: string;
  path: string;
  projectId: string;
  projectName: string;
  lastReviewedAt: Date;
  reviewedBy: DocumentAuthor | null;
  dueAt: Date | null;
};

/** Latest review per document, read from the projection columns only. */
export async function listRecentlyReviewed(
  db: PrismaClient,
  input: { cursor?: string; limit?: number },
  actor: ProjectActor,
): Promise<{ items: RecentlyReviewedDocument[]; nextCursor: string | null }> {
  const { limit, after } = pageWindow(input);
  const rows = await db.document.findMany({
    where: {
      AND: [
        { lastReviewedAt: { not: null }, project: accessibleProjects(actor) },
        ...(after
          ? [
              {
                OR: [
                  { lastReviewedAt: { lt: after.at } },
                  { lastReviewedAt: after.at, id: { gt: after.id } },
                ],
              },
            ]
          : []),
      ],
    },
    orderBy: [{ lastReviewedAt: "desc" }, { id: "asc" }],
    take: limit + 1,
    select: {
      id: true,
      title: true,
      path: true,
      projectId: true,
      reviewDueAt: true,
      lastReviewedAt: true,
      reviewedById: true,
      reviewedByName: true,
      reviewedBy: { select: { name: true, email: true } },
      project: { select: { name: true } },
    },
  });
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => ({
      id: row.id,
      title: row.title,
      path: row.path,
      projectId: row.projectId,
      projectName: row.project.name,
      lastReviewedAt: row.lastReviewedAt!,
      reviewedBy: presentAuthor(
        row.reviewedById,
        row.reviewedByName,
        row.reviewedBy,
      ),
      dueAt: row.reviewDueAt,
    })),
    nextCursor:
      rows.length > limit && last
        ? encodeCursor(last.lastReviewedAt!, last.id)
        : null,
  };
}

export async function countDocumentsToReview(
  db: PrismaClient,
  actor: ProjectActor,
): Promise<number> {
  return db.document.count({ where: dueWhere(actor) });
}

export async function isReviewerAnywhere(
  db: PrismaClient,
  actor: ProjectActor,
): Promise<boolean> {
  return (
    (await db.document.count({
      where: {
        project: accessibleProjects(actor),
        ...reviewerFilter(actor.userId),
      },
      take: 1,
    })) > 0
  );
}

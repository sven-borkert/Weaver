import type { Document, PrismaClient } from "@weaver/db/client";
import type { GitLogEntry, ProjectRepoWriter } from "@weaver/git-store";
import {
  assertAuthorName,
  authorForUser,
  composeDocumentFile,
  DOCUMENT_HEADER_VERSION,
  parseDocumentFile,
  type DocumentAuthor,
} from "../documents/frontmatter";
import { documentKindOfPath } from "../documents/kinds";
import { reviewDueAt, type DocumentReview } from "../documents/review";
import {
  isDocumentFilePath,
  repairDocumentProjectionInRepo,
  resolveAttribution,
} from "./documents";
import {
  notifyProjectContentChanged,
  SYSTEM_USER_ID,
} from "./projectGitRemoteJobs";
import { withExistingProjectRepo } from "./projectRepo";
import { defaultReviewFor } from "./reviewerGroups";

const PROJECTS_PER_PASS = 20;
const DOCUMENTS_PER_PROJECT = 500;
/** Whole-file history: the oldest entry is the creating commit. */
const HISTORY_LIMIT = 100_000;
const UNKNOWN_AUTHOR = "Unknown author";
export const SYSTEM_AUTHOR = {
  name: "Weaver",
  email: "weaver@local",
  userId: SYSTEM_USER_ID,
};

/** One system commit per project: current header format, authors filled from Git history. */
export async function upgradeDocumentHeaders(
  db: PrismaClient,
  options: { documentsPerProject?: number } = {},
): Promise<{ projects: number; documents: number }> {
  const pending = await db.project.findMany({
    where: {
      deletedAt: null,
      OR: [
        { documentHeaderVersion: { lt: DOCUMENT_HEADER_VERSION } },
        {
          documents: {
            some: { OR: [{ createdByName: null }, { updatedByName: null }] },
          },
        },
        {
          documents: {
            some: { reviewEveryMonths: null, reviewExempt: false },
          },
        },
      ],
    },
    select: { id: true },
    orderBy: { id: "asc" },
    take: PROJECTS_PER_PASS,
  });
  const errors: unknown[] = [];
  let documents = 0;
  for (const { id: projectId } of pending) {
    try {
      const result = await withExistingProjectRepo(projectId, (repo) =>
        upgradeProject(
          db,
          repo,
          projectId,
          options.documentsPerProject ?? DOCUMENTS_PER_PROJECT,
        ),
      );
      documents += result?.changed ?? 0;
      if (!result || result.complete)
        await db.project.update({
          where: { id: projectId },
          data: { documentHeaderVersion: DOCUMENT_HEADER_VERSION },
        });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      "document header upgrade failed for some projects",
    );
  return { projects: pending.length, documents };
}

export async function authorOf(
  db: PrismaClient,
  entry: GitLogEntry,
): Promise<DocumentAuthor> {
  const [user] = await resolveAttribution(db, [entry]);
  if (user?.kind === "machine") return { id: null, name: user.name };
  if (user) return authorForUser(user);
  try {
    assertAuthorName(entry.authorName);
    return { id: null, name: entry.authorName };
  } catch {
    return { id: null, name: UNKNOWN_AUTHOR };
  }
}

/** Repair searches every tracked file for the row's id; null means no usable file carries it. */
function isBackedByNoUsableFile(repaired: Document | null | undefined) {
  return repaired === null;
}

async function upgradeProject(
  db: PrismaClient,
  repo: ProjectRepoWriter,
  projectId: string,
  documentsPerProject: number,
): Promise<{ changed: number; complete: boolean }> {
  const head = await repo.resolveHead();
  const changed: Array<{ id: string; path: string }> = [];
  let complete = true;
  let onlyReview = true;
  let defaults: DocumentReview | undefined;
  const projectDefaults = async () =>
    (defaults ??= await defaultReviewFor(
      db,
      projectId,
      new Date().toISOString(),
    ));
  for (const file of (await repo.listTrackedFiles(head))
    .filter(isDocumentFilePath)
    .sort()) {
    // Python files are always written with a current header.
    if (documentKindOfPath(file) !== "markdown") continue;
    if (changed.length >= documentsPerProject) {
      complete = false;
      break;
    }
    let parsed: ReturnType<typeof parseDocumentFile>;
    try {
      parsed = parseDocumentFile(
        await repo.readFileFromWorktree(file),
        "markdown",
      );
    } catch {
      continue;
    }
    const { meta, body, legacy } = parsed;
    const exempt = meta.properties?.reviewExempt === true && !meta.review;
    if (!legacy && meta.createdBy && meta.updatedBy && (meta.review || exempt))
      continue;
    let { createdBy, updatedBy } = meta;
    if (!createdBy || !updatedBy) {
      const history = await repo.logForPath(file, {
        skip: 0,
        limit: HISTORY_LIMIT,
      });
      const newest = history[0];
      const oldest = history.at(-1);
      if (newest && oldest) {
        createdBy ??= await authorOf(db, oldest);
        updatedBy ??= await authorOf(db, newest);
      }
    }
    const review = exempt ? null : (meta.review ?? (await projectDefaults()));
    await repo.writeFileAtomic(
      file,
      composeDocumentFile(
        { ...meta, createdBy, updatedBy, review },
        body,
        "markdown",
      ),
    );
    onlyReview &&= !legacy && Boolean(meta.createdBy && meta.updatedBy);
    changed.push({ id: meta.id, path: file });
  }
  if (!changed.length) {
    // The files are current; only the projection lags behind.
    const stale = await db.document.findMany({
      where: {
        projectId,
        OR: [
          { createdByName: null },
          { updatedByName: null },
          { reviewEveryMonths: null, reviewExempt: false },
        ],
      },
      select: { id: true, path: true },
      take: documentsPerProject,
    });
    const repaired = new Map<string, Document | null>();
    for (const document of stale)
      repaired.set(
        document.id,
        await repairDocumentProjectionInRepo(
          db,
          repo,
          projectId,
          document.id,
          document.path,
        ),
      );
    // A row whose file no longer parses cannot be filled; name its authors
    // unknown so the project leaves the pending set.
    const ids = stale.map((document) => document.id);
    await db.document.updateMany({
      where: { projectId, id: { in: ids }, createdByName: null },
      data: { createdById: null, createdByName: UNKNOWN_AUTHOR },
    });
    await db.document.updateMany({
      where: { projectId, id: { in: ids }, updatedByName: null },
      data: { updatedById: null, updatedByName: UNKNOWN_AUTHOR },
    });
    const unreviewed = await db.document.findMany({
      where: {
        projectId,
        id: { in: ids },
        reviewEveryMonths: null,
        reviewExempt: false,
      },
      select: { id: true },
    });
    const drain = unreviewed
      .map((document) => document.id)
      .filter((id) => isBackedByNoUsableFile(repaired.get(id)));
    if (drain.length) {
      const { everyMonths, since } = await projectDefaults();
      await db.document.updateMany({
        where: { projectId, id: { in: drain }, reviewEveryMonths: null },
        data: {
          reviewEveryMonths: everyMonths,
          reviewSince: new Date(since),
          reviewDueAt: reviewDueAt({
            reviewers: [],
            everyMonths,
            since,
            lastReviewed: null,
            reviewedBy: null,
          }),
        },
      });
    }
    return { changed: 0, complete };
  }
  await repo.commitAll(
    onlyReview
      ? "chore: add document review metadata"
      : "chore: upgrade document headers",
    SYSTEM_AUTHOR,
  );
  for (const document of changed)
    await repairDocumentProjectionInRepo(
      db,
      repo,
      projectId,
      document.id,
      document.path,
    );
  void notifyProjectContentChanged(db, projectId);
  return { changed: changed.length, complete };
}

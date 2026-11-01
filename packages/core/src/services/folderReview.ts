import type { PrismaClient, Prisma } from "@weaver/db/client";
import type { ProjectRepoReader, ProjectRepoWriter } from "@weaver/git-store";
import { closestFolderReviewDefault } from "../documents/folderReview";
import type { StoredFolderReviewDefaults } from "../documents/folderReview";
import type { DocumentReview } from "../documents/review";
import { readFolderMetadataAt, readRootFolderMetadataAt } from "./folders";
import {
  defaultReviewFor,
  getConfiguredProjectReviewers,
  reviewFromConfiguredDefaults,
  resolveReviewerTargets,
  type ReviewerTarget,
} from "./reviewerGroups";
import { documentTitleSchema } from "../documents/title";
import { CoreError } from "../errors";
import { assertSafeSegments, folderNotFound } from "../documents/paths";
import { assertOutsideTablesRoot } from "../tables/paths";
import {
  authorForUser,
  composeDocumentFile,
  parseDocumentFile,
} from "../documents/frontmatter";
import { documentKindOfPath } from "../documents/kinds";
import {
  composeFolderMetadata,
  composeRootFolderMetadata,
  parseFolderMetadata,
  parseRootFolderMetadata,
  folderMetadataPath,
  type FolderMetadata,
  type RootFolderMetadata,
} from "../documents/folderMetadata";
import { MAX_REVIEWERS, type ReviewerRef } from "../documents/review";
import {
  folderReviewExceedsLimits,
  normalizeFolderReviewDefaults,
} from "../documents/folderReview";
import {
  author,
  assertDocumentFileSize,
  documentSlugFromPath,
  isDocumentFilePath,
  projectPreparedDocumentInRepo,
  reportProjectionFailureAndReconcile,
  type EnrichedActor,
} from "./documents";
import { listScopeDirsAt } from "./folders";
import {
  assertProjectRole,
  projectRoleAtLeast,
  resolveProjectAccess,
  type ProjectActor,
} from "./projectAccess";
import { hasCapability } from "../security/context";
import { withExistingProjectRepoReader, withProjectRepo } from "./projectRepo";
import { notifyProjectContentChanged } from "./projectGitRemoteJobs";
import { effectiveReviewerDocumentIds } from "./documentReview";

export type FolderReviewTarget = { projectId: string; path: string[] };

/** Uses the caller's writer lock and its current committed ancestor settings. */
export async function defaultReviewForFolderInRepo(
  db: PrismaClient | Prisma.TransactionClient,
  repo: ProjectRepoWriter,
  input: FolderReviewTarget & { now: string },
): Promise<DocumentReview> {
  const head = await repo.resolveHead();
  const dirs = input.path.map((_, index) =>
    input.path.slice(0, index + 1).join("/"),
  );
  const metadata = await readFolderMetadataAt(repo, "documents", head, dirs);
  const defaults: Record<string, StoredFolderReviewDefaults> = {};
  for (const [path, meta] of Object.entries(metadata))
    if (meta.reviewDefaults) defaults[path] = meta.reviewDefaults;
  const root = await readRootFolderMetadataAt(repo, head);
  if (root?.reviewDefaults) defaults[""] = root.reviewDefaults;
  const inherited = closestFolderReviewDefault(input.path, defaults);
  return defaultReviewFor(db, input.projectId, input.now, inherited?.reviewers);
}

export type FolderReviewInput = FolderReviewTarget & {
  reviewers: ReviewerTarget[];
};
export type FolderReviewPreflight = {
  baseProjectCommitSha: string;
  documentCount: number;
  changedDocumentCount: number;
  descendantDefaultOverrideCount: number;
  rewrittenBytes: number;
  exceedsLimits: boolean;
};
export type FolderReviewResult = {
  headCommitSha: string;
  changedDocumentCount: number;
};

type FolderReviewActor = ProjectActor &
  Partial<Pick<EnrichedActor, "name" | "email">>;

type PreparedFile = {
  path: string;
  original: string | null;
  content: string;
  documentId?: string;
};
type Inventory = {
  head: string;
  documents: string[];
  dirs: string[];
  blobs: Map<string, string>;
  tracked: Set<string>;
};

function assertTarget(input: FolderReviewTarget) {
  try {
    assertSafeSegments(input.path);
    assertOutsideTablesRoot(input.path);
  } catch {
    throw new CoreError("BAD_REQUEST", "Invalid folder path", {
      field: "path",
    });
  }
}

function assertHead(actual: string, expected: string) {
  if (!/^[0-9a-f]{40}$/.test(expected))
    throw new CoreError("BAD_REQUEST", "Invalid project revision");
  if (actual !== expected)
    throw new CoreError(
      "CONFLICT",
      "The project changed. Refresh the preview and try again.",
      { headCommitSha: actual },
    );
}

function inSubtree(path: string, target: string) {
  return !target || path === target || path.startsWith(`${target}/`);
}

async function inventory(
  repo: ProjectRepoReader,
  input: FolderReviewTarget,
  includeDocuments = true,
): Promise<Inventory> {
  assertTarget(input);
  const head = await repo.resolveHead();
  const dirs = await listScopeDirsAt(repo, "documents", head);
  const target = input.path.join("/");
  if (target && !dirs.includes(target)) throw folderNotFound("path");
  const tracked = new Set(await repo.listTrackedFiles(head));
  const documents = includeDocuments
    ? [...tracked].filter(
        (path) => isDocumentFilePath(path) && inSubtree(path, target),
      )
    : [];
  const blobs = await repo.readBlobsAt(head, [
    ...documents,
    ...dirs.map(folderMetadataPath),
    folderMetadataPath(""),
  ]);
  return { head, dirs, documents, blobs, tracked };
}

function folderMeta(
  source: Inventory,
  dir: string,
  strictDefaults = false,
): FolderMetadata | RootFolderMetadata {
  const text = source.blobs.get(folderMetadataPath(dir));
  if (text === undefined && source.tracked.has(folderMetadataPath(dir)))
    throw new CoreError(
      "BAD_REQUEST",
      "Folder metadata is too large or unreadable",
    );
  if (text === undefined)
    return dir
      ? {
          name: dir.split("/").at(-1)!,
          created: null,
          createdBy: null,
          updated: null,
          updatedBy: null,
        }
      : {};
  const meta = dir ? parseFolderMetadata(text) : parseRootFolderMetadata(text);
  if (!meta)
    throw new CoreError(
      "BAD_REQUEST",
      `Invalid folder metadata at ${dir || "the document root"}`,
    );
  if (strictDefaults) {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (
      Object.hasOwn(raw, "reviewDefaults") &&
      !normalizeFolderReviewDefaults(raw.reviewDefaults)
    )
      throw new CoreError(
        "BAD_REQUEST",
        `Invalid reviewer defaults at ${dir || "the document root"}. Repair the setting before changing reviewers.`,
      );
  }
  return meta;
}

function defaultsIn(source: Inventory, path: string[]) {
  const defaults: Record<string, StoredFolderReviewDefaults> = {};
  for (const dir of [
    "",
    ...path.map((_, index) => path.slice(0, index + 1).join("/")),
  ]) {
    const meta = folderMeta(source, dir);
    if (meta.reviewDefaults) defaults[dir] = meta.reviewDefaults;
  }
  return defaults;
}

/** Fully prepares validated replacements before the first worktree mutation. */
function prepare(
  source: Inventory,
  input: FolderReviewInput,
  reviewers: ReviewerRef[],
  fallback: DocumentReview,
  actor: FolderReviewActor,
  now: string,
) {
  const files: PreparedFile[] = [];
  const ids = new Set<string>();
  let changedDocumentCount = 0;
  let rewrittenBytes = 0;
  for (const path of source.documents) {
    const original = source.blobs.get(path);
    if (original === undefined)
      throw new CoreError("BAD_REQUEST", `Missing document at ${path}`);
    let parsed: ReturnType<typeof parseDocumentFile>;
    try {
      documentSlugFromPath(path);
      parsed = parseDocumentFile(original, documentKindOfPath(path));
      if (documentTitleSchema.parse(parsed.meta.title) !== parsed.meta.title)
        throw new Error("Noncanonical title");
    } catch {
      throw new CoreError(
        "BAD_REQUEST",
        `Invalid document at ${path}. Repair it before assigning reviewers.`,
      );
    }
    if (ids.has(parsed.meta.id))
      throw new CoreError(
        "BAD_REQUEST",
        "Duplicate document identity in this subtree",
      );
    ids.add(parsed.meta.id);
    const review = parsed.meta.review ?? fallback;
    if (
      parsed.meta.review &&
      JSON.stringify(review.reviewers) === JSON.stringify(reviewers)
    )
      continue;
    const content = composeDocumentFile(
      { ...parsed.meta, review: { ...review, reviewers } },
      parsed.body,
      documentKindOfPath(path),
    );
    assertDocumentFileSize(content, path);
    if (original === content) continue;
    files.push({ path, original, content, documentId: parsed.meta.id });
    changedDocumentCount++;
    rewrittenBytes += Buffer.byteLength(content, "utf8");
  }
  let descendantDefaultOverrideCount = 0;
  const target = input.path.join("/");
  for (const dir of [
    target,
    ...source.dirs.filter((dir) => dir !== target && inSubtree(dir, target)),
  ]) {
    assertTarget({ ...input, path: dir ? dir.split("/") : [] });
    const meta = folderMeta(source, dir, true);
    const wanted = dir === target ? { reviewers } : undefined;
    if (dir !== target && meta.reviewDefaults) descendantDefaultOverrideCount++;
    if (JSON.stringify(meta.reviewDefaults) === JSON.stringify(wanted))
      continue;
    const next = { ...meta, reviewDefaults: wanted };
    const content = dir
      ? composeFolderMetadata({
          ...(next as FolderMetadata),
          updated: now,
          updatedBy: authorForUser({
            id: actor.userId,
            name: actor.name ?? null,
            email: actor.email ?? "unknown@local",
          }),
        })
      : composeRootFolderMetadata(next);
    const path = folderMetadataPath(dir);
    files.push({ path, original: source.blobs.get(path) ?? null, content });
  }
  return {
    files,
    preflight: {
      baseProjectCommitSha: source.head,
      documentCount: source.documents.length,
      changedDocumentCount,
      descendantDefaultOverrideCount,
      rewrittenBytes,
      exceedsLimits: folderReviewExceedsLimits(
        changedDocumentCount,
        rewrittenBytes,
      ),
    } satisfies FolderReviewPreflight,
  };
}

async function prepareInRepo(
  db: PrismaClient,
  repo: ProjectRepoReader,
  input: FolderReviewInput,
  actor: FolderReviewActor,
  expectedHead?: string,
) {
  const source = await inventory(repo, input);
  if (expectedHead !== undefined) assertHead(source.head, expectedHead);
  if (
    input.reviewers.length > MAX_REVIEWERS ||
    input.reviewers.some(
      (ref) =>
        !["user", "group"].includes(ref.type) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          ref.id,
        ),
    )
  )
    throw new CoreError(
      "BAD_REQUEST",
      "Select at most 50 current project reviewers",
      { field: "reviewers" },
    );
  const reviewers = await resolveReviewerTargets(
    db,
    input.projectId,
    input.reviewers,
  );
  const now = new Date().toISOString();
  const fallback = await defaultReviewFor(db, input.projectId, now);
  const prepared = prepare(source, input, reviewers, fallback, actor, now);
  const ids = prepared.files.flatMap((file) =>
    file.documentId ? [file.documentId] : [],
  );
  if (
    ids.length &&
    (await db.document.findFirst({
      where: { id: { in: ids }, projectId: { not: input.projectId } },
    }))
  )
    throw new CoreError(
      "BAD_REQUEST",
      "A document identity belongs to another project",
    );
  return prepared;
}

export async function getFolderReviewDefaults(
  db: PrismaClient,
  input: FolderReviewTarget,
  actor: ProjectActor,
): Promise<{
  reviewers: ReviewerRef[];
  configuredReviewers: ReviewerRef[];
  inheritedFrom: string[] | null;
  hasOwnDefault: boolean;
  canManage: boolean;
  baseProjectCommitSha: string;
}> {
  await assertProjectRole(db, input.projectId, actor, "Viewer");
  const result = await withExistingProjectRepoReader(
    input.projectId,
    async (repo) => {
      const access = await assertProjectRole(
        db,
        input.projectId,
        actor,
        "Viewer",
      );
      const source = await inventory(repo, input, false);
      const defaults = defaultsIn(source, input.path);
      const closest = closestFolderReviewDefault(input.path, defaults);
      const configuredReviewers =
        closest?.reviewers ??
        (await getConfiguredProjectReviewers(db, input.projectId));
      const effective = await reviewFromConfiguredDefaults(
        db,
        input.projectId,
        new Date().toISOString(),
        {
          reviewers: configuredReviewers,
          source: closest ? "folder" : "project",
        },
      );
      return {
        reviewers: effective.reviewers,
        configuredReviewers,
        inheritedFrom: closest?.path ?? null,
        hasOwnDefault: Object.hasOwn(defaults, input.path.join("/")),
        canManage:
          projectRoleAtLeast(access.effectiveRole, "Maintainer") &&
          hasCapability(actor, "content:write"),
        baseProjectCommitSha: source.head,
      };
    },
  );
  if (!result) throw new CoreError("NOT_FOUND");
  return result;
}

export async function previewFolderReview(
  db: PrismaClient,
  input: FolderReviewInput,
  actor: ProjectActor,
): Promise<FolderReviewPreflight> {
  await assertProjectRole(db, input.projectId, actor, "Maintainer", {
    capability: "content:read",
  });
  const result = await withExistingProjectRepoReader(
    input.projectId,
    async (repo) => {
      await assertProjectRole(db, input.projectId, actor, "Maintainer", {
        capability: "content:read",
      });
      return (await prepareInRepo(db, repo, input, actor)).preflight;
    },
  );
  if (!result) throw new CoreError("NOT_FOUND");
  return result;
}

async function commitFiles(
  repo: ProjectRepoWriter,
  files: PreparedFile[],
  head: string,
  actor: EnrichedActor,
  message: string,
): Promise<string> {
  if (!files.length) return head;
  try {
    for (const file of files)
      await repo.writeFileAtomic(file.path, file.content);
    return await repo.commitAll(message, author(actor));
  } catch (error) {
    const committedHead = await repo.resolveHead();
    if (committedHead !== head) return committedHead;
    for (const file of files)
      if (file.original !== null)
        await repo.writeBinaryFileAtomic(file.path, Buffer.from(file.original));
    await repo.resetWorktreeTo(head);
    for (const file of files)
      if (file.original === null) await repo.removeUntrackedFile(file.path);
    throw error;
  }
}

async function projectFiles(
  db: PrismaClient,
  repo: ProjectRepoWriter,
  projectId: string,
  files: PreparedFile[],
  sha: string,
  actor: EnrichedActor,
) {
  for (const file of files) {
    if (!file.documentId) continue;
    try {
      const parsed = parseDocumentFile(
        file.content,
        documentKindOfPath(file.path),
      );
      await projectPreparedDocumentInRepo(db, repo, {
        projectId,
        path: file.path,
        ...parsed,
        sha,
        actorId: actor.userId,
      });
    } catch (error) {
      await reportProjectionFailureAndReconcile({
        projectId,
        documentId: file.documentId,
        headCommitSha: sha,
        error,
      });
    }
  }
}

export async function setFolderReviewRecursively(
  db: PrismaClient,
  input: FolderReviewInput & { expectedHeadCommitSha: string },
  actor: EnrichedActor,
): Promise<FolderReviewResult> {
  await assertProjectRole(db, input.projectId, actor, "Maintainer");
  let changed = false;
  const result = await withProjectRepo(input.projectId, async (repo) => {
    await assertProjectRole(db, input.projectId, actor, "Maintainer");
    const { files, preflight } = await prepareInRepo(
      db,
      repo,
      input,
      actor,
      input.expectedHeadCommitSha,
    );
    if (preflight.exceedsLimits)
      throw new CoreError(
        "BAD_REQUEST",
        "This assignment exceeds 1,000 document rewrites or 50 MiB. Select a smaller folder and preview again.",
      );
    const sha = await commitFiles(
      repo,
      files,
      preflight.baseProjectCommitSha,
      actor,
      `review: assign folder reviewers ${input.path.join("/") || "/"}`,
    );
    changed = files.length > 0;
    await projectFiles(db, repo, input.projectId, files, sha, actor);
    return {
      headCommitSha: sha,
      changedDocumentCount: preflight.changedDocumentCount,
    };
  });
  if (changed) void notifyProjectContentChanged(db, input.projectId);
  return result;
}

export async function clearFolderReviewDefault(
  db: PrismaClient,
  input: FolderReviewTarget & { expectedHeadCommitSha: string },
  actor: EnrichedActor,
): Promise<{ headCommitSha: string }> {
  await assertProjectRole(db, input.projectId, actor, "Maintainer");
  let changed = false;
  const result = await withProjectRepo(input.projectId, async (repo) => {
    await assertProjectRole(db, input.projectId, actor, "Maintainer");
    const source = await inventory(repo, input, false);
    assertHead(source.head, input.expectedHeadCommitSha);
    const dir = input.path.join("/");
    const meta = folderMeta(source, dir, true);
    if (!meta.reviewDefaults) return { headCommitSha: source.head };
    const path = folderMetadataPath(dir);
    const next = { ...meta, reviewDefaults: undefined };
    const content = dir
      ? composeFolderMetadata({
          ...(next as FolderMetadata),
          updated: new Date().toISOString(),
          updatedBy: authorForUser({
            id: actor.userId,
            name: actor.name ?? null,
            email: actor.email ?? "unknown@local",
          }),
        })
      : composeRootFolderMetadata(next);
    const headCommitSha = await commitFiles(
      repo,
      [{ path, original: source.blobs.get(path) ?? null, content }],
      source.head,
      actor,
      `review: use parent default ${dir || "/"}`,
    );
    changed = true;
    return { headCommitSha };
  });
  if (changed) void notifyProjectContentChanged(db, input.projectId);
  return result;
}

export type FolderMarkReviewedPreflight = {
  baseProjectCommitSha: string;
  documentCount: number;
  eligibleDocumentCount: number;
  skippedDocumentCount: number;
  rewrittenBytes: number;
  exceedsLimits: boolean;
};

/** Prepares the review stamp for every subtree document the actor is an effective reviewer of. */
async function prepareMarkInRepo(
  db: PrismaClient,
  repo: ProjectRepoReader,
  input: FolderReviewTarget,
  actor: FolderReviewActor,
  expectedHead?: string,
) {
  const source = await inventory(repo, input);
  if (expectedHead !== undefined) assertHead(source.head, expectedHead);
  const parsed = new Map<
    string,
    { path: string; original: string } & ReturnType<typeof parseDocumentFile>
  >();
  for (const path of source.documents) {
    const original = source.blobs.get(path);
    if (original === undefined) continue;
    try {
      const file = parseDocumentFile(original, documentKindOfPath(path));
      if (!parsed.has(file.meta.id))
        parsed.set(file.meta.id, { path, original, ...file });
    } catch {
      // An unreadable file cannot be reviewed; it counts as skipped.
    }
  }
  const mine = await effectiveReviewerDocumentIds(
    db,
    input.projectId,
    [...parsed.keys()],
    actor.userId,
  );
  const now = new Date().toISOString();
  const fallback = await defaultReviewFor(db, input.projectId, now);
  const reviewedBy = authorForUser({
    id: actor.userId,
    name: actor.name ?? null,
    email: actor.email ?? "unknown@local",
  });
  const files: PreparedFile[] = [];
  let rewrittenBytes = 0;
  for (const [id, file] of parsed) {
    if (mine.get(id) !== file.path) continue;
    const content = composeDocumentFile(
      {
        ...file.meta,
        review: {
          ...(file.meta.review ?? fallback),
          lastReviewed: now,
          reviewedBy,
        },
      },
      file.body,
      documentKindOfPath(file.path),
    );
    assertDocumentFileSize(content, file.path);
    files.push({
      path: file.path,
      original: file.original,
      content,
      documentId: id,
    });
    rewrittenBytes += Buffer.byteLength(content, "utf8");
  }
  return {
    files,
    preflight: {
      baseProjectCommitSha: source.head,
      documentCount: source.documents.length,
      eligibleDocumentCount: files.length,
      skippedDocumentCount: source.documents.length - files.length,
      rewrittenBytes,
      exceedsLimits: folderReviewExceedsLimits(files.length, rewrittenBytes),
    } satisfies FolderMarkReviewedPreflight,
  };
}

export async function previewFolderMarkReviewed(
  db: PrismaClient,
  input: FolderReviewTarget,
  actor: FolderReviewActor,
): Promise<FolderMarkReviewedPreflight> {
  await assertProjectRole(db, input.projectId, actor, "Viewer");
  const result = await withExistingProjectRepoReader(
    input.projectId,
    async (repo) => {
      await assertProjectRole(db, input.projectId, actor, "Viewer");
      return (await prepareMarkInRepo(db, repo, input, actor)).preflight;
    },
  );
  if (!result) throw new CoreError("NOT_FOUND");
  return result;
}

/** Any member may call this; only documents the actor is an effective reviewer of are stamped. */
export async function markFolderReviewed(
  db: PrismaClient,
  input: FolderReviewTarget & { expectedHeadCommitSha: string },
  actor: EnrichedActor,
): Promise<FolderReviewResult> {
  const authorize = async () => {
    // Membership first so a non-member cannot probe folders.
    await resolveProjectAccess(db, input.projectId, actor);
    if (!hasCapability(actor, "content:write"))
      throw new CoreError("FORBIDDEN");
  };
  await authorize();
  let changed = false;
  const result = await withProjectRepo(input.projectId, async (repo) => {
    await authorize();
    const { files, preflight } = await prepareMarkInRepo(
      db,
      repo,
      input,
      actor,
      input.expectedHeadCommitSha,
    );
    if (preflight.exceedsLimits)
      throw new CoreError(
        "BAD_REQUEST",
        "This folder exceeds 1,000 document rewrites or 50 MiB. Select a smaller folder and try again.",
      );
    const sha = await commitFiles(
      repo,
      files,
      preflight.baseProjectCommitSha,
      actor,
      `review: mark folder reviewed ${input.path.join("/") || "/"}`,
    );
    changed = files.length > 0;
    await projectFiles(db, repo, input.projectId, files, sha, actor);
    return { headCommitSha: sha, changedDocumentCount: files.length };
  });
  if (changed) void notifyProjectContentChanged(db, input.projectId);
  return result;
}

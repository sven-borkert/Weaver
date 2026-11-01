import { normalizeAppearance, type Appearance } from "../appearance/metadata";
import { CoreError } from "@weaver/core/errors";
import {
  Prisma,
  type DocumentKind,
  type PrismaClient,
} from "@weaver/db/client";
import { hasAssetsSegment } from "@weaver/core/documents/images";
import {
  documentIndexLights,
  type IndexStateRow,
} from "@weaver/core/documents/indexLight";
import {
  MAX_FOLDER_DEPTH,
  assertSafeSegments,
  folderNotFound,
} from "@weaver/core/documents/paths";
import { slugify } from "@weaver/core/documents/slug";
import {
  composeFolderMetadata,
  folderMetadataPath,
  isFolderMarkerFile,
  newFolderMetadata,
  normalizeFolderName,
  parseFolderMetadata,
  parseRootFolderMetadata,
  type RootFolderMetadata,
  type FolderMetadata,
} from "@weaver/core/documents/folderMetadata";
import type { StoredFolderReviewDefaults } from "../documents/folderReview";
import {
  authorForUser,
  type DocumentAuthor,
} from "@weaver/core/documents/frontmatter";
import {
  TABLES_ROOT,
  assertOutsideTablesRoot,
  isTableDirName,
} from "@weaver/core/tables/paths";
import { assertProjectRole, type ProjectActor } from "./projectAccess";
import {
  openProjectRepo,
  type ProjectRepoReader,
  type ProjectRepoWriter,
} from "@weaver/git-store";
import { presentAuthor } from "./documents";
import { withProjectRepo } from "./projectRepo";
import {
  enqueueDocumentChanged,
  enqueueProjectReconcile,
  enqueueTableChanged,
} from "./knowledgeReconciliation";
import { notifyProjectContentChanged } from "./projectGitRemoteJobs";
import { captureError } from "../diagnostics/writer";

type Actor = ProjectActor & { name?: string | null; email?: string };

function actorAuthor(actor: Actor) {
  return {
    name: actor.name ?? null,
    email: actor.email ?? "unknown@local",
    userId: actor.userId,
  };
}

function folderAuthor(actor: Actor): DocumentAuthor {
  return authorForUser({
    id: actor.userId,
    name: actor.name ?? null,
    email: actor.email ?? "unknown@local",
  });
}

export type FolderScope = "documents" | "tables";

export type FolderWriteResult = {
  /** Scope-relative segments — what the exported wrappers return. */
  segments: string[];
  /** Repository-relative path; carries the tables root in the tables scope. */
  path: string;
  headCommitSha: string;
};

/** Commit trailers a folder write may carry, so a lost acknowledgement can be
 * recognised by operation id exactly like a document or table write. */
export type FolderAudit = {
  operationId?: string;
  mcpRequestHash?: string;
  mcpToolName?: string;
  runId?: string;
};

const scopeRoot = (scope: FolderScope): string[] =>
  scope === "tables" ? [TABLES_ROOT] : [];

const toRel = (scope: FolderScope, segments: string[]): string =>
  [...scopeRoot(scope), ...segments].join("/");

function assertScopePath(scope: FolderScope, segments: string[]): void {
  try {
    assertSafeSegments(segments);
    if (scope === "documents") assertOutsideTablesRoot(segments);
  } catch {
    throw new CoreError("BAD_REQUEST", "invalid folder path");
  }
}

/** Worktree directories visible inside a folder scope. */
export async function listScopeDirs(
  repo: ProjectRepoWriter,
  scope: FolderScope,
): Promise<string[]> {
  const dirs = await repo.listWorktreeDirs();
  if (scope === "documents") {
    return dirs
      .filter((dir) => !hasAssetsSegment(dir))
      .filter(
        (dir) => dir !== ".weaver-icons" && !dir.startsWith(".weaver-icons/"),
      )
      .filter(
        (dir) => dir !== TABLES_ROOT && !dir.startsWith(`${TABLES_ROOT}/`),
      );
  }
  return dirs
    .filter((dir) => dir.startsWith(`${TABLES_ROOT}/`))
    .map((dir) => dir.slice(TABLES_ROOT.length + 1))
    .filter(
      (dir) => !dir.split("/").some((segment) => isTableDirName(segment)),
    );
}

export async function listScopeDirsAt(
  repo: ProjectRepoReader,
  scope: FolderScope,
  commitish: string,
): Promise<string[]> {
  const dirs = new Set<string>();
  for (const file of await repo.listTrackedFiles(commitish)) {
    const segments = file.split("/").slice(0, -1);
    for (let length = 1; length <= segments.length; length++) {
      dirs.add(segments.slice(0, length).join("/"));
    }
  }
  if (scope === "documents") {
    return [...dirs]
      .filter((dir) => !hasAssetsSegment(dir))
      .filter(
        (dir) => dir !== ".weaver-icons" && !dir.startsWith(".weaver-icons/"),
      )
      .filter(
        (dir) => dir !== TABLES_ROOT && !dir.startsWith(`${TABLES_ROOT}/`),
      )
      .sort();
  }
  return [...dirs]
    .filter((dir) => dir.startsWith(`${TABLES_ROOT}/`))
    .map((dir) => dir.slice(TABLES_ROOT.length + 1))
    .filter((dir) => !dir.split("/").some((segment) => isTableDirName(segment)))
    .sort();
}

async function assertNoSibling(
  repo: ProjectRepoWriter,
  parentRel: string,
  seg: string,
): Promise<void> {
  const rel = parentRel.length > 0 ? `${parentRel}/${seg}` : seg;
  if (await repo.fileExistsInWorktree(rel)) {
    throw new CoreError(
      "CONFLICT",
      "A folder with this (slugified) name already exists here",
      { field: "name" },
    );
  }
}

async function assertExistingFolder(
  repo: ProjectRepoWriter,
  rel: string,
  field: "path" | "parentPath" | "newParentPath",
): Promise<void> {
  if (rel.length > 0 && !(await repo.fileExistsInWorktree(rel))) {
    throw folderNotFound(field);
  }
}

/** Metadata of the given scope-relative folders at one revision; folders without a readable file are absent. */
export async function readFolderMetadataAt(
  repo: ProjectRepoReader,
  scope: FolderScope,
  commitish: string,
  dirs: string[],
): Promise<Record<string, FolderMetadata>> {
  const metadata: Record<string, FolderMetadata> = {};
  if (dirs.length === 0) return metadata;
  const pathsByDir = new Map(
    dirs.map((dir) => [
      folderMetadataPath(toRel(scope, dir ? dir.split("/") : [])),
      dir,
    ]),
  );
  const blobs = await repo.readBlobsAt(commitish, [...pathsByDir.keys()]);
  for (const [path, text] of blobs) {
    const dir = pathsByDir.get(path);
    const parsed = parseFolderMetadata(text);
    if (dir !== undefined && parsed) metadata[dir] = parsed;
  }
  return metadata;
}

/** Nameless document-root settings at the same captured revision as the folder tree. */
export async function readRootFolderMetadataAt(
  repo: ProjectRepoReader,
  commitish: string,
): Promise<RootFolderMetadata | null> {
  const path = folderMetadataPath("");
  const text = (await repo.readBlobsAt(commitish, [path])).get(path);
  return text === undefined ? null : parseRootFolderMetadata(text);
}

/** Display names of the given scope-relative folders at one revision; folders without metadata are absent. */
export async function readFolderNamesAt(
  repo: ProjectRepoReader,
  scope: FolderScope,
  commitish: string,
  dirs: string[],
): Promise<Record<string, string>> {
  return folderNamesOf(
    await readFolderMetadataAt(repo, scope, commitish, dirs),
  );
}

function folderNamesOf(
  metadata: Record<string, FolderMetadata>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata).map(([dir, { name }]) => [dir, name]),
  );
}

export type FolderStamps = {
  createdAt: Date | null;
  createdBy: DocumentAuthor | null;
  updatedAt: Date | null;
  updatedBy: DocumentAuthor | null;
};

/** Names plus create/update stamps for a tree response, with the authors' current user names. */
export async function presentFolderTree(
  db: PrismaClient,
  repo: ProjectRepoReader,
  scope: FolderScope,
  commitish: string,
  dirs: string[],
): Promise<{
  folderNames: Record<string, string>;
  folderStamps: Record<string, FolderStamps>;
  folderAppearances: Record<string, Appearance>;
  folderReviewDefaults: Record<string, StoredFolderReviewDefaults>;
  rootReviewDefaults?: StoredFolderReviewDefaults;
}> {
  const metadata = await readFolderMetadataAt(
    repo,
    scope,
    commitish,
    scope === "tables" ? ["", ...dirs] : dirs,
  );
  const rootReviewDefaults =
    scope === "documents"
      ? (await readRootFolderMetadataAt(repo, commitish))?.reviewDefaults
      : undefined;
  const ids = new Set<string>();
  for (const { createdBy, updatedBy } of Object.values(metadata))
    for (const author of [createdBy, updatedBy])
      if (author?.id) ids.add(author.id);
  const users = ids.size
    ? await db.user.findMany({
        where: { id: { in: [...ids] } },
        select: { id: true, name: true, email: true },
      })
    : [];
  const byId = new Map(users.map((user) => [user.id, user]));
  const present = (author: DocumentAuthor | null) =>
    author
      ? presentAuthor(
          author.id,
          author.name,
          author.id ? (byId.get(author.id) ?? null) : null,
        )
      : null;
  const folderStamps: Record<string, FolderStamps> = {};
  for (const [dir, meta] of Object.entries(metadata))
    folderStamps[dir] = {
      createdAt: meta.created ? new Date(meta.created) : null,
      createdBy: present(meta.createdBy),
      updatedAt: meta.updated ? new Date(meta.updated) : null,
      updatedBy: present(meta.updatedBy),
    };
  const folderAppearances: Record<string, Appearance> = {};
  for (const [dir, meta] of Object.entries(metadata)) {
    const appearance = normalizeAppearance(meta.appearance);
    if (appearance) folderAppearances[dir] = appearance;
  }
  const folderReviewDefaults: Record<string, StoredFolderReviewDefaults> = {};
  if (scope === "documents")
    for (const [dir, meta] of Object.entries(metadata))
      if (meta.reviewDefaults) folderReviewDefaults[dir] = meta.reviewDefaults;
  return {
    folderNames: folderNamesOf(metadata),
    folderStamps,
    folderAppearances,
    folderReviewDefaults,
    ...(rootReviewDefaults === undefined ? {} : { rootReviewDefaults }),
  };
}

/** The committed folder's metadata after a rename or move by `actor`: the creation stamp is kept, the update stamp is new.
 * Null for a folder without metadata that is not being named, which stays untouched. */
async function touchedFolderMetadata(
  repo: ProjectRepoWriter,
  rel: string,
  actor: Actor,
  name?: string,
): Promise<FolderMetadata | null> {
  const metadataRel = folderMetadataPath(rel);
  const committed = (await repo.readBlobsAt("HEAD", [metadataRel])).get(
    metadataRel,
  );
  const existing =
    committed === undefined ? null : parseFolderMetadata(committed);
  const nextName = name ?? existing?.name;
  if (nextName === undefined) return null;
  return {
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.appearance ? { appearance: existing.appearance } : {}),
    ...(existing?.reviewDefaults
      ? { reviewDefaults: existing.reviewDefaults }
      : {}),
    name: nextName,
    created: existing?.created ?? null,
    createdBy: existing?.createdBy ?? null,
    updated: new Date().toISOString(),
    updatedBy: folderAuthor(actor),
  };
}

function requireFolderName(name: string): string {
  const normalized = normalizeFolderName(name);
  if (normalized === null) {
    throw new CoreError("BAD_REQUEST", "Enter a folder name", {
      field: "name",
    });
  }
  return normalized;
}

export async function getTree(
  db: PrismaClient,
  input: { projectId: string },
  actor: ProjectActor,
  scope: FolderScope = "documents",
) {
  await assertProjectRole(db, input.projectId, actor, "Viewer");
  const repo = await openProjectRepo(input.projectId);
  const activeGeneration = await db.knowledgeGeneration.findFirst({
    where: { projectId: input.projectId, status: "active" },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    select: { id: true, configFingerprint: true },
  });
  const generation =
    activeGeneration ??
    (await db.knowledgeGeneration.findFirst({
      where: { projectId: input.projectId, status: "building" },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      select: { id: true, configFingerprint: true },
    }));
  const generationId = generation?.id ?? null;
  // Configuration-blocked active documents show pending while a building generation covers them.
  const coveredByBuild =
    activeGeneration !== null &&
    (await db.knowledgeGeneration.count({
      where: { projectId: input.projectId, status: "building" },
    })) > 0;
  const rows = await db.$queryRaw<
    Array<
      IndexStateRow & {
        appearance: Prisma.JsonValue | null;
        id: string;
        title: string;
        slug: string;
        path: string;
        kind: DocumentKind;
        createdAt: Date;
        createdById: string | null;
        createdByName: string | null;
        creatorName: string | null;
        creatorEmail: string | null;
        updatedAt: Date;
        updatedById: string | null;
        updatedByName: string | null;
        updaterName: string | null;
        updaterEmail: string | null;
        reviewDueAt: Date | null;
        lastReviewedAt: Date | null;
      }
    >
  >(Prisma.sql`
    SELECT d."appearance", d."id", d."title", d."slug", d."path", d."kind", d."headCommitSha",
      d."reviewDueAt", d."lastReviewedAt",
      d."createdAt", d."createdById", d."createdByName",
      cu."name" AS "creatorName", cu."email" AS "creatorEmail",
      d."updatedAt", d."updatedById", d."updatedByName",
      uu."name" AS "updaterName", uu."email" AS "updaterEmail",
      k."status"::text AS "keywordStatus", k."targetSha" AS "keywordTargetSha",
      k."keywordIndexedSha", k."failureSummary" AS "keywordFailureSummary",
      g."status"::text AS "generationStatus", g."targetSha" AS "generationTargetSha",
      g."configFingerprint" AS "generationFingerprint",
      g."semanticIndexedSha", g."graphIndexedSha",
      g."failureSummary" AS "generationFailureSummary"
    FROM "Document" d
    LEFT JOIN "User" cu ON cu."id" = d."createdById"
    LEFT JOIN "User" uu ON uu."id" = d."updatedById"
    LEFT JOIN "DocumentIndexState" k ON k."documentId" = d."id" AND k."projectId" = d."projectId"
    LEFT JOIN "KnowledgeGenerationDocument" g
      ON g."documentId" = d."id" AND g."projectId" = d."projectId"
     AND g."generationId" = ${generationId}::uuid
    WHERE d."projectId" = ${input.projectId}::uuid
    ORDER BY d."path" ASC
  `);
  const documents = rows.map((row) => ({
    appearance: normalizeAppearance(row.appearance),
    id: row.id,
    title: row.title,
    slug: row.slug,
    path: row.path,
    documentKind: row.kind,
    headCommitSha: row.headCommitSha,
    reviewDueAt: row.reviewDueAt,
    lastReviewedAt: row.lastReviewedAt,
    createdAt: row.createdAt,
    createdBy: presentAuthor(
      row.createdById,
      row.createdByName,
      row.creatorEmail === null
        ? null
        : { name: row.creatorName, email: row.creatorEmail },
    ),
    // The explorer's "edited" slot shows the document metadata's update.
    lastEditedAt: row.updatedAt,
    lastEditedBy: presentAuthor(
      row.updatedById,
      row.updatedByName,
      row.updaterEmail === null
        ? null
        : { name: row.updaterName, email: row.updaterEmail },
    ),
    index: documentIndexLights(row, generation, { coveredByBuild }),
  }));
  if (!repo)
    return {
      folders: [],
      folderNames: {},
      folderStamps: {},
      folderAppearances: {},
      folderReviewDefaults: {},
      documents,
    };
  const snapshotSha = await repo.resolveHead();
  const folderPaths = await listScopeDirsAt(repo, scope, snapshotSha);
  return {
    folders: folderPaths,
    ...(await presentFolderTree(db, repo, scope, snapshotSha, folderPaths)),
    documents,
  };
}

export async function stageFolderInRepo(
  repo: ProjectRepoWriter,
  input: { segments: string[]; name: string; appearance?: Appearance },
  actor: Actor,
  scope: FolderScope,
): Promise<{ segments: string[]; path: string }> {
  const full = input.segments;
  const parent = full.slice(0, -1);
  assertScopePath(scope, full);
  if (!full.length)
    throw new CoreError("BAD_REQUEST", "A folder name is required");
  const name = requireFolderName(input.name);
  if (parent.length > 0)
    await assertExistingFolder(repo, toRel(scope, parent), "parentPath");
  await assertNoSibling(repo, toRel(scope, parent), full.at(-1)!);
  const rel = toRel(scope, full);
  await repo.ensureFolder(rel);
  await repo.writeFileAtomic(
    folderMetadataPath(rel),
    composeFolderMetadata({
      ...newFolderMetadata(name, folderAuthor(actor), new Date()),
      ...(input.appearance ? { appearance: input.appearance } : {}),
    }),
  );
  return { segments: full, path: rel };
}

export async function createFolderInRepo(
  repo: ProjectRepoWriter,
  input: { parentPath: string[]; name: string },
  actor: Actor,
  scope: FolderScope,
  audit: FolderAudit = {},
): Promise<FolderWriteResult> {
  assertScopePath(scope, input.parentPath);
  const name = requireFolderName(input.name);
  const staged = await stageFolderInRepo(
    repo,
    { segments: [...input.parentPath, slugify(name)], name },
    actor,
    scope,
  );
  const headCommitSha = await repo.commitAll(
    `create: ${staged.path}/`,
    actorAuthor(actor),
    audit,
  );
  return { ...staged, headCommitSha };
}

export async function createFolder(
  db: PrismaClient,
  input: { projectId: string; parentPath: string[]; name: string },
  actor: Actor,
  scope: FolderScope = "documents",
) {
  await assertProjectRole(db, input.projectId, actor, "Editor");
  const result = await withProjectRepo(input.projectId, (repo) =>
    createFolderInRepo(repo, input, actor, scope),
  );
  void notifyProjectContentChanged(db, input.projectId);
  return { path: result.segments };
}

export async function moveFolderToInRepo(
  db: PrismaClient,
  repo: ProjectRepoWriter,
  projectId: string,
  from: string[],
  to: string[],
  actor: Actor,
  scope: FolderScope,
  audit: FolderAudit = {},
  displayName?: string,
): Promise<FolderWriteResult> {
  assertScopePath(scope, from);
  assertScopePath(scope, to);
  const fromRel = toRel(scope, from);
  const toRelPath = toRel(scope, to);
  if (toRelPath === fromRel) {
    await assertExistingFolder(repo, fromRel, "path");
    // Nothing to commit; the caller's guard already proved this revision.
    return {
      segments: to,
      path: toRelPath,
      headCommitSha: await repo.resolveHead(),
    };
  }
  if (`${toRelPath}/`.startsWith(`${fromRel}/`)) {
    throw new CoreError("BAD_REQUEST", "cannot move a folder into itself");
  }
  await assertExistingFolder(repo, fromRel, "path");
  await assertExistingFolder(
    repo,
    toRel(scope, to.slice(0, -1)),
    "newParentPath",
  );
  await assertNoSibling(repo, toRel(scope, to.slice(0, -1)), to.at(-1)!);
  const scopeDirs =
    scope === "tables"
      ? (await listScopeDirs(repo, scope)).map((dir) => `${TABLES_ROOT}/${dir}`)
      : await listScopeDirs(repo, scope);
  const deepest = scopeDirs
    .filter((dir) => dir === fromRel || dir.startsWith(`${fromRel}/`))
    .reduce(
      (max, dir) => Math.max(max, dir.split("/").length),
      fromRel.split("/").length,
    );
  if (
    deepest - fromRel.split("/").length + toRelPath.split("/").length >
    MAX_FOLDER_DEPTH + scopeRoot(scope).length
  ) {
    throw new CoreError("BAD_REQUEST", "folder depth exceeds 10");
  }
  const moved = await touchedFolderMetadata(repo, fromRel, actor, displayName);
  await repo.mv(fromRel, toRelPath);
  if (moved) {
    await repo.writeFileAtomic(
      folderMetadataPath(toRelPath),
      composeFolderMetadata(moved),
    );
  }
  const sha = await repo.commitAll(
    `move: ${toRelPath}/ (was ${fromRel}/)`,
    actorAuthor(actor),
    audit,
  );
  const updateProjection = async (): Promise<
    Array<{ sourceId: string; path: string }>
  > => {
    const committedAt = await repo.commitDate(sha);
    return db.$transaction(async (tx) => {
      if (scope === "documents") {
        const affected = await tx.document.findMany({
          where: { projectId, path: { startsWith: `${fromRel}/` } },
          select: { id: true, path: true },
          orderBy: { id: "asc" },
        });
        for (const document of affected) {
          await tx.document.update({
            where: { id: document.id },
            data: {
              path: `${toRelPath}/${document.path.slice(fromRel.length + 1)}`,
              headCommitSha: sha,
              lastEditedById: actor.userId,
              lastEditedByProjectKeyId: null,
              lastEditedByName: actor.name ?? actor.email ?? null,
              lastEditedAt: committedAt,
            },
          });
        }
        return affected.map((document) => ({
          sourceId: document.id,
          path: `${toRelPath}/${document.path.slice(fromRel.length + 1)}`,
        }));
      } else {
        const affected = await tx.dataTable.findMany({
          where: { projectId, path: { startsWith: `${fromRel}/` } },
          select: { id: true, path: true },
          orderBy: { id: "asc" },
        });
        for (const table of affected) {
          await tx.dataTable.update({
            where: { id: table.id },
            data: {
              path: `${toRelPath}/${table.path.slice(fromRel.length + 1)}`,
              headCommitSha: sha,
              lastEditedById: actor.userId,
              lastEditedByProjectKeyId: null,
              lastEditedByName: actor.name ?? actor.email ?? null,
              lastEditedAt: committedAt,
            },
          });
        }
        return affected.map((table) => ({
          sourceId: table.id,
          path: `${toRelPath}/${table.path.slice(fromRel.length + 1)}`,
        }));
      }
    });
  };
  let affected: Array<{ sourceId: string; path: string }> = [];
  try {
    affected = await updateProjection();
  } catch (error) {
    const reference = captureError({
      event: "content.projection.failed",
      message: "folder projection failed after git commit",
      error,
      projectId,
      details: {
        kind: "folder",
        from: fromRel,
        to: toRelPath,
        headCommitSha: sha,
      },
    });
    console.error(
      `Folder projection failed after git commit (ref ${reference ?? "none"})`,
      { projectId },
    );
    await enqueueProjectReconcile(projectId);
  }
  for (const source of affected) {
    if (scope === "documents") {
      await enqueueDocumentChanged({
        projectId,
        documentId: source.sourceId,
        sourceCommitSha: sha,
        pathAtSha: source.path,
      });
    } else {
      await enqueueTableChanged({
        projectId,
        tableId: source.sourceId,
        sourceCommitSha: sha,
        pathAtSha: source.path,
      });
    }
  }
  return { segments: to, path: toRelPath, headCommitSha: sha };
}

/** Stores the display name and, when its slug changes, moves the directory in the same commit. */
export async function renameFolderInRepo(
  db: PrismaClient,
  repo: ProjectRepoWriter,
  projectId: string,
  input: { path: string[]; name: string },
  actor: Actor,
  scope: FolderScope,
  audit: FolderAudit = {},
): Promise<FolderWriteResult> {
  assertScopePath(scope, input.path);
  const name = requireFolderName(input.name);
  const to = [...input.path.slice(0, -1), slugify(name)];
  const fromRel = toRel(scope, input.path);
  await assertExistingFolder(repo, fromRel, "path");
  if (to.join("/") !== input.path.join("/")) {
    // The move validates first and writes the name itself: a rejected rename must leave the worktree clean.
    return moveFolderToInRepo(
      db,
      repo,
      projectId,
      input.path,
      to,
      actor,
      scope,
      audit,
      name,
    );
  }
  const metadataRel = folderMetadataPath(fromRel);
  if (
    (await repo.fileExistsInWorktree(metadataRel)) &&
    parseFolderMetadata(await repo.readFileFromWorktree(metadataRel))?.name ===
      name
  ) {
    return {
      segments: to,
      path: fromRel,
      headCommitSha: await repo.resolveHead(),
    };
  }
  await repo.writeFileAtomic(
    metadataRel,
    composeFolderMetadata(
      (await touchedFolderMetadata(repo, fromRel, actor, name))!,
    ),
  );
  const headCommitSha = await repo.commitAll(
    `update: ${fromRel}/`,
    actorAuthor(actor),
    audit,
  );
  return { segments: to, path: fromRel, headCommitSha };
}

export async function renameFolder(
  db: PrismaClient,
  input: { projectId: string; path: string[]; name: string },
  actor: Actor,
  scope: FolderScope = "documents",
) {
  await assertProjectRole(db, input.projectId, actor, "Editor");
  const result = await withProjectRepo(input.projectId, (repo) =>
    renameFolderInRepo(db, repo, input.projectId, input, actor, scope),
  );
  void notifyProjectContentChanged(db, input.projectId);
  return { path: result.segments };
}

export async function moveFolder(
  db: PrismaClient,
  input: { projectId: string; path: string[]; newParentPath: string[] },
  actor: Actor,
  scope: FolderScope = "documents",
) {
  await assertProjectRole(db, input.projectId, actor, "Editor");
  const to = [...input.newParentPath, input.path.at(-1)!];
  await withProjectRepo(input.projectId, (repo) =>
    moveFolderToInRepo(db, repo, input.projectId, input.path, to, actor, scope),
  );
  void notifyProjectContentChanged(db, input.projectId);
  return { path: to };
}

export async function deleteFolderInRepo(
  repo: ProjectRepoWriter,
  input: { path: string[] },
  actor: Actor,
  scope: FolderScope,
  audit: FolderAudit = {},
): Promise<FolderWriteResult> {
  assertScopePath(scope, input.path);
  const rel = toRel(scope, input.path);
  await assertExistingFolder(repo, rel, "path");
  const tracked = (await repo.listTrackedFiles()).filter(
    (file) =>
      file.startsWith(`${rel}/`) &&
      !isFolderMarkerFile(file.slice(rel.length + 1)),
  );
  if (tracked.length > 0) {
    throw new CoreError("PRECONDITION_FAILED", "folder is not empty");
  }
  await repo.rmDir(rel);
  const headCommitSha = await repo.commitAll(
    `delete: ${rel}/`,
    actorAuthor(actor),
    audit,
  );
  return { segments: input.path, path: rel, headCommitSha };
}

export async function deleteFolder(
  db: PrismaClient,
  input: { projectId: string; path: string[] },
  actor: Actor,
  scope: FolderScope = "documents",
) {
  await assertProjectRole(db, input.projectId, actor, "Editor");
  await withProjectRepo(input.projectId, (repo) =>
    deleteFolderInRepo(repo, input, actor, scope),
  );
  void notifyProjectContentChanged(db, input.projectId);
}

export type ContentFolderEntry = {
  resourceType: "document" | "table";
  path: string[];
};

export type ContentFolderListing = {
  baseProjectCommitSha: string;
  folders: ContentFolderEntry[];
};

export function scopeForResourceType(
  resourceType: "document" | "table",
): FolderScope {
  return resourceType === "table" ? "tables" : "documents";
}

/**
 * Folders at one project revision (concept §7.1). `baseProjectCommitSha` is the
 * guard every folder action must carry, because a path identifies a subtree
 * rather than a stable folder UUID (concept §7.2).
 */
export async function listContentFolders(
  db: PrismaClient,
  input: { projectId: string; resourceType?: "document" | "table" },
  actor: ProjectActor,
): Promise<ContentFolderListing> {
  await assertProjectRole(db, input.projectId, actor, "Viewer");
  const wanted: Array<"document" | "table"> = input.resourceType
    ? [input.resourceType]
    : ["document", "table"];
  const read = async (
    repo: ProjectRepoReader,
  ): Promise<ContentFolderListing> => {
    const baseProjectCommitSha = await repo.resolveHead();
    const folders: ContentFolderEntry[] = [];
    for (const resourceType of wanted) {
      const dirs = await listScopeDirsAt(
        repo,
        scopeForResourceType(resourceType),
        baseProjectCommitSha,
      );
      for (const dir of dirs)
        folders.push({ resourceType, path: dir.split("/") });
    }
    return { baseProjectCommitSha, folders };
  };
  const repo = await openProjectRepo(input.projectId);
  if (repo) return read(repo);
  // A project nobody has written to has no repository and so no revision to
  // pin; withProjectRepo creates one with its empty root commit.
  return withProjectRepo(input.projectId, read);
}

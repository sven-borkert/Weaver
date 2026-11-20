import { createHash, randomUUID } from "node:crypto";
import { type Prisma, type PrismaClient } from "@weaver/db/client";
import { openProjectRepo } from "@weaver/git-store";
import { normalizeAppearance, type Appearance } from "../appearance/metadata";
import { closestFolderReviewDefault } from "../documents/folderReview";
import type { StoredFolderReviewDefaults } from "../documents/folderReview";
import {
  composeFolderMetadata,
  newFolderMetadata,
  normalizeFolderName,
  parseFolderMetadata,
  type FolderMetadata,
} from "../documents/folderMetadata";
import {
  authorForUser,
  composeDocumentFile,
  parseDocumentFile,
  type DocumentMeta,
} from "../documents/frontmatter";
import {
  allocateImageFileName,
  assetsDirForDocPath,
  assetsPrefixForSlug,
  imageBasename,
  imageExtension,
  rewriteOwnAssetsPrefix,
  sniffImageType,
} from "../documents/images";
import { DOCUMENT_KINDS, type DocumentKind } from "../documents/kinds";
import {
  MAX_FOLDER_DEPTH,
  assertSafeSegments,
  docPath,
  folderNotFound,
} from "../documents/paths";
import type { DocumentReview } from "../documents/review";
import { slugify } from "../documents/slug";
import { parseDocumentBody } from "../editor/markdown";
import { CoreError } from "../errors";
import { hasCapability } from "../security/context";
import { assertOutsideTablesRoot } from "../tables/paths";
import {
  applyPagePropertiesInput,
  withoutReviewExempt,
  type WikiPagePropertiesInput,
} from "../wiki/properties";
import { documentAuthorForContent } from "./contentAuthor";
import {
  assertDocumentFileSize,
  assertDocumentTitle,
  assertImageSourcesContained,
  assertUpdatedNotBeforeCreated,
  documentMetadataColumns,
  prepareContent,
  presentAuthor,
  presentDocumentMetadata,
  presentDocumentReview,
  projectionContent,
  type DocumentContentInput,
  type DocumentResult,
  type EnrichedActor,
} from "./documents";
import {
  listScopeDirsAt,
  readFolderMetadataAt,
  readRootFolderMetadataAt,
} from "./folders";
import {
  assertProjectRole,
  resolveProjectAccess,
  type ProjectActor,
} from "./projectAccess";
import {
  committedReviewerCheck,
  defaultReviewFor,
  resolveImportedReview,
} from "./reviewerGroups";
import { presentWikiProperties } from "./wikiProperties";

type Db = PrismaClient | Prisma.TransactionClient;
type Tx = Prisma.TransactionClient;

const MAX_UNTRACKED_DOCUMENTS = 10_000;
const MAX_UNTRACKED_IMAGE_BYTES = 20 * 1024 * 1024;

/** Stands in for a commit SHA: the save precondition of an untracked document. */
export function untrackedRevision(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 40);
}

const rowFields = {
  id: true,
  projectId: true,
  path: true,
  slug: true,
  kind: true,
  title: true,
  content: true,
  revision: true,
} satisfies Prisma.UntrackedDocumentSelect;

type UntrackedRow = Prisma.UntrackedDocumentGetPayload<{
  select: typeof rowFields;
}>;

export async function findUntrackedDocument(
  db: Db,
  projectId: string,
  documentId: string,
): Promise<UntrackedRow | null> {
  return db.untrackedDocument.findFirst({
    where: { id: documentId, projectId },
    select: rowFields,
  });
}

export async function isUntrackedDocument(
  db: Db,
  projectId: string,
  documentId: string,
): Promise<boolean> {
  return (
    (await db.untrackedDocument.count({
      where: { id: documentId, projectId },
    })) > 0
  );
}

function folderRel(segments: string[]): string {
  return segments.join("/");
}

/** Every ancestor-or-self path of `segments`, shortest first. */
function prefixes(segments: string[]): string[] {
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}

/** True when the folder itself or one of its ancestors is kept out of Git. */
export async function isUntrackedFolderPath(
  db: Db,
  projectId: string,
  segments: string[],
): Promise<boolean> {
  if (segments.length === 0) return false;
  return (
    (await db.untrackedFolder.count({
      where: { projectId, path: { in: prefixes(segments) } },
    })) > 0
  );
}

export async function untrackedFolderExists(
  db: Db,
  projectId: string,
  segments: string[],
): Promise<boolean> {
  return (
    (await db.untrackedFolder.count({
      where: { projectId, path: folderRel(segments) },
    })) > 0
  );
}

/** Untracked content at or below a folder path. */
export async function untrackedContentUnder(
  db: Db,
  projectId: string,
  rel: string,
): Promise<number> {
  const below = `${rel}/`;
  const [documents, folders] = await Promise.all([
    db.untrackedDocument.count({
      where: { projectId, path: { startsWith: below } },
    }),
    db.untrackedFolder.count({
      where: {
        projectId,
        OR: [{ path: rel }, { path: { startsWith: below } }],
      },
    }),
  ]);
  return documents + folders;
}

export async function untrackedSlugTaken(
  db: Db,
  projectId: string,
  slug: string,
  excludeDocumentId?: string,
): Promise<boolean> {
  return (
    (await db.untrackedDocument.count({
      where: {
        projectId,
        slug,
        ...(excludeDocumentId ? { id: { not: excludeDocumentId } } : {}),
      },
    })) > 0
  );
}

/** Rewrites untracked paths after a tracked folder moved in Git. */
export async function moveUntrackedPrefix(
  db: Db,
  projectId: string,
  fromRel: string,
  toRel: string,
): Promise<void> {
  const from = `${fromRel}/`;
  const shift = (path: string) => `${toRel}/${path.slice(from.length)}`;
  const [documents, folders, files] = await Promise.all([
    db.untrackedDocument.findMany({
      where: { projectId, path: { startsWith: from } },
      select: { id: true, path: true },
    }),
    db.untrackedFolder.findMany({
      where: { projectId, path: { startsWith: from } },
      select: { path: true },
    }),
    db.untrackedFile.findMany({
      where: { projectId, path: { startsWith: from } },
      select: { path: true },
    }),
  ]);
  for (const document of documents)
    await db.untrackedDocument.update({
      where: { id: document.id },
      data: { path: shift(document.path) },
    });
  for (const folder of folders)
    await db.untrackedFolder.update({
      where: { projectId_path: { projectId, path: folder.path } },
      data: { path: shift(folder.path) },
    });
  for (const file of files)
    await db.untrackedFile.update({
      where: { projectId_path: { projectId, path: file.path } },
      data: { path: shift(file.path) },
    });
}

async function withUntrackedWrite<T>(
  db: PrismaClient,
  projectId: string,
  actor: ProjectActor,
  write: (tx: Tx) => Promise<T>,
  /** Marking reviewed needs membership only; its reviewer check runs inside. */
  role: "Viewer" | "Editor" | "Maintainer" = "Editor",
): Promise<T> {
  await assertProjectRole(db, projectId, actor, role);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`weaver:untracked:${projectId}`}, 0))::text`;
    await assertProjectRole(tx, projectId, actor, role);
    return write(tx);
  });
}

/** Committed (HEAD) document folders; empty when the project has no repository yet. */
async function trackedFolders(projectId: string): Promise<Set<string>> {
  const repo = await openProjectRepo(projectId);
  if (!repo) return new Set();
  return new Set(
    await listScopeDirsAt(repo, "documents", await repo.resolveHead()),
  );
}

async function assertFolderExists(
  tx: Db,
  projectId: string,
  segments: string[],
  field: string,
): Promise<void> {
  try {
    assertSafeSegments(segments);
    assertOutsideTablesRoot(segments);
  } catch {
    throw new CoreError("BAD_REQUEST", "invalid folder path");
  }
  if (segments.length === 0) return;
  if (await untrackedFolderExists(tx, projectId, segments)) return;
  if ((await trackedFolders(projectId)).has(folderRel(segments))) return;
  throw folderNotFound(field);
}

async function allocateSlug(
  tx: Db,
  projectId: string,
  title: string,
  excludeDocumentId?: string,
): Promise<string> {
  const base = slugify(title);
  for (let i = 1; i < 1000; i++) {
    const suffix = i === 1 ? "" : `-${i}`;
    const slug = `${base.slice(0, 80 - suffix.length).replace(/-+$/g, "")}${suffix}`;
    const tracked = await tx.document.count({ where: { projectId, slug } });
    if (tracked) continue;
    if (await untrackedSlugTaken(tx, projectId, slug, excludeDocumentId))
      continue;
    return slug;
  }
  throw new CoreError("INTERNAL_SERVER_ERROR", "no available slug");
}

/** Folder defaults from the untracked chain first, then the committed folders and root. */
async function defaultReviewAt(
  db: Db,
  projectId: string,
  folderPath: string[],
  now: string,
): Promise<DocumentReview> {
  const defaults: Record<string, StoredFolderReviewDefaults> = {};
  const repo = await openProjectRepo(projectId);
  if (repo) {
    const head = await repo.resolveHead();
    const tracked = await readFolderMetadataAt(
      repo,
      "documents",
      head,
      prefixes(folderPath),
    );
    for (const [path, meta] of Object.entries(tracked))
      if (meta.reviewDefaults) defaults[path] = meta.reviewDefaults;
    const root = await readRootFolderMetadataAt(repo, head);
    if (root?.reviewDefaults) defaults[""] = root.reviewDefaults;
  }
  const untracked = await db.untrackedFolder.findMany({
    where: { projectId, path: { in: prefixes(folderPath) } },
  });
  for (const folder of untracked) {
    const meta = parseFolderMetadata(folder.metadata);
    if (meta?.reviewDefaults) defaults[folder.path] = meta.reviewDefaults;
  }
  const inherited = closestFolderReviewDefault(folderPath, defaults);
  return defaultReviewFor(db, projectId, now, inherited?.reviewers);
}

function parseRow(row: UntrackedRow) {
  try {
    return parseDocumentFile(row.content, row.kind);
  } catch {
    throw new CoreError("PRECONDITION_FAILED", "document content is malformed");
  }
}

async function projectionColumns(
  db: Db,
  meta: DocumentMeta,
  content: string,
  excerpt: string,
) {
  const [columns] = await documentMetadataColumns(db, [meta]);
  const c = columns!;
  return {
    title: meta.title,
    content,
    revision: untrackedRevision(content),
    appearance: c.appearance,
    excerpt,
    createdAt: c.createdAt,
    createdById: c.createdById,
    createdByName: c.createdByName,
    updatedAt: c.updatedAt,
    updatedById: c.updatedById,
    updatedByName: c.updatedByName,
    reviewDueAt: c.reviewDueAt,
    lastReviewedAt: c.lastReviewedAt,
    wikiType: c.wikiType,
    wikiSummary: c.wikiSummary,
  };
}

function excerptOf(kind: DocumentKind, body: string): string {
  return projectionContent(kind, body).excerpt;
}

function result(row: {
  id: string;
  path: string;
  slug: string;
  title: string;
  revision: string;
}): DocumentResult {
  return {
    id: row.id,
    path: row.path,
    slug: row.slug,
    title: row.title,
    headCommitSha: row.revision,
  };
}

/** Same shape as `getDocumentWithSnapshot`, with the content hash as revision. */
export async function getUntrackedDocument(
  db: PrismaClient,
  input: { projectId: string; documentId: string },
  actor: ProjectActor,
) {
  await assertProjectRole(db, input.projectId, actor, "Viewer");
  const row = await findUntrackedDocument(
    db,
    input.projectId,
    input.documentId,
  );
  if (!row) throw new CoreError("NOT_FOUND");
  const { meta, body } = parseRow(row);
  const kind = row.kind;
  const content: DocumentContentInput =
    kind === "markdown"
      ? { kind, contentJson: parseDocumentBody(body) }
      : { kind, text: body };
  const metadata = await presentDocumentMetadata(db, meta);
  const lastEditedBy = meta.updatedBy?.id
    ? await db.user.findUnique({
        where: { id: meta.updatedBy.id },
        select: { id: true, name: true, email: true },
      })
    : null;
  return {
    id: row.id,
    path: row.path,
    slug: row.slug,
    title: meta.title,
    kind,
    content,
    untracked: true as const,
    snapshotCommitSha: row.revision,
    baseCommitSha: row.revision,
    lastEditedAt: new Date(meta.updated),
    lastEditedById: lastEditedBy?.id ?? null,
    lastEditedBy,
    machineEditor: null,
    ...metadata,
    appearance: normalizeAppearance(meta.appearance),
    properties: await presentWikiProperties(
      db,
      input.projectId,
      meta.properties,
    ),
    review: await presentDocumentReview(db, input.projectId, meta.review),
  };
}

export async function createUntrackedDocument(
  db: PrismaClient,
  input: {
    projectId: string;
    folderPath: string[];
    title: string;
    content: DocumentContentInput;
    appearance?: Appearance;
    properties?: WikiPagePropertiesInput;
    review?: DocumentReview;
    reviewSource?: { kind: "import"; imported: DocumentReview | null };
    /** Images stored with the document, named relative to its assets directory. */
    assets?: Array<{ name: string; bytes: Uint8Array }>;
    /** Asset prefix the content uses; rewritten onto the allocated slug. */
    assetsFromSlug?: string;
  },
  actor: EnrichedActor,
): Promise<DocumentResult> {
  assertDocumentTitle(input.title);
  if (
    !DOCUMENT_KINDS[input.content.kind].supportsImages &&
    (input.assets?.length ?? 0) > 0
  )
    throw new CoreError("BAD_REQUEST", "This file kind does not hold images");
  return withUntrackedWrite(db, input.projectId, actor, async (tx) => {
    await assertFolderExists(
      tx,
      input.projectId,
      input.folderPath,
      "folderPath",
    );
    if (
      (await tx.untrackedDocument.count({
        where: { projectId: input.projectId },
      })) >= MAX_UNTRACKED_DOCUMENTS
    )
      throw new CoreError(
        "PRECONDITION_FAILED",
        "The project holds the maximum number of documents outside Git",
      );
    const slug = await allocateSlug(tx, input.projectId, input.title);
    const kind = input.content.kind;
    const path = docPath(input.folderPath, slug, kind);
    const content0: DocumentContentInput =
      input.content.kind === "markdown" &&
      input.assetsFromSlug !== undefined &&
      input.assetsFromSlug !== slug
        ? {
            kind: "markdown",
            contentJson: rewriteOwnAssetsPrefix(
              input.content.contentJson,
              input.assetsFromSlug,
              slug,
            ),
          }
        : input.content;
    const prepared = await prepareContent(tx, input.projectId, content0);
    if (prepared.json) assertImageSourcesContained(prepared.json, path);
    const now = new Date().toISOString();
    const self = documentAuthorForContent(actor);
    const properties = input.properties
      ? applyPagePropertiesInput(undefined, input.properties)
      : undefined;
    const meta: DocumentMeta = {
      id: randomUUID(),
      title: input.title,
      created: now,
      createdBy: self,
      updated: now,
      updatedBy: self,
      ...(input.appearance ? { appearance: input.appearance } : {}),
      ...(properties ? { properties } : {}),
      review: null,
    };
    const defaults =
      input.review ??
      (properties?.reviewExempt
        ? null
        : await defaultReviewAt(tx, input.projectId, input.folderPath, now));
    meta.review =
      input.reviewSource && defaults
        ? await resolveImportedReview(
            tx,
            input.projectId,
            input.reviewSource.imported,
            now,
            defaults,
          )
        : defaults;
    const content = composeDocumentFile(meta, prepared.body, kind);
    assertDocumentFileSize(content, path);
    const row = await tx.untrackedDocument.create({
      data: {
        id: meta.id,
        projectId: input.projectId,
        path,
        slug,
        kind,
        ...(await projectionColumns(tx, meta, content, prepared.excerpt)),
      },
    });
    const assetsDir = assetsDirForDocPath(path);
    for (const asset of input.assets ?? [])
      await tx.untrackedFile.create({
        data: {
          projectId: input.projectId,
          path: `${assetsDir}/${asset.name}`,
          bytes: Buffer.from(asset.bytes),
          sha: untrackedRevision(asset.bytes),
        },
      });
    return result(row);
  });
}

async function lockRow(
  tx: Tx,
  projectId: string,
  documentId: string,
): Promise<UntrackedRow> {
  const row = await findUntrackedDocument(tx, projectId, documentId);
  if (!row) throw new CoreError("NOT_FOUND");
  return row;
}

function assertRevision(row: UntrackedRow, expected: string, message: string) {
  if (row.revision !== expected)
    throw new CoreError("CONFLICT", message, { headCommitSha: row.revision });
}

/** Moves a document's images when its path changes. */
async function moveAssets(
  tx: Tx,
  projectId: string,
  fromPath: string,
  toPath: string,
) {
  if (fromPath === toPath) return;
  const from = `${assetsDirForDocPath(fromPath)}/`;
  const to = `${assetsDirForDocPath(toPath)}/`;
  const files = await tx.untrackedFile.findMany({
    where: { projectId, path: { startsWith: from } },
    select: { path: true },
  });
  for (const file of files)
    await tx.untrackedFile.update({
      where: { projectId_path: { projectId, path: file.path } },
      data: { path: `${to}${file.path.slice(from.length)}` },
    });
}

export async function saveUntrackedDocument(
  db: PrismaClient,
  input: {
    projectId: string;
    documentId: string;
    baseCommitSha: string;
    title?: string;
    content: DocumentContentInput;
    properties?: WikiPagePropertiesInput;
  },
  actor: EnrichedActor,
): Promise<DocumentResult> {
  if (input.title !== undefined) assertDocumentTitle(input.title);
  const prepared = await prepareContent(db, input.projectId, input.content);
  return withUntrackedWrite(db, input.projectId, actor, async (tx) => {
    const row = await lockRow(tx, input.projectId, input.documentId);
    if (row.kind !== input.content.kind)
      throw new CoreError(
        "BAD_REQUEST",
        `this is a ${DOCUMENT_KINDS[row.kind].label}; send ${row.kind} content`,
        { field: "content" },
      );
    assertRevision(
      row,
      input.baseCommitSha,
      "Document changed since you loaded it",
    );
    const { meta: old } = parseRow(row);
    const title = input.title ?? old.title;
    let slug = row.slug;
    let path = row.path;
    if (title !== old.title && slugify(title) !== slugify(old.title)) {
      slug = await allocateSlug(tx, input.projectId, title, row.id);
      path = docPath(row.path.split("/").slice(0, -1), slug, row.kind);
    }
    let body = prepared.body;
    let json = prepared.json;
    if (slug !== row.slug && input.content.kind === "markdown") {
      json = rewriteOwnAssetsPrefix(input.content.contentJson, row.slug, slug);
      body = (
        await prepareContent(db, input.projectId, {
          kind: "markdown",
          contentJson: json,
        })
      ).body;
    }
    if (json) assertImageSourcesContained(json, path);
    const properties =
      input.properties === undefined
        ? old.properties
        : applyPagePropertiesInput(old.properties, input.properties);
    const now = new Date().toISOString();
    const meta: DocumentMeta = {
      ...old,
      title,
      updated: now,
      updatedBy: documentAuthorForContent(actor),
      review:
        old.review ??
        (properties?.reviewExempt
          ? null
          : await defaultReviewAt(
              tx,
              input.projectId,
              path.split("/").slice(0, -1),
              now,
            )),
      ...(properties ? { properties } : { properties: undefined }),
    };
    assertUpdatedNotBeforeCreated(meta);
    const content = composeDocumentFile(meta, body, row.kind);
    assertDocumentFileSize(content, path);
    await moveAssets(tx, input.projectId, row.path, path);
    const updated = await tx.untrackedDocument.update({
      where: { id: row.id },
      data: {
        path,
        slug,
        ...(await projectionColumns(tx, meta, content, prepared.excerpt)),
      },
    });
    return result(updated);
  });
}

/** Header-only rewrite guarded by the loaded revision. */
async function rewriteHeader(
  db: PrismaClient,
  input: {
    projectId: string;
    documentId: string;
    expectedHeadCommitSha: string;
  },
  actor: ProjectActor,
  change: (
    meta: DocumentMeta,
    row: UntrackedRow,
    tx: Tx,
  ) => Promise<DocumentMeta>,
  role: "Viewer" | "Editor" | "Maintainer" = "Editor",
): Promise<{ headCommitSha: string }> {
  return withUntrackedWrite(
    db,
    input.projectId,
    actor,
    async (tx) => {
      const row = await lockRow(tx, input.projectId, input.documentId);
      const { meta, body } = parseRow(row);
      assertRevision(
        row,
        input.expectedHeadCommitSha,
        "The document changed. Reload and try again.",
      );
      const next = await change(meta, row, tx);
      const content = composeDocumentFile(next, body, row.kind);
      assertDocumentFileSize(content, row.path);
      if (content === row.content) return { headCommitSha: row.revision };
      const updated = await tx.untrackedDocument.update({
        where: { id: row.id },
        data: await projectionColumns(
          tx,
          next,
          content,
          excerptOf(row.kind, body),
        ),
      });
      return { headCommitSha: updated.revision };
    },
    role,
  );
}

export async function markUntrackedDocumentReviewed(
  db: PrismaClient,
  input: {
    projectId: string;
    documentId: string;
    expectedHeadCommitSha: string;
  },
  actor: EnrichedActor,
): Promise<{ headCommitSha: string }> {
  await resolveProjectAccess(db, input.projectId, actor);
  if (!hasCapability(actor, "content:write")) throw new CoreError("FORBIDDEN");
  const self = authorForUser({
    id: actor.userId,
    name: actor.name,
    email: actor.email,
  });
  const isReviewer = await committedReviewerCheck(
    db,
    input.projectId,
    actor.userId,
  );
  return rewriteHeader(
    db,
    input,
    actor,
    async (meta, row, tx) => {
      if (!isReviewer(meta.review)) throw new CoreError("FORBIDDEN");
      const now = new Date().toISOString();
      const current =
        meta.review ?? (await defaultReviewFor(tx, row.projectId, now));
      const properties = withoutReviewExempt(meta.properties);
      return {
        ...meta,
        review: { ...current, lastReviewed: now, reviewedBy: self },
        ...(properties ? { properties } : { properties: undefined }),
      };
    },
    "Viewer",
  );
}

export async function setUntrackedDocumentReview(
  db: PrismaClient,
  input: {
    projectId: string;
    documentId: string;
    expectedHeadCommitSha: string;
  },
  actor: EnrichedActor,
  change: (review: DocumentReview) => DocumentReview,
): Promise<{ headCommitSha: string }> {
  await assertProjectRole(db, input.projectId, actor, "Maintainer");
  return rewriteHeader(
    db,
    input,
    actor,
    async (meta, row, tx) => {
      const now = new Date().toISOString();
      const current =
        meta.review ?? (await defaultReviewFor(tx, row.projectId, now));
      const properties = withoutReviewExempt(meta.properties);
      return {
        ...meta,
        review: change(current),
        ...(properties ? { properties } : { properties: undefined }),
      };
    },
    "Maintainer",
  );
}

export async function untrackedReviewPermissions(
  db: Db,
  projectId: string,
  documentId: string,
  actor: ProjectActor,
): Promise<boolean> {
  const row = await findUntrackedDocument(db, projectId, documentId);
  if (!row) throw new CoreError("NOT_FOUND");
  const { meta } = parseRow(row);
  const isReviewer = await committedReviewerCheck(db, projectId, actor.userId);
  return isReviewer(meta.review);
}

export async function setUntrackedDocumentProperties(
  db: PrismaClient,
  input: {
    projectId: string;
    documentId: string;
    expectedHeadCommitSha: string;
    properties: WikiPagePropertiesInput;
  },
  actor: EnrichedActor,
): Promise<{ headCommitSha: string }> {
  return rewriteHeader(db, input, actor, async (meta) => {
    const properties = applyPagePropertiesInput(
      meta.properties,
      input.properties,
    );
    const { properties: _old, ...rest } = meta;
    const unchanged =
      JSON.stringify(properties ?? null) ===
      JSON.stringify(meta.properties ?? null);
    if (unchanged) return meta;
    return {
      ...rest,
      ...(properties ? { properties } : {}),
      updated: new Date().toISOString(),
      updatedBy: documentAuthorForContent(actor),
    };
  });
}

export async function readUntrackedAppearance(
  db: Db,
  projectId: string,
  target: { kind: "document"; id: string } | { kind: "folder"; path: string[] },
): Promise<{ appearance: Appearance | null; revision: string } | null> {
  if (target.kind === "document") {
    const row = await findUntrackedDocument(db, projectId, target.id);
    if (!row) return null;
    return {
      appearance: normalizeAppearance(parseRow(row).meta.appearance),
      revision: row.revision,
    };
  }
  const folder = await db.untrackedFolder.findUnique({
    where: { projectId_path: { projectId, path: folderRel(target.path) } },
  });
  if (!folder) return null;
  return {
    appearance: normalizeAppearance(
      parseFolderMetadata(folder.metadata)?.appearance,
    ),
    revision: untrackedRevision(folder.metadata),
  };
}

export async function writeUntrackedAppearance(
  db: PrismaClient,
  projectId: string,
  target: { kind: "document"; id: string } | { kind: "folder"; path: string[] },
  expectedRevision: string,
  apply: (current: Appearance | null) => Appearance | null,
  actor: EnrichedActor,
  icon?: { path: string; bytes: Uint8Array },
): Promise<{ headCommitSha: string; revision: string }> {
  return withUntrackedWrite(db, projectId, actor, async (tx) => {
    if (icon)
      await tx.untrackedFile.upsert({
        where: { projectId_path: { projectId, path: icon.path } },
        create: {
          projectId,
          path: icon.path,
          bytes: Buffer.from(icon.bytes),
          sha: untrackedRevision(icon.bytes),
        },
        update: {},
      });
    if (target.kind === "document") {
      const row = await lockRow(tx, projectId, target.id);
      assertRevision(
        row,
        expectedRevision,
        "The content changed. Reload and try again.",
      );
      const { meta, body } = parseRow(row);
      const appearance = apply(normalizeAppearance(meta.appearance));
      const { appearance: _old, ...rest } = meta;
      const next = { ...rest, ...(appearance ? { appearance } : {}) };
      const content = composeDocumentFile(next, body, row.kind);
      if (content === row.content)
        return { headCommitSha: row.revision, revision: row.revision };
      const updated = await tx.untrackedDocument.update({
        where: { id: row.id },
        data: await projectionColumns(
          tx,
          next,
          content,
          excerptOf(row.kind, body),
        ),
      });
      return { headCommitSha: updated.revision, revision: updated.revision };
    }
    const path = folderRel(target.path);
    const folder = await tx.untrackedFolder.findUnique({
      where: { projectId_path: { projectId, path } },
    });
    if (!folder) throw new CoreError("NOT_FOUND");
    const revision = untrackedRevision(folder.metadata);
    if (revision !== expectedRevision)
      throw new CoreError(
        "CONFLICT",
        "The content changed. Reload and try again.",
        {
          headCommitSha: revision,
        },
      );
    const meta = parseFolderMetadata(folder.metadata);
    if (!meta)
      throw new CoreError(
        "PRECONDITION_FAILED",
        "folder metadata is malformed",
      );
    const appearance = apply(normalizeAppearance(meta.appearance));
    const metadata = composeFolderMetadata({
      ...meta,
      appearance: appearance ?? undefined,
    });
    await tx.untrackedFolder.update({
      where: { projectId_path: { projectId, path } },
      data: { metadata },
    });
    const next = untrackedRevision(metadata);
    return { headCommitSha: next, revision: next };
  });
}

export async function moveUntrackedDocument(
  db: PrismaClient,
  input: { projectId: string; documentId: string; folderPath: string[] },
  actor: EnrichedActor,
): Promise<DocumentResult> {
  return withUntrackedWrite(db, input.projectId, actor, async (tx) => {
    const row = await lockRow(tx, input.projectId, input.documentId);
    await assertFolderExists(
      tx,
      input.projectId,
      input.folderPath,
      "folderPath",
    );
    const path = docPath(input.folderPath, row.slug, row.kind);
    if (path === row.path) return result(row);
    await moveAssets(tx, input.projectId, row.path, path);
    const updated = await tx.untrackedDocument.update({
      where: { id: row.id },
      data: { path },
    });
    return result(updated);
  });
}

export async function deleteUntrackedDocument(
  db: PrismaClient,
  input: { projectId: string; documentId: string },
  actor: EnrichedActor,
): Promise<void> {
  await withUntrackedWrite(db, input.projectId, actor, async (tx) => {
    const row = await lockRow(tx, input.projectId, input.documentId);
    await tx.untrackedFile.deleteMany({
      where: {
        projectId: input.projectId,
        path: { startsWith: `${assetsDirForDocPath(row.path)}/` },
      },
    });
    await tx.untrackedDocument.delete({ where: { id: row.id } });
  });
}

export type StoredUntrackedImage = {
  src: string;
  path: string;
  contentType: string;
  byteSize: number;
  commitSha: string;
};

export async function storeUntrackedImage(
  db: PrismaClient,
  input: {
    projectId: string;
    documentId: string;
    fileName: string | null;
    bytes: Uint8Array;
  },
  actor: EnrichedActor,
): Promise<StoredUntrackedImage> {
  const contentType = sniffImageType(input.bytes.subarray(0, 16));
  if (!contentType)
    throw new CoreError("BAD_REQUEST", "unsupported image type");
  if (input.bytes.byteLength > MAX_UNTRACKED_IMAGE_BYTES)
    throw new CoreError("BAD_REQUEST", "image too large");
  return withUntrackedWrite(db, input.projectId, actor, async (tx) => {
    const row = await lockRow(tx, input.projectId, input.documentId);
    if (!DOCUMENT_KINDS[row.kind].supportsImages)
      throw new CoreError("BAD_REQUEST", "This file kind does not hold images");
    const assetsDir = assetsDirForDocPath(row.path);
    const taken = new Set(
      (
        await tx.untrackedFile.findMany({
          where: {
            projectId: input.projectId,
            path: { startsWith: `${assetsDir}/` },
          },
          select: { path: true },
        })
      ).map((file) => file.path.slice(assetsDir.length + 1)),
    );
    const fileName = allocateImageFileName(
      imageBasename(input.fileName),
      imageExtension(contentType),
      taken,
    );
    const path = `${assetsDir}/${fileName}`;
    const sha = untrackedRevision(input.bytes);
    await tx.untrackedFile.create({
      data: {
        projectId: input.projectId,
        path,
        bytes: Buffer.from(input.bytes),
        sha,
      },
    });
    return {
      src: `${assetsPrefixForSlug(row.slug)}${fileName}`,
      path,
      contentType,
      byteSize: input.bytes.byteLength,
      commitSha: row.revision,
    };
  });
}

export async function readUntrackedFile(
  db: Db,
  projectId: string,
  path: string,
): Promise<{ bytes: Buffer; sha: string } | null> {
  const file = await db.untrackedFile.findUnique({
    where: { projectId_path: { projectId, path } },
    select: { bytes: true, sha: true },
  });
  return file ? { bytes: Buffer.from(file.bytes), sha: file.sha } : null;
}

/** All files of the given document paths' asset directories. */
export async function readUntrackedAssets(
  db: Db,
  projectId: string,
  documentPath: string,
): Promise<Array<{ path: string; bytes: Buffer }>> {
  const files = await db.untrackedFile.findMany({
    where: {
      projectId,
      path: { startsWith: `${assetsDirForDocPath(documentPath)}/` },
    },
    select: { path: true, bytes: true },
    orderBy: { path: "asc" },
  });
  return files.map((file) => ({
    path: file.path,
    bytes: Buffer.from(file.bytes),
  }));
}

/** The stored file text and its untracked path, for downloads. */
export async function readUntrackedDocumentFile(
  db: Db,
  projectId: string,
  documentId: string,
) {
  const row = await findUntrackedDocument(db, projectId, documentId);
  if (!row) return null;
  return {
    id: row.id,
    path: row.path,
    slug: row.slug,
    title: row.title,
    kind: row.kind,
    content: row.content,
  };
}

/** Untracked documents and folder metadata at or below `rel` (all when empty). */
export async function listUntrackedUnder(
  db: Db,
  projectId: string,
  rel: string,
) {
  const below = rel ? { startsWith: `${rel}/` } : undefined;
  const [documents, folders] = await Promise.all([
    db.untrackedDocument.findMany({
      where: { projectId, ...(below ? { path: below } : {}) },
      select: {
        id: true,
        path: true,
        kind: true,
        content: true,
        slug: true,
        title: true,
      },
      orderBy: { path: "asc" },
    }),
    db.untrackedFolder.findMany({
      where: {
        projectId,
        ...(rel ? { OR: [{ path: rel }, { path: below! }] } : {}),
      },
      orderBy: { path: "asc" },
    }),
  ]);
  return { documents, folders };
}

export type UntrackedTreeDocument = {
  id: string;
  title: string;
  slug: string;
  path: string;
  documentKind: DocumentKind;
  revision: string;
  appearance: Appearance | null;
  wikiType: string | null;
  wikiSummary: string | null;
  reviewDueAt: Date | null;
  lastReviewedAt: Date | null;
  createdAt: Date;
  createdBy: ReturnType<typeof presentAuthor>;
  lastEditedAt: Date;
  lastEditedBy: ReturnType<typeof presentAuthor>;
};

/** Explorer entries for the documents tree. */
export async function listUntrackedTree(db: PrismaClient, projectId: string) {
  const [rows, folders] = await Promise.all([
    db.untrackedDocument.findMany({
      where: { projectId },
      orderBy: { path: "asc" },
      select: {
        id: true,
        title: true,
        slug: true,
        path: true,
        kind: true,
        appearance: true,
        wikiType: true,
        wikiSummary: true,
        reviewDueAt: true,
        lastReviewedAt: true,
        createdAt: true,
        createdById: true,
        createdByName: true,
        updatedAt: true,
        updatedById: true,
        updatedByName: true,
        revision: true,
      },
    }),
    db.untrackedFolder.findMany({
      where: { projectId },
      orderBy: { path: "asc" },
    }),
  ]);
  const ids = [
    ...new Set(
      rows
        .flatMap((row) => [row.createdById, row.updatedById])
        .filter((id): id is string => id !== null),
    ),
  ];
  const users = new Map(
    (ids.length
      ? await db.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, email: true },
        })
      : []
    ).map((user) => [user.id, user]),
  );
  const documents: UntrackedTreeDocument[] = rows.map((row) => ({
    id: row.id,
    title: row.title,
    slug: row.slug,
    path: row.path,
    documentKind: row.kind,
    revision: row.revision,
    appearance: normalizeAppearance(row.appearance),
    wikiType: row.wikiType,
    wikiSummary: row.wikiSummary,
    reviewDueAt: row.reviewDueAt,
    lastReviewedAt: row.lastReviewedAt,
    createdAt: row.createdAt,
    createdBy: presentAuthor(
      row.createdById,
      row.createdByName,
      row.createdById ? (users.get(row.createdById) ?? null) : null,
    ),
    lastEditedAt: row.updatedAt,
    lastEditedBy: presentAuthor(
      row.updatedById,
      row.updatedByName,
      row.updatedById ? (users.get(row.updatedById) ?? null) : null,
    ),
  }));
  const metadata: Record<string, FolderMetadata> = {};
  for (const folder of folders) {
    const parsed = parseFolderMetadata(folder.metadata);
    if (parsed) metadata[folder.path] = parsed;
  }
  return {
    documents,
    folders: folders.map((folder) => folder.path),
    metadata,
  };
}

function requireFolderName(name: string): string {
  const normalized = normalizeFolderName(name);
  if (normalized === null)
    throw new CoreError("BAD_REQUEST", "Enter a folder name", {
      field: "name",
    });
  return normalized;
}

async function assertFreeFolderPath(
  tx: Db,
  projectId: string,
  segments: string[],
): Promise<void> {
  const rel = folderRel(segments);
  const taken =
    (await untrackedFolderExists(tx, projectId, segments)) ||
    (await trackedFolders(projectId)).has(rel) ||
    (await tx.untrackedDocument.count({
      where: { projectId, path: { startsWith: `${rel}.` } },
    })) > 0;
  if (taken)
    throw new CoreError(
      "CONFLICT",
      "A folder with this (slugified) name already exists here",
      { field: "name" },
    );
}

type FolderActor = ProjectActor & { name?: string | null; email?: string };

function folderAuthor(actor: FolderActor) {
  return authorForUser({
    id: actor.userId,
    name: actor.name ?? null,
    email: actor.email ?? "unknown@local",
  });
}

export async function createUntrackedFolder(
  db: PrismaClient,
  input: {
    projectId: string;
    parentPath: string[];
    name: string;
    appearance?: Appearance;
  },
  actor: FolderActor,
): Promise<{ path: string[] }> {
  const name = requireFolderName(input.name);
  const segments = [...input.parentPath, slugify(name)];
  if (segments.length > MAX_FOLDER_DEPTH)
    throw new CoreError("BAD_REQUEST", "folder depth exceeds 10");
  return withUntrackedWrite(db, input.projectId, actor, async (tx) => {
    await assertFolderExists(
      tx,
      input.projectId,
      input.parentPath,
      "parentPath",
    );
    await assertFreeFolderPath(tx, input.projectId, segments);
    await tx.untrackedFolder.create({
      data: {
        projectId: input.projectId,
        path: folderRel(segments),
        metadata: composeFolderMetadata({
          ...newFolderMetadata(name, folderAuthor(actor), new Date()),
          ...(input.appearance ? { appearance: input.appearance } : {}),
        }),
      },
    });
    return { path: segments };
  });
}

async function moveUntrackedFolderInTx(
  tx: Tx,
  projectId: string,
  from: string[],
  to: string[],
  actor: FolderActor,
  name?: string,
): Promise<void> {
  const fromRel = folderRel(from);
  const toRel = folderRel(to);
  const folder = await tx.untrackedFolder.findUnique({
    where: { projectId_path: { projectId, path: fromRel } },
  });
  if (!folder) throw folderNotFound("path");
  const meta = parseFolderMetadata(folder.metadata);
  const next = composeFolderMetadata({
    ...(meta ?? {
      name: from.at(-1)!,
      created: null,
      createdBy: null,
    }),
    ...(name ? { name } : {}),
    updated: new Date().toISOString(),
    updatedBy: folderAuthor(actor),
  });
  if (toRel === fromRel) {
    await tx.untrackedFolder.update({
      where: { projectId_path: { projectId, path: fromRel } },
      data: { metadata: next },
    });
    return;
  }
  if (`${toRel}/`.startsWith(`${fromRel}/`))
    throw new CoreError("BAD_REQUEST", "cannot move a folder into itself");
  await assertFolderExists(tx, projectId, to.slice(0, -1), "newParentPath");
  await assertFreeFolderPath(tx, projectId, to);
  const deepest = (
    await tx.untrackedFolder.findMany({
      where: { projectId, path: { startsWith: `${fromRel}/` } },
      select: { path: true },
    })
  ).reduce(
    (max, { path }) => Math.max(max, path.split("/").length),
    from.length,
  );
  if (deepest - from.length + to.length > MAX_FOLDER_DEPTH)
    throw new CoreError("BAD_REQUEST", "folder depth exceeds 10");
  await tx.untrackedFolder.update({
    where: { projectId_path: { projectId, path: fromRel } },
    data: { path: toRel, metadata: next },
  });
  await moveUntrackedPrefix(tx, projectId, fromRel, toRel);
}

export async function renameUntrackedFolder(
  db: PrismaClient,
  input: { projectId: string; path: string[]; name: string },
  actor: FolderActor,
): Promise<{ path: string[] }> {
  const name = requireFolderName(input.name);
  const to = [...input.path.slice(0, -1), slugify(name)];
  await withUntrackedWrite(db, input.projectId, actor, (tx) =>
    moveUntrackedFolderInTx(tx, input.projectId, input.path, to, actor, name),
  );
  return { path: to };
}

export async function moveUntrackedFolder(
  db: PrismaClient,
  input: { projectId: string; path: string[]; newParentPath: string[] },
  actor: FolderActor,
): Promise<{ path: string[] }> {
  const to = [...input.newParentPath, input.path.at(-1)!];
  await withUntrackedWrite(db, input.projectId, actor, (tx) =>
    moveUntrackedFolderInTx(tx, input.projectId, input.path, to, actor),
  );
  return { path: to };
}

export async function deleteUntrackedFolder(
  db: PrismaClient,
  input: { projectId: string; path: string[] },
  actor: FolderActor,
): Promise<void> {
  await withUntrackedWrite(db, input.projectId, actor, async (tx) => {
    const rel = folderRel(input.path);
    if (!(await untrackedFolderExists(tx, input.projectId, input.path)))
      throw folderNotFound("path");
    const children =
      (await tx.untrackedDocument.count({
        where: { projectId: input.projectId, path: { startsWith: `${rel}/` } },
      })) +
      (await tx.untrackedFolder.count({
        where: { projectId: input.projectId, path: { startsWith: `${rel}/` } },
      }));
    if (children > 0)
      throw new CoreError("PRECONDITION_FAILED", "folder is not empty");
    await tx.untrackedFolder.delete({
      where: { projectId_path: { projectId: input.projectId, path: rel } },
    });
  });
}

/** Rejects putting Git content below a folder that is kept out of Git. */
export async function assertTrackedDestination(
  db: Db,
  projectId: string,
  segments: string[],
): Promise<void> {
  if (await isUntrackedFolderPath(db, projectId, segments))
    throw new CoreError(
      "BAD_REQUEST",
      "Git content cannot be moved into a folder outside Git",
      { field: "folderPath" },
    );
}

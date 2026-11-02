import {
  withAppearanceAssetsInRepo,
  type AppearanceAsset,
} from "./appearanceAssets";
import { createKnowledgeSystemContextForRuntime } from "../jobs/systemContext";
import { flipDocumentAiExempt } from "./knowledgeGenerations";
import { normalizeAppearance, type Appearance } from "../appearance/metadata";
import { presentWikiProperties } from "./wikiProperties";
import {
  applyPagePropertiesInput,
  type WikiPageProperties,
  type WikiPagePropertiesInput,
} from "../wiki/properties";
import { randomUUID } from "node:crypto";
import { parseServerEnv } from "@weaver/config/server";
import {
  MAX_IMPORTED_IMAGES,
  MAX_IMPORT_IMAGE_BYTES,
} from "../documents/limits";
import { CoreError } from "@weaver/core/errors";
import type { JSONContent } from "@tiptap/core";
import { diffLines, type Change } from "diff";
import { z } from "zod";
import { Prisma, type Document, type PrismaClient } from "@weaver/db/client";
import {
  composeDocumentFile,
  parseDocumentFile,
  authorForUser,
  type DocumentAuthor,
  type DocumentMeta,
} from "@weaver/core/documents/frontmatter";
import {
  extractCrossrefTargets,
  type CrossrefTarget,
} from "@weaver/core/documents/links";
import {
  assetsDirForDocPath,
  sniffImageType,
  classifyImageSrc,
  collectImageSources,
  hasAssetsSegment,
  resolveRelativeImagePath,
  rewriteOwnAssetsPrefix,
} from "@weaver/core/documents/images";
import {
  assertSafeSegments,
  docPath,
  folderNotFound,
} from "@weaver/core/documents/paths";
import {
  DOCUMENT_KIND_NAMES,
  DOCUMENT_KINDS,
  documentFileExtension,
  documentKindFromPath,
  documentKindOfPath,
  type DocumentKind,
} from "@weaver/core/documents/kinds";
import {
  assertPlainText,
  normalizeDocumentText,
} from "@weaver/core/documents/text";
import { slugify } from "@weaver/core/documents/slug";
import { documentTitleSchema } from "@weaver/core/documents/title";
import { assertOutsideTablesRoot } from "@weaver/core/tables/paths";
import {
  applyCrossrefLabels,
  crossrefTargetKey,
  parseDocumentBody,
  serializeDocumentBody,
  validateDocumentContent,
} from "@weaver/core/editor/markdown";
import {
  reviewDueAt,
  type DocumentReview,
} from "@weaver/core/documents/review";
import { syncLinks } from "./documentLinks";
import { resolveImportedReview } from "./reviewerGroups";
import { defaultReviewForFolderInRepo } from "./folderReview";
import {
  openProjectRepo,
  type GitLogEntry,
  type ProjectRepoReader,
  type ProjectRepoWriter,
} from "@weaver/git-store";
import type { SecurityContext } from "../security/context";
import { assertProjectRole, type ProjectActor } from "./projectAccess";
import {
  gitAuthorForContent,
  documentAuthorForContent,
  contentUserId,
  machineEditorColumns,
  machineEditorFromRow,
  machineIdentity,
  skipsLabelEnrichment,
  type ContentWriteActor,
  type MachineEditor,
  type MachineEditorRef,
} from "./contentAuthor";
import { withExistingProjectRepoReader, withProjectRepo } from "./projectRepo";
import { resolveSnapshotCommit } from "./contentSnapshots";
import { loadChangeSummaries } from "./documentChangeSummaryReads";
import {
  enqueueContentDeleted,
  enqueueDocumentChanged,
  enqueueProjectReconcile,
} from "./knowledgeReconciliation";
import { notifyProjectContentChanged } from "./projectGitRemoteJobs";
import { captureError } from "../diagnostics/writer";

type Db = PrismaClient | Prisma.TransactionClient;

export type EnrichedActor = ProjectActor & {
  name: string | null;
  email: string;
};

export type DocumentResult = {
  id: string;
  path: string;
  slug: string;
  title: string;
  headCommitSha: string;
};

type WriteMetadata = {
  operation: "create" | "update" | "restore";
  message?: (path: string, oldPath: string | null) => string;
  sourceCommitSha?: string;
  /** Stable audit identifier recorded as a Weaver-Operation-Id commit trailer. */
  operationId?: string;
  /** Durable MCP request identity used to validate crash recovery. */
  mcpRequestHash?: string;
  mcpToolName?: string;
  apiRequestHash?: string;
  apiOperation?: string;
  /** Assistant run that produced the change, as a Weaver-Run-Id commit trailer. */
  runId?: string;
  /** Weaver-Wiki-Request-Hash; the wiki agent's recovery key. */
  wikiRequestHash?: string;
  /** Weaver-Wiki-Input-Id on a source writer commit. */
  wikiInputId?: string;
  /** Runs under the project lock immediately before the commit; a throw aborts it. */
  beforeCommit?: () => Promise<void>;
};

/** Trailers a caller may attach to a write (a scheduled task run, Phase 6A §7). */
export type DocumentProvenance = Pick<WriteMetadata, "operationId" | "runId">;

/** Audit trailers a restore may carry, so MCP replay can recognise its own commit. */
export type DocumentWriteAudit = Pick<
  WriteMetadata,
  | "operationId"
  | "mcpRequestHash"
  | "mcpToolName"
  | "runId"
  | "apiRequestHash"
  | "apiOperation"
>;

/** A binary file committed together with the document, named relative to its
 * assets directory (recovery brings a deleted document's images back). */
export type DocumentAssetFile = { name: string; bytes: Uint8Array };

export type DocumentContentInput =
  | { kind: "markdown"; contentJson: JSONContent }
  | { kind: "python"; text: string };

export function documentContentText(content: DocumentContentInput): string {
  return content.kind === "markdown"
    ? serializeDocumentBody(content.contentJson)
    : content.text;
}

/** Explicitly set document metadata (e.g. an imported document's original
 *  dates and author); fields left out take their defaults. Authors are
 *  already resolved and validated by the caller. */
export type DocumentMetadataOverride = {
  created?: string;
  createdBy?: DocumentAuthor;
  updated?: string;
  updatedBy?: DocumentAuthor;
};

type WriteRequest =
  | {
      kind: "create";
      id: string;
      folderPath: string[];
      title: string;
      content: DocumentContentInput;
      createdAt: string;
      metadata?: DocumentMetadataOverride;
      assets?: DocumentAssetFile[];
      /** Slug the content's own asset links currently use, when it is not the
       * slug this write will allocate. */
      assetsFromSlug?: string;
      /** Preserved review metadata for deleted-content recovery. */
      review?: DocumentReview;
      reviewSource?: { kind: "import"; imported: DocumentReview | null };
      appearance?: Appearance;
      /** Internal system path: carried from a recovered header, source writer, bootstrap. */
      properties?: WikiPageProperties;
      /** Public writer input, validated and merged over `properties`. */
      propertiesInput?: WikiPagePropertiesInput;
      /** Source writer only: the WikiInputItem this page records. */
      wikiSourceItemId?: string;
    }
  | {
      kind: "update";
      documentId: string;
      baseCommitSha: string;
      title?: string;
      content: DocumentContentInput;
      changeSummary: string;
      metadata?: DocumentMetadataOverride;
      /** Images committed into the document's assets directory with the edit. */
      assets?: DocumentAssetFile[];
      /** Public writer input, merged over the page's stored properties. */
      propertiesInput?: WikiPagePropertiesInput;
    };

export type DocumentWriteRequest = WriteRequest;

type Projection = {
  id: string;
  projectId: string;
  path: string;
  slug: string;
  title: string;
  excerpt: string;
  sha: string;
  actorId: string | null;
  actorMachine?: MachineEditorRef | null;
  actorName?: string | null;
  meta: DocumentMeta;
  targets: CrossrefTarget[];
  create: boolean;
  /** Set by the source writer; otherwise re-derived from WikiInputItem in the projection write. */
  wikiSourceItemId?: string;
};

type PreparedWrite = Omit<Projection, "sha"> & {
  oldPath: string | null;
  body: string;
  assets: DocumentAssetFile[];
  /** Metadata fields set explicitly, recorded as a commit trailer. */
  overridden: (keyof DocumentMetadataOverride)[];
};

/** A far-future date in a pulled file must not push the due date out forever. */
function dueAtFrom(review: DocumentReview, now: Date): Date {
  const clamp = (value: string) =>
    new Date(value) > now ? now.toISOString() : value;
  return reviewDueAt({
    ...review,
    since: clamp(review.since),
    lastReviewed: review.lastReviewed ? clamp(review.lastReviewed) : null,
  });
}

/** Projection columns mirroring the frontmatter; an author id links only when
 *  that user exists here (a pulled or restored file may name unknown ids). */
/** Rows are derived and can be rebuilt; the item's link is what survives. */
async function wikiSourceItemIds(
  db: Db,
  projectId: string,
  documentIds: readonly string[],
): Promise<Map<string, string>> {
  if (documentIds.length === 0) return new Map();
  const items = await db.wikiInputItem.findMany({
    where: { projectId, sourceDocumentId: { in: [...documentIds] } },
    select: { id: true, sourceDocumentId: true },
  });
  return new Map(items.map((item) => [item.sourceDocumentId!, item.id]));
}

export async function documentMetadataColumns(
  db: Db,
  metas: readonly DocumentMeta[],
): Promise<
  Array<{
    appearance: Prisma.InputJsonValue | typeof Prisma.DbNull;
    wikiType: string | null;
    wikiSummary: string | null;
    wikiTags: Prisma.InputJsonValue | typeof Prisma.DbNull;
    wikiSources: Prisma.InputJsonValue | typeof Prisma.DbNull;
    reviewExempt: boolean;
    createdAt: Date;
    createdById: string | null;
    createdByName: string | null;
    updatedAt: Date;
    updatedById: string | null;
    updatedByName: string | null;
    reviewEveryMonths: number | null;
    reviewSince: Date | null;
    lastReviewedAt: Date | null;
    reviewedById: string | null;
    reviewedByName: string | null;
    reviewDueAt: Date | null;
  }>
> {
  const ids = [
    ...new Set(
      metas
        .flatMap((meta) => [
          meta.createdBy?.id,
          meta.updatedBy?.id,
          meta.review?.reviewedBy?.id,
        ])
        .filter((id): id is string => typeof id === "string"),
    ),
  ];
  const known = new Set(
    ids.length
      ? (
          await db.user.findMany({
            where: { id: { in: ids } },
            select: { id: true },
          })
        ).map((user) => user.id)
      : [],
  );
  const link = (author: DocumentAuthor | null) =>
    author?.id && known.has(author.id) ? author.id : null;
  const now = new Date();
  return metas.map((meta) => ({
    appearance: normalizeAppearance(meta.appearance) ?? Prisma.DbNull,
    wikiType: meta.properties?.type ?? null,
    wikiSummary: meta.properties?.summary ?? null,
    wikiTags: meta.properties?.tags ?? Prisma.DbNull,
    wikiSources: meta.properties?.sources ?? Prisma.DbNull,
    reviewExempt: meta.properties?.reviewExempt === true,
    createdAt: new Date(meta.created),
    createdById: link(meta.createdBy),
    createdByName: meta.createdBy?.name ?? null,
    updatedAt: new Date(meta.updated),
    updatedById: link(meta.updatedBy),
    updatedByName: meta.updatedBy?.name ?? null,
    reviewEveryMonths: meta.review?.everyMonths ?? null,
    reviewSince: meta.review ? new Date(meta.review.since) : null,
    lastReviewedAt: meta.review?.lastReviewed
      ? new Date(meta.review.lastReviewed)
      : null,
    reviewedById: link(meta.review?.reviewedBy ?? null),
    reviewedByName: meta.review?.reviewedBy?.name ?? null,
    reviewDueAt: meta.review ? dueAtFrom(meta.review, now) : null,
  }));
}

type ReviewerTargets = {
  members: Map<string, { id: string; name: string; email: string }>;
  groups: Map<string, string>;
};

/** The current project members and existing groups among the given reviewer refs. */
async function lookupReviewerTargets(
  db: Db,
  projectId: string,
  reviewers: DocumentReview["reviewers"],
): Promise<ReviewerTargets> {
  const userIds = [
    ...new Set(reviewers.filter((r) => r.type === "user").map((r) => r.id)),
  ];
  const groupIds = [
    ...new Set(reviewers.filter((r) => r.type === "group").map((r) => r.id)),
  ];
  const members = userIds.length
    ? await db.member.findMany({
        where: {
          userId: { in: userIds },
          organization: { project: { id: projectId } },
        },
        select: { user: { select: { id: true, name: true, email: true } } },
      })
    : [];
  const groups = groupIds.length
    ? await db.reviewerGroup.findMany({
        where: { projectId, id: { in: groupIds } },
        select: { id: true, name: true },
      })
    : [];
  return {
    members: new Map(members.map((m) => [m.user.id, m.user])),
    groups: new Map(groups.map((g) => [g.id, g.name])),
  };
}

const REVIEWER_ROW_CHUNK = 1000;

/** Replaces the reviewer rows of several documents; links only current members and existing groups. */
export async function syncDocumentsReviewers(
  tx: Db,
  projectId: string,
  entries: Array<{ documentId: string; review: DocumentReview | null }>,
): Promise<void> {
  if (!entries.length) return;
  await tx.documentReviewer.deleteMany({
    where: { documentId: { in: entries.map((e) => e.documentId) } },
  });
  const { members, groups } = await lookupReviewerTargets(
    tx,
    projectId,
    entries.flatMap((e) => e.review?.reviewers ?? []),
  );
  const data = entries.flatMap(({ documentId, review }) =>
    (review?.reviewers ?? []).map((ref) => ({
      documentId,
      type: ref.type,
      refId: ref.id,
      name: ref.name,
      userId: ref.type === "user" && members.has(ref.id) ? ref.id : null,
      groupId: ref.type === "group" && groups.has(ref.id) ? ref.id : null,
    })),
  );
  for (let i = 0; i < data.length; i += REVIEWER_ROW_CHUNK)
    await tx.documentReviewer.createMany({
      data: data.slice(i, i + REVIEWER_ROW_CHUNK),
    });
}

/** Replaces the document's reviewer rows; links only current members and existing groups. */
export async function syncDocumentReviewers(
  tx: Db,
  projectId: string,
  documentId: string,
  review: DocumentReview | null,
): Promise<void> {
  await syncDocumentsReviewers(tx, projectId, [{ documentId, review }]);
}

export type DocumentReviewView = {
  reviewers: {
    type: "user" | "group";
    id: string;
    name: string;
    resolved: boolean;
  }[];
  everyMonths: number;
  since: Date;
  lastReviewedAt: Date | null;
  reviewedBy: DocumentAuthor | null;
  dueAt: Date;
};

/** The review block with current member/group names and whether each reviewer still resolves. */
async function presentDocumentReview(
  db: Db,
  projectId: string,
  review: DocumentReview | null,
): Promise<DocumentReviewView | null> {
  if (!review) return null;
  const { members, groups } = await lookupReviewerTargets(
    db,
    projectId,
    review.reviewers,
  );
  const reviewer = review.reviewedBy?.id
    ? await db.user.findUnique({
        where: { id: review.reviewedBy.id },
        select: { name: true, email: true },
      })
    : null;
  return {
    reviewers: review.reviewers.map((ref) => {
      const current =
        ref.type === "user"
          ? members.has(ref.id)
            ? authorForUser(members.get(ref.id)!).name
            : undefined
          : groups.get(ref.id);
      return {
        ...ref,
        name: current ?? ref.name,
        resolved: current !== undefined,
      };
    }),
    everyMonths: review.everyMonths,
    since: new Date(review.since),
    lastReviewedAt: review.lastReviewed ? new Date(review.lastReviewed) : null,
    reviewedBy: review.reviewedBy
      ? presentAuthor(review.reviewedBy.id, review.reviewedBy.name, reviewer)
      : null,
    dueAt: dueAtFrom(review, new Date()),
  };
}

/** Presents an author with the user's current name when the id resolves. */
export function presentAuthor(
  id: string | null,
  storedName: string | null,
  user: { name: string | null; email: string } | null,
): DocumentAuthor | null {
  if (!id && !storedName) return null;
  // An account without a display name falls back to the stored name, then email.
  const current = user?.name?.trim();
  return {
    id: user ? id : null,
    name:
      (current === "" ? undefined : current) ?? storedName ?? user?.email ?? "",
  };
}

export type DocumentMetadataView = {
  createdAt: Date;
  createdBy: DocumentAuthor | null;
  updatedAt: Date;
  updatedBy: DocumentAuthor | null;
};

/** The four metadata fields of a read revision, with current user names. */
async function presentDocumentMetadata(
  db: Db,
  meta: DocumentMeta,
): Promise<DocumentMetadataView> {
  const ids = [meta.createdBy?.id, meta.updatedBy?.id].filter(
    (id): id is string => typeof id === "string",
  );
  const users = new Map(
    (ids.length
      ? await db.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, email: true },
        })
      : []
    ).map((user) => [user.id, user]),
  );
  const author = (value: DocumentAuthor | null) =>
    value &&
    presentAuthor(value.id, value.name, users.get(value.id ?? "") ?? null);
  return {
    createdAt: new Date(meta.created),
    createdBy: author(meta.createdBy),
    updatedAt: new Date(meta.updated),
    updatedBy: author(meta.updatedBy),
  };
}

function assertUpdatedNotBeforeCreated(meta: DocumentMeta): void {
  if (meta.updated < meta.created)
    throw new CoreError(
      "BAD_REQUEST",
      "updated must not be earlier than created",
      { field: "metadata.updated" },
    );
}

const MAX_FILE_BYTES = 2_000_000;
const MAX_DIFF_CHARS = 500_000;
const MAX_DIFF_EDIT_LENGTH = 500;
const MAX_DIFF_MS = 100;
const PARSE_CACHE_MAX = 50;
const parseCache = new Map<string, JSONContent>();
const trailerUserIdSchema = z.uuid();

type AttributionEntry = Pick<
  GitLogEntry,
  "authorEmail" | "userId" | "trustedAuthor"
> & {
  projectKeyId?: string | null;
  wikiAgentId?: string | null;
  authorName?: string;
};
export type ResolvedContentAuthor =
  | { id: string; name: string | null; email: string; kind?: "user" }
  | {
      kind: "machine";
      machineKind: MachineEditorRef["machineKind"];
      machineId: string;
      id: null;
      name: string;
      email: string;
    };

export function machineRefOf(
  author: ResolvedContentAuthor | null | undefined,
): MachineEditorRef | null {
  return author?.kind === "machine" ? author : null;
}

export function machineEditorOf(
  author: ResolvedContentAuthor | null | undefined,
): MachineEditor | null {
  return author?.kind === "machine"
    ? { kind: author.machineKind, id: author.machineId, name: author.name }
    : null;
}

export async function resolveAttribution(
  db: Db,
  entries: AttributionEntry[],
): Promise<Array<ResolvedContentAuthor | null>> {
  const parsed = entries.map((entry) => {
    const trailer =
      entry.trustedAuthor !== false &&
      !entry.projectKeyId &&
      !entry.wikiAgentId &&
      entry.userId
        ? trailerUserIdSchema.safeParse(entry.userId)
        : null;
    return trailer?.success ? trailer.data.toLowerCase() : null;
  });
  const trailerIds = [
    ...new Set(parsed.filter((id): id is string => id !== null)),
  ];
  const trailerUsers =
    trailerIds.length > 0
      ? await db.user.findMany({
          where: { id: { in: trailerIds } },
          select: { id: true, name: true, email: true },
        })
      : [];
  const byTrailer = new Map(trailerUsers.map((user) => [user.id, user]));
  const fallbackEmails = [
    ...new Set(
      entries
        .filter((_, index) => {
          const trailerId = parsed[index];
          return (
            entries[index]!.trustedAuthor !== false &&
            !entries[index]!.projectKeyId &&
            !entries[index]!.wikiAgentId &&
            (!trailerId || !byTrailer.has(trailerId))
          );
        })
        .map((entry) => entry.authorEmail),
    ),
  ];
  const fallbackUsers =
    fallbackEmails.length > 0
      ? await db.user.findMany({
          where: { email: { in: fallbackEmails } },
          select: { id: true, name: true, email: true },
        })
      : [];
  const byEmail = new Map(fallbackUsers.map((user) => [user.email, user]));
  return entries.map((entry, index) => {
    if (entry.trustedAuthor === false) return null;
    // Only the ledger vouches for the agent: unset trust is not trust here.
    if (entry.wikiAgentId) {
      if (
        entry.trustedAuthor !== true ||
        entry.projectKeyId ||
        !trailerUserIdSchema.safeParse(entry.wikiAgentId).success
      )
        return null;
      return {
        kind: "machine" as const,
        machineKind: "wikiAgent" as const,
        machineId: entry.wikiAgentId,
        id: null,
        name: entry.authorName ?? "Wiki agent",
        email: entry.authorEmail,
      };
    }
    if (entry.projectKeyId) {
      if (!trailerUserIdSchema.safeParse(entry.projectKeyId).success)
        return null;
      return {
        kind: "machine" as const,
        machineKind: "projectApiKey" as const,
        machineId: entry.projectKeyId,
        id: null,
        name: entry.authorName ?? "Project API key",
        email: entry.authorEmail,
      };
    }
    return (
      (parsed[index] ? byTrailer.get(parsed[index]) : undefined) ??
      byEmail.get(entry.authorEmail) ??
      null
    );
  });
}

export const author = gitAuthorForContent;

export function assertDocumentFileSize(file: string, path?: string): void {
  if (Buffer.byteLength(file, "utf8") > MAX_FILE_BYTES) {
    throw new CoreError(
      "BAD_REQUEST",
      path
        ? `Document at ${path} would exceed ${MAX_FILE_BYTES.toLocaleString("en-US")} UTF-8 bytes. Reduce its content or reviewer list before trying again.`
        : "document too large",
    );
  }
}

function assertImageSourcesContained(json: JSONContent, docPath: string) {
  for (const src of collectImageSources(json)) {
    if (
      classifyImageSrc(src) === "relative" &&
      resolveRelativeImagePath(docPath, src) === null
    )
      throw new CoreError("BAD_REQUEST", "image path escapes the repository");
  }
}

async function moveAssetsDir(
  repo: ProjectRepoWriter,
  fromDocPath: string,
  toDocPath: string,
) {
  const from = assetsDirForDocPath(fromDocPath);
  if (await repo.fileExistsInWorktree(from)) {
    await repo.mv(from, assetsDirForDocPath(toDocPath));
  }
}

export function documentSlugFromPath(file: string): string {
  const segments = file.split("/");
  const filename = segments.pop() ?? "";
  const kind = documentKindFromPath(filename);
  if (kind === null) throw new Error("document path is not canonical");
  const slug = filename.slice(0, -documentFileExtension(kind).length);
  if (docPath(segments, slug, kind) !== file)
    throw new Error("document path is not canonical");
  return slug;
}

function assertDocumentTitle(title: string): void {
  const result = documentTitleSchema.safeParse(title);
  if (!result.success) {
    throw new CoreError(
      "BAD_REQUEST",
      result.error.issues[0]?.message ?? "invalid title",
    );
  }
  if (result.data !== title) {
    throw new CoreError("BAD_REQUEST", "title must be trimmed and nonempty");
  }
}

async function readDocumentProjectionCandidate(
  repo: ProjectRepoReader,
  snapshotSha: string,
  path: string,
) {
  const slug = documentSlugFromPath(path);
  const size = await repo.blobSizeAt(snapshotSha, path);
  if (size === null) throw new Error("blob not found");
  if (size > MAX_FILE_BYTES) throw new Error("document too large");
  const parsed = parseDocumentFile(
    await repo.showFileAt(snapshotSha, path),
    documentKindOfPath(path),
  );
  assertDocumentTitle(parsed.meta.title);
  return { slug, ...parsed };
}

function cachedParse(key: string, body: string): JSONContent {
  const hit = parseCache.get(key);
  if (hit) {
    parseCache.delete(key);
    parseCache.set(key, hit);
    return structuredClone(hit);
  }
  const parsed = parseDocumentBody(body);
  parseCache.set(key, parsed);
  if (parseCache.size > PARSE_CACHE_MAX) {
    parseCache.delete(parseCache.keys().next().value!);
  }
  return structuredClone(parsed);
}

function defaultCommitMessage(
  metadata: WriteMetadata,
  path: string,
  oldPath: string | null,
): string {
  if (metadata.message) return metadata.message(path, oldPath);
  if (metadata.operation === "restore" && metadata.sourceCommitSha) {
    return `restore: ${path} (from ${metadata.sourceCommitSha.slice(0, 7)})`;
  }
  const moved = oldPath && oldPath !== path ? ` (was ${oldPath})` : "";
  return `${metadata.operation}: ${path}${moved}`;
}

async function persistDocumentProjection(
  db: PrismaClient,
  repo: ProjectRepoReader,
  projection: Projection,
): Promise<void> {
  const committedAt = await repo.commitDate(projection.sha);
  let linkChanged = false;
  await db.$transaction(async (tx) => {
    const [metadata] = await documentMetadataColumns(tx, [projection.meta]);
    const wikiSourceItemId =
      projection.wikiSourceItemId ??
      (await wikiSourceItemIds(tx, projection.projectId, [projection.id])).get(
        projection.id,
      ) ??
      null;
    const data = {
      wikiSourceItemId,
      path: projection.path,
      kind: documentKindOfPath(projection.path),
      slug: projection.slug,
      title: projection.title,
      excerpt: projection.excerpt,
      headCommitSha: projection.sha,
      lastEditedById: projection.actorId,
      ...machineEditorColumns(projection.actorMachine ?? null),
      lastEditedByName:
        projection.actorName ?? projection.meta.updatedBy?.name ?? null,
      lastEditedAt: committedAt,
      ...metadata!,
    };
    if (projection.create) {
      await tx.document.create({
        data: {
          id: projection.id,
          projectId: projection.projectId,
          ...data,
        },
      });
      await tx.documentIndexState.updateMany({
        where: { documentId: projection.id, projectId: projection.projectId },
        data: { keywordIndexedSha: null, status: "pending", completedAt: null },
      });
    } else {
      const previous = await tx.document.findUnique({
        where: { id: projection.id },
        select: { wikiSourceItemId: true },
      });
      linkChanged = (previous?.wikiSourceItemId ?? null) !== wikiSourceItemId;
      await tx.document.update({
        where: { id: projection.id, projectId: projection.projectId },
        data,
      });
    }
    await syncLinks(tx, projection.id, projection.targets);
    await syncDocumentReviewers(
      tx,
      projection.projectId,
      projection.id,
      projection.meta.review,
    );
  });
  if (linkChanged)
    await flipDocumentAiExempt(createKnowledgeSystemContextForRuntime(), db, {
      projectId: projection.projectId,
      documentId: projection.id,
    });
}

function reportProjectionFailure(input: {
  projectId: string;
  documentId: string;
  headCommitSha: string;
  error: unknown;
}): void {
  const reference = captureError({
    event: "content.projection.failed",
    message: "document projection failed after git commit",
    error: input.error,
    projectId: input.projectId,
    documentId: input.documentId,
    details: { kind: "document", headCommitSha: input.headCommitSha },
  });
  console.error(
    `Document projection failed after git commit (ref ${reference ?? "none"})`,
    { projectId: input.projectId, documentId: input.documentId },
  );
}

async function updateProjection(
  db: PrismaClient,
  repo: ProjectRepoReader,
  projection: Projection,
): Promise<void> {
  try {
    await persistDocumentProjection(db, repo, projection);
  } catch (error) {
    await reportProjectionFailureAndReconcile({
      projectId: projection.projectId,
      documentId: projection.id,
      headCommitSha: projection.sha,
      error,
    });
  }
}

export async function reportProjectionFailureAndReconcile(input: {
  projectId: string;
  documentId: string;
  headCommitSha: string;
  error: unknown;
}): Promise<void> {
  reportProjectionFailure(input);
  await enqueueProjectReconcile(input.projectId, [input.documentId]);
}

async function updateMovedProjection(
  db: PrismaClient,
  repo: ProjectRepoReader,
  input: {
    projectId: string;
    documentId: string;
    path: string;
    slug: string;
    sha: string;
    actorId: string;
  },
): Promise<void> {
  try {
    const lastEditedAt = await repo.commitDate(input.sha);
    await db.document.update({
      where: { id: input.documentId },
      data: {
        path: input.path,
        slug: input.slug,
        headCommitSha: input.sha,
        lastEditedById: input.actorId,
        ...machineEditorColumns(null),
        lastEditedByName: null,
        lastEditedAt,
      },
    });
  } catch (error) {
    reportProjectionFailure({
      projectId: input.projectId,
      documentId: input.documentId,
      headCommitSha: input.sha,
      error,
    });
  }
}

async function deleteDocumentProjection(
  db: PrismaClient,
  input: { projectId: string; documentId: string; sha: string },
): Promise<void> {
  try {
    await db.document.delete({ where: { id: input.documentId } });
  } catch (error) {
    reportProjectionFailure({
      projectId: input.projectId,
      documentId: input.documentId,
      headCommitSha: input.sha,
      error,
    });
  }
}

async function commitPreparedWrite(
  db: PrismaClient,
  repo: ProjectRepoWriter,
  prepared: PreparedWrite,
  actor: ContentWriteActor,
  metadata: WriteMetadata,
): Promise<DocumentResult> {
  const { oldPath, body, assets, overridden, ...projection } = prepared;
  const file = composeDocumentFile(
    projection.meta,
    body,
    documentKindOfPath(projection.path),
  );
  assertDocumentFileSize(file);
  if (oldPath && oldPath !== projection.path) {
    await repo.mv(oldPath, projection.path);
    await moveAssetsDir(repo, oldPath, projection.path);
  }
  await repo.writeFileAtomic(projection.path, file);
  // After slug allocation, before the commit: one operation, one commit.
  const assetsDir = assetsDirForDocPath(projection.path);
  for (const asset of assets) {
    await repo.writeBinaryFileAtomic(`${assetsDir}/${asset.name}`, asset.bytes);
  }
  const sha = await repo.commitAll(
    defaultCommitMessage(metadata, projection.path, oldPath),
    author(actor),
    {
      operationId: metadata.operationId,
      mcpRequestHash: metadata.mcpRequestHash,
      mcpToolName: metadata.mcpToolName,
      apiRequestHash: metadata.apiRequestHash,
      apiOperation: metadata.apiOperation,
      runId: metadata.runId,
      wikiRequestHash: metadata.wikiRequestHash,
      wikiInputId: metadata.wikiInputId,
      beforeCommit: metadata.beforeCommit,
      metadataOverride: overridden,
    },
  );
  await updateProjection(db, repo, { ...projection, sha });
  await enqueueDocumentChanged({
    projectId: projection.projectId,
    documentId: projection.id,
    sourceCommitSha: sha,
    pathAtSha: projection.path,
  });
  return {
    id: projection.id,
    path: projection.path,
    slug: projection.slug,
    title: projection.title,
    headCommitSha: sha,
  };
}

export function plainTextExcerpt(json: JSONContent, max = 300): string {
  const parts: string[] = [];
  const walk = (node: JSONContent): void => {
    if (node.type === "text" && typeof node.text === "string") {
      parts.push(node.text);
    }
    node.content?.forEach(walk);
  };
  walk(json);
  return parts
    .join(" ")
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function plainTextExcerptOfText(text: string, max = 300): string {
  return text
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

type PreparedContent = {
  body: string;
  targets: CrossrefTarget[];
  excerpt: string;
  /** The TipTap tree for Markdown; null for plain-text kinds. */
  json: JSONContent | null;
};

async function prepareContent(
  db: Db,
  projectId: string,
  content: DocumentContentInput,
  enrichTitles = true,
): Promise<PreparedContent> {
  if (content.kind === "python") {
    assertPlainText(content.text, "content.text");
    const body = normalizeDocumentText(content.text);
    if (Buffer.byteLength(body, "utf8") > MAX_FILE_BYTES)
      throw new CoreError("BAD_REQUEST", "document too large");
    return {
      body,
      targets: [],
      excerpt: plainTextExcerptOfText(body),
      json: null,
    };
  }
  const { body, targets } = await serializeForSave(
    db,
    projectId,
    content.contentJson,
    enrichTitles,
  );
  return {
    body,
    targets,
    excerpt: plainTextExcerpt(content.contentJson),
    json: content.contentJson,
  };
}

/** Projection-only fields of a committed body, by kind. */
export function projectionContent(
  kind: DocumentKind,
  body: string,
): { excerpt: string; targets: CrossrefTarget[] } {
  if (kind === "python")
    return { excerpt: plainTextExcerptOfText(body), targets: [] };
  const json = parseDocumentBody(body);
  return {
    excerpt: plainTextExcerpt(json),
    targets: extractCrossrefTargets(json),
  };
}

export async function serializeForSave(
  db: Db,
  projectId: string,
  contentJson: JSONContent,
  enrichTitles = true,
): Promise<{ body: string; targets: CrossrefTarget[] }> {
  try {
    validateDocumentContent(contentJson);
  } catch (error) {
    const reason = error instanceof Error ? error.message.trim() : "";
    throw new CoreError("BAD_REQUEST", reason || "invalid document content");
  }
  const targets = extractCrossrefTargets(contentJson);
  if (!enrichTitles)
    return { body: serializeDocumentBody(contentJson), targets };
  const documentIds = targets
    .filter((target) => target.targetType === "document")
    .map((target) => target.targetId);
  const tableIds = targets
    .filter((target) => target.targetType === "table")
    .map((target) => target.targetId);
  const [documentRows, tableRows] = await Promise.all([
    documentIds.length > 0
      ? db.document.findMany({
          where: { projectId, id: { in: documentIds } },
          select: { id: true, title: true },
        })
      : [],
    tableIds.length > 0
      ? db.dataTable.findMany({
          where: { projectId, id: { in: tableIds } },
          select: { id: true, title: true },
        })
      : [],
  ]);
  const titles = new Map<string, string>([
    ...documentRows.map(
      (row) => [crossrefTargetKey("document", row.id), row.title] as const,
    ),
    ...tableRows.map(
      (row) => [crossrefTargetKey("table", row.id), row.title] as const,
    ),
  ]);
  let body: string;
  try {
    body = serializeDocumentBody(applyCrossrefLabels(contentJson, titles));
  } catch {
    throw new CoreError("BAD_REQUEST", "invalid document content");
  }
  if (Buffer.byteLength(body, "utf8") > MAX_FILE_BYTES) {
    throw new CoreError("BAD_REQUEST", "document too large");
  }
  return { body, targets };
}

export async function nextAvailableSlug(
  db: Db,
  repo: ProjectRepoWriter,
  projectId: string,
  title: string,
  folderPath: string[],
  kind: DocumentKind,
  excludeDocumentId?: string,
): Promise<{ slug: string; path: string }> {
  const base = slugify(title);
  const excluded = excludeDocumentId
    ? await db.document.findFirst({
        where: { id: excludeDocumentId, projectId },
        select: { path: true },
      })
    : null;
  const ownHistoryPaths = new Set<string>();
  if (excluded) {
    for (let skip = 0; skip < 1000; skip += 100) {
      const entries = await repo.logForPath(excluded.path, {
        skip,
        limit: 100,
      });
      for (const entry of entries) ownHistoryPaths.add(entry.pathAtSha);
      if (entries.length < 100) break;
    }
  }
  const tracked = await repo.listTrackedFiles();
  const historicalPaths = new Set(
    await repo.listHistoricalPaths(folderPath.join("/")),
  );
  for (let i = 1; i < 1000; i++) {
    const suffix = i === 1 ? "" : `-${i}`;
    const slug = `${base.slice(0, 80 - suffix.length).replace(/-+$/g, "")}${suffix}`;
    const path = docPath(folderPath, slug, kind);
    const inIndex = await db.document.findFirst({
      where: {
        projectId,
        slug,
        ...(excludeDocumentId ? { id: { not: excludeDocumentId } } : {}),
      },
      select: { id: true },
    });
    const isCurrentSelfPath = excluded?.path === path;
    const isOwnHistoryPath = isCurrentSelfPath || ownHistoryPaths.has(path);
    const basenames = DOCUMENT_KIND_NAMES.map(
      (candidate) => `${slug}${documentFileExtension(candidate)}`,
    );
    const trackedCollision = tracked.some(
      (trackedPath) =>
        basenames.some(
          (basename) =>
            trackedPath.endsWith(`/${basename}`) || trackedPath === basename,
        ) && trackedPath !== excluded?.path,
    );
    const inWorktree = await repo.fileExistsInWorktree(path);
    const inHistory = historicalPaths.has(path);
    const assetsDir = assetsDirForDocPath(path);
    const assetsTaken =
      (await repo.fileExistsInWorktree(assetsDir)) && !isCurrentSelfPath;
    if (
      !inIndex &&
      !trackedCollision &&
      !assetsTaken &&
      (!inWorktree || isCurrentSelfPath) &&
      (!inHistory || isOwnHistoryPath)
    ) {
      return { slug, path };
    }
  }
  throw new CoreError("INTERNAL_SERVER_ERROR", "no available slug");
}

const historicPathCache = new WeakMap<
  ProjectRepoReader,
  Map<string, string | null>
>();

export async function pathAtCommit(
  repo: ProjectRepoReader,
  currentPath: string,
  sha: string,
  snapshotSha = "HEAD",
): Promise<string | null> {
  if (!(await repo.isAncestor(sha, snapshotSha))) return null;
  const key = `${snapshotSha}:${currentPath}:${sha}`;
  const cache = historicPathCache.get(repo) ?? new Map<string, string | null>();
  if (snapshotSha !== "HEAD" && cache.has(key)) return cache.get(key)!;
  const entries = await repo.logForPath(currentPath, {
    skip: 0,
    limit: 10_000,
    commitish: snapshotSha,
  });
  const result = entries.find((entry) => entry.sha === sha)?.pathAtSha ?? null;
  if (snapshotSha !== "HEAD") {
    for (const entry of entries)
      cache.set(`${snapshotSha}:${currentPath}:${entry.sha}`, entry.pathAtSha);
    cache.set(key, result);
    historicPathCache.set(repo, cache);
  }
  return result;
}

async function requireDocument(
  db: Db,
  projectId: string,
  documentId: string,
): Promise<Document> {
  const row = await db.document.findFirst({
    where: { id: documentId, projectId },
  });
  if (!row) throw new CoreError("NOT_FOUND");
  return row;
}

export async function writeDocumentInRepo(
  db: PrismaClient,
  repo: ProjectRepoWriter,
  projectId: string,
  request: WriteRequest,
  actor: ContentWriteActor,
  metadata: WriteMetadata,
): Promise<DocumentResult> {
  if (request.title !== undefined) assertDocumentTitle(request.title);
  if (
    !DOCUMENT_KINDS[request.content.kind].supportsImages &&
    ((request.assets?.length ?? 0) > 0 ||
      (request.kind === "create" && request.assetsFromSlug !== undefined))
  )
    throw new CoreError("BAD_REQUEST", "This file kind does not hold images");
  const prepared0 = await prepareContent(
    db,
    projectId,
    request.content,
    !skipsLabelEnrichment(actor),
  );
  const { excerpt } = prepared0;
  let prepared: PreparedWrite;
  if (request.kind === "create") {
    try {
      assertSafeSegments(request.folderPath);
      assertOutsideTablesRoot(request.folderPath);
    } catch {
      throw new CoreError("BAD_REQUEST", "invalid folder path");
    }
    if (
      request.folderPath.length > 0 &&
      !(await repo.fileExistsInWorktree(request.folderPath.join("/")))
    ) {
      throw folderNotFound("folderPath");
    }
    const { slug, path } = await nextAvailableSlug(
      db,
      repo,
      projectId,
      request.title,
      request.folderPath,
      request.content.kind,
    );
    // Same rule as a rename below: content that carries another slug's asset
    // prefix is rewritten onto the slug actually allocated here.
    let saved: PreparedContent = prepared0;
    if (
      request.content.kind === "markdown" &&
      request.assetsFromSlug !== undefined &&
      request.assetsFromSlug !== slug
    ) {
      saved = await prepareContent(db, projectId, {
        kind: "markdown",
        contentJson: rewriteOwnAssetsPrefix(
          request.content.contentJson,
          request.assetsFromSlug,
          slug,
        ),
      });
    }
    if (saved.json) assertImageSourcesContained(saved.json, path);
    const override = request.metadata ?? {};
    const self = documentAuthorForContent(actor);
    const properties =
      request.propertiesInput === undefined
        ? request.properties
        : applyPagePropertiesInput(request.properties, request.propertiesInput);
    const defaults =
      request.review ??
      (properties?.reviewExempt
        ? null
        : await defaultReviewForFolderInRepo(db, repo, {
            projectId,
            path: request.folderPath,
            now: request.createdAt,
          }));
    const review =
      request.reviewSource && defaults
        ? await resolveImportedReview(
            db,
            projectId,
            request.reviewSource.imported,
            request.createdAt,
            defaults,
          )
        : defaults;
    const meta: DocumentMeta = {
      id: request.id,
      title: request.title,
      created: override.created ?? request.createdAt,
      createdBy: override.createdBy ?? self,
      updated: override.updated ?? request.createdAt,
      updatedBy: override.updatedBy ?? self,
      ...(request.appearance ? { appearance: request.appearance } : {}),
      ...(properties ? { properties } : {}),
      review,
    };
    assertUpdatedNotBeforeCreated(meta);
    prepared = {
      id: request.id,
      projectId,
      path,
      slug,
      title: request.title,
      excerpt,
      actorId: contentUserId(actor),
      actorMachine: machineIdentity(actor),
      actorName: documentAuthorForContent(actor).name,
      meta,
      targets: saved.targets,
      create: true,
      ...(request.wikiSourceItemId && {
        wikiSourceItemId: request.wikiSourceItemId,
      }),
      oldPath: null,
      body: saved.body,
      assets: request.assets ?? [],
      overridden: overriddenFields(override),
    };
  } else {
    const row = await requireDocument(db, projectId, request.documentId);
    if (row.kind !== request.content.kind)
      throw new CoreError(
        "BAD_REQUEST",
        `this is a ${DOCUMENT_KINDS[row.kind].label}; send ${row.kind} content`,
        { field: "content" },
      );
    const lastSha = await repo.lastCommitForPath(row.path);
    if (!lastSha) throw new CoreError("NOT_FOUND");
    if (lastSha !== request.baseCommitSha) {
      const snapshotSha = await repo.resolveHead();
      const basePath = await pathAtCommit(
        repo,
        row.path,
        request.baseCommitSha,
        snapshotSha,
      );
      const blobNow = await repo.blobShaAt(lastSha, row.path);
      const blobBase = basePath
        ? await repo.blobShaAt(request.baseCommitSha, basePath)
        : null;
      if (!blobBase || blobNow !== blobBase) {
        throw new CoreError("CONFLICT", "Document changed since you loaded it");
      }
    }

    const oldPath = row.path;
    const oldFile = parseDocumentFile(
      await repo.readFileFromWorktree(oldPath),
      documentKindOfPath(oldPath),
    );
    const title = request.title ?? oldFile.meta.title;
    assertDocumentTitle(title);
    let path = oldPath;
    let slug = row.slug;
    if (
      title !== oldFile.meta.title &&
      slugify(title) !== slugify(oldFile.meta.title)
    ) {
      const next = await nextAvailableSlug(
        db,
        repo,
        projectId,
        title,
        oldPath.split("/").slice(0, -1),
        row.kind,
        row.id,
      );
      path = next.path;
      slug = next.slug;
    }
    let saved: PreparedContent = prepared0;
    if (slug !== row.slug && request.content.kind === "markdown") {
      saved = await prepareContent(db, projectId, {
        kind: "markdown",
        contentJson: rewriteOwnAssetsPrefix(
          request.content.contentJson,
          row.slug,
          slug,
        ),
      });
    }
    if (saved.json) assertImageSourcesContained(saved.json, path);
    const override = request.metadata ?? {};
    const properties =
      request.propertiesInput === undefined
        ? oldFile.meta.properties
        : applyPagePropertiesInput(
            oldFile.meta.properties,
            request.propertiesInput,
          );
    const meta: DocumentMeta = {
      id: row.id,
      title,
      created: override.created ?? oldFile.meta.created,
      createdBy: override.createdBy ?? oldFile.meta.createdBy,
      updated: override.updated ?? new Date().toISOString(),
      updatedBy: override.updatedBy ?? documentAuthorForContent(actor),
      review: oldFile.meta.review,
      ...(oldFile.meta.appearance
        ? { appearance: oldFile.meta.appearance }
        : {}),
      ...(properties ? { properties } : {}),
    };
    assertUpdatedNotBeforeCreated(meta);
    prepared = {
      id: row.id,
      projectId,
      path,
      slug,
      title,
      excerpt,
      actorId: contentUserId(actor),
      actorMachine: machineIdentity(actor),
      actorName: documentAuthorForContent(actor).name,
      meta,
      targets: saved.targets,
      create: false,
      oldPath,
      body: saved.body,
      assets: request.assets ?? [],
      overridden: overriddenFields(override),
    };
  }
  const writeMetadata =
    request.kind === "update" &&
    !metadata.message &&
    metadata.operation === "update"
      ? {
          ...metadata,
          message: (path: string, oldPath: string | null) =>
            `${defaultCommitMessage(metadata, path, oldPath)}${request.changeSummary.trim() ? ` — ${request.changeSummary.replace(/[\r\n\u2028\u2029\u0000]+/g, " ").trim()}` : ""}`,
        }
      : metadata;
  return commitPreparedWrite(db, repo, prepared, actor, writeMetadata);
}

function overriddenFields(
  override: DocumentMetadataOverride,
): (keyof DocumentMetadataOverride)[] {
  return (["created", "createdBy", "updated", "updatedBy"] as const).filter(
    (field) => override[field] !== undefined,
  );
}

async function writeDocument(
  db: PrismaClient,
  projectId: string,
  request: WriteRequest,
  actor: EnrichedActor,
  metadata: WriteMetadata,
): Promise<DocumentResult> {
  const result = await withProjectRepo(projectId, (repo) =>
    writeDocumentInRepo(db, repo, projectId, request, actor, metadata),
  );
  void notifyProjectContentChanged(db, projectId);
  return result;
}

export async function createDocument(
  db: PrismaClient,
  input: {
    projectId: string;
    folderPath: string[];
    title: string;
    content: DocumentContentInput;
    assets?: DocumentAssetFile[];
    assetsFromSlug?: string;
    review?: DocumentReview;
    reviewSource?: { kind: "import"; imported: DocumentReview | null };
    appearance?: Appearance;
    properties?: WikiPagePropertiesInput;
    iconAssets?: AppearanceAsset[];
    allowMissingIcon?: boolean;
  },
  actor: EnrichedActor,
  provenance?: DocumentProvenance,
): Promise<DocumentResult> {
  await assertProjectRole(db, input.projectId, actor, "Editor");
  const result = await withProjectRepo(input.projectId, async (repo) => {
    await assertProjectRole(db, input.projectId, actor, "Editor");
    return withAppearanceAssetsInRepo(
      repo,
      input.appearance ? [input.appearance] : [],
      input.iconAssets ?? [],
      (writer) =>
        writeDocumentInRepo(
          db,
          writer,
          input.projectId,
          {
            kind: "create",
            id: randomUUID(),
            folderPath: input.folderPath,
            title: input.title,
            content: input.content,
            createdAt: new Date().toISOString(),
            ...(input.assets && { assets: input.assets }),
            ...(input.assetsFromSlug && {
              assetsFromSlug: input.assetsFromSlug,
            }),
            ...(input.review && { review: input.review }),
            ...(input.reviewSource && { reviewSource: input.reviewSource }),
            ...(input.appearance && { appearance: input.appearance }),
            ...(input.properties && { propertiesInput: input.properties }),
          },
          actor,
          { operation: "create", ...provenance },
        ),
      input.allowMissingIcon,
    );
  });
  void notifyProjectContentChanged(db, input.projectId);
  return result;
}

export async function getDocument(
  db: PrismaClient,
  input: { projectId: string; documentId: string },
  actor: ProjectActor,
) {
  await assertProjectRole(db, input.projectId, actor, "Viewer");
  let row = await requireDocument(db, input.projectId, input.documentId);
  const repo = await openProjectRepo(input.projectId);
  if (!repo) throw new CoreError("NOT_FOUND");
  let snapshotSha = await repo.resolveHead();
  let snapshotPath = row.path;
  let snapshot = await repo.readCommittedFileAt(snapshotSha, snapshotPath);
  if (!snapshot) {
    const renamedPath = await repo.renamedPathBetween(
      row.headCommitSha,
      snapshotSha,
      row.path,
    );
    if (renamedPath) {
      snapshotPath = renamedPath;
      snapshot = await repo.readCommittedFileAt(snapshotSha, snapshotPath);
    }
  }
  if (!snapshot) {
    const current = await requireDocument(
      db,
      input.projectId,
      input.documentId,
    );
    if (current.path !== row.path) {
      row = current;
      snapshotSha = await repo.resolveHead();
      snapshotPath = row.path;
      snapshot = await repo.readCommittedFileAt(snapshotSha, snapshotPath);
    }
  }
  if (!snapshot) throw new CoreError("NOT_FOUND");
  const { content, baseCommitSha } = snapshot;
  let parsed: ReturnType<typeof parseDocumentFile>;
  try {
    parsed = parseDocumentFile(content, documentKindOfPath(snapshotPath));
  } catch {
    throw new CoreError("PRECONDITION_FAILED", "document content is malformed");
  }
  const { meta, body } = parsed;
  const kind = documentKindOfPath(snapshotPath);
  if (meta.id !== row.id) throw new CoreError("NOT_FOUND");
  const snapshotSlug = documentSlugFromPath(snapshotPath);
  if (
    baseCommitSha !== row.headCommitSha ||
    snapshotPath !== row.path ||
    snapshotSlug !== row.slug
  ) {
    try {
      await db.document.updateMany({
        where: {
          id: row.id,
          projectId: input.projectId,
          path: row.path,
          headCommitSha: row.headCommitSha,
        },
        data: {
          path: snapshotPath,
          slug: snapshotSlug,
          headCommitSha: baseCommitSha,
        },
      });
    } catch (error) {
      const reference = captureError({
        event: "content.projection.failed",
        message: "document read projection repair failed",
        error,
        projectId: input.projectId,
        documentId: row.id,
        details: { kind: "document", repair: true },
      });
      console.error(
        `Document read projection repair failed (ref ${reference ?? "none"})`,
        { projectId: input.projectId, documentId: row.id },
      );
    }
  }
  const lastEditedBy = row.lastEditedById
    ? await db.user.findUnique({
        where: { id: row.lastEditedById },
        select: { id: true, name: true, email: true },
      })
    : null;
  const documentContent: DocumentContentInput =
    kind === "markdown"
      ? { kind, contentJson: cachedParse(`${row.id}:${baseCommitSha}`, body) }
      : { kind, text: body };
  return {
    id: row.id,
    path: snapshotPath,
    slug: snapshotSlug,
    title: meta.title,
    kind,
    content: documentContent,
    baseCommitSha,
    lastEditedAt: row.lastEditedAt,
    lastEditedById: row.lastEditedById,
    lastEditedBy,
    machineEditor: machineEditorFromRow(row),
    ...(await presentDocumentMetadata(db, meta)),
    appearance: normalizeAppearance(meta.appearance),
    properties: await presentWikiProperties(
      db,
      input.projectId,
      meta.properties,
    ),
    review: await presentDocumentReview(db, input.projectId, meta.review),
  };
}

/**
 * Read-only pinned read (concept §4.1). Unlike getDocument it repairs no
 * projection and never substitutes current content for an unavailable snapshot.
 */
export async function getDocumentAtSnapshot(
  db: PrismaClient,
  input: { projectId: string; documentId: string; atCommitSha?: string },
  actor: SecurityContext,
): Promise<{
  id: string;
  path: string;
  title: string;
  kind: DocumentKind;
  markdown: string;
  appearance: Appearance | null;
  properties: WikiPageProperties | null;
  snapshotCommitSha: string;
  baseCommitSha: string;
  metadata: DocumentMetadataView;
  review: DocumentReviewView | null;
}> {
  await assertProjectRole(db, input.projectId, actor, "Viewer");
  const row = await requireDocument(db, input.projectId, input.documentId);
  const repo = await openProjectRepo(input.projectId);
  if (!repo) throw new CoreError("NOT_FOUND");
  const snapshotCommitSha = await resolveSnapshotCommit(
    repo,
    input.atCommitSha,
  );
  // Lazy: only pay for the rename diff when the direct path misses.
  const readCandidate = async (path: string) => {
    const file = await repo.readCommittedFileAt(snapshotCommitSha, path);
    if (!file) return null;
    const kind = documentKindOfPath(path);
    let parsed: ReturnType<typeof parseDocumentFile>;
    try {
      parsed = parseDocumentFile(file.content, kind);
    } catch {
      throw new CoreError(
        "PRECONDITION_FAILED",
        "document content is malformed",
      );
    }
    if (parsed.meta.id !== row.id) return null;
    return {
      id: row.id,
      path,
      title: parsed.meta.title,
      kind,
      markdown:
        kind === "markdown"
          ? serializeDocumentBody(
              cachedParse(`${row.id}:${file.baseCommitSha}`, parsed.body),
            )
          : parsed.body,
      appearance: normalizeAppearance(parsed.meta.appearance),
      properties: parsed.meta.properties ?? null,
      snapshotCommitSha,
      baseCommitSha: file.baseCommitSha,
      metadata: await presentDocumentMetadata(db, parsed.meta),
      review: await presentDocumentReview(
        db,
        input.projectId,
        parsed.meta.review,
      ),
    };
  };
  const direct = await readCandidate(row.path);
  if (direct) return direct;
  const renamed = await repo.renamedPathBetween(
    row.headCommitSha,
    snapshotCommitSha,
    row.path,
  );
  if (renamed && renamed !== row.path) {
    const viaRename = await readCandidate(renamed);
    if (viaRename) return viaRename;
  }
  throw new CoreError("NOT_FOUND");
}

export async function saveDocument(
  db: PrismaClient,
  input: {
    projectId: string;
    documentId: string;
    baseCommitSha: string;
    title?: string;
    content: DocumentContentInput;
    changeSummary: string;
    properties?: WikiPagePropertiesInput;
  },
  actor: EnrichedActor,
  provenance?: DocumentProvenance,
): Promise<DocumentResult> {
  await assertProjectRole(db, input.projectId, actor, "Editor");
  const summary = input.changeSummary.trim();
  return writeDocument(
    db,
    input.projectId,
    {
      kind: "update",
      documentId: input.documentId,
      baseCommitSha: input.baseCommitSha,
      title: input.title,
      content: input.content,
      changeSummary: summary,
      ...(input.properties && { propertiesInput: input.properties }),
    },
    actor,
    {
      operation: "update",
      ...provenance,
      message: (path, oldPath) => {
        const moved = oldPath && oldPath !== path ? ` (was ${oldPath})` : "";
        return `update: ${path}${moved}${summary ? ` — ${summary}` : ""}`;
      },
    },
  );
}

export async function getHistory(
  db: Db,
  input: {
    projectId: string;
    documentId: string;
    offset: number;
    limit: number;
  },
  actor: ProjectActor,
) {
  await assertProjectRole(db, input.projectId, actor, "Viewer");
  if (
    !Number.isInteger(input.offset) ||
    input.offset < 0 ||
    input.offset > 1000 ||
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100
  )
    throw new CoreError("BAD_REQUEST", "invalid document history pagination");
  const row = await requireDocument(db, input.projectId, input.documentId);
  const repo = await openProjectRepo(input.projectId);
  if (!repo) throw new CoreError("NOT_FOUND");
  const snapshotSha = await repo.resolveHead();
  const raw = await repo.logForPath(row.path, {
    skip: input.offset,
    limit: input.limit + 1,
    commitish: snapshotSha,
  });
  const entries = raw.slice(0, input.limit);
  const attribution = await resolveAttribution(db, entries);
  const summaries = await loadChangeSummaries(
    db,
    input.projectId,
    entries.map((entry) => entry.sha),
  );
  return {
    hasMore: raw.length > input.limit,
    entries: entries.map((entry, index) => {
      const resolved = attribution[index];
      return {
        sha: entry.sha,
        authorName: entry.authorName,
        userId: resolved?.id ?? null,
        userName: resolved ? (resolved.name ?? resolved.email) : null,
        projectKeyId:
          resolved?.kind === "machine" &&
          resolved.machineKind === "projectApiKey"
            ? resolved.machineId
            : null,
        machineEditor: machineEditorOf(resolved),
        date: entry.date,
        message: entry.message,
        changeSummary: summaries.get(entry.sha) ?? null,
      };
    }),
  };
}

// The caller must hold this project's repository lock and have authorized the content operation.
/** A tracked path that holds a document: a registered document kind outside the
 *  tables root and outside any `*.assets` directory. */
export function isDocumentFilePath(file: string): boolean {
  return (
    documentKindFromPath(file) !== null &&
    !file.startsWith("tables/") &&
    !file.startsWith(".weaver-icons/") &&
    !hasAssetsSegment(file)
  );
}

/** Projects a validated committed file without rescanning the repository. */
export async function projectPreparedDocumentInRepo(
  db: PrismaClient,
  repo: ProjectRepoReader,
  input: {
    projectId: string;
    path: string;
    meta: DocumentMeta;
    body: string;
    sha: string;
    actorId: string | null;
    actorMachine?: MachineEditorRef | null;
    actorName?: string | null;
  },
): Promise<void> {
  const existing = await db.document.findUnique({
    where: { id: input.meta.id },
  });
  if (existing && existing.projectId !== input.projectId)
    throw new CoreError(
      "CONFLICT",
      "Document identity belongs to another project",
    );
  const { excerpt, targets } = projectionContent(
    documentKindOfPath(input.path),
    input.body,
  );
  await persistDocumentProjection(db, repo, {
    id: input.meta.id,
    projectId: input.projectId,
    path: input.path,
    slug: documentSlugFromPath(input.path),
    title: input.meta.title,
    excerpt,
    sha: input.sha,
    actorId: input.actorId,
    actorMachine: input.actorMachine,
    actorName: input.actorName,
    meta: input.meta,
    targets,
    create: !existing,
  });
  await enqueueDocumentChanged({
    projectId: input.projectId,
    documentId: input.meta.id,
    sourceCommitSha: input.sha,
    pathAtSha: input.path,
  });
}

export async function repairDocumentProjectionInRepo(
  db: PrismaClient,
  repo: ProjectRepoReader,
  projectId: string,
  documentId: string,
  hintPath?: string,
): Promise<Document | null> {
  const existing = await db.document.findUnique({ where: { id: documentId } });
  if (existing && existing.projectId !== projectId) return null;
  const snapshotSha = await repo.resolveHead();
  const preferredPath = hintPath ?? existing?.path;
  const files = (await repo.listTrackedFiles(snapshotSha))
    .filter(isDocumentFilePath)
    .sort((a, b) =>
      a === preferredPath ? -1 : b === preferredPath ? 1 : a.localeCompare(b),
    );
  for (const path of files) {
    let candidate: { slug: string; meta: DocumentMeta; body: string };
    try {
      candidate = await readDocumentProjectionCandidate(
        repo,
        snapshotSha,
        path,
      );
      if (candidate.meta.id !== documentId) continue;
    } catch {
      continue;
    }
    const [head] = await repo.logForPath(path, {
      skip: 0,
      limit: 1,
      commitish: snapshotSha,
    });
    if (!head) continue;
    const [attribution] = await resolveAttribution(db, [head]);
    await projectPreparedDocumentInRepo(db, repo, {
      projectId,
      path,
      meta: candidate.meta,
      body: candidate.body,
      sha: head.sha,
      actorId: attribution?.id ?? null,
      actorMachine: machineRefOf(attribution),
      actorName: head.authorName,
    });
    return db.document.findFirst({ where: { id: documentId, projectId } });
  }
  return null;
}

export async function rebuildIndex(
  db: PrismaClient,
  input: { projectId: string },
  actor: ProjectActor,
): Promise<{
  indexed: number;
  skipped: Array<{ path: string; reason: string }>;
}> {
  await assertProjectRole(db, input.projectId, actor, "Maintainer");
  let flips: string[] = [];
  const report = await withExistingProjectRepoReader(
    input.projectId,
    async (repo) => {
      const snapshotSha = await repo.resolveHead();
      const files = (await repo.listTrackedFiles(snapshotSha))
        .filter(isDocumentFilePath)
        .sort();
      const skipped: Array<{ path: string; reason: string }> = [];
      const candidates: Array<{
        id: string;
        path: string;
        slug: string;
        title: string;
        excerpt: string;
        head: GitLogEntry;
        meta: DocumentMeta;
        targets: CrossrefTarget[];
      }> = [];
      for (const file of files) {
        try {
          const { slug, meta, body } = await readDocumentProjectionCandidate(
            repo,
            snapshotSha,
            file,
          );
          const { excerpt, targets } = projectionContent(
            documentKindOfPath(file),
            body,
          );
          const [head] = await repo.logForPath(file, {
            skip: 0,
            limit: 1,
            commitish: snapshotSha,
          });
          if (!head) {
            skipped.push({ path: file, reason: "no commit found" });
            continue;
          }
          candidates.push({
            id: meta.id,
            path: file,
            slug,
            title: meta.title,
            excerpt,
            head,
            meta,
            targets,
          });
        } catch (error) {
          skipped.push({
            path: file,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const existing =
        candidates.length > 0
          ? await db.document.findMany({
              where: {
                id: { in: candidates.map((candidate) => candidate.id) },
              },
              select: { id: true, projectId: true },
            })
          : [];
      const ownerById = new Map(existing.map((row) => [row.id, row.projectId]));
      const seenIds = new Set<string>();
      const seenPaths = new Set<string>();
      const seenSlugs = new Set<string>();
      const rows = candidates.filter((candidate) => {
        if (seenIds.has(candidate.id)) {
          skipped.push({
            path: candidate.path,
            reason: `duplicate id ${candidate.id} (first file by path order wins)`,
          });
          return false;
        }
        seenIds.add(candidate.id);
        const ownerProjectId = ownerById.get(candidate.id);
        if (ownerProjectId && ownerProjectId !== input.projectId) {
          skipped.push({
            path: candidate.path,
            reason: `id ${candidate.id} belongs to another project`,
          });
          return false;
        }
        if (seenPaths.has(candidate.path)) {
          skipped.push({
            path: candidate.path,
            reason: `duplicate path ${candidate.path} (first file by path order wins)`,
          });
          return false;
        }
        if (seenSlugs.has(candidate.slug)) {
          skipped.push({
            path: candidate.path,
            reason: `duplicate slug ${candidate.slug} (first file by path order wins)`,
          });
          return false;
        }
        seenPaths.add(candidate.path);
        seenSlugs.add(candidate.slug);
        return true;
      });
      const attribution = await resolveAttribution(
        db,
        rows.map((row) => row.head),
      );
      const metadata = await documentMetadataColumns(
        db,
        rows.map((row) => row.meta),
      );
      const sourceItems = await wikiSourceItemIds(
        db,
        input.projectId,
        rows.map((row) => row.id),
      );
      const linkBefore = new Map(
        (
          await db.document.findMany({
            where: { id: { in: rows.map((row) => row.id) } },
            select: { id: true, wikiSourceItemId: true },
          })
        ).map((row) => [row.id, row.wikiSourceItemId]),
      );
      flips = rows
        .filter(
          (row) =>
            linkBefore.has(row.id) &&
            (linkBefore.get(row.id) ?? null) !==
              (sourceItems.get(row.id) ?? null),
        )
        .map((row) => row.id);

      await db.$transaction(async (tx) => {
        await tx.document.deleteMany({
          where: {
            projectId: input.projectId,
            id: { notIn: rows.map((row) => row.id) },
          },
        });
        const current = await tx.document.findMany({
          where: { projectId: input.projectId },
          select: { id: true, path: true, slug: true },
        });
        const currentById = new Map(current.map((row) => [row.id, row]));
        const temporaryPrefix = `.weaver-rebuild-${randomUUID()}`;
        for (const row of rows) {
          const previous = currentById.get(row.id);
          if (
            previous &&
            (previous.path !== row.path || previous.slug !== row.slug)
          ) {
            await tx.document.update({
              where: { id: row.id, projectId: input.projectId },
              data: {
                path: `${temporaryPrefix}/${row.id}`,
                slug: `${temporaryPrefix}-${row.id}`,
              },
            });
          }
        }
        for (const [index, row] of rows.entries()) {
          const data = {
            id: row.id,
            projectId: input.projectId,
            path: row.path,
            kind: documentKindOfPath(row.path),
            slug: row.slug,
            title: row.title,
            excerpt: row.excerpt,
            headCommitSha: row.head.sha,
            lastEditedById: attribution[index]?.id ?? null,
            ...machineEditorColumns(machineRefOf(attribution[index])),
            lastEditedByName: row.head.authorName,
            lastEditedAt: row.head.date,
            wikiSourceItemId: sourceItems.get(row.id) ?? null,
            ...metadata[index]!,
          };
          await tx.document.upsert({
            where: { id: row.id, projectId: input.projectId },
            create: data,
            update: data,
          });
        }
        await tx.documentIndexState.updateMany({
          where: {
            projectId: input.projectId,
            documentId: {
              in: rows
                .filter((row) => !currentById.has(row.id))
                .map((row) => row.id),
            },
          },
          data: {
            keywordIndexedSha: null,
            status: "pending",
            completedAt: null,
          },
        });
        for (const row of rows) await syncLinks(tx, row.id, row.targets);
        await syncDocumentsReviewers(
          tx,
          input.projectId,
          rows.map((row) => ({ documentId: row.id, review: row.meta.review })),
        );
      });
      return { indexed: rows.length, skipped };
    },
  );
  const result = report ?? {
    indexed: 0,
    skipped: [{ path: "", reason: "project repository not found" }],
  };
  for (const documentId of flips)
    await flipDocumentAiExempt(createKnowledgeSystemContextForRuntime(), db, {
      projectId: input.projectId,
      documentId,
    });
  await enqueueProjectReconcile(input.projectId);
  return result;
}

/** The stored file at `sha`, following renames back from `currentPath`; public
 * for callers outside this module that hold a repo reader (assistant citations),
 * whose anchors need that revision's own frontmatter title alongside the body. */
export async function documentFileAt(
  repo: ProjectRepoReader,
  currentPath: string,
  sha: string,
  snapshotSha: string,
  expectedDocumentId?: string,
): Promise<{ meta: DocumentMeta; body: string }> {
  const path = await pathAtCommit(repo, currentPath, sha, snapshotSha);
  if (!path) {
    throw new CoreError("NOT_FOUND", "version not found");
  }
  const [historic, current] = await Promise.all([
    repo.showFileAt(sha, path),
    repo.showFileAt(snapshotSha, currentPath),
  ]);
  const parsed = parseDocumentFile(historic, documentKindOfPath(path));
  if (
    (expectedDocumentId !== undefined &&
      parsed.meta.id !== expectedDocumentId) ||
    parsed.meta.id !==
      parseDocumentFile(current, documentKindOfPath(currentPath)).meta.id
  )
    throw new CoreError("NOT_FOUND", "version not found");
  return parsed;
}

async function bodyAt(
  repo: ProjectRepoReader,
  currentPath: string,
  sha: string,
  snapshotSha: string,
  expectedDocumentId?: string,
): Promise<string> {
  return (
    await documentFileAt(
      repo,
      currentPath,
      sha,
      snapshotSha,
      expectedDocumentId,
    )
  ).body;
}

async function boundedLineDiff(
  from: string,
  to: string,
): Promise<Change[] | undefined> {
  return new Promise((resolve) => {
    diffLines(from, to, {
      maxEditLength: MAX_DIFF_EDIT_LENGTH,
      timeout: MAX_DIFF_MS,
      callback: resolve,
    });
  });
}

export async function getDiff(
  db: Db,
  input: {
    projectId: string;
    documentId: string;
    fromSha: string;
    toSha: string;
  },
  actor: ProjectActor,
) {
  await assertProjectRole(db, input.projectId, actor, "Viewer");
  const row = await requireDocument(db, input.projectId, input.documentId);
  const repo = await openProjectRepo(input.projectId);
  if (!repo) throw new CoreError("NOT_FOUND");
  const snapshotSha = await repo.resolveHead();
  const from = await bodyAt(repo, row.path, input.fromSha, snapshotSha, row.id);
  const to = await bodyAt(repo, row.path, input.toSha, snapshotSha, row.id);
  if (from.length > MAX_DIFF_CHARS || to.length > MAX_DIFF_CHARS) {
    return { tooLarge: true as const };
  }
  const parts = await boundedLineDiff(from, to);
  if (!parts) return { tooLarge: true as const };
  return {
    lines: parts.flatMap((part) => {
      const type = part.added
        ? ("add" as const)
        : part.removed
          ? ("del" as const)
          : ("same" as const);
      return part.value
        .split("\n")
        .filter(
          (_, index, lines) =>
            index < lines.length - 1 || lines[index]!.length > 0,
        )
        .map((text) => ({ type, text }));
    }),
  };
}

export async function restoreDocumentInRepo(
  db: PrismaClient,
  repo: ProjectRepoWriter,
  input: {
    projectId: string;
    documentId: string;
    sha: string;
    expectedHeadCommitSha: string;
  },
  actor: EnrichedActor,
  audit: DocumentWriteAudit = {},
): Promise<DocumentResult> {
  const row = await requireDocument(db, input.projectId, input.documentId);
  const currentSha = await repo.lastCommitForPath(row.path);
  if (!currentSha) throw new CoreError("NOT_FOUND");
  if (input.expectedHeadCommitSha !== currentSha)
    throw new CoreError(
      "CONFLICT",
      "The document changed. Reload before restoring.",
      { headCommitSha: currentSha },
    );
  const snapshotSha = await repo.resolveHead();
  const restoredPath = await pathAtCommit(
    repo,
    row.path,
    input.sha,
    snapshotSha,
  );
  if (!restoredPath) {
    throw new CoreError("NOT_FOUND", "version not found");
  }
  const kind = documentKindOfPath(restoredPath);
  const restored = parseDocumentFile(
    await repo.showFileAt(input.sha, restoredPath),
    kind,
  );
  if (restored.meta.id !== row.id)
    throw new CoreError("NOT_FOUND", "version not found");
  const assets: DocumentAssetFile[] = [];
  if (kind === "markdown") {
    const prefix = `${assetsDirForDocPath(restoredPath)}/`;
    const paths = new Set(
      collectImageSources(parseDocumentBody(restored.body))
        .map((src) => resolveRelativeImagePath(restoredPath, src))
        .filter((path): path is string => path?.startsWith(prefix) === true),
    );
    if (paths.size > MAX_IMPORTED_IMAGES)
      throw new CoreError("BAD_REQUEST", "Too many historical images");
    const maxBytes = parseServerEnv(
      process.env,
    ).WEAVER_DOCUMENT_IMAGE_MAX_BYTES;
    let totalBytes = 0;
    for (const path of paths) {
      const size = await repo.blobSizeAt(input.sha, path);
      if (size === null) continue;
      totalBytes += size;
      if (size > maxBytes || totalBytes > MAX_IMPORT_IMAGE_BYTES)
        throw new CoreError(
          "BAD_REQUEST",
          "Historical images exceed the image size limit",
        );
      const blob = await repo.readCommittedBlobAt(input.sha, path, maxBytes);
      if (!blob || !sniffImageType(blob.bytes.subarray(0, 16)))
        throw new CoreError("BAD_REQUEST", "Invalid historical image");
      assets.push({ name: path.slice(prefix.length), bytes: blob.bytes });
    }
  }
  return writeDocumentInRepo(
    db,
    repo,
    input.projectId,
    {
      kind: "update",
      documentId: row.id,
      baseCommitSha: currentSha,
      assets,
      title: restored.meta.title,
      content:
        kind === "markdown"
          ? {
              kind,
              contentJson: rewriteOwnAssetsPrefix(
                parseDocumentBody(restored.body),
                documentSlugFromPath(restoredPath),
                row.slug,
              ),
            }
          : { kind, text: restored.body },
      changeSummary: "",
    },
    actor,
    { operation: "restore", sourceCommitSha: input.sha, ...audit },
  );
}

export async function restoreDocument(
  db: PrismaClient,
  input: {
    projectId: string;
    documentId: string;
    sha: string;
    expectedHeadCommitSha: string;
  },
  actor: EnrichedActor,
): Promise<DocumentResult> {
  await assertProjectRole(db, input.projectId, actor, "Editor");
  const result = await withProjectRepo(input.projectId, (repo) =>
    restoreDocumentInRepo(db, repo, input, actor),
  );
  void notifyProjectContentChanged(db, input.projectId);
  return result;
}

export async function moveDocumentInRepo(
  db: PrismaClient,
  repo: ProjectRepoWriter,
  input: { projectId: string; documentId: string; folderPath: string[] },
  actor: EnrichedActor,
  audit: DocumentWriteAudit = {},
): Promise<DocumentResult> {
  const row = await requireDocument(db, input.projectId, input.documentId);
  const kind = documentKindOfPath(row.path);
  try {
    assertSafeSegments(input.folderPath);
    assertOutsideTablesRoot(input.folderPath);
  } catch {
    throw new CoreError("BAD_REQUEST", "invalid folder path");
  }
  if (
    input.folderPath.length > 0 &&
    !(await repo.fileExistsInWorktree(input.folderPath.join("/")))
  ) {
    throw folderNotFound("folderPath");
  }
  const targetPath = docPath(input.folderPath, row.slug, kind);
  if (targetPath === row.path) {
    if (!(await repo.fileExistsInWorktree(row.path))) {
      throw new CoreError("NOT_FOUND");
    }
    const headCommitSha = await repo.lastCommitForPath(row.path);
    if (!headCommitSha) throw new CoreError("NOT_FOUND");
    const { meta } = parseDocumentFile(
      await repo.readFileFromWorktree(row.path),
      kind,
    );
    return {
      id: row.id,
      path: row.path,
      slug: row.slug,
      title: meta.title,
      headCommitSha,
    };
  }
  // A stray `<slug>.assets` would nest the moved directory or be adopted.
  const collides =
    (await repo.fileExistsInWorktree(targetPath)) ||
    (await repo.fileExistsInWorktree(assetsDirForDocPath(targetPath)));
  const next = collides
    ? await nextAvailableSlug(
        db,
        repo,
        input.projectId,
        row.title,
        input.folderPath,
        kind,
        row.id,
      )
    : { path: targetPath, slug: row.slug };
  const reslugged =
    next.slug !== row.slug && kind === "markdown"
      ? parseDocumentFile(await repo.readFileFromWorktree(row.path), kind)
      : null;
  await repo.mv(row.path, next.path);
  await moveAssetsDir(repo, row.path, next.path);
  if (reslugged) {
    const rewritten = rewriteOwnAssetsPrefix(
      parseDocumentBody(reslugged.body),
      row.slug,
      next.slug,
    );
    await repo.writeFileAtomic(
      next.path,
      composeDocumentFile(
        reslugged.meta,
        serializeDocumentBody(rewritten),
        kind,
      ),
    );
  }
  const sha = await repo.commitAll(
    `move: ${next.path} (was ${row.path})`,
    author(actor),
    audit,
  );
  await updateMovedProjection(db, repo, {
    projectId: input.projectId,
    documentId: row.id,
    path: next.path,
    slug: next.slug,
    sha,
    actorId: actor.userId,
  });
  await enqueueDocumentChanged({
    projectId: input.projectId,
    documentId: row.id,
    sourceCommitSha: sha,
    pathAtSha: next.path,
  });
  return {
    id: row.id,
    path: next.path,
    slug: next.slug,
    title: row.title,
    headCommitSha: sha,
  };
}

export async function moveDocument(
  db: PrismaClient,
  input: { projectId: string; documentId: string; folderPath: string[] },
  actor: EnrichedActor,
): Promise<DocumentResult> {
  await assertProjectRole(db, input.projectId, actor, "Editor");
  const result = await withProjectRepo(input.projectId, (repo) =>
    moveDocumentInRepo(db, repo, input, actor),
  );
  void notifyProjectContentChanged(db, input.projectId);
  return result;
}

export type DocumentDeleteResult = {
  id: string;
  path: string;
  headCommitSha: string;
};

export async function deleteDocumentInRepo(
  db: PrismaClient,
  repo: ProjectRepoWriter,
  input: { projectId: string; documentId: string },
  actor: ContentWriteActor,
  audit: DocumentWriteAudit = {},
): Promise<DocumentDeleteResult> {
  const row = await requireDocument(db, input.projectId, input.documentId);
  const assetsDir = assetsDirForDocPath(row.path);
  if (await repo.fileExistsInWorktree(assetsDir)) await repo.rmDir(assetsDir);
  await repo.rm(row.path);
  const sha = await repo.commitAll(`delete: ${row.path}`, author(actor), audit);
  await deleteDocumentProjection(db, {
    projectId: input.projectId,
    documentId: row.id,
    sha,
  });
  await enqueueContentDeleted({
    projectId: input.projectId,
    sourceType: "document",
    sourceId: row.id,
    sourceCommitSha: sha,
  });
  return { id: row.id, path: row.path, headCommitSha: sha };
}

export async function deleteDocument(
  db: PrismaClient,
  input: { projectId: string; documentId: string },
  actor: EnrichedActor,
): Promise<void> {
  await assertProjectRole(db, input.projectId, actor, "Editor");
  await withProjectRepo(input.projectId, (repo) =>
    deleteDocumentInRepo(db, repo, input, actor),
  );
  void notifyProjectContentChanged(db, input.projectId);
}

export async function resolveRefs(
  db: PrismaClient,
  input: { projectId: string; ids: string[] },
  actor: ProjectActor,
) {
  await assertProjectRole(db, input.projectId, actor, "Viewer");
  const [documentRows, tableRows] = await Promise.all([
    db.document.findMany({
      where: { projectId: input.projectId, id: { in: input.ids } },
      select: {
        id: true,
        title: true,
        path: true,
        excerpt: true,
        lastEditedAt: true,
      },
    }),
    db.dataTable.findMany({
      where: { projectId: input.projectId, id: { in: input.ids } },
      select: { id: true, title: true, path: true, lastEditedAt: true },
    }),
  ]);
  const byId = new Map(
    [
      ...documentRows.map((row) => ({
        ...row,
        targetType: "document" as const,
      })),
      ...tableRows.map((row) => ({
        ...row,
        excerpt: "",
        targetType: "table" as const,
      })),
    ].map((row) => [crossrefTargetKey(row.targetType, row.id), row]),
  );
  type ResolvedRow = NonNullable<ReturnType<typeof byId.get>> & {
    exists: true;
  };
  return input.ids.flatMap<ResolvedRow | { id: string; exists: false }>(
    (id) => {
      const rows = [
        byId.get(crossrefTargetKey("document", id)),
        byId.get(crossrefTargetKey("table", id)),
      ].filter((row) => row !== undefined);
      return rows.length
        ? rows.map((row) => ({ ...row, exists: true as const }))
        : [{ id, exists: false as const }];
    },
  );
}

export async function getBacklinks(
  db: PrismaClient,
  input: {
    projectId: string;
    documentId: string;
    cursor?: string;
    limit?: number;
  },
  actor: SecurityContext,
) {
  await assertProjectRole(db, input.projectId, actor, "Viewer");
  await requireDocument(db, input.projectId, input.documentId);
  const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
  const where = {
    projectId: input.projectId,
    linksTo: {
      some: {
        targetDocumentId: input.documentId,
        targetType: "document" as const,
      },
    },
  };
  const cursor = input.cursor
    ? await db.document.findFirst({
        where: { ...where, id: input.cursor },
        select: { id: true, title: true },
      })
    : null;
  if (input.cursor && !cursor)
    throw new CoreError(
      "BAD_REQUEST",
      "Backlink cursor is no longer available; reload the list",
    );
  const rows = await db.document.findMany({
    where: {
      ...where,
      ...(cursor
        ? {
            OR: [
              { title: { gt: cursor.title } },
              { title: cursor.title, id: { gt: cursor.id } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      title: true,
      path: true,
      excerpt: true,
      lastEditedAt: true,
    },
    orderBy: [{ title: "asc" }, { id: "asc" }],
    take: limit + 1,
  });
  const documents = rows.slice(0, limit);
  return {
    documents,
    nextCursor: rows.length > limit ? documents.at(-1)!.id : null,
  };
}

export async function listDocuments(
  db: PrismaClient,
  input: {
    projectId: string;
    page: number;
    pageSize: number;
    search?: string;
    folderPath?: string[];
    type?: string;
    tag?: string;
    includeSummary?: boolean;
    sort: "title" | "lastEditedAt" | "createdAt" | "updatedAt";
    dir: "asc" | "desc";
  },
  actor: SecurityContext,
) {
  await assertProjectRole(db, input.projectId, actor, "Viewer");
  const folderPrefix = input.folderPath?.length
    ? `${input.folderPath.join("/")}/`
    : undefined;
  const where: Prisma.DocumentWhereInput = {
    projectId: input.projectId,
    ...(folderPrefix ? { path: { startsWith: folderPrefix } } : {}),
    ...(input.search
      ? { title: { contains: input.search, mode: "insensitive" as const } }
      : {}),
    ...(input.type
      ? { wikiType: { equals: input.type, mode: "insensitive" as const } }
      : {}),
    ...(input.tag ? { wikiTags: { array_contains: [input.tag] } } : {}),
  };
  const total = await db.document.count({ where });
  const orderBy: Prisma.DocumentOrderByWithRelationInput[] = [
    { [input.sort]: input.dir },
    { id: "asc" },
  ];
  const items = await db.document.findMany({
    where,
    orderBy,
    ...(input.pageSize > 0
      ? { skip: (input.page - 1) * input.pageSize, take: input.pageSize }
      : {}),
    select: {
      id: true,
      title: true,
      slug: true,
      path: true,
      kind: true,
      excerpt: true,
      lastEditedAt: true,
      lastEditedBy: { select: { id: true, name: true, email: true } },
      lastEditedByMachineKind: true,
      lastEditedByMachineId: true,
      lastEditedByName: true,
      createdAt: true,
      createdById: true,
      createdByName: true,
      createdBy: { select: { name: true, email: true } },
      updatedAt: true,
      updatedById: true,
      updatedByName: true,
      updatedBy: { select: { name: true, email: true } },
      reviewDueAt: true,
      appearance: true,
      wikiType: true,
      wikiSummary: input.includeSummary === true,
    },
  });
  const pageSize = input.pageSize > 0 ? input.pageSize : total;
  return {
    items: items.map(
      ({
        createdById,
        createdByName,
        createdBy,
        updatedById,
        updatedByName,
        updatedBy,
        kind,
        lastEditedByMachineKind,
        lastEditedByMachineId,
        lastEditedByName,
        ...item
      }) => ({
        ...item,
        documentKind: kind,
        machineEditor: machineEditorFromRow({
          lastEditedByMachineKind,
          lastEditedByMachineId,
          lastEditedByName,
        }),
        appearance: normalizeAppearance(item.appearance),
        createdBy: presentAuthor(createdById, createdByName, createdBy),
        updatedBy: presentAuthor(updatedById, updatedByName, updatedBy),
      }),
    ),
    total,
    page: input.page,
    pageSize,
    pageCount: pageSize > 0 ? Math.ceil(total / pageSize) : 1,
  };
}

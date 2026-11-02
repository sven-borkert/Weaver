import { UUID_RE, DIGEST_RE } from "../ingestion/paths";
import { Buffer } from "node:buffer";
import { z } from "zod";
import { CoreError } from "@weaver/core/errors";
import { deleteBlob, promoteUpload } from "@weaver/core/ingestion/blobStore";
import {
  isBlobReferenced,
  retainedBytes,
} from "@weaver/core/ingestion/blobReferences";
import { MAX_INGESTION_UPLOAD_FILES } from "@weaver/core/ingestion/limits";
import {
  isAllowedMimeType,
  normalizeMimeType,
} from "@weaver/core/ingestion/mimeTypes";
import type {
  Capability,
  UserSecurityContext,
} from "@weaver/core/security/context";
import type {
  IngestionFailureKind,
  IngestionFileStatus,
  IngestionOrigin,
  PrismaClient,
} from "@weaver/db/client";
import { Prisma } from "@weaver/db/client";
import { MAX_MARKDOWN_CHARS } from "../documents/limits";
import { assertSafeSegments, PathError } from "../documents/paths";
import { documentTitleSchema } from "../documents/title";
import {
  DRAFT_COLUMN_TYPES,
  draftTableIssue,
  type DraftTableColumn,
} from "../ingestion/draftTable";
import { columnTypeIssue } from "../ingestion/columnTypes";
import {
  MAX_LINK_QUERIES,
  MAX_LINK_QUERY_CHARS,
  MAX_PROPOSED_LINKS,
  proposedLinksSchema,
  type ProposedLink,
} from "../ingestion/links";
import { DRAFT_TABLE_SAMPLE_ROWS } from "../ingestion/limits";
import type { KnowledgeJobName } from "../jobs/types";
import { assertProjectRole, notDeleted } from "./projectAccess";

type Db = PrismaClient | Prisma.TransactionClient;

export const BATCH_PAGE_MAX = 50;
const BATCH_PAGE_DEFAULT = 25;
export const BATCH_CURSOR_MAX_CHARS = 512;
const CONTROL_OR_PATH_RE = /[\u0000-\u001f\u007f/\\]/;
const ATTENTION_STATUSES = [
  "failed",
  "blocked_configuration",
] as const satisfies readonly IngestionFileStatus[];
const PROCESSING_STATUSES = [
  "parsing",
  "extracting",
  "linking",
  "accepting",
] as const satisfies readonly IngestionFileStatus[];
const ACTIVE_STATUSES = [
  "pending",
  ...PROCESSING_STATUSES,
] as const satisfies readonly IngestionFileStatus[];
const ACTIVE_STATUS_SET = new Set<IngestionFileStatus>(ACTIVE_STATUSES);
const RESOLVED_STATUSES = [
  "accepted",
  "rejected",
] as const satisfies readonly IngestionFileStatus[];

export type IngestionStage = "parse" | "analyze" | "link";

export const INGESTION_STAGE_JOBS = {
  parse: "ingestion.parse",
  analyze: "ingestion.analyze",
  link: "ingestion.link",
} as const satisfies Record<IngestionStage, KnowledgeJobName>;

/** The failed stage, including a queued stage ended by exhaustion before it was claimed. */
export function failedStageOf(file: {
  analyzeStartedAt: Date | null;
  analyzeEndedAt?: Date | null;
  linkStartedAt: Date | null;
  linkEndedAt?: Date | null;
}): IngestionStage {
  if (file.linkStartedAt || file.linkEndedAt) return "link";
  if (file.analyzeStartedAt || file.analyzeEndedAt) return "analyze";
  return "parse";
}

export function recoveryStageOf(status: IngestionFileStatus): IngestionStage {
  if (status === "extracting") return "analyze";
  if (status === "linking") return "link";
  return "parse";
}

const STAGE_RESET_DATA: Record<
  IngestionStage,
  Prisma.IngestionFileUpdateManyMutationInput
> = {
  parse: {
    status: "pending",
    parseStartedAt: null,
    parseEndedAt: null,
    analyzeStartedAt: null,
    analyzeEndedAt: null,
    linkStartedAt: null,
    linkEndedAt: null,
  },
  analyze: {
    status: "extracting",
    analyzeStartedAt: null,
    analyzeEndedAt: null,
    linkStartedAt: null,
    linkEndedAt: null,
  },
  link: { status: "linking", linkStartedAt: null, linkEndedAt: null },
};

const notFound = () => new CoreError("NOT_FOUND", "ingestion record not found");

function badRequest(field: string, message: string): CoreError {
  return new CoreError("BAD_REQUEST", message, { field });
}

export type DerivedBatchStatus =
  "empty" | "pending" | "processing" | "ready" | "attention" | "resolved";

export type BatchCreator = {
  id: string;
  name: string;
  email: string;
};

export type BatchSummary = {
  id: string;
  origin: IngestionOrigin;
  label: string | null;
  createdAt: Date;
  createdById: string;
  createdBy: BatchCreator;
  fileCount: number;
  status: DerivedBatchStatus;
  /** Lets the UI keep polling a mixed batch whose worst derived status is attention. */
  hasActiveFiles: boolean;
};

export type FileSummary = {
  id: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  status: IngestionFileStatus;
  failureKind: IngestionFailureKind | null;
  failureMessage: string | null;
  parserAdapterId: string | null;
  parserVersion: string | null;
  attemptCount: number;
  createdAt: Date;
  updatedAt: Date;
  targetKind: "document" | "table" | null;
  acceptedResourceId: string | null;
};

export type BatchDetail = BatchSummary & { files: FileSummary[] };

export type DraftTableDetail = {
  columns: DraftTableColumn[];
  rowCount: number;
  sampleRows: string[][];
};

export type DraftDetail = {
  targetKind: "document" | "table";
  proposedTitle: string;
  proposedFolderPath: string;
  proposedTags: string[];
  markdown: string | null;
  table: DraftTableDetail | null;
  links: ProposedLink[];
  warnings: string[];
  editedById: string | null;
  acceptedResourceId: string | null;
  acceptedCommitSha: string | null;
  /** Bumped by every review save; pass it back to save or accept what was reviewed. */
  revision: number;
};

const storedTableSchema = z.object({
  columns: z.array(
    z.object({ name: z.string(), type: z.enum(DRAFT_COLUMN_TYPES) }),
  ),
});
const storedTableRows = z.array(z.array(z.string()));

/** Stored draft table JSON, or null when a row predates the typed schema or is malformed. */
export function parseStoredTable(
  schema: unknown,
  rows: unknown,
): { columns: DraftTableColumn[]; rows: string[][] } | null {
  const parsedSchema = storedTableSchema.safeParse(schema);
  const parsedRows = storedTableRows.safeParse(rows);
  if (!parsedSchema.success || !parsedRows.success) return null;
  return { columns: parsedSchema.data.columns, rows: parsedRows.data };
}

function toDraftTable(schema: unknown, rows: unknown): DraftTableDetail | null {
  const stored = parseStoredTable(schema, rows);
  if (!stored) return null;
  return {
    columns: stored.columns,
    rowCount: stored.rows.length,
    sampleRows: stored.rows.slice(0, DRAFT_TABLE_SAMPLE_ROWS),
  };
}

export type FileDetail = FileSummary & {
  projectId: string;
  batchId: string;
  draft: DraftDetail | null;
};

const STATUS_PRIORITY: ReadonlyArray<
  [readonly IngestionFileStatus[], DerivedBatchStatus]
> = [
  [ATTENTION_STATUSES, "attention"],
  [PROCESSING_STATUSES, "processing"],
  [["pending"], "pending"],
  [["ready"], "ready"],
  [RESOLVED_STATUSES, "resolved"],
];

export function deriveBatchStatus(
  statuses: readonly IngestionFileStatus[],
): DerivedBatchStatus {
  if (statuses.length === 0) return "empty";
  const present = new Set(statuses);
  for (const [group, derived] of STATUS_PRIORITY) {
    if (group.some((status) => present.has(status))) return derived;
  }
  return "resolved";
}

function isDerivedBatchStatus(value: string): value is DerivedBatchStatus {
  return [
    "empty",
    "pending",
    "processing",
    "ready",
    "attention",
    "resolved",
  ].includes(value);
}

function assertUuid(value: string, field: string): void {
  if (!UUID_RE.test(value)) throw badRequest(field, `${field} must be a UUID`);
}

type BatchCursor = { createdAt: Date; id: string };

function encodeBatchCursor(projectId: string, boundary: BatchCursor): string {
  return Buffer.from(
    JSON.stringify({
      projectId,
      createdAt: boundary.createdAt.toISOString(),
      id: boundary.id,
    }),
  ).toString("base64url");
}

function decodeBatchCursor(cursor: string, projectId: string): BatchCursor {
  if (
    cursor.length === 0 ||
    cursor.length > BATCH_CURSOR_MAX_CHARS ||
    !/^[A-Za-z0-9_-]+$/.test(cursor)
  ) {
    throw badRequest("cursor", "cursor is invalid");
  }
  try {
    const decoded = Buffer.from(cursor, "base64url");
    if (decoded.toString("base64url") !== cursor) throw new Error();
    const value = JSON.parse(decoded.toString("utf8")) as Record<
      string,
      unknown
    >;
    if (
      value.projectId !== projectId ||
      typeof value.createdAt !== "string" ||
      typeof value.id !== "string" ||
      !UUID_RE.test(value.id)
    ) {
      throw new Error();
    }
    const createdAt = new Date(value.createdAt);
    if (
      !Number.isFinite(createdAt.getTime()) ||
      createdAt.toISOString() !== value.createdAt
    ) {
      throw new Error();
    }
    return { createdAt, id: value.id };
  } catch {
    throw badRequest("cursor", "cursor is invalid");
  }
}

export function normalizedLabel(label: string | undefined): string | null {
  if (label === undefined) return null;
  const value = label.trim();
  if (value.length === 0 || value.length > 200 || /[\r\n]/.test(value)) {
    throw badRequest(
      "label",
      "label must be a single line of 1 to 200 characters",
    );
  }
  return value;
}

export function validateUploadFileName(fileName: string): void {
  if (
    fileName.length === 0 ||
    fileName.length > 255 ||
    fileName !== fileName.trim() ||
    CONTROL_OR_PATH_RE.test(fileName)
  ) {
    throw badRequest(
      "fileName",
      "fileName must be a safe name of 1 to 255 characters",
    );
  }
}

function validateFileMetadata(input: {
  fileName: string;
  mimeType: string;
  byteSize: number;
  contentDigest: string;
}): string {
  validateUploadFileName(input.fileName);
  const mimeType = normalizeMimeType(input.mimeType);
  if (mimeType.length > 128 || !isAllowedMimeType(mimeType)) {
    throw badRequest("mimeType", "mimeType is not supported");
  }
  if (
    !Number.isSafeInteger(input.byteSize) ||
    input.byteSize < 0 ||
    input.byteSize > 2_147_483_647
  ) {
    throw badRequest(
      "byteSize",
      "byteSize must be a non-negative 32-bit integer",
    );
  }
  if (!DIGEST_RE.test(input.contentDigest)) {
    throw badRequest(
      "contentDigest",
      "contentDigest must be a lowercase SHA-256 digest",
    );
  }
  return mimeType;
}

function validateDraftMetadata(input: {
  proposedTitle: string;
  proposedFolderPath: string;
  proposedTags: string[];
}): void {
  const title = documentTitleSchema.safeParse(input.proposedTitle);
  if (!title.success || title.data !== input.proposedTitle) {
    throw badRequest(
      "proposedTitle",
      title.error?.issues[0]?.message ?? "proposedTitle is invalid",
    );
  }
  if (input.proposedFolderPath.length > 500) {
    throw badRequest("proposedFolderPath", "proposedFolderPath is too long");
  }
  try {
    assertSafeSegments(
      input.proposedFolderPath === ""
        ? []
        : input.proposedFolderPath.split("/"),
    );
  } catch (error) {
    if (!(error instanceof PathError)) throw error;
    throw badRequest("proposedFolderPath", error.message);
  }
  if (input.proposedTags.length > 50) {
    throw badRequest("proposedTags", "no more than 50 tags are allowed");
  }
  const seen = new Set<string>();
  for (const tag of input.proposedTags) {
    if (
      tag.length === 0 ||
      tag.length > 100 ||
      tag !== tag.trim() ||
      /[\r\n]/.test(tag) ||
      seen.has(tag)
    ) {
      throw badRequest(
        "proposedTags",
        "tags must be unique, trimmed single lines of 1 to 100 characters",
      );
    }
    seen.add(tag);
  }
}

function submissionCapability(origin: IngestionOrigin): Capability {
  return origin === "external" ? "ingest:external" : "content:write";
}

async function assertEditor(
  db: Db,
  actor: UserSecurityContext,
  projectId: string,
  capability?: Capability,
): Promise<string> {
  if (!UUID_RE.test(projectId)) throw notFound();
  const access = await assertProjectRole(
    db,
    projectId,
    actor,
    "Editor",
    capability === undefined ? undefined : { capability },
  );
  return access.project.id;
}

/** Authorizes a submission before its request body is allowed to reach disk. */
export async function authorizeIngestionUpload(
  db: PrismaClient,
  actor: UserSecurityContext,
  projectId: string,
  origin: IngestionOrigin,
): Promise<{ projectId: string }> {
  return {
    projectId: await assertEditor(
      db,
      actor,
      projectId,
      submissionCapability(origin),
    ),
  };
}

/** Serializes blob reference and filesystem lifecycle changes per project. */
export async function withProjectIngestionLifecycleLock<T>(
  db: PrismaClient,
  projectId: string,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  assertUuid(projectId, "projectId");
  // Postgres compares uuids case-insensitively; the lock key must too.
  const lockKey = `weaver:ingestion:${projectId.toLowerCase()}`;
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${lockKey}, 0)
      )::text
    `);
      return operation(tx);
    },
    { timeout: 30_000, maxWait: 30_000 },
  );
}

async function loadBatch(db: Db, actor: UserSecurityContext, batchId: string) {
  if (!UUID_RE.test(batchId)) throw notFound();
  const batch = await db.ingestionBatch.findFirst({
    where: { id: batchId, project: { ...notDeleted } },
    include: {
      createdBy: { select: { id: true, name: true, email: true } },
      files: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        include: {
          draft: { select: { targetKind: true, acceptedResourceId: true } },
        },
      },
    },
  });
  if (!batch) throw notFound();
  await assertEditor(db, actor, batch.projectId);
  return batch;
}

/** @internal Test fixture and future external-ingestion registration. */
export async function createUploadBatch(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: { projectId: string; origin: "upload" | "external"; label?: string },
): Promise<{ batchId: string }> {
  await assertEditor(db, actor, input.projectId);
  if (input.origin !== "upload" && input.origin !== "external") {
    throw badRequest("origin", "origin must be upload or external");
  }
  const batch = await db.ingestionBatch.create({
    data: {
      projectId: input.projectId,
      createdById: actor.userId,
      origin: input.origin,
      label: normalizedLabel(input.label),
    },
    select: { id: true },
  });
  return { batchId: batch.id };
}

export type RegisterUploadedFileOptions = {
  /** Promote this completed staging entry immediately before inserting its row. */
  promote?: { dataDir: string; uploadId: string };
};

/** @internal Test fixture; browser uploads use atomic finalizeUploadBatch. */
export async function registerUploadedFile(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: {
    batchId: string;
    fileName: string;
    mimeType: string;
    byteSize: number;
    contentDigest: string;
  },
  options: RegisterUploadedFileOptions = {},
): Promise<{ fileId: string; projectId: string; contentDigest: string }> {
  const initial = await loadBatch(db, actor, input.batchId);
  const mimeType = validateFileMetadata(input);
  if (options.promote) {
    assertUuid(options.promote.uploadId, "uploadId");
    if (options.promote.dataDir.length === 0) {
      throw badRequest("dataDir", "dataDir is required for promotion");
    }
  }
  return withProjectIngestionLifecycleLock(
    db,
    initial.projectId,
    async (tx) => {
      const batch = await loadBatch(tx, actor, input.batchId);
      if (options.promote) {
        await promoteUpload(
          options.promote.dataDir,
          batch.projectId,
          options.promote.uploadId,
          input.contentDigest,
        );
      }
      const file = await tx.ingestionFile.create({
        data: {
          batchId: batch.id,
          projectId: batch.projectId,
          fileName: input.fileName,
          mimeType,
          byteSize: input.byteSize,
          contentDigest: input.contentDigest,
        },
        select: { id: true },
      });
      return {
        fileId: file.id,
        projectId: batch.projectId,
        contentDigest: input.contentDigest,
      };
    },
  );
}

export type FinalizeUploadFile = {
  uploadId: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  contentDigest: string;
};

/** Promotes and registers a complete upload batch under one lifecycle lock. */
export async function finalizeUploadBatch(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: {
    projectId: string;
    origin: IngestionOrigin;
    label?: string;
    files: readonly FinalizeUploadFile[];
  },
  options: { dataDir: string; projectQuotaBytes?: number },
): Promise<{
  batchId: string;
  projectId: string;
  files: Array<{
    id: string;
    fileName: string;
    status: "pending";
    contentDigest: string;
  }>;
}> {
  const capability = submissionCapability(input.origin);
  const projectId = await assertEditor(db, actor, input.projectId, capability);
  const label = normalizedLabel(input.label);
  if (
    input.files.length === 0 ||
    input.files.length > MAX_INGESTION_UPLOAD_FILES
  ) {
    throw badRequest(
      "files",
      `files must contain 1 to ${MAX_INGESTION_UPLOAD_FILES} entries`,
    );
  }
  if (options.dataDir.length === 0) {
    throw badRequest("dataDir", "dataDir is required for promotion");
  }
  const files = input.files.map((file) => {
    assertUuid(file.uploadId, "uploadId");
    return { ...file, mimeType: validateFileMetadata(file) };
  });

  return withProjectIngestionLifecycleLock(db, projectId, async (tx) => {
    const canonicalProjectId = await assertEditor(
      tx,
      actor,
      projectId,
      capability,
    );
    const retained = await retainedBytes(
      tx,
      canonicalProjectId,
      files.map((file) => ({
        digest: file.contentDigest,
        byteSize: file.byteSize,
      })),
    );
    if (retained > BigInt(options.projectQuotaBytes ?? 5 * 1024 ** 3))
      throw new CoreError(
        "PRECONDITION_FAILED",
        "Project upload storage quota exceeded; delete an old import batch or file before uploading more files",
      );
    const batch = await tx.ingestionBatch.create({
      data: {
        projectId: canonicalProjectId,
        createdById: actor.userId,
        origin: input.origin,
        label,
      },
      select: { id: true },
    });
    const registered: Array<{
      id: string;
      fileName: string;
      status: "pending";
      contentDigest: string;
    }> = [];
    for (const file of files) {
      await promoteUpload(
        options.dataDir,
        canonicalProjectId,
        file.uploadId,
        file.contentDigest,
      );
      const created = await tx.ingestionFile.create({
        data: {
          batchId: batch.id,
          projectId: canonicalProjectId,
          fileName: file.fileName,
          mimeType: file.mimeType,
          byteSize: file.byteSize,
          contentDigest: file.contentDigest,
        },
        select: { id: true },
      });
      registered.push({
        id: created.id,
        fileName: file.fileName,
        status: "pending",
        contentDigest: file.contentDigest,
      });
    }
    return {
      batchId: batch.id,
      projectId: canonicalProjectId,
      files: registered,
    };
  });
}

function toFileSummary(file: {
  id: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  status: IngestionFileStatus;
  failureKind: IngestionFailureKind | null;
  failureMessage: string | null;
  parserAdapterId: string | null;
  parserVersion: string | null;
  attemptCount: number;
  createdAt: Date;
  updatedAt: Date;
  draft?: {
    targetKind: "document" | "table";
    acceptedResourceId: string | null;
  } | null;
}): FileSummary {
  return {
    id: file.id,
    fileName: file.fileName,
    mimeType: file.mimeType,
    byteSize: file.byteSize,
    status: file.status,
    failureKind: file.failureKind,
    failureMessage: file.failureMessage,
    parserAdapterId: file.parserAdapterId,
    parserVersion: file.parserVersion,
    attemptCount: file.attemptCount,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    targetKind: file.draft?.targetKind ?? null,
    acceptedResourceId: file.draft?.acceptedResourceId ?? null,
  };
}

function batchStatusWhere(
  status: DerivedBatchStatus,
): Prisma.IngestionBatchWhereInput {
  const none = (statuses: readonly IngestionFileStatus[]) => ({
    files: { none: { status: { in: [...statuses] } } },
  });
  const some = (statuses: readonly IngestionFileStatus[]) => ({
    files: { some: { status: { in: [...statuses] } } },
  });
  switch (status) {
    case "empty":
      return { files: { none: {} } };
    case "attention":
      return some(ATTENTION_STATUSES);
    case "processing":
      return { AND: [none(ATTENTION_STATUSES), some(PROCESSING_STATUSES)] };
    case "pending":
      return {
        AND: [
          none([...ATTENTION_STATUSES, ...PROCESSING_STATUSES]),
          some(["pending"]),
        ],
      };
    case "ready":
      return {
        AND: [
          none([...ATTENTION_STATUSES, ...PROCESSING_STATUSES, "pending"]),
          some(["ready"]),
        ],
      };
    case "resolved":
      return {
        AND: [
          none([
            ...ATTENTION_STATUSES,
            ...PROCESSING_STATUSES,
            "pending",
            "ready",
          ]),
          some(RESOLVED_STATUSES),
        ],
      };
  }
}

type BatchWithSummaryRelations = Prisma.IngestionBatchGetPayload<{
  include: {
    createdBy: { select: { id: true; name: true; email: true } };
    files: { select: { status: true } };
  };
}>;

function toBatchSummary(batch: BatchWithSummaryRelations): BatchSummary {
  const statuses = batch.files.map((file) => file.status);
  return {
    id: batch.id,
    origin: batch.origin,
    label: batch.label,
    createdAt: batch.createdAt,
    createdById: batch.createdById,
    createdBy: batch.createdBy,
    fileCount: batch.files.length,
    status: deriveBatchStatus(statuses),
    hasActiveFiles: statuses.some((status) => ACTIVE_STATUS_SET.has(status)),
  };
}

export async function listBatches(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: {
    projectId: string;
    limit?: number;
    cursor?: string;
    status?: DerivedBatchStatus;
  },
): Promise<{ items: BatchSummary[]; nextCursor: string | null }> {
  await assertEditor(db, actor, input.projectId);
  const take = input.limit ?? BATCH_PAGE_DEFAULT;
  if (!Number.isInteger(take) || take < 1 || take > BATCH_PAGE_MAX) {
    throw badRequest("limit", `limit must be between 1 and ${BATCH_PAGE_MAX}`);
  }
  if (input.status !== undefined && !isDerivedBatchStatus(input.status)) {
    throw badRequest("status", "status is invalid");
  }
  const filters: Prisma.IngestionBatchWhereInput[] = [
    {
      projectId: input.projectId,
      project: { ...notDeleted },
    },
  ];
  if (input.status) filters.push(batchStatusWhere(input.status));
  if (input.cursor !== undefined) {
    const boundary = decodeBatchCursor(input.cursor, input.projectId);
    filters.push({
      OR: [
        { createdAt: { lt: boundary.createdAt } },
        { createdAt: boundary.createdAt, id: { lt: boundary.id } },
      ],
    });
  }
  const batches = await db.ingestionBatch.findMany({
    where: { AND: filters },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    include: {
      createdBy: { select: { id: true, name: true, email: true } },
      files: { select: { status: true } },
    },
  });
  const page = batches.slice(0, take);
  return {
    items: page.map(toBatchSummary),
    nextCursor:
      batches.length > take && page.length > 0
        ? encodeBatchCursor(input.projectId, page.at(-1)!)
        : null,
  };
}

export async function getBatch(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: { batchId: string },
): Promise<BatchDetail> {
  const batch = await loadBatch(db, actor, input.batchId);
  const statuses = batch.files.map((file) => file.status);
  return {
    id: batch.id,
    origin: batch.origin,
    label: batch.label,
    createdAt: batch.createdAt,
    createdById: batch.createdById,
    createdBy: batch.createdBy,
    fileCount: batch.files.length,
    status: deriveBatchStatus(statuses),
    hasActiveFiles: statuses.some((status) => ACTIVE_STATUS_SET.has(status)),
    files: batch.files.map(toFileSummary),
  };
}

export async function loadIngestionFile(
  db: Db,
  actor: UserSecurityContext,
  fileId: string,
  withDraft = true,
) {
  if (!UUID_RE.test(fileId)) throw notFound();
  const file = await db.ingestionFile.findFirst({
    where: { id: fileId, project: { ...notDeleted } },
    include: { draft: withDraft },
  });
  if (!file) throw notFound();
  await assertEditor(db, actor, file.projectId);
  return file;
}

export function toFileDetail(
  file: Awaited<ReturnType<typeof loadIngestionFile>>,
): FileDetail {
  return {
    ...toFileSummary(file),
    projectId: file.projectId,
    batchId: file.batchId,
    draft: file.draft
      ? {
          targetKind: file.draft.targetKind,
          proposedTitle: file.draft.proposedTitle,
          proposedFolderPath: file.draft.proposedFolderPath,
          proposedTags: file.draft.proposedTags,
          markdown: file.draft.markdown,
          table:
            file.draft.targetKind === "table"
              ? toDraftTable(file.draft.tableSchema, file.draft.tableRows)
              : null,
          links:
            proposedLinksSchema.safeParse(file.draft.proposedLinks).data ?? [],
          warnings: file.draft.warnings,
          editedById: file.draft.editedById,
          acceptedResourceId: file.draft.acceptedResourceId,
          acceptedCommitSha: file.draft.acceptedCommitSha,
          revision: file.draft.revision,
        }
      : null,
  };
}

export async function getFile(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: { fileId: string },
): Promise<FileDetail> {
  return toFileDetail(await loadIngestionFile(db, actor, input.fileId));
}

/** A reviewer may only save or accept the draft version they actually saw. */
export function assertDraftRevision(
  current: number,
  expected: number | undefined,
): void {
  if (expected !== undefined && expected !== current) {
    throw new CoreError(
      "CONFLICT",
      "This draft was changed by someone else. Reload it and review it again.",
    );
  }
}

export async function updateDraft(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: {
    fileId: string;
    proposedTitle: string;
    proposedFolderPath: string;
    proposedTags: string[];
    columns?: DraftTableColumn[];
    links?: Array<{ documentId: string; keep: boolean }>;
    expectedRevision?: number;
  },
): Promise<FileDetail> {
  if (!UUID_RE.test(input.fileId)) throw notFound();
  validateDraftMetadata(input);
  if (input.columns && input.columns.length > 100) {
    throw badRequest("columns", "no more than 100 columns are allowed");
  }
  if (input.links && input.links.length > MAX_PROPOSED_LINKS) {
    throw badRequest("links", "too many links");
  }
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT id
      FROM "IngestionFile"
      WHERE id = ${input.fileId}::uuid
      FOR UPDATE
    `;
    const file = await loadIngestionFile(tx, actor, input.fileId);
    const draft = file.draft;
    if (!draft || file.status !== "ready") {
      throw new CoreError(
        "PRECONDITION_FAILED",
        "only a ready file's draft can be edited",
      );
    }
    assertDraftRevision(draft.revision, input.expectedRevision);
    let tableSchema: Prisma.InputJsonValue | undefined;
    if (input.columns) {
      if (draft.targetKind !== "table") {
        throw badRequest("columns", "only table drafts have columns");
      }
      const stored = parseStoredTable(draft.tableSchema, draft.tableRows);
      if (stored?.columns.length !== input.columns.length) {
        throw badRequest("columns", "columns do not match the stored table");
      }
      const issue = draftTableIssue(input.columns, stored.rows);
      if (issue) throw badRequest("columns", issue);
      const typeIssue = columnTypeIssue(input.columns, stored.rows);
      if (typeIssue) {
        throw badRequest(
          "columns",
          `column ${typeIssue.column} cannot be ${input.columns.find((column) => column.name === typeIssue.column)?.type}: row ${typeIssue.row} holds ${JSON.stringify(typeIssue.value)}`,
        );
      }
      tableSchema = { columns: input.columns };
    }
    let proposedLinks: Prisma.InputJsonValue | undefined;
    if (input.links) {
      const keep = new Map(
        input.links.map((link) => [link.documentId, link.keep]),
      );
      const current =
        proposedLinksSchema.safeParse(draft.proposedLinks).data ?? [];
      proposedLinks = current.map((link) => ({
        ...link,
        keep: keep.get(link.documentId) ?? link.keep,
      }));
    }
    await tx.ingestionDraft.update({
      where: { fileId: file.id },
      data: {
        proposedTitle: input.proposedTitle,
        proposedFolderPath: input.proposedFolderPath,
        proposedTags: input.proposedTags,
        ...(tableSchema === undefined ? {} : { tableSchema }),
        ...(proposedLinks === undefined ? {} : { proposedLinks }),
        editedById: actor.userId,
        editedAt: new Date(),
        revision: { increment: 1 },
      },
    });
    return toFileDetail(await loadIngestionFile(tx, actor, input.fileId));
  });
}

export async function retryFile(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: { fileId: string },
): Promise<{
  stage: IngestionStage;
  fileId: string;
  projectId: string;
  contentDigest: string;
  attemptCount: number;
}> {
  const file = await loadIngestionFile(db, actor, input.fileId, false);
  const stage = failedStageOf(file);
  const updated = await db.ingestionFile.updateMany({
    where: {
      id: file.id,
      project: { ...notDeleted },
      status: { in: ["failed", "blocked_configuration"] },
      attemptCount: file.attemptCount,
    },
    data: {
      ...STAGE_RESET_DATA[stage],
      failureKind: null,
      failureMessage: null,
      stageClaimJobId: null,
      stageClaimRetryCount: null,
    },
  });
  if (updated.count === 0) {
    throw new CoreError(
      "PRECONDITION_FAILED",
      "only a failed or blocked file can be retried",
    );
  }
  return {
    stage,
    fileId: file.id,
    projectId: file.projectId,
    contentDigest: file.contentDigest,
    attemptCount: file.attemptCount,
  };
}

export async function deleteBatch(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: { batchId: string },
  options: { dataDir: string },
): Promise<{ deletedBlobs: number }> {
  const initial = await loadBatch(db, actor, input.batchId);
  const removed = await withProjectIngestionLifecycleLock(
    db,
    initial.projectId,
    async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM "IngestionFile"
        WHERE "batchId" = ${input.batchId}::uuid ORDER BY id FOR UPDATE
      `;
      const batch = await loadBatch(tx, actor, input.batchId);
      if (batch.files.some((file) => file.status === "accepting"))
        throw new CoreError(
          "CONFLICT",
          "acceptance is in progress; retry accepting before deleting the batch",
        );
      if (
        batch.files.some(
          (file) =>
            file.status === "parsing" ||
            (file.status === "extracting" && file.analyzeStartedAt !== null) ||
            (file.status === "linking" && file.linkStartedAt !== null),
        )
      )
        throw new CoreError(
          "CONFLICT",
          "Processing is in progress; wait for the active file before deleting the batch",
        );
      const digests = [
        ...new Set(batch.files.map((file) => file.contentDigest)),
      ];
      await tx.ingestionBatch.delete({ where: { id: batch.id } });
      return { projectId: batch.projectId, digests };
    },
  );

  return withProjectIngestionLifecycleLock(
    db,
    removed.projectId,
    async (tx) => {
      let deletedBlobs = 0;
      for (const digest of removed.digests) {
        if (await isBlobReferenced(tx, removed.projectId, digest)) continue;
        await deleteBlob(options.dataDir, removed.projectId, digest);
        deletedBlobs += 1;
      }
      return { deletedBlobs };
    },
  );
}

// ---- Worker-facing; the durable job payload is the authorization (spec §3.2). ----

export type ClaimedFile = {
  id: string;
  byteSize: number;
  projectId: string;
  fileName: string;
  mimeType: string;
  contentDigest: string;
  parserAdapterId: string | null;
  parserVersion: string | null;
  attemptCount: number;
};

export type StageClaimOptions = {
  /** Payload identity guards. A mismatch is a harmless stale delivery. */
  expectedProjectId?: string;
  expectedContentDigest?: string;
  /** Attempt count observed when this durable job was published. */
  baseAttemptCount?: number;
  /** A newer retry of the same durable job may recover a crashed claim. */
  delivery?: { jobId: string; retryCount: number };
};

export type ClaimFileForParsingOptions = StageClaimOptions & {
  /** Persisted in the same claim transaction, before the parser reads bytes. */
  parser?: { id: string; version: string };
};

function validateStageClaimOptions(
  fileId: string,
  options: StageClaimOptions,
): boolean {
  if (!UUID_RE.test(fileId)) return false;
  if (options.expectedProjectId && !UUID_RE.test(options.expectedProjectId))
    return false;
  if (
    options.expectedContentDigest &&
    !DIGEST_RE.test(options.expectedContentDigest)
  )
    return false;
  if (
    options.baseAttemptCount !== undefined &&
    (!Number.isSafeInteger(options.baseAttemptCount) ||
      options.baseAttemptCount < 0)
  )
    throw badRequest(
      "baseAttemptCount",
      "baseAttemptCount must be a non-negative integer",
    );
  if (
    options.delivery &&
    (options.delivery.jobId.length === 0 ||
      options.delivery.jobId.length > 64 ||
      !Number.isSafeInteger(options.delivery.retryCount) ||
      options.delivery.retryCount < 0)
  )
    throw badRequest("delivery", "delivery identity is invalid");
  return true;
}

function claimIdentityWhere(
  fileId: string,
  options: StageClaimOptions,
): Prisma.IngestionFileWhereInput {
  return {
    id: fileId,
    project: { ...notDeleted },
    ...(options.expectedProjectId
      ? { projectId: options.expectedProjectId }
      : {}),
    ...(options.expectedContentDigest
      ? { contentDigest: options.expectedContentDigest }
      : {}),
  };
}

/** Claims pending work once; a newer delivery of the same job recovers a crash. */
export async function claimFileForParsing(
  db: PrismaClient,
  fileId: string,
  options: ClaimFileForParsingOptions = {},
): Promise<ClaimedFile | null> {
  if (!validateStageClaimOptions(fileId, options)) return null;
  if (
    options.parser &&
    (options.parser.id.length === 0 ||
      options.parser.id.length > 40 ||
      options.parser.version.length === 0 ||
      options.parser.version.length > 40)
  ) {
    throw badRequest("parser", "parser identity is invalid");
  }

  return db.$transaction(async (tx) => {
    const claimable: Prisma.IngestionFileWhereInput[] = [
      {
        status: "pending",
        ...(options.baseAttemptCount === undefined
          ? {}
          : { attemptCount: options.baseAttemptCount }),
      },
    ];
    if (options.delivery && options.baseAttemptCount !== undefined) {
      claimable.push({
        status: "parsing",
        attemptCount: { gt: options.baseAttemptCount },
        stageClaimJobId: options.delivery.jobId,
        stageClaimRetryCount: { lt: options.delivery.retryCount },
      });
    }
    const claimed = await tx.ingestionFile.updateMany({
      where: { ...claimIdentityWhere(fileId, options), OR: claimable },
      data: {
        status: "parsing",
        parseStartedAt: new Date(),
        parseEndedAt: null,
        analyzeStartedAt: null,
        analyzeEndedAt: null,
        linkStartedAt: null,
        linkEndedAt: null,
        attemptCount: { increment: 1 },
        ...(options.delivery
          ? {
              stageClaimJobId: options.delivery.jobId,
              stageClaimRetryCount: options.delivery.retryCount,
            }
          : {}),
        ...(options.parser
          ? {
              parserAdapterId: options.parser.id,
              parserVersion: options.parser.version,
            }
          : {}),
      },
    });
    if (claimed.count === 0) return null;
    return tx.ingestionFile.findFirstOrThrow({
      where: { id: fileId, project: { ...notDeleted } },
      select: {
        id: true,
        projectId: true,
        fileName: true,
        mimeType: true,
        byteSize: true,
        contentDigest: true,
        parserAdapterId: true,
        parserVersion: true,
        attemptCount: true,
      },
    });
  });
}

export type CompleteParseDraft =
  | { targetKind: "document"; markdown: string }
  | { targetKind: "table"; columns: DraftTableColumn[]; rows: string[][] };

export type CompleteParseInput = {
  fileId: string;
  /** Fence an earlier worker after a parsing redelivery. */
  attemptCount?: number;
  parserAdapterId: string;
  parserVersion: string;
  proposedTitle: string;
  warnings: string[];
  draft: CompleteParseDraft;
};

function validateParserIdentity(parser: { id: string; version: string }): void {
  if (
    parser.id.length === 0 ||
    parser.id.length > 40 ||
    parser.version.length === 0 ||
    parser.version.length > 40
  ) {
    throw badRequest("parserAdapterId", "parser identity is invalid");
  }
}

function validateCompletedParse(input: CompleteParseInput): void {
  const title = documentTitleSchema.safeParse(input.proposedTitle);
  if (!title.success || title.data !== input.proposedTitle) {
    throw badRequest("proposedTitle", "proposedTitle is invalid");
  }
  if (input.draft.targetKind === "document") {
    if (input.draft.markdown.length > MAX_MARKDOWN_CHARS) {
      throw badRequest("markdown", "parsed markdown is too large");
    }
  } else {
    const issue = draftTableIssue(input.draft.columns, input.draft.rows);
    if (issue) throw badRequest("draft", issue);
  }
  validateParserIdentity({
    id: input.parserAdapterId,
    version: input.parserVersion,
  });
  if (
    input.warnings.length > 100 ||
    input.warnings.some((warning) => warning.length > 500)
  ) {
    throw badRequest("warnings", "parser warnings exceed their bounds");
  }
}

export async function completeParse(
  db: PrismaClient,
  input: CompleteParseInput,
): Promise<boolean> {
  if (!UUID_RE.test(input.fileId)) return false;
  validateCompletedParse(input);
  const draft =
    input.draft.targetKind === "document"
      ? {
          targetKind: "document" as const,
          markdown: input.draft.markdown,
          tableSchema: Prisma.DbNull,
          tableRows: Prisma.DbNull,
        }
      : {
          targetKind: "table" as const,
          markdown: null,
          tableSchema: {
            columns: input.draft.columns,
          } as Prisma.InputJsonValue,
          tableRows: input.draft.rows as Prisma.InputJsonValue,
        };
  return db.$transaction(async (tx) => {
    const transitioned = await tx.ingestionFile.updateMany({
      where: {
        id: input.fileId,
        project: { ...notDeleted },
        status: "parsing",
        ...(input.attemptCount === undefined
          ? {}
          : { attemptCount: input.attemptCount }),
      },
      data: {
        status: "extracting",
        parseEndedAt: new Date(),
        analyzeStartedAt: null,
        analyzeEndedAt: null,
        linkStartedAt: null,
        linkEndedAt: null,
        failureKind: null,
        failureMessage: null,
      },
    });
    if (transitioned.count === 0) return false;
    await tx.ingestionFile.update({
      where: { id: input.fileId },
      data: {
        parserAdapterId: input.parserAdapterId,
        parserVersion: input.parserVersion,
      },
    });
    await tx.ingestionDraft.upsert({
      where: { fileId: input.fileId },
      create: {
        fileId: input.fileId,
        proposedTitle: input.proposedTitle,
        warnings: input.warnings,
        linkQueries: [],
        proposedLinks: Prisma.DbNull,
        acceptedResourceId: null,
        acceptedCommitSha: null,
        ...draft,
      },
      update: {
        proposedTitle: input.proposedTitle,
        warnings: input.warnings,
        linkQueries: [],
        proposedLinks: Prisma.DbNull,
        acceptedResourceId: null,
        acceptedCommitSha: null,
        ...draft,
      },
    });
    return true;
  });
}

const CLAIMED_DRAFT_SELECT = {
  targetKind: true,
  proposedTitle: true,
  proposedFolderPath: true,
  markdown: true,
  tableSchema: true,
  tableRows: true,
  linkQueries: true,
  warnings: true,
} as const;

export type ClaimedDraftFile = {
  id: string;
  projectId: string;
  fileName: string;
  mimeType: string;
  contentDigest: string;
  attemptCount: number;
  draft: {
    targetKind: "document" | "table";
    proposedTitle: string;
    proposedFolderPath: string;
    markdown: string | null;
    columns: DraftTableColumn[] | null;
    rows: string[][] | null;
    linkQueries: string[];
    warnings: string[];
  };
};

type AiStage = "analyze" | "link";

async function claimAiStage(
  db: PrismaClient,
  fileId: string,
  stage: AiStage,
  options: StageClaimOptions,
): Promise<ClaimedDraftFile | null> {
  if (!validateStageClaimOptions(fileId, options)) return null;
  const status = stage === "analyze" ? "extracting" : "linking";
  const startedAt = stage === "analyze" ? "analyzeStartedAt" : "linkStartedAt";
  return db.$transaction(async (tx) => {
    const claimable: Prisma.IngestionFileWhereInput[] = [
      {
        status,
        [startedAt]: null,
        ...(options.baseAttemptCount === undefined
          ? {}
          : { attemptCount: options.baseAttemptCount }),
      },
    ];
    if (options.delivery && options.baseAttemptCount !== undefined)
      claimable.push({
        status,
        attemptCount: { gt: options.baseAttemptCount },
        stageClaimJobId: options.delivery.jobId,
        stageClaimRetryCount: { lt: options.delivery.retryCount },
      });
    const claimed = await tx.ingestionFile.updateMany({
      where: { ...claimIdentityWhere(fileId, options), OR: claimable },
      data: {
        ...(stage === "analyze"
          ? { analyzeStartedAt: new Date(), analyzeEndedAt: null }
          : { linkStartedAt: new Date(), linkEndedAt: null }),
        attemptCount: { increment: 1 },
        ...(options.delivery
          ? {
              stageClaimJobId: options.delivery.jobId,
              stageClaimRetryCount: options.delivery.retryCount,
            }
          : {}),
      },
    });
    if (claimed.count === 0) return null;
    const file = await tx.ingestionFile.findFirstOrThrow({
      where: { id: fileId },
      select: {
        id: true,
        projectId: true,
        fileName: true,
        mimeType: true,
        contentDigest: true,
        attemptCount: true,
        draft: { select: CLAIMED_DRAFT_SELECT },
      },
    });
    if (!file.draft) {
      await tx.ingestionFile.update({
        where: { id: fileId },
        data: {
          status: "failed",
          failureKind: "internal",
          failureMessage: "the draft for this file is missing",
          ...(stage === "analyze"
            ? { analyzeEndedAt: new Date() }
            : { linkEndedAt: new Date() }),
        },
      });
      return null;
    }
    const table =
      file.draft.targetKind === "table"
        ? parseStoredTable(file.draft.tableSchema, file.draft.tableRows)
        : null;
    return {
      id: file.id,
      projectId: file.projectId,
      fileName: file.fileName,
      mimeType: file.mimeType,
      contentDigest: file.contentDigest,
      attemptCount: file.attemptCount,
      draft: {
        targetKind: file.draft.targetKind,
        proposedTitle: file.draft.proposedTitle,
        proposedFolderPath: file.draft.proposedFolderPath,
        markdown: file.draft.markdown,
        columns: table?.columns ?? null,
        rows: table?.rows ?? null,
        linkQueries: file.draft.linkQueries,
        warnings: file.draft.warnings,
      },
    };
  });
}

export function claimFileForAnalysis(
  db: PrismaClient,
  fileId: string,
  options: StageClaimOptions = {},
) {
  return claimAiStage(db, fileId, "analyze", options);
}
export function claimFileForLinking(
  db: PrismaClient,
  fileId: string,
  options: StageClaimOptions = {},
) {
  return claimAiStage(db, fileId, "link", options);
}

function validateWarnings(warnings: string[]): void {
  if (warnings.length > 100 || warnings.some((warning) => warning.length > 500))
    throw badRequest("warnings", "stage warnings exceed their bounds");
}

export async function completeAnalysis(
  db: PrismaClient,
  input: {
    fileId: string;
    attemptCount: number;
    proposedTitle: string;
    proposedFolderPath: string;
    columns?: DraftTableColumn[];
    linkQueries: string[];
    warnings: string[];
  },
): Promise<boolean> {
  if (!UUID_RE.test(input.fileId)) return false;
  validateDraftMetadata({ ...input, proposedTags: [] });
  validateWarnings(input.warnings);
  if (
    input.linkQueries.length > MAX_LINK_QUERIES ||
    input.linkQueries.some(
      (query) => query.length === 0 || query.length > MAX_LINK_QUERY_CHARS,
    )
  )
    throw badRequest("linkQueries", "link queries exceed their bounds");
  return db.$transaction(async (tx) => {
    const current = await tx.ingestionDraft.findFirst({
      where: {
        fileId: input.fileId,
        file: {
          status: "extracting",
          attemptCount: input.attemptCount,
          analyzeStartedAt: { not: null },
        },
      },
      select: CLAIMED_DRAFT_SELECT,
    });
    if (!current) return false;
    let tableSchema: Prisma.InputJsonValue | undefined;
    if (input.columns) {
      const stored = parseStoredTable(current.tableSchema, current.tableRows);
      if (stored?.columns.length !== input.columns.length)
        throw badRequest("columns", "columns do not match the stored table");
      const issue = draftTableIssue(input.columns, stored.rows);
      if (issue) throw badRequest("columns", issue);
      const typeIssue = columnTypeIssue(input.columns, stored.rows);
      if (typeIssue)
        throw badRequest(
          "columns",
          `column ${typeIssue.column} cannot be typed that way: row ${typeIssue.row} holds ${JSON.stringify(typeIssue.value)}`,
        );
      tableSchema = { columns: input.columns };
    }
    const transitioned = await tx.ingestionFile.updateMany({
      where: {
        id: input.fileId,
        project: { ...notDeleted },
        status: "extracting",
        attemptCount: input.attemptCount,
        analyzeStartedAt: { not: null },
      },
      data: {
        status: "linking",
        analyzeEndedAt: new Date(),
        linkStartedAt: null,
        linkEndedAt: null,
        failureKind: null,
        failureMessage: null,
      },
    });
    if (transitioned.count === 0) return false;
    await tx.ingestionDraft.update({
      where: { fileId: input.fileId },
      data: {
        proposedTitle: input.proposedTitle,
        proposedFolderPath: input.proposedFolderPath,
        linkQueries: input.linkQueries,
        warnings: [...current.warnings, ...input.warnings].slice(0, 100),
        ...(tableSchema === undefined ? {} : { tableSchema }),
      },
    });
    return true;
  });
}

export async function completeLinking(
  db: PrismaClient,
  input: { fileId: string; attemptCount: number; links: ProposedLink[] },
): Promise<boolean> {
  if (!UUID_RE.test(input.fileId)) return false;
  const links = proposedLinksSchema.safeParse(input.links);
  if (!links.success) throw badRequest("links", "proposed links are invalid");
  return db.$transaction(async (tx) => {
    const transitioned = await tx.ingestionFile.updateMany({
      where: {
        id: input.fileId,
        project: { ...notDeleted },
        status: "linking",
        attemptCount: input.attemptCount,
        linkStartedAt: { not: null },
      },
      data: {
        status: "ready",
        linkEndedAt: new Date(),
        failureKind: null,
        failureMessage: null,
      },
    });
    if (transitioned.count === 0) return false;
    await tx.ingestionDraft.update({
      where: { fileId: input.fileId },
      data: { proposedLinks: links.data },
    });
    return true;
  });
}

export type ParseAttemptDetails = {
  parser?: { id: string; version: string };
  routeSnapshot?: Prisma.InputJsonValue;
};

/** Records the adapter (and, for OCR, the route) chosen for the live parsing attempt. */
export async function recordParseAttemptDetails(
  db: PrismaClient,
  input: {
    fileId: string;
    attemptCount: number;
    status?: "parsing" | "extracting";
  } & ParseAttemptDetails,
): Promise<boolean> {
  if (!UUID_RE.test(input.fileId)) return false;
  if (input.parser) validateParserIdentity(input.parser);
  const updated = await db.ingestionFile.updateMany({
    where: {
      id: input.fileId,
      project: { ...notDeleted },
      status: input.status ?? "parsing",
      attemptCount: input.attemptCount,
      ...(input.status === "extracting"
        ? { analyzeStartedAt: { not: null } }
        : {}),
    },
    data: {
      ...(input.parser
        ? {
            parserAdapterId: input.parser.id,
            parserVersion: input.parser.version,
          }
        : {}),
      ...(input.routeSnapshot === undefined
        ? {}
        : { routeSnapshot: input.routeSnapshot }),
    },
  });
  return updated.count === 1;
}

export type FailFileInput = {
  fileId: string;
  /** Fence an earlier worker after a redelivery. */
  attemptCount?: number;
  /** The active stage being ended; parsing keeps existing callers unchanged. */
  fromStatus?: "parsing" | "extracting" | "linking";
  failureKind: IngestionFailureKind;
  message: string;
};

export async function failFile(
  db: PrismaClient,
  input: FailFileInput,
): Promise<boolean> {
  if (!UUID_RE.test(input.fileId)) return false;
  if (
    ![
      "configuration",
      "source_missing",
      "parser",
      "provider",
      "validation",
      "internal",
    ].includes(input.failureKind)
  ) {
    throw badRequest("failureKind", "failureKind is invalid");
  }
  return db.$transaction(async (tx) => {
    const transitioned = await tx.ingestionFile.updateMany({
      where: {
        id: input.fileId,
        project: { ...notDeleted },
        status: input.fromStatus ?? "parsing",
        ...(input.fromStatus === "extracting"
          ? { analyzeStartedAt: { not: null } }
          : input.fromStatus === "linking"
            ? { linkStartedAt: { not: null } }
            : {}),
        ...(input.attemptCount === undefined
          ? {}
          : { attemptCount: input.attemptCount }),
      },
      data: {
        status:
          input.failureKind === "configuration"
            ? "blocked_configuration"
            : "failed",
      },
    });
    if (transitioned.count === 0) return false;
    await tx.ingestionFile.update({
      where: { id: input.fileId },
      data: {
        failureKind: input.failureKind,
        failureMessage: input.message.slice(0, 500),
        ...(input.fromStatus === "extracting"
          ? { analyzeEndedAt: new Date() }
          : input.fromStatus === "linking"
            ? { linkEndedAt: new Date() }
            : { parseEndedAt: new Date() }),
      },
    });
    return true;
  });
}

const INGESTION_RECOVERY_BATCH_SIZE = 100;

/** Bounded snapshots; each winning reservation starts a new publication cooldown. */
export async function listStaleIngestionFiles(
  db: PrismaClient,
  olderThan: Date,
) {
  return db.ingestionFile.findMany({
    where: {
      project: { ...notDeleted },
      updatedAt: { lt: olderThan },
      OR: [
        { status: "pending" },
        {
          status: "parsing",
          OR: [{ parseStartedAt: { lt: olderThan } }, { parseStartedAt: null }],
        },
        {
          status: "extracting",
          OR: [
            { analyzeStartedAt: { lt: olderThan } },
            { analyzeStartedAt: null },
          ],
        },
        {
          status: "linking",
          OR: [{ linkStartedAt: { lt: olderThan } }, { linkStartedAt: null }],
        },
      ],
    },
    select: {
      id: true,
      projectId: true,
      contentDigest: true,
      status: true,
      updatedAt: true,
      parseStartedAt: true,
      analyzeStartedAt: true,
      linkStartedAt: true,
      attemptCount: true,
      stageClaimJobId: true,
      stageClaimRetryCount: true,
    },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: INGESTION_RECOVERY_BATCH_SIZE,
  });
}

type IngestionRecoverySnapshot = Awaited<
  ReturnType<typeof listStaleIngestionFiles>
>[number];

/** Four full pg-boss deliveries (retryLimit 5) across all stages before recovery gives up. */
export const MAX_INGESTION_ATTEMPTS = 24;
export const INGESTION_EXHAUSTED_MESSAGE = `processing did not finish after ${MAX_INGESTION_ATTEMPTS} attempts`;

const RECOVERABLE_STATUSES = new Set<IngestionFileStatus>([
  "pending",
  "parsing",
  "extracting",
  "linking",
]);

/** Recovery is finite: an exhausted file ends terminally instead of being republished forever. */
export async function failExhaustedIngestionFile(
  db: PrismaClient,
  snapshot: IngestionRecoverySnapshot,
): Promise<boolean> {
  if (snapshot.attemptCount < MAX_INGESTION_ATTEMPTS) return false;
  if (!RECOVERABLE_STATUSES.has(snapshot.status)) return false;
  const failed = await db.ingestionFile.updateMany({
    where: { ...snapshot, project: { ...notDeleted } },
    data: {
      status: "failed",
      failureKind: "internal",
      failureMessage: INGESTION_EXHAUSTED_MESSAGE,
      parseEndedAt: snapshot.status === "parsing" ? new Date() : undefined,
      analyzeEndedAt: snapshot.status === "extracting" ? new Date() : undefined,
      linkEndedAt: snapshot.status === "linking" ? new Date() : undefined,
      stageClaimJobId: null,
      stageClaimRetryCount: null,
    },
  });
  return failed.count === 1;
}

/** Resets only the unchanged attempt; stale workers lose their status/attempt fence. */
export async function reserveIngestionFileRecovery(
  db: PrismaClient,
  snapshot: IngestionRecoverySnapshot,
): Promise<boolean> {
  if (!RECOVERABLE_STATUSES.has(snapshot.status)) return false;
  const reserved = await db.ingestionFile.updateMany({
    where: { ...snapshot, project: { ...notDeleted } },
    data: {
      ...STAGE_RESET_DATA[recoveryStageOf(snapshot.status)],
      updatedAt: new Date(),
      stageClaimJobId: null,
      stageClaimRetryCount: null,
    },
  });
  return reserved.count === 1;
}

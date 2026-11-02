import { CoreError } from "@weaver/core/errors";
import {
  assertSystemAdmin,
  type UserSecurityContext,
} from "@weaver/core/security/context";
import type {
  IngestionFileStatus,
  Prisma,
  PrismaClient,
} from "@weaver/db/client";
import {
  clampLimit,
  decodeTimestampIdPageCursor,
  encodePageCursor,
} from "./adminPaging";
import { deriveBatchStatus } from "./ingestion";
import { assertProjectRole } from "./projectAccess";

const FILE_SELECT = {
  id: true,
  batchId: true,
  fileName: true,
  mimeType: true,
  byteSize: true,
  contentDigest: true,
  status: true,
  failureKind: true,
  failureMessage: true,
  parserAdapterId: true,
  parserVersion: true,
  attemptCount: true,
  parseStartedAt: true,
  parseEndedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.IngestionFileSelect;

export type IngestionBatchRow = Awaited<
  ReturnType<typeof listIngestionBatches>
>["items"][number];
export type IngestionFileRow = Awaited<
  ReturnType<typeof listIngestionFiles>
>["items"][number];
export type IngestionFileDetailRow = Awaited<
  ReturnType<typeof getIngestionFileDetail>
>;

async function assertInspectionAccess(
  db: PrismaClient,
  actor: UserSecurityContext,
  projectId: string,
): Promise<void> {
  assertSystemAdmin(actor);
  await assertProjectRole(db, projectId, actor, "Maintainer", {
    capability: "content:read",
  });
}

export async function listIngestionBatches(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: { projectId: string; limit?: number; cursor?: string },
) {
  await assertInspectionAccess(db, actor, input.projectId);
  const limit = clampLimit(input.limit);
  const cursor = input.cursor
    ? decodeTimestampIdPageCursor(input.cursor)
    : null;
  const cursorWhere: Prisma.IngestionBatchWhereInput | undefined = cursor
    ? {
        OR: [
          { createdAt: { lt: cursor[0] } },
          { createdAt: cursor[0], id: { gt: cursor[1] } },
        ],
      }
    : undefined;
  const rows = await db.ingestionBatch.findMany({
    where: { projectId: input.projectId, ...(cursorWhere ?? {}) },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: limit + 1,
    select: {
      id: true,
      label: true,
      origin: true,
      createdById: true,
      createdAt: true,
    },
  });
  const page = rows.slice(0, limit);
  const fileRows = page.length
    ? await db.ingestionFile.findMany({
        where: { batchId: { in: page.map((batch) => batch.id) } },
        select: { batchId: true, status: true },
      })
    : [];
  const items = page.map((batch) => {
    const statuses = fileRows
      .filter((file) => file.batchId === batch.id)
      .map((file) => file.status);
    const fileStatusCounts: Partial<Record<IngestionFileStatus, number>> = {};
    for (const status of statuses) {
      fileStatusCounts[status] = (fileStatusCounts[status] ?? 0) + 1;
    }
    return { ...batch, status: deriveBatchStatus(statuses), fileStatusCounts };
  });
  const last = page.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? encodePageCursor([last.createdAt.toISOString(), last.id])
        : null,
    truncated: rows.length > limit,
  };
}

export async function listIngestionFiles(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: {
    projectId: string;
    batchId?: string;
    status?: IngestionFileStatus;
    limit?: number;
    cursor?: string;
  },
) {
  await assertInspectionAccess(db, actor, input.projectId);
  if (input.batchId !== undefined) {
    const batch = await db.ingestionBatch.findFirst({
      where: { id: input.batchId, projectId: input.projectId },
      select: { id: true },
    });
    if (!batch) throw new CoreError("NOT_FOUND");
  }
  const limit = clampLimit(input.limit);
  const cursor = input.cursor
    ? decodeTimestampIdPageCursor(input.cursor)
    : null;
  const cursorWhere: Prisma.IngestionFileWhereInput | undefined = cursor
    ? {
        OR: [
          { createdAt: { lt: cursor[0] } },
          { createdAt: cursor[0], id: { gt: cursor[1] } },
        ],
      }
    : undefined;
  const rows = await db.ingestionFile.findMany({
    where: {
      projectId: input.projectId,
      ...(input.batchId !== undefined ? { batchId: input.batchId } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(cursorWhere ?? {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: limit + 1,
    select: { ...FILE_SELECT, draft: { select: { id: true } } },
  });
  const items = rows.slice(0, limit).map(({ draft, ...file }) => ({
    ...file,
    hasDraft: draft !== null,
  }));
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? encodePageCursor([last.createdAt.toISOString(), last.id])
        : null,
    truncated: rows.length > limit,
  };
}

export async function getIngestionFileDetail(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: { projectId: string; fileId: string },
) {
  await assertInspectionAccess(db, actor, input.projectId);
  const file = await db.ingestionFile.findFirst({
    where: { id: input.fileId, projectId: input.projectId },
    select: {
      ...FILE_SELECT,
      projectId: true,
      draft: {
        select: {
          targetKind: true,
          proposedTitle: true,
          proposedFolderPath: true,
          proposedTags: true,
          markdown: true,
          warnings: true,
          editedById: true,
          editedAt: true,
        },
      },
    },
  });
  if (!file) throw new CoreError("NOT_FOUND");
  return file;
}

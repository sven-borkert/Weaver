import { CoreError } from "@weaver/core/errors";
import {
  assertSystemAdmin,
  type SecurityContext,
} from "@weaver/core/security/context";
import type {
  KnowledgeDocumentStatus,
  KnowledgeGenerationStatus,
  Prisma,
  PrismaClient,
} from "@weaver/db/client";
import {
  clampLimit,
  decodeIdPageCursor,
  decodeTimestampIdPageCursor,
  encodePageCursor,
} from "./adminPaging";
import { assertProjectRole } from "./projectAccess";

export type KnowledgeGenerationRow = Awaited<
  ReturnType<typeof listKnowledgeGenerations>
>["items"][number];
export type KnowledgeGenerationDocumentRow = Awaited<
  ReturnType<typeof listGenerationDocuments>
>["items"][number];

export async function listKnowledgeGenerations(
  db: PrismaClient,
  actor: SecurityContext,
  input: {
    projectId: string;
    status?: KnowledgeGenerationStatus;
    limit?: number;
    cursor?: string;
  },
) {
  assertSystemAdmin(actor);
  await assertProjectRole(db, input.projectId, actor, "Maintainer", {
    capability: "content:read",
  });
  const limit = clampLimit(input.limit);
  const cursor = input.cursor
    ? decodeTimestampIdPageCursor(input.cursor)
    : null;
  const cursorWhere: Prisma.KnowledgeGenerationWhereInput | undefined = cursor
    ? {
        OR: [
          { createdAt: { lt: cursor[0] } },
          { createdAt: cursor[0], id: { gt: cursor[1] } },
        ],
      }
    : undefined;
  const rows = await db.knowledgeGeneration.findMany({
    where: {
      projectId: input.projectId,
      ...(input.status ? { status: input.status } : {}),
      ...(cursorWhere ?? {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: limit + 1,
    select: {
      id: true,
      status: true,
      configFingerprint: true,
      embeddingModel: true,
      embeddingDimensions: true,
      extractionSchemaVersion: true,
      promptVersion: true,
      routeSnapshot: true,
      documentTotal: true,
      documentReadyCount: true,
      documentFailedCount: true,
      failureKind: true,
      failureSummary: true,
      createdAt: true,
      completedAt: true,
      activatedAt: true,
      supersededAt: true,
    },
  });
  const items = rows.slice(0, limit);
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

export async function listGenerationDocuments(
  db: PrismaClient,
  actor: SecurityContext,
  input: {
    projectId: string;
    generationId: string;
    status?: KnowledgeDocumentStatus;
    limit?: number;
    cursor?: string;
  },
) {
  assertSystemAdmin(actor);
  await assertProjectRole(db, input.projectId, actor, "Maintainer", {
    capability: "content:read",
  });
  const generation = await db.knowledgeGeneration.findFirst({
    where: { id: input.generationId, projectId: input.projectId },
    select: { id: true },
  });
  if (!generation) throw new CoreError("NOT_FOUND");

  const limit = clampLimit(input.limit);
  const cursor = input.cursor ? decodeIdPageCursor(input.cursor) : null;
  const rows = await db.knowledgeGenerationDocument.findMany({
    where: {
      projectId: input.projectId,
      generationId: input.generationId,
      ...(input.status ? { status: input.status } : {}),
      ...(cursor ? { documentId: { gt: cursor } } : {}),
    },
    orderBy: { documentId: "asc" },
    take: limit + 1,
    select: {
      documentId: true,
      status: true,
      attempts: true,
      failureKind: true,
      failureSummary: true,
      targetSha: true,
      semanticIndexedSha: true,
      graphIndexedSha: true,
      lastAttemptAt: true,
      completedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last ? encodePageCursor([last.documentId]) : null,
    truncated: rows.length > limit,
  };
}

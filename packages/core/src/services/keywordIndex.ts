import { preserveMovedDocumentKnowledge } from "./knowledgeMoves";
import { UTC_NOW } from "./sql";
import { knowledgeTransaction } from "./knowledgeTargets";
import { lockLiveKnowledgeProject as projectIsLiveForUpdate } from "./knowledgeTargets";
import { Prisma, type PrismaClient } from "@weaver/db/client";
import { MAX_KNOWLEDGE_CHUNK_CHARACTERS } from "@weaver/core/knowledge/chunking";
import { chunkDocumentSource } from "@weaver/core/knowledge/chunkDocument";
import type { KnowledgeSystemContext } from "../jobs/systemContext";
import {
  type DocumentSourcePayload,
  type TableSourcePayload,
  withDocumentIndexSource,
  withTableSearchSource,
} from "./knowledgeSources";

type LiveProjection = { headCommitSha: string };

export async function syncDocumentKeywordIndex(
  context: KnowledgeSystemContext,
  db: PrismaClient,
  payload: DocumentSourcePayload,
  options?: { skipIfReady?: boolean },
) {
  if (options?.skipIfReady) {
    const state = await db.documentIndexState.findFirst({
      where: {
        projectId: payload.projectId,
        documentId: payload.documentId,
        targetSha: payload.sourceCommitSha,
        keywordIndexedSha: payload.sourceCommitSha,
        status: "ready",
        project: { deletedAt: null },
      },
      select: { documentId: true },
    });
    if (
      state &&
      (await db.document.findFirst({
        where: {
          id: payload.documentId,
          projectId: payload.projectId,
          headCommitSha: payload.sourceCommitSha,
          searchChunks: {
            some: {
              sourceCommitSha: payload.sourceCommitSha,
              supersededAt: null,
            },
          },
        },
        select: { id: true },
      }))
    )
      return { outcome: "indexed" as const };
  }
  try {
    const result = await withDocumentIndexSource(
      context,
      db,
      payload,
      async (source) => {
        const chunks = chunkDocumentSource({
          documentId: payload.documentId,
          sourceCommitSha: payload.sourceCommitSha,
          source,
          maxChars: MAX_KNOWLEDGE_CHUNK_CHARACTERS,
          overlapChars: 300,
        });

        return knowledgeTransaction(db, async (tx) => {
          if (!(await projectIsLiveForUpdate(tx, payload.projectId))) {
            return { outcome: "missing" as const };
          }
          const [liveDocument] = await tx.$queryRaw<LiveProjection[]>`
      SELECT "headCommitSha"
      FROM "Document"
      WHERE "id" = ${payload.documentId}::uuid
        AND "projectId" = ${payload.projectId}::uuid
      FOR UPDATE
    `;
          if (liveDocument?.headCommitSha !== payload.sourceCommitSha) {
            return { outcome: "stale" as const };
          }

          const existingState = await tx.documentIndexState.findUnique({
            where: { documentId: payload.documentId },
            select: {
              projectId: true,
              status: true,
              targetSha: true,
              keywordIndexedSha: true,
            },
          });
          if (existingState && existingState.projectId !== payload.projectId) {
            return { outcome: "stale" as const };
          }

          const previousSha = existingState?.keywordIndexedSha;
          // A commit that leaves every chunk identical (a move, a header
          // rewrite, a metadata change) carries vectors and graph forward.
          const carryCandidate =
            !!previousSha &&
            previousSha !== payload.sourceCommitSha &&
            existingState.status === "ready" &&
            existingState.targetSha === previousSha;
          const previousChunks = carryCandidate
            ? await tx.documentSearchChunk.findMany({
                where: {
                  projectId: payload.projectId,
                  documentId: payload.documentId,
                },
                orderBy: { ordinal: "asc" },
              })
            : [];
          const reusableChunks =
            carryCandidate &&
            previousChunks.length === chunks.length &&
            previousChunks.every((chunk, index) => {
              const replacement = chunks[index]!;
              return (
                chunk.sourceCommitSha === previousSha &&
                chunk.supersededAt === null &&
                chunk.ordinal === replacement.ordinal &&
                chunk.contentHash === replacement.contentHash &&
                chunk.content === replacement.content &&
                chunk.navigationAnchor === replacement.navigationAnchor &&
                JSON.stringify(chunk.headingPath) ===
                  JSON.stringify(replacement.headingPath)
              );
            });

          if (chunks.length) {
            const replacements = Prisma.join(
              chunks.map(
                (chunk) => Prisma.sql`(${chunk.id}, ${chunk.contentHash})`,
              ),
            );
            await tx.$executeRaw(Prisma.sql`
              INSERT INTO "KnowledgeEmbedding"
                ("id", "projectId", "generationId", "ownerType", "ownerId", "contentHash",
                 "configFingerprint", "model", "embeddingDimensions", "embedding", "createdAt")
              SELECT gen_random_uuid(), cached."projectId", cached."generationId", 'document_chunk',
                     cached."replacementId", cached."contentHash", cached."configFingerprint", cached."model",
                     cached."embeddingDimensions", cached."embedding", ${UTC_NOW}
              FROM (
                SELECT DISTINCT ON (embedding."generationId", replacement."id")
                       embedding.*, replacement."id" AS "replacementId"
                FROM (VALUES ${replacements}) AS replacement("id", "contentHash")
                JOIN "DocumentSearchChunk" AS chunk
                  ON chunk."projectId" = ${payload.projectId}::uuid
                 AND chunk."documentId" = ${payload.documentId}::uuid
                 AND chunk."contentHash" = replacement."contentHash"
                JOIN "KnowledgeEmbedding" AS embedding
                  ON embedding."projectId" = chunk."projectId"
                 AND embedding."ownerType" = 'document_chunk'
                 AND embedding."ownerId" = chunk."id"
                 AND embedding."contentHash" = replacement."contentHash"
                JOIN "KnowledgeGeneration" AS generation
                  ON generation."id" = embedding."generationId"
                 AND generation."projectId" = embedding."projectId"
                 AND generation."status" IN ('active', 'building')
                 AND generation."configFingerprint" = embedding."configFingerprint"
                 AND generation."embeddingDimensions" = embedding."embeddingDimensions"
                ORDER BY embedding."generationId", replacement."id", embedding."createdAt" DESC, embedding."id"
              ) AS cached
              ON CONFLICT ("generationId", "ownerType", "ownerId") DO NOTHING
            `);
          }

          await tx.$executeRaw(Prisma.sql`
            DELETE FROM "KnowledgeEmbedding" AS embedding
            USING "DocumentSearchChunk" AS chunk
            WHERE embedding."projectId" = ${payload.projectId}::uuid
              AND embedding."ownerType" = 'document_chunk'
              AND embedding."ownerId" = chunk."id"
              AND chunk."projectId" = ${payload.projectId}::uuid
              AND chunk."documentId" = ${payload.documentId}::uuid
              ${chunks.length ? Prisma.sql`AND chunk."id" NOT IN (${Prisma.join(chunks.map((chunk) => chunk.id))})` : Prisma.empty}
          `);
          await tx.documentSearchChunk.deleteMany({
            where: {
              projectId: payload.projectId,
              documentId: payload.documentId,
              id: { notIn: chunks.map((chunk) => chunk.id) },
            },
          });
          for (const chunk of chunks) {
            await tx.documentSearchChunk.upsert({
              where: { id: chunk.id },
              create: {
                ...chunk,
                projectId: payload.projectId,
                documentId: payload.documentId,
                sourceCommitSha: payload.sourceCommitSha,
              },
              update: {
                contentHash: chunk.contentHash,
                headingPath: chunk.headingPath,
                navigationAnchor: chunk.navigationAnchor,
                content: chunk.content,
                supersededAt: null,
              },
            });
          }

          if (reusableChunks && previousSha) {
            await preserveMovedDocumentKnowledge(
              tx,
              payload,
              previousSha,
              previousChunks,
              chunks,
            );
          }

          const completedAt = new Date();
          await tx.documentIndexState.upsert({
            where: { documentId: payload.documentId },
            create: {
              documentId: payload.documentId,
              projectId: payload.projectId,
              targetSha: payload.sourceCommitSha,
              keywordIndexedSha: payload.sourceCommitSha,
              status: "ready",
              attempts: 1,
              lastAttemptAt: completedAt,
              completedAt,
            },
            update: {
              targetSha: payload.sourceCommitSha,
              keywordIndexedSha: payload.sourceCommitSha,
              status: "ready",
              attempts: { increment: 1 },
              failureKind: null,
              failureSummary: null,
              lastAttemptAt: completedAt,
              completedAt,
            },
          });
          return { outcome: "indexed" as const };
        });
      },
    );
    if (!result) await recordKeywordFailure(db, payload, "source_missing");
    return result ?? { outcome: "missing" as const };
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    await recordKeywordFailure(db, payload, "validation");
    return { outcome: "failed" as const };
  }
}

async function recordKeywordFailure(
  db: PrismaClient,
  payload: DocumentSourcePayload,
  kind: "validation" | "source_missing",
) {
  await knowledgeTransaction(db, async (tx) => {
    if (!(await projectIsLiveForUpdate(tx, payload.projectId))) return;
    const [document] = await tx.$queryRaw<
      Array<{ headCommitSha: string; path: string }>
    >`
      SELECT "headCommitSha", "path" FROM "Document"
      WHERE "id" = ${payload.documentId}::uuid AND "projectId" = ${payload.projectId}::uuid FOR UPDATE
    `;
    if (
      document?.headCommitSha !== payload.sourceCommitSha ||
      document.path !== payload.pathAtSha
    )
      return;
    const now = new Date();
    const failure = {
      targetSha: payload.sourceCommitSha,
      status: "failed" as const,
      failureKind: kind,
      failureSummary:
        kind === "validation"
          ? "Document exceeds keyword indexing limits"
          : "Document source is unavailable or invalid",
      completedAt: now,
      lastAttemptAt: now,
    };
    await tx.documentIndexState.upsert({
      where: { documentId: payload.documentId },
      create: {
        documentId: payload.documentId,
        projectId: payload.projectId,
        attempts: 1,
        ...failure,
      },
      update: { ...failure, attempts: { increment: 1 } },
    });
  });
}

export async function syncTableKeywordIndex(
  context: KnowledgeSystemContext,
  db: PrismaClient,
  payload: TableSourcePayload,
) {
  const result = await withTableSearchSource(
    context,
    db,
    payload,
    async (source) =>
      knowledgeTransaction(db, async (tx) => {
        if (!(await projectIsLiveForUpdate(tx, payload.projectId))) {
          return { outcome: "missing" as const };
        }
        const [liveTable] = await tx.$queryRaw<LiveProjection[]>`
      SELECT "headCommitSha"
      FROM "DataTable"
      WHERE "id" = ${payload.tableId}::uuid
        AND "projectId" = ${payload.projectId}::uuid
      FOR UPDATE
    `;
        if (liveTable?.headCommitSha !== payload.sourceCommitSha) {
          return { outcome: "stale" as const };
        }

        const existingProjection = await tx.tableSearchProjection.findUnique({
          where: { tableId: payload.tableId },
          select: { projectId: true },
        });
        if (
          existingProjection &&
          existingProjection.projectId !== payload.projectId
        ) {
          return { outcome: "stale" as const };
        }

        await tx.tableSearchProjection.upsert({
          where: { tableId: payload.tableId },
          create: {
            tableId: payload.tableId,
            projectId: payload.projectId,
            sourceCommitSha: payload.sourceCommitSha,
            title: source.title,
            schemaText: source.schemaText,
          },
          update: {
            sourceCommitSha: payload.sourceCommitSha,
            title: source.title,
            schemaText: source.schemaText,
          },
        });
        return { outcome: "indexed" as const };
      }),
  );
  return result ?? { outcome: "missing" as const };
}

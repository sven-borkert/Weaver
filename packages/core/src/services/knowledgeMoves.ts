import { refreshEntityDescriptions } from "./knowledgeEntityDescriptions";
import { refreshGenerationCountersBatch } from "./knowledgeGenerations";
import { Prisma } from "@weaver/db/client";
import type { KnowledgeChunk } from "../knowledge/chunking";
import type { DocumentSourcePayload } from "./knowledgeSources";

// The caller holds the project lock and has verified identical chunks.
export async function preserveMovedDocumentKnowledge(
  tx: Prisma.TransactionClient,
  payload: DocumentSourcePayload,
  previousSha: string,
  previousChunks: Array<{ id: string }>,
  chunks: KnowledgeChunk[],
): Promise<void> {
  const states = await tx.knowledgeGenerationDocument.findMany({
    where: {
      projectId: payload.projectId,
      documentId: payload.documentId,
      targetSha: previousSha,
      semanticIndexedSha: previousSha,
      graphIndexedSha: previousSha,
      status: "ready",
      generation: {
        projectId: payload.projectId,
        status: { in: ["active", "building"] },
      },
    },
    include: { generation: true },
  });
  const reusable: string[] = [];
  for (const state of states) {
    const generation = state.generation;
    if (state.configFingerprint !== generation.configFingerprint) continue;
    const vectors = await tx.knowledgeEmbedding.count({
      where: {
        projectId: payload.projectId,
        generationId: generation.id,
        ownerType: "document_chunk",
        ownerId: { in: chunks.map((chunk) => chunk.id) },
        configFingerprint: generation.configFingerprint,
        embeddingDimensions: generation.embeddingDimensions,
      },
    });
    if (vectors === chunks.length) reusable.push(generation.id);
  }
  if (!reusable.length) return;
  if (chunks.length) {
    const mapping = Prisma.join(
      chunks.map(
        (chunk, index) =>
          Prisma.sql`(${previousChunks[index]!.id}, ${chunk.id})`,
      ),
    );
    for (const table of [
      Prisma.sql`"EntityMention"`,
      Prisma.sql`"RelationEvidence"`,
    ]) {
      await tx.$executeRaw(Prisma.sql`
        UPDATE ${table} AS evidence
        SET "sourceChunkId" = replacement."newId", "sourceCommitSha" = ${payload.sourceCommitSha}
        FROM (VALUES ${mapping}) AS replacement("oldId", "newId")
        WHERE evidence."sourceChunkId" = replacement."oldId"
          AND evidence."projectId" = ${payload.projectId}::uuid
          AND evidence."documentId" = ${payload.documentId}::uuid
          AND evidence."generationId" IN (${Prisma.join(reusable.map((id) => Prisma.sql`${id}::uuid`))})
          AND evidence."sourceCommitSha" = ${previousSha}
          AND evidence."invalidatedAt" IS NULL
      `);
    }
  }
  for (const generationId of reusable) {
    await refreshEntityDescriptions(tx, {
      projectId: payload.projectId,
      documentId: payload.documentId,
      generationId,
    });
  }
  await tx.knowledgeGenerationDocument.updateMany({
    where: {
      projectId: payload.projectId,
      documentId: payload.documentId,
      generationId: { in: reusable },
    },
    data: {
      targetSha: payload.sourceCommitSha,
      semanticIndexedSha: payload.sourceCommitSha,
      graphIndexedSha: payload.sourceCommitSha,
    },
  });
  // Other changed sources still contribute until their state-based transition deducts them.
  await refreshGenerationCountersBatch(
    tx,
    payload.projectId,
    reusable,
    "persisted",
  );
}

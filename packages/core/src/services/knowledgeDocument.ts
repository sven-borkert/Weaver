import { CoreError } from "@weaver/core/errors";
import {
  Prisma,
  type KnowledgeGeneration,
  type PrismaClient,
} from "@weaver/db/client";

import { documentIndexLights } from "../documents/indexLight";
import { isAiExempt } from "../knowledge/aiExempt";
import { generationEmbedding } from "../knowledge/generationEmbedding";
import { projectRoleAtLeast } from "../roles";
import { cachedKnowledgeRouting } from "./llmRoutes";
import { assertProjectRole, type ProjectActor } from "./projectAccess";

const ENTITY_LIMIT = 50;

type DocumentKnowledgeInput = { projectId: string; documentId: string };

/** One document's keyword, semantic and graph index state; model names only for Maintainer+. */
export async function getDocumentKnowledge(
  db: PrismaClient,
  input: DocumentKnowledgeInput,
  actor: ProjectActor,
) {
  const access = await assertProjectRole(db, input.projectId, actor, "Viewer", {
    capability: "content:read",
  });
  const projectId = access.project.id;
  const includeModels = projectRoleAtLeast(access.effectiveRole, "Maintainer");
  const document = await db.document.findFirst({
    where: { id: input.documentId, projectId },
    select: { id: true, headCommitSha: true, wikiSourceItemId: true },
  });
  if (!document) throw new CoreError("NOT_FOUND");
  const head = document.headCommitSha;

  const [keyword, chunkCount, active, building, routing] = await Promise.all([
    db.documentIndexState.findFirst({
      where: { documentId: document.id, projectId },
      select: {
        status: true,
        targetSha: true,
        keywordIndexedSha: true,
        attempts: true,
        lastAttemptAt: true,
        completedAt: true,
        failureKind: true,
        failureSummary: true,
      },
    }),
    db.documentSearchChunk.count({
      where: {
        projectId,
        documentId: document.id,
        sourceCommitSha: head,
        supersededAt: null,
      },
    }),
    findGeneration(db, projectId, "active"),
    findGeneration(db, projectId, "building"),
    cachedKnowledgeRouting(db),
  ]);
  const generations = [active, building].filter(
    (generation): generation is KnowledgeGeneration => generation !== null,
  );
  const generationIds = generations.map((generation) => generation.id);

  const [states, embeddedChunks, graph] = await Promise.all([
    db.knowledgeGenerationDocument.findMany({
      where: {
        projectId,
        documentId: document.id,
        generationId: { in: generationIds },
      },
    }),
    countEmbeddedChunks(db, projectId, document, generationIds),
    active
      ? loadDocumentGraph(db, projectId, active.id, document.id)
      : Promise.resolve(null),
  ]);
  const stateFor = (generationId: string) =>
    states.find((state) => state.generationId === generationId) ?? null;

  const lightGeneration = active ?? building;
  const lightState = lightGeneration ? stateFor(lightGeneration.id) : null;
  const lights = documentIndexLights(
    {
      headCommitSha: head,
      keywordStatus: keyword?.status ?? null,
      keywordTargetSha: keyword?.targetSha ?? null,
      keywordIndexedSha: keyword?.keywordIndexedSha ?? null,
      keywordFailureSummary: keyword?.failureSummary ?? null,
      generationStatus: lightState?.status ?? null,
      generationTargetSha: lightState?.targetSha ?? null,
      generationFingerprint: lightState?.configFingerprint ?? null,
      semanticIndexedSha: lightState?.semanticIndexedSha ?? null,
      graphIndexedSha: lightState?.graphIndexedSha ?? null,
      generationFailureSummary: lightState?.failureSummary ?? null,
    },
    lightGeneration,
    {
      coveredByBuild: active !== null && building !== null,
      aiExempt: isAiExempt(document),
    },
  );

  return {
    documentId: document.id,
    headCommitSha: head,
    lights,
    keyword: {
      status: keyword?.status ?? null,
      targetSha: keyword?.targetSha ?? null,
      indexedSha: keyword?.keywordIndexedSha ?? null,
      chunkCount,
      attempts: keyword?.attempts ?? 0,
      lastAttemptAt: keyword?.lastAttemptAt ?? null,
      completedAt: keyword?.completedAt ?? null,
      failureKind: keyword?.failureKind ?? null,
      failureSummary: keyword?.failureSummary ?? null,
    },
    generations: generations.map((generation) => {
      const state = stateFor(generation.id);
      return {
        id: generation.id,
        status: generation.status,
        graphCarried: generation.graphSourceGenerationId !== null,
        embedding: generationEmbedding(generation, {
          includeModel: includeModels,
        }),
        document: state
          ? {
              status: state.status,
              targetSha: state.targetSha,
              semanticIndexedSha: state.semanticIndexedSha,
              graphIndexedSha: state.graphIndexedSha,
              embeddedChunks: embeddedChunks.get(generation.id) ?? 0,
              extractionModel: includeModels ? state.extractionModel : null,
              // Mirrors the project-level count: the current graph came from another extraction route or prompt.
              extractionOutdated:
                routing !== null &&
                state.graphIndexedSha === head &&
                state.extractionFingerprint !== routing.extractionFingerprint,
              attempts: state.attempts,
              lastAttemptAt: state.lastAttemptAt,
              completedAt: state.completedAt,
              failureKind: state.failureKind,
              failureSummary: state.failureSummary,
            }
          : null,
      };
    }),
    graph: graph ?? {
      generationId: null,
      entityTotal: 0,
      relationTotal: 0,
      entities: [],
      truncated: false,
    },
  };
}

function findGeneration(
  db: PrismaClient,
  projectId: string,
  status: "active" | "building",
) {
  return db.knowledgeGeneration.findFirst({
    where: { projectId, status },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
  });
}

async function countEmbeddedChunks(
  db: PrismaClient,
  projectId: string,
  document: { id: string; headCommitSha: string },
  generationIds: string[],
): Promise<Map<string, number>> {
  if (generationIds.length === 0) return new Map();
  const rows = await db.$queryRaw<
    Array<{ generationId: string; count: number }>
  >(Prisma.sql`
    SELECT embedding."generationId"::text AS "generationId",
           count(*)::int AS "count"
    FROM "KnowledgeEmbedding" AS embedding
    JOIN "DocumentSearchChunk" AS chunk
      ON chunk."id" = embedding."ownerId"
     AND chunk."projectId" = embedding."projectId"
    WHERE embedding."projectId" = ${projectId}::uuid
      AND embedding."generationId" IN (${Prisma.join(
        generationIds.map((id) => Prisma.sql`${id}::uuid`),
      )})
      AND embedding."ownerType" = 'document_chunk'
      AND chunk."documentId" = ${document.id}::uuid
      AND chunk."sourceCommitSha" = ${document.headCommitSha}
      AND chunk."supersededAt" IS NULL
    GROUP BY embedding."generationId"
  `);
  return new Map(rows.map((row) => [row.generationId, row.count]));
}

async function loadDocumentGraph(
  db: PrismaClient,
  projectId: string,
  generationId: string,
  documentId: string,
) {
  const [entities, [totals]] = await Promise.all([
    db.$queryRaw<
      Array<{ id: string; name: string; type: string; mentions: number }>
    >(Prisma.sql`
      SELECT entity."id"::text AS "id",
             entity."canonicalName" AS "name",
             entity."entityType" AS "type",
             count(*)::int AS "mentions"
      FROM "EntityMention" AS mention
      JOIN "GraphEntity" AS entity
        ON entity."id" = mention."entityId"
       AND entity."projectId" = mention."projectId"
       AND entity."generationId" = mention."generationId"
      WHERE mention."projectId" = ${projectId}::uuid
        AND mention."generationId" = ${generationId}::uuid
        AND mention."documentId" = ${documentId}::uuid
        AND mention."invalidatedAt" IS NULL
      GROUP BY entity."id"
      ORDER BY "mentions" DESC, entity."canonicalName" ASC, entity."id" ASC
      LIMIT ${ENTITY_LIMIT + 1}
    `),
    db.$queryRaw<Array<{ entityTotal: number; relationTotal: number }>>(
      Prisma.sql`
        SELECT
          (SELECT count(DISTINCT mention."entityId")::int
             FROM "EntityMention" AS mention
            WHERE mention."projectId" = ${projectId}::uuid
              AND mention."generationId" = ${generationId}::uuid
              AND mention."documentId" = ${documentId}::uuid
              AND mention."invalidatedAt" IS NULL) AS "entityTotal",
          (SELECT count(DISTINCT evidence."relationId")::int
             FROM "RelationEvidence" AS evidence
            WHERE evidence."projectId" = ${projectId}::uuid
              AND evidence."generationId" = ${generationId}::uuid
              AND evidence."documentId" = ${documentId}::uuid
              AND evidence."invalidatedAt" IS NULL) AS "relationTotal"
      `,
    ),
  ]);
  return {
    generationId,
    entityTotal: totals?.entityTotal ?? 0,
    relationTotal: totals?.relationTotal ?? 0,
    entities: entities.slice(0, ENTITY_LIMIT),
    truncated: entities.length > ENTITY_LIMIT,
  };
}

import pgvector from "pgvector";

import { Prisma, type PrismaClient } from "@weaver/db/client";
import { normalizeKnowledgeName } from "@weaver/core/knowledge/extraction";
import { reciprocalRankFusion } from "@weaver/core/knowledge/ranking";
import {
  MAX_SEARCH_ALIASES,
  MAX_SEARCH_ALIAS_CHARACTERS,
  boundSearchAliases,
  boundSearchHeadingPath,
} from "@weaver/core/knowledge/publicBounds";
import {
  createDbCredentialSource,
  createKnowledgeProvider,
} from "../ai/registry";
import { AiProviderError, type AiProvider } from "../ai/types";
import { emitDiagnostic } from "../diagnostics/writer";
import { embeddingVectorType } from "../knowledge/vectorSql";
import { loadEncryptionKeyRing } from "../security/encryption";
import type { SecurityContext } from "../security/context";
import { embedQuery } from "./knowledgeEmbeddings";
import { cachedKnowledgeRouting, type KnowledgeRouting } from "./llmRoutes";
import { listProjectsForUser } from "./projects";
import {
  hashNormalizedTitle,
  loadLexicalDocuments,
  parameterizedProjectIds,
  type DocumentCandidate,
} from "./searchLexical";

const RRF_K = 60;
const EXACT_MATCH_BOOST = 0.25;
const SEARCH_SNIPPET_LIMIT = 240;
const TABLE_COLUMN_MATCH_LIMIT = 5;
/** Interactive searches fall back to keyword results instead of queueing behind indexing. */
export const QUERY_EMBEDDING_TIMEOUT_MS = 5_000;

export type SearchKnowledgeInput = {
  query: string;
  projectIds?: string[];
  limitPerGroup?: number;
};

export type SearchDocumentResult = {
  documentId: string;
  projectId: string;
  projectName: string;
  sourceCommitSha: string;
  title: string;
  slug: string;
  path: string;
  headingPath: string[];
  navigationAnchor: string | null;
  snippet: string;
  score: number;
};

export type SearchTableResult = {
  tableId: string;
  projectId: string;
  projectName: string;
  sourceCommitSha: string;
  title: string;
  slug: string;
  path: string;
  rowCount: number;
  matchingColumns: string[];
  score: number;
};

export type SearchEntityResult = {
  entityId: string;
  projectId: string;
  projectName: string;
  generationId: string;
  canonicalName: string;
  aliases: string[];
  entityType: string;
  description: string | null;
  score: number;
};

export type SearchKnowledgeResult = {
  mode: "hybrid" | "keyword";
  documents: SearchDocumentResult[];
  tables: SearchTableResult[];
  entities: SearchEntityResult[];
  partial: Array<"semantic_unavailable">;
};

type TableCandidate = {
  tableId: string;
  projectId: string;
  projectName: string;
  sourceCommitSha: string;
  title: string;
  slug: string;
  path: string;
  rowCount: number;
  schemaText: string;
  rank: number;
};

type EntityCandidate = {
  entityId: string;
  projectId: string;
  projectName: string;
  generationId: string;
  canonicalName: string;
  entityType: string;
  description: string | null;
  aliases: string[];
  rank?: number;
  distance?: number;
};

type SemanticSearchContext = {
  routing: KnowledgeRouting;
  provider: AiProvider;
  providerName: string;
  embeddingConnectionId: string;
  embeddingModel: string;
  embeddingDimensions: number;
  configFingerprint: string;
  inputCostMicrosPerMillion: number | null;
  outputCostMicrosPerMillion: number | null;
  currency: string | null;
};

export async function searchKnowledge(
  db: PrismaClient,
  input: SearchKnowledgeInput,
  actor: SecurityContext,
  override?: {
    routing: KnowledgeRouting;
    provider: AiProvider;
    queryEmbeddingTimeoutMs?: number;
  },
): Promise<SearchKnowledgeResult> {
  const query = input.query.trim();
  const limit = input.limitPerGroup ?? 8;
  const candidateLimit = limit * 4;
  const accessibleProjects = await listProjectsForUser(db, actor);
  const requestedIds = input.projectIds ? new Set(input.projectIds) : null;
  const allowedProjectIds = accessibleProjects
    .map((project) => project.id)
    .filter((projectId) => !requestedIds || requestedIds.has(projectId));
  const semanticContext = await resolveSemanticContext(db, override);

  if (allowedProjectIds.length === 0) {
    return {
      mode: semanticContext ? "hybrid" : "keyword",
      documents: [],
      tables: [],
      entities: [],
      partial: semanticContext ? [] : ["semantic_unavailable"],
    };
  }

  const [lexicalDocuments, lexicalTables, lexicalEntities] = await Promise.all([
    loadLexicalDocuments(db, allowedProjectIds, query, candidateLimit),
    loadLexicalTables(db, allowedProjectIds, query, candidateLimit),
    loadLexicalEntities(db, allowedProjectIds, query, candidateLimit),
  ]);

  let semanticDocuments: DocumentCandidate[] = [];
  let semanticEntities: EntityCandidate[] = [];
  let semanticAvailable = semanticContext !== null;
  if (semanticContext) {
    let vector: number[] | null = null;
    const timeoutMs =
      override?.queryEmbeddingTimeoutMs ?? QUERY_EMBEDDING_TIMEOUT_MS;
    const timeout = AbortSignal.timeout(timeoutMs);
    const startedAt = Date.now();
    try {
      vector = await embedQuery(db, semanticContext.provider, {
        query,
        providerName: semanticContext.providerName,
        embeddingConnectionId: semanticContext.embeddingConnectionId,
        embeddingModel: semanticContext.embeddingModel,
        embeddingDimensions: semanticContext.embeddingDimensions,
        configFingerprint: semanticContext.configFingerprint,
        inputCostMicrosPerMillion: semanticContext.inputCostMicrosPerMillion,
        outputCostMicrosPerMillion: semanticContext.outputCostMicrosPerMillion,
        currency: semanticContext.currency,
        signal: timeout,
      });
    } catch (error) {
      semanticAvailable = false;
      emitDiagnostic({
        event: "knowledge.search.degraded",
        severity: "warn",
        message: "semantic search unavailable; keyword results returned",
        details: {
          reason: timeout.aborted
            ? "timeout"
            : error instanceof AiProviderError && error.kind === "validation"
              ? "validation"
              : "provider",
          timeoutMs,
          durationMs: Date.now() - startedAt,
        },
      });
    }
    if (vector) {
      const generations = await db.knowledgeGeneration.findMany({
        where: {
          projectId: { in: allowedProjectIds },
          status: "active",
          embeddingDimensions: semanticContext.embeddingDimensions,
          configFingerprint: semanticContext.configFingerprint,
        },
        select: { id: true },
      });
      const generationIds = generations.map((generation) => generation.id);
      [semanticDocuments, semanticEntities] =
        generationIds.length === 0
          ? [[], []]
          : await Promise.all([
              loadSemanticDocuments(
                db,
                allowedProjectIds,
                vector,
                generationIds,
                candidateLimit,
                semanticContext.embeddingDimensions,
              ),
              loadSemanticEntities(
                db,
                allowedProjectIds,
                vector,
                generationIds,
                candidateLimit,
                semanticContext.embeddingDimensions,
              ),
            ]);
      if (semanticDocuments.length === 0 && semanticEntities.length === 0) {
        semanticAvailable = false;
      }
    }
  }

  return {
    mode: semanticAvailable ? "hybrid" : "keyword",
    documents: fuseDocuments(
      lexicalDocuments,
      semanticAvailable ? semanticDocuments : [],
      query,
      limit,
    ),
    tables: fuseTables(lexicalTables, query, limit),
    entities: fuseEntities(
      lexicalEntities,
      semanticAvailable ? semanticEntities : [],
      query,
      limit,
    ),
    partial: semanticAvailable ? [] : ["semantic_unavailable"],
  };
}

async function resolveSemanticContext(
  db: PrismaClient,
  override?: { routing: KnowledgeRouting; provider: AiProvider },
): Promise<SemanticSearchContext | null> {
  const routing = override?.routing ?? (await cachedKnowledgeRouting(db));
  if (!routing) return null;
  const provider =
    override?.provider ??
    createKnowledgeProvider(
      routing,
      createDbCredentialSource(db, loadEncryptionKeyRing()),
    );
  return {
    routing,
    provider,
    providerName: routing.embedding.providerType,
    embeddingConnectionId: routing.embedding.connectionId,
    embeddingModel: routing.embedding.providerModelId,
    embeddingDimensions: routing.embeddingDimensions,
    configFingerprint: routing.configFingerprint,
    inputCostMicrosPerMillion: routing.embedding.inputCostMicrosPerMillion,
    outputCostMicrosPerMillion: routing.embedding.outputCostMicrosPerMillion,
    currency: routing.embedding.currency,
  };
}

async function loadLexicalTables(
  db: PrismaClient,
  projectIds: string[],
  query: string,
  limit: number,
): Promise<TableCandidate[]> {
  const allowedProjects = parameterizedProjectIds(projectIds);
  const normalizedQuery = normalizeKnowledgeName(query);
  const normalizedQueryHash = hashNormalizedTitle(normalizedQuery);
  return db.$queryRaw<TableCandidate[]>(Prisma.sql`
    WITH search_query AS (
      SELECT websearch_to_tsquery('simple', ${query}) AS value
    ), allowed_projects AS (
      SELECT project."id", project."name"
      FROM "Project" AS project
      JOIN unnest(ARRAY[${allowedProjects}]::uuid[])
        AS allowed_project("projectId")
        ON allowed_project."projectId" = project."id"
      WHERE project."deletedAt" IS NULL
    ), exact_matches AS (
      SELECT exact_table."tableId" AS "tableId",
             exact_table."projectId" AS "projectId",
             project."name" AS "projectName",
             exact_table."sourceCommitSha" AS "sourceCommitSha",
             exact_table."title" AS "title",
             exact_table."slug" AS "slug",
             exact_table."path" AS "path",
             exact_table."rowCount" AS "rowCount",
             exact_table."schemaText" AS "schemaText",
             0::real AS "rank",
             true AS "exactMatch"
      FROM allowed_projects AS project
      CROSS JOIN LATERAL (
        SELECT table_row."id" AS "tableId",
               table_row."projectId" AS "projectId",
               table_row."headCommitSha" AS "sourceCommitSha",
               table_row."title" AS "title",
               table_row."slug" AS "slug",
               table_row."path" AS "path",
               table_row."rowCount" AS "rowCount",
               exact_projection."schemaText" AS "schemaText"
        FROM (
          SELECT exact_projection."tableId",
                 exact_projection."projectId",
                 exact_projection."sourceCommitSha",
                 exact_projection."title",
                 exact_projection."schemaText",
                 exact_projection."exactTitle"
          FROM "TableSearchProjection" AS exact_projection
          WHERE exact_projection."projectId" = project."id"
            AND exact_projection."exactNormalizedTitleHash" =
                ${normalizedQueryHash}
            AND exact_projection."exactNormalizedTitle" = ${normalizedQuery}
            AND exact_projection."exactTitle" IS NOT NULL
          ORDER BY exact_projection."exactTitle" ASC,
                   exact_projection."tableId" ASC
          LIMIT ${limit}
          OFFSET 0
        ) AS exact_projection
        JOIN "DataTable" AS table_row
          ON table_row."id" = exact_projection."tableId"
         AND table_row."projectId" = exact_projection."projectId"
         AND table_row."headCommitSha" =
             exact_projection."sourceCommitSha"
         AND table_row."title" = exact_projection."exactTitle"
         AND table_row."title" = exact_projection."title"
        ORDER BY table_row."title" ASC, table_row."id" ASC
      ) AS exact_table
      ORDER BY exact_table."title" ASC, exact_table."tableId" ASC
      LIMIT ${limit}
    ), full_text_matches AS (
      SELECT table_row."id" AS "tableId",
             table_row."projectId" AS "projectId",
             project."name" AS "projectName",
             table_row."headCommitSha" AS "sourceCommitSha",
             table_row."title" AS "title",
             table_row."slug" AS "slug",
             table_row."path" AS "path",
             table_row."rowCount" AS "rowCount",
             projection."schemaText" AS "schemaText",
             ts_rank_cd(projection."searchVector", search_query.value)
               AS "rank",
             false AS "exactMatch"
      FROM "TableSearchProjection" AS projection
      JOIN "DataTable" AS table_row
        ON table_row."id" = projection."tableId"
       AND table_row."projectId" = projection."projectId"
       AND table_row."headCommitSha" = projection."sourceCommitSha"
      JOIN "Project" AS project
        ON project."id" = table_row."projectId"
       AND project."deletedAt" IS NULL
      CROSS JOIN search_query
      WHERE projection."projectId" IN (${allowedProjects})
        AND projection."searchVector" @@ search_query.value
      ORDER BY "rank" DESC, table_row."title" ASC, table_row."id" ASC
      LIMIT ${limit}
    ), matches AS (
      SELECT * FROM exact_matches
      UNION ALL
      SELECT * FROM full_text_matches
    ), per_table AS (
      SELECT matches.*,
             row_number() OVER (
               PARTITION BY matches."tableId"
               ORDER BY matches."exactMatch" DESC,
                        matches."rank" DESC
             ) AS "tableRank"
      FROM matches
    )
    SELECT "tableId", "projectId", "projectName", "sourceCommitSha",
           "title", "slug", "path", "rowCount", "schemaText", "rank"
    FROM per_table
    WHERE "tableRank" = 1
    ORDER BY "exactMatch" DESC, "rank" DESC, "title" ASC, "tableId" ASC
    LIMIT ${limit}
  `);
}

async function loadLexicalEntities(
  db: PrismaClient,
  projectIds: string[],
  query: string,
  limit: number,
): Promise<EntityCandidate[]> {
  const allowedProjects = parameterizedProjectIds(projectIds);
  const normalizedQuery = normalizeKnowledgeName(query);
  return db.$queryRaw<EntityCandidate[]>(Prisma.sql`
    WITH search_query AS (
      SELECT websearch_to_tsquery('simple', ${query}) AS value
    ), entity_candidates AS MATERIALIZED (
      SELECT DISTINCT matches."id" FROM (
        (SELECT entity."id"
         FROM "GraphEntity" entity
         JOIN "KnowledgeGeneration" generation ON generation."id" = entity."generationId" AND generation."status" = 'active'
         WHERE entity."projectId" IN (${allowedProjects}) AND entity."normalizedName" = ${normalizedQuery}
           AND EXISTS (SELECT 1 FROM "EntityMention" mention WHERE mention."entityId" = entity."id" AND mention."invalidatedAt" IS NULL)
         ORDER BY entity."canonicalName", entity."id" LIMIT ${limit})
        UNION ALL
        (SELECT entity."id"
         FROM "GraphEntityAlias" alias
         JOIN "GraphEntity" entity ON entity."id" = alias."entityId" AND entity."projectId" = alias."projectId"
         JOIN "KnowledgeGeneration" generation ON generation."id" = entity."generationId" AND generation."status" = 'active'
         WHERE alias."projectId" IN (${allowedProjects}) AND alias."normalizedAlias" = ${normalizedQuery}
           AND EXISTS (SELECT 1 FROM "EntityMention" mention WHERE mention."entityId" = entity."id" AND mention."invalidatedAt" IS NULL)
         ORDER BY entity."canonicalName", entity."id" LIMIT ${limit})
        UNION ALL
        (SELECT entity."id"
         FROM "GraphEntity" entity
         JOIN "KnowledgeGeneration" generation ON generation."id" = entity."generationId" AND generation."status" = 'active'
         CROSS JOIN search_query
         WHERE entity."projectId" IN (${allowedProjects})
           AND (entity."searchVector" @@ search_query.value OR entity."normalizedName" = ${normalizedQuery})
           AND EXISTS (SELECT 1 FROM "EntityMention" mention WHERE mention."entityId" = entity."id" AND mention."invalidatedAt" IS NULL)
         LIMIT ${Math.min(2000, Math.max(200, limit * 20))})
        UNION ALL
        (SELECT entity."id"
         FROM "GraphEntityAlias" alias
         JOIN "GraphEntity" entity ON entity."id" = alias."entityId" AND entity."projectId" = alias."projectId"
         JOIN "KnowledgeGeneration" generation ON generation."id" = entity."generationId" AND generation."status" = 'active'
         CROSS JOIN search_query
         WHERE alias."projectId" IN (${allowedProjects})
           AND (alias."searchVector" @@ search_query.value OR alias."normalizedAlias" = ${normalizedQuery})
           AND EXISTS (SELECT 1 FROM "EntityMention" mention WHERE mention."entityId" = entity."id" AND mention."invalidatedAt" IS NULL)
         LIMIT ${Math.min(2000, Math.max(200, limit * 20))})
      ) matches
    )
    SELECT entity."id" AS "entityId",
           entity."projectId" AS "projectId",
           project."name" AS "projectName",
           entity."generationId" AS "generationId",
           entity."canonicalName" AS "canonicalName",
           entity."entityType" AS "entityType",
           entity."description" AS "description",
           alias_data."aliases" AS "aliases",
           GREATEST(
             ts_rank_cd(
               entity."searchVector",
               search_query.value
             ),
             alias_data."rank"
           ) AS "rank",
           (
             entity."normalizedName" = ${normalizedQuery}
             OR EXISTS (
               SELECT 1
               FROM "GraphEntityAlias" AS exact_alias
               WHERE exact_alias."entityId" = entity."id"
                 AND exact_alias."projectId" = entity."projectId"
                 AND exact_alias."normalizedAlias" = ${normalizedQuery}
             )
           ) AS "exactMatch"
    FROM "GraphEntity" AS entity
    JOIN entity_candidates candidates ON candidates."id" = entity."id"
    JOIN "KnowledgeGeneration" AS generation
      ON generation."id" = entity."generationId"
     AND generation."projectId" = entity."projectId"
     AND generation."status" = 'active'
    JOIN "Project" AS project
      ON project."id" = entity."projectId"
     AND project."deletedAt" IS NULL
    CROSS JOIN search_query
    LEFT JOIN LATERAL (
      SELECT coalesce(
               array_agg(
                 left(alias."alias", ${MAX_SEARCH_ALIAS_CHARACTERS})
                 ORDER BY alias."normalizedAlias", alias."id"
               ),
               ARRAY[]::text[]
             ) AS "aliases",
             coalesce(
               max(ts_rank_cd(alias."searchVector", search_query.value)),
               0
             ) AS "rank"
      FROM (
        SELECT candidate.*
        FROM "GraphEntityAlias" AS candidate
        WHERE candidate."entityId" = entity."id"
          AND candidate."projectId" = entity."projectId"
        ORDER BY candidate."normalizedAlias", candidate."id"
        LIMIT ${MAX_SEARCH_ALIASES}
      ) AS alias
    ) AS alias_data ON true
    WHERE entity."projectId" IN (${allowedProjects})
      AND EXISTS (SELECT 1 FROM "EntityMention" AS live_mention WHERE live_mention."entityId" = entity."id" AND live_mention."projectId" = entity."projectId" AND live_mention."invalidatedAt" IS NULL)
    ORDER BY "exactMatch" DESC, "rank" DESC,
             entity."canonicalName" ASC, entity."id" ASC
    LIMIT ${limit}
  `);
}

async function loadSemanticDocuments(
  db: PrismaClient,
  projectIds: string[],
  vector: number[],
  generationIds: string[],
  limit: number,
  dimensions: number,
): Promise<DocumentCandidate[]> {
  const allowedProjects = parameterizedProjectIds(projectIds);
  const queryVector = pgvector.toSql(vector);
  const vectorType = embeddingVectorType(dimensions);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL hnsw.iterative_scan = 'strict_order'`;
    await tx.$executeRaw`SET LOCAL hnsw.ef_search = 100`;
    return tx.$queryRaw<DocumentCandidate[]>(Prisma.sql`
    WITH nearest_embeddings AS MATERIALIZED (
      SELECT e.* FROM "KnowledgeEmbedding" AS e
      WHERE e."projectId" IN (${allowedProjects})
        AND e."ownerType" = 'document_chunk'
        AND e."generationId" IN (${parameterizedProjectIds(generationIds)})
        AND e."embeddingDimensions" = ${dimensions}
        AND EXISTS (SELECT 1 FROM "KnowledgeGeneration" g WHERE g."id" = e."generationId" AND g."projectId" = e."projectId" AND g."status" = 'active')
      ORDER BY (e."embedding"::${vectorType} <=> ${queryVector}::${vectorType}) ASC
      LIMIT ${limit * 20}
    ), ranked_chunks AS (
      SELECT document."id" AS "documentId",
             document."projectId" AS "projectId",
             project."name" AS "projectName",
             document."headCommitSha" AS "sourceCommitSha",
             document."title" AS "title",
             document."slug" AS "slug",
             document."path" AS "path",
             chunk."headingPath" AS "headingPath",
             chunk."navigationAnchor" AS "navigationAnchor",
             chunk."content" AS "content",
             (e."embedding"::${vectorType}
               <=> ${queryVector}::${vectorType}) AS "distance",
             row_number() OVER (
               PARTITION BY document."projectId", document."id"
               ORDER BY (e."embedding"::${vectorType}
                           <=> ${queryVector}::${vectorType}) ASC,
                        chunk."ordinal" ASC,
                        chunk."id" ASC
             ) AS "documentRank"
      FROM nearest_embeddings AS e
      JOIN "KnowledgeGeneration" AS generation
        ON generation."id" = e."generationId"
       AND generation."projectId" = e."projectId"
       AND generation."status" = 'active'
       AND generation."embeddingDimensions" = ${dimensions}
       AND generation."id" IN (${parameterizedProjectIds(generationIds)})
       AND generation."configFingerprint" = e."configFingerprint"
      JOIN "DocumentSearchChunk" AS chunk
        ON chunk."id" = e."ownerId"
       AND chunk."projectId" = e."projectId"
       AND chunk."supersededAt" IS NULL
      JOIN "Document" AS document
        ON document."id" = chunk."documentId"
       AND document."projectId" = chunk."projectId"
       AND document."headCommitSha" = chunk."sourceCommitSha"
      JOIN "DocumentIndexState" AS keyword_state
        ON keyword_state."documentId" = document."id"
       AND keyword_state."projectId" = document."projectId"
       AND keyword_state."targetSha" = document."headCommitSha"
       AND keyword_state."keywordIndexedSha" = document."headCommitSha"
       AND keyword_state."status" = 'ready'
      JOIN "KnowledgeGenerationDocument" AS generation_document
        ON generation_document."generationId" = generation."id"
       AND generation_document."documentId" = document."id"
       AND generation_document."projectId" = document."projectId"
       AND generation_document."targetSha" = document."headCommitSha"
       AND generation_document."semanticIndexedSha" = document."headCommitSha"
       AND generation_document."configFingerprint" = generation."configFingerprint"
      JOIN "Project" AS project
        ON project."id" = document."projectId"
       AND project."deletedAt" IS NULL
      WHERE e."projectId" IN (${allowedProjects})
        AND e."ownerType" = 'document_chunk'
        AND e."embeddingDimensions" = ${dimensions}
    )
    SELECT "documentId", "projectId", "projectName", "sourceCommitSha",
           "title", "slug", "path", "headingPath", "navigationAnchor",
           "content", "distance"
    FROM ranked_chunks
    WHERE "documentRank" = 1
    ORDER BY "distance" ASC, "title" ASC, "documentId" ASC
    LIMIT ${limit}
  `);
  });
}

async function loadSemanticEntities(
  db: PrismaClient,
  projectIds: string[],
  vector: number[],
  generationIds: string[],
  limit: number,
  dimensions: number,
): Promise<EntityCandidate[]> {
  const allowedProjects = parameterizedProjectIds(projectIds);
  const queryVector = pgvector.toSql(vector);
  const vectorType = embeddingVectorType(dimensions);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL hnsw.iterative_scan = 'strict_order'`;
    await tx.$executeRaw`SET LOCAL hnsw.ef_search = 100`;
    return tx.$queryRaw<EntityCandidate[]>(Prisma.sql`
    SELECT entity."id" AS "entityId",
           entity."projectId" AS "projectId",
           project."name" AS "projectName",
           entity."generationId" AS "generationId",
           entity."canonicalName" AS "canonicalName",
           entity."entityType" AS "entityType",
           entity."description" AS "description",
           ARRAY(
             SELECT left(alias."alias", ${MAX_SEARCH_ALIAS_CHARACTERS})
             FROM "GraphEntityAlias" AS alias
             WHERE alias."entityId" = entity."id"
               AND alias."projectId" = entity."projectId"
             ORDER BY alias."normalizedAlias" ASC, alias."id" ASC
             LIMIT ${MAX_SEARCH_ALIASES}
           ) AS "aliases",
           (e."embedding"::${vectorType}
             <=> ${queryVector}::${vectorType}) AS "distance"
    FROM "KnowledgeEmbedding" AS e
    JOIN "KnowledgeGeneration" AS generation
      ON generation."id" = e."generationId"
     AND generation."projectId" = e."projectId"
     AND generation."status" = 'active'
     AND generation."embeddingDimensions" = ${dimensions}
     AND generation."id" IN (${parameterizedProjectIds(generationIds)})
     AND generation."configFingerprint" = e."configFingerprint"
    JOIN "GraphEntity" AS entity
      ON entity."id"::text = e."ownerId"
     AND entity."projectId" = e."projectId"
     AND entity."generationId" = generation."id"
    JOIN "Project" AS project
      ON project."id" = entity."projectId"
     AND project."deletedAt" IS NULL
    WHERE e."projectId" IN (${allowedProjects})
      AND e."ownerType" = 'entity'
      AND EXISTS (SELECT 1 FROM "EntityMention" AS live_mention WHERE live_mention."entityId" = entity."id" AND live_mention."projectId" = entity."projectId" AND live_mention."invalidatedAt" IS NULL)
      AND e."embeddingDimensions" = ${dimensions}
    ORDER BY (e."embedding"::${vectorType}
                <=> ${queryVector}::${vectorType}) ASC,
             entity."canonicalName" ASC,
             entity."id" ASC
    LIMIT ${limit}
  `);
  });
}

function fuseDocuments(
  lexical: DocumentCandidate[],
  semantic: DocumentCandidate[],
  query: string,
  limit: number,
): SearchDocumentResult[] {
  const candidates = new Map<string, DocumentCandidate>();
  for (const candidate of semantic) {
    candidates.set(candidate.documentId, candidate);
  }
  for (const candidate of lexical) {
    candidates.set(candidate.documentId, candidate);
  }
  const normalizedQuery = normalizeKnowledgeName(query);
  const ranked = reciprocalRankFusion(
    [
      lexical.map((candidate) => ({
        kind: "document",
        id: candidate.documentId,
      })),
      semantic.map((candidate) => ({
        kind: "document",
        id: candidate.documentId,
      })),
    ],
    {
      k: RRF_K,
      boosts: [...candidates.values()]
        .filter(
          (candidate) =>
            normalizeKnowledgeName(candidate.title) === normalizedQuery,
        )
        .map((candidate) => ({
          kind: "document",
          id: candidate.documentId,
          score: EXACT_MATCH_BOOST,
        })),
    },
  );

  return ranked.slice(0, limit).map((item) => {
    const candidate = candidates.get(item.id)!;
    return {
      documentId: candidate.documentId,
      projectId: candidate.projectId,
      projectName: candidate.projectName,
      sourceCommitSha: candidate.sourceCommitSha,
      title: candidate.title,
      slug: candidate.slug,
      path: candidate.path,
      headingPath: boundSearchHeadingPath(candidate.headingPath),
      navigationAnchor: candidate.navigationAnchor,
      snippet: boundedText(candidate.content),
      score: item.score,
    };
  });
}

function fuseTables(
  lexical: TableCandidate[],
  query: string,
  limit: number,
): SearchTableResult[] {
  const candidates = new Map(
    lexical.map((candidate) => [candidate.tableId, candidate]),
  );
  const normalizedQuery = normalizeKnowledgeName(query);
  const ranked = reciprocalRankFusion(
    [
      lexical.map((candidate) => ({
        kind: "table",
        id: candidate.tableId,
      })),
    ],
    {
      k: RRF_K,
      boosts: lexical
        .filter(
          (candidate) =>
            normalizeKnowledgeName(candidate.title) === normalizedQuery,
        )
        .map((candidate) => ({
          kind: "table",
          id: candidate.tableId,
          score: EXACT_MATCH_BOOST,
        })),
    },
  );

  return ranked.slice(0, limit).map((item) => {
    const candidate = candidates.get(item.id)!;
    return {
      tableId: candidate.tableId,
      projectId: candidate.projectId,
      projectName: candidate.projectName,
      sourceCommitSha: candidate.sourceCommitSha,
      title: candidate.title,
      slug: candidate.slug,
      path: candidate.path,
      rowCount: candidate.rowCount,
      matchingColumns: matchingColumns(candidate.schemaText, query),
      score: item.score,
    };
  });
}

function fuseEntities(
  lexical: EntityCandidate[],
  semantic: EntityCandidate[],
  query: string,
  limit: number,
): SearchEntityResult[] {
  const candidates = new Map<string, EntityCandidate>();
  for (const candidate of semantic) {
    candidates.set(candidate.entityId, candidate);
  }
  for (const candidate of lexical) {
    candidates.set(candidate.entityId, candidate);
  }
  const normalizedQuery = normalizeKnowledgeName(query);
  const ranked = reciprocalRankFusion(
    [
      lexical.map((candidate) => ({
        kind: "entity",
        id: candidate.entityId,
      })),
      semantic.map((candidate) => ({
        kind: "entity",
        id: candidate.entityId,
      })),
    ],
    {
      k: RRF_K,
      boosts: [...candidates.values()]
        .filter(
          (candidate) =>
            normalizeKnowledgeName(candidate.canonicalName) === normalizedQuery,
        )
        .map((candidate) => ({
          kind: "entity",
          id: candidate.entityId,
          score: EXACT_MATCH_BOOST,
        })),
    },
  );

  return ranked.slice(0, limit).map((item) => {
    const candidate = candidates.get(item.id)!;
    return {
      entityId: candidate.entityId,
      projectId: candidate.projectId,
      projectName: candidate.projectName,
      generationId: candidate.generationId,
      canonicalName: candidate.canonicalName,
      aliases: boundSearchAliases(candidate.aliases),
      entityType: candidate.entityType,
      description:
        candidate.description === null
          ? null
          : boundedText(candidate.description),
      score: item.score,
    };
  });
}

function matchingColumns(schemaText: string, query: string): string[] {
  const normalizedQuery = normalizeKnowledgeName(query);
  const terms = normalizedQuery
    .split(/\s+/u)
    .filter((term) => term && !["and", "or", "not"].includes(term));
  return schemaText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      const normalizedLine = normalizeKnowledgeName(line);
      return (
        normalizedLine.includes(normalizedQuery) ||
        terms.some((term) => normalizedLine.includes(term))
      );
    })
    .slice(0, TABLE_COLUMN_MATCH_LIMIT)
    .map((line) => boundedText(line, 200));
}

function boundedText(value: string, maxLength = SEARCH_SNIPPET_LIMIT): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, maxLength).trimEnd();
}

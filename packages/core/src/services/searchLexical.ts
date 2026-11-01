import { createHash } from "node:crypto";

import { Prisma, type PrismaClient } from "@weaver/db/client";
import { normalizeKnowledgeName } from "@weaver/core/knowledge/extraction";

export type DocumentCandidate = {
  documentId: string;
  projectId: string;
  projectName: string;
  sourceCommitSha: string;
  title: string;
  slug: string;
  path: string;
  headingPath: string[];
  navigationAnchor: string | null;
  content: string;
  rank?: number;
  distance?: number;
};

export function parameterizedProjectIds(projectIds: string[]): Prisma.Sql {
  return Prisma.join(
    projectIds.map((projectId) => Prisma.sql`${projectId}::uuid`),
  );
}

export function hashNormalizedTitle(normalizedTitle: string): Buffer {
  return createHash("sha256").update(normalizedTitle, "utf8").digest();
}

/** Same-project keyword candidates: exact-title hits first (rank 0), then ts_rank_cd matches. */
export async function loadLexicalDocuments(
  db: PrismaClient,
  projectIds: string[],
  query: string,
  limit: number,
): Promise<DocumentCandidate[]> {
  const allowedProjects = parameterizedProjectIds(projectIds);
  const normalizedQuery = normalizeKnowledgeName(query);
  const normalizedQueryHash = hashNormalizedTitle(normalizedQuery);
  return db.$queryRaw<DocumentCandidate[]>(Prisma.sql`
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
      SELECT exact_document."documentId" AS "documentId",
             exact_document."projectId" AS "projectId",
             project."name" AS "projectName",
             exact_document."sourceCommitSha" AS "sourceCommitSha",
             exact_document."title" AS "title",
             exact_document."slug" AS "slug",
             exact_document."path" AS "path",
             coalesce(exact_document."headingPath", ARRAY[]::text[])
               AS "headingPath",
             exact_document."navigationAnchor" AS "navigationAnchor",
             coalesce(exact_document."content", '') AS "content",
             0::real AS "rank",
             true AS "exactMatch",
             coalesce(exact_document."ordinal", 2147483647) AS "ordinal",
             coalesce(exact_document."chunkId", '') AS "chunkId"
      FROM allowed_projects AS project
      CROSS JOIN LATERAL (
        SELECT document."id" AS "documentId",
               document."projectId" AS "projectId",
               document."headCommitSha" AS "sourceCommitSha",
               document."title" AS "title",
               document."slug" AS "slug",
               document."path" AS "path",
               exact_chunk."headingPath" AS "headingPath",
               exact_chunk."navigationAnchor" AS "navigationAnchor",
               exact_chunk."content" AS "content",
               exact_chunk."ordinal" AS "ordinal",
               exact_chunk."id" AS "chunkId"
        FROM (
          SELECT exact_state."documentId",
                 exact_state."exactProjectId" AS "projectId",
                 exact_state."targetSha",
                 exact_state."exactTitle"
          FROM "DocumentIndexState" AS exact_state
          WHERE exact_state."exactProjectId" = project."id"
            AND exact_state."exactNormalizedTitleHash" =
                ${normalizedQueryHash}
            AND exact_state."exactNormalizedTitle" = ${normalizedQuery}
          ORDER BY exact_state."exactTitle" ASC,
                   exact_state."documentId" ASC
          LIMIT ${limit}
          OFFSET 0
        ) AS exact_state
        JOIN "Document" AS document
          ON document."id" = exact_state."documentId"
         AND document."projectId" = exact_state."projectId"
         AND document."headCommitSha" = exact_state."targetSha"
         AND document."title" = exact_state."exactTitle"
        LEFT JOIN LATERAL (
          SELECT chunk."id", chunk."ordinal", chunk."headingPath",
                 chunk."navigationAnchor", chunk."content"
          FROM "DocumentSearchChunk" AS chunk
          WHERE chunk."documentId" = document."id"
            AND chunk."projectId" = document."projectId"
            AND chunk."sourceCommitSha" = document."headCommitSha"
            AND chunk."supersededAt" IS NULL
          ORDER BY chunk."ordinal" ASC, chunk."id" ASC
          LIMIT 1
        ) AS exact_chunk ON true
        ORDER BY document."title" ASC, document."id" ASC
      ) AS exact_document
      ORDER BY exact_document."title" ASC, exact_document."documentId" ASC
      LIMIT ${limit}
    ), chunk_candidates AS MATERIALIZED (
      SELECT chunk.*
      FROM "DocumentSearchChunk" chunk
      JOIN "Document" document ON document."id" = chunk."documentId"
        AND document."projectId" = chunk."projectId" AND document."headCommitSha" = chunk."sourceCommitSha"
      JOIN "DocumentIndexState" state ON state."documentId" = document."id"
        AND state."projectId" = document."projectId" AND state."targetSha" = document."headCommitSha"
        AND state."keywordIndexedSha" = document."headCommitSha" AND state."status" = 'ready'
      JOIN allowed_projects project ON project."id" = chunk."projectId"
      CROSS JOIN search_query
      WHERE chunk."supersededAt" IS NULL AND chunk."searchVector" @@ search_query.value
      LIMIT ${Math.min(2000, Math.max(200, limit * 20))}
    ), full_text_chunk_matches AS (
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
             ts_rank_cd(chunk."searchVector", search_query.value) AS "rank",
             false AS "exactMatch",
             chunk."ordinal" AS "ordinal",
             chunk."id" AS "chunkId",
             row_number() OVER (
               PARTITION BY document."id"
               ORDER BY ts_rank_cd(chunk."searchVector", search_query.value) DESC,
                        chunk."ordinal" ASC,
                        chunk."id" ASC
             ) AS "documentRank"
      FROM chunk_candidates AS chunk
      JOIN "Document" AS document
        ON document."id" = chunk."documentId"
       AND document."projectId" = chunk."projectId"
       AND document."headCommitSha" = chunk."sourceCommitSha"
      JOIN "Project" AS project
        ON project."id" = document."projectId"
       AND project."deletedAt" IS NULL
      JOIN "DocumentIndexState" AS state
        ON state."documentId" = document."id"
       AND state."projectId" = document."projectId"
       AND state."targetSha" = document."headCommitSha"
       AND state."keywordIndexedSha" = document."headCommitSha"
       AND state."status" = 'ready'
      CROSS JOIN search_query
      WHERE chunk."projectId" IN (${allowedProjects})
        AND chunk."supersededAt" IS NULL
        AND chunk."searchVector" @@ search_query.value
    ), full_text_matches AS (
      SELECT "documentId", "projectId", "projectName", "sourceCommitSha",
             "title", "slug", "path", "headingPath", "navigationAnchor",
             "content", "rank",
             "exactMatch", "ordinal", "chunkId"
      FROM full_text_chunk_matches
      WHERE "documentRank" = 1
      ORDER BY "rank" DESC, "title" ASC, "documentId" ASC
      LIMIT ${limit}
    ), matches AS (
      SELECT * FROM exact_matches
      UNION ALL
      SELECT * FROM full_text_matches
    ), per_document AS (
      SELECT matches.*,
             row_number() OVER (
               PARTITION BY matches."documentId"
               ORDER BY matches."exactMatch" DESC,
                        matches."rank" DESC,
                        matches."ordinal" ASC,
                        matches."chunkId" ASC
             ) AS "documentRank"
      FROM matches
    )
    SELECT "documentId", "projectId", "projectName", "sourceCommitSha",
           "title", "slug", "path", "headingPath", "navigationAnchor",
           "content", "rank"
    FROM per_document
    WHERE "documentRank" = 1
    ORDER BY "exactMatch" DESC, "rank" DESC, "title" ASC, "documentId" ASC
    LIMIT ${limit}
  `);
}

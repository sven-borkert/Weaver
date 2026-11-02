import { readFile } from "node:fs/promises";
import path from "node:path";

import { Client } from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { INDEXED_EMBEDDING_DIMENSIONS } from "@weaver/core/knowledge/dimensions";
import { getPrisma, makeProject, resetDb } from "./_harness";

const transitionMigrationPath = path.join(
  process.cwd(),
  "packages/db/prisma/migrations/20260830133000_search_exact_title_transition_reconcile/migration.sql",
);

describe("knowledge schema", () => {
  beforeEach(resetDb);

  it("installs vector and the application-owned search indexes", async () => {
    const db = getPrisma();
    const extension = await db.$queryRaw<Array<{ extversion: string }>>`
      SELECT extversion FROM pg_extension WHERE extname = 'vector'
    `;
    expect(extension[0]?.extversion).toMatch(/^0\.8\./);
    const indexes = await db.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes
      WHERE indexname IN (
        'DocumentSearchChunk_searchVector_idx',
        'TableSearchProjection_searchVector_idx',
        'GraphEntity_searchVector_idx',
        'GraphEntityAlias_searchVector_idx',
        'KnowledgeEmbedding_embedding_1536_hnsw_idx'
      ) ORDER BY indexname
    `;
    expect(indexes.map((row) => row.indexname)).toEqual([
      "DocumentSearchChunk_searchVector_idx",
      "GraphEntityAlias_searchVector_idx",
      "GraphEntity_searchVector_idx",
      "KnowledgeEmbedding_embedding_1536_hnsw_idx",
      "TableSearchProjection_searchVector_idx",
    ]);
  });

  it("stores an embedding dimension mode with a native default", async () => {
    const columns = await getPrisma().$queryRaw<
      Array<{ dataType: string; columnDefault: string | null }>
    >`
      SELECT data_type AS "dataType", column_default AS "columnDefault"
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'LlmModel'
        AND column_name = 'embeddingDimensionMode'
    `;

    expect(columns).toEqual([
      {
        dataType: "USER-DEFINED",
        columnDefault: "'native'::\"LlmEmbeddingDimensionMode\"",
      },
    ]);
  });

  it("reconciles eligibility stranded before source insert refresh was installed", async () => {
    const db = getPrisma();
    const project = await makeProject("Stranded exact-title eligibility");
    const documentId = "11111111-1111-4111-8111-111111111111";
    const tableId = "22222222-2222-4222-8222-222222222222";
    const sourceCommitSha = "a".repeat(40);
    await db.documentIndexState.create({
      data: {
        documentId,
        projectId: project.id,
        targetSha: sourceCommitSha,
        keywordIndexedSha: sourceCommitSha,
        status: "ready",
      },
    });
    await db.tableSearchProjection.create({
      data: {
        tableId,
        projectId: project.id,
        sourceCommitSha,
        title: "Atlas Stranded",
        schemaText: "Owner (text)",
      },
    });
    const migrationSql = await readFile(transitionMigrationPath, "utf8");
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query("BEGIN");
    try {
      await client.query(
        'ALTER TABLE "Document" DISABLE TRIGGER "Document_refresh_exact_title_insert"',
      );
      await client.query(
        'ALTER TABLE "DataTable" DISABLE TRIGGER "DataTable_refresh_exact_title_insert"',
      );
      await client.query(
        `INSERT INTO "Document" (
          "id", "projectId", "path", "slug", "title", "excerpt",
          "headCommitSha", "lastEditedAt", "createdAt", "updatedAt"
        ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, '', $6, now(), now(), now())`,
        [
          documentId,
          project.id,
          "documents/atlas-stranded.md",
          "atlas-stranded",
          "Atlas Stranded",
          sourceCommitSha,
        ],
      );
      await client.query(
        `INSERT INTO "DataTable" (
          "id", "projectId", "path", "slug", "title", "rowCount",
          "headCommitSha", "lastEditedAt", "createdAt"
        ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, 0, $6, now(), now())`,
        [
          tableId,
          project.id,
          "tables/atlas-stranded",
          "atlas-stranded",
          "Atlas Stranded",
          sourceCommitSha,
        ],
      );
      // ALTER TABLE refuses pending deferred FK events from the inserts above.
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      await client.query(
        'ALTER TABLE "Document" ENABLE TRIGGER "Document_refresh_exact_title_insert"',
      );
      await client.query(
        'ALTER TABLE "DataTable" ENABLE TRIGGER "DataTable_refresh_exact_title_insert"',
      );
      const before = await client.query<{
        documentTitle: string | null;
        tableTitle: string | null;
      }>(`
        SELECT state."exactTitle" AS "documentTitle",
               projection."exactTitle" AS "tableTitle"
        FROM "DocumentIndexState" AS state
        CROSS JOIN "TableSearchProjection" AS projection
        WHERE state."documentId" = '${documentId}'::uuid
          AND projection."tableId" = '${tableId}'::uuid
      `);
      expect(before.rows).toEqual([{ documentTitle: null, tableTitle: null }]);

      await client.query(migrationSql);

      const after = await client.query<{
        documentTitle: string | null;
        tableTitle: string | null;
      }>(`
        SELECT state."exactTitle" AS "documentTitle",
               projection."exactTitle" AS "tableTitle"
        FROM "DocumentIndexState" AS state
        CROSS JOIN "TableSearchProjection" AS projection
        WHERE state."documentId" = '${documentId}'::uuid
          AND projection."tableId" = '${tableId}'::uuid
      `);
      expect(after.rows).toEqual([
        {
          documentTitle: "Atlas Stranded",
          tableTitle: "Atlas Stranded",
        },
      ]);
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  });

  it("indexes every listed knowledge embedding size", async () => {
    const rows = await getPrisma().$queryRaw<
      Array<{ indexname: string; indexdef: string }>
    >`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'KnowledgeEmbedding'
        AND indexname LIKE 'KnowledgeEmbedding_embedding_%'
    `;
    const expected = INDEXED_EMBEDDING_DIMENSIONS.map((size) =>
      size > 2000
        ? `KnowledgeEmbedding_embedding_${size}_halfvec_hnsw_idx`
        : `KnowledgeEmbedding_embedding_${size}_hnsw_idx`,
    ).sort();
    expect(rows.map((row) => row.indexname).sort()).toEqual(expected);
    for (const row of rows) {
      expect(row.indexdef).toContain("USING hnsw");
      expect(row.indexdef).toMatch(/WHERE \("embeddingDimensions" = \d+\)/);
    }
  });

  it("records where a generation's graph was copied from", async () => {
    const columns = await getPrisma().$queryRaw<
      Array<{ dataType: string; nullable: string }>
    >`
      SELECT data_type AS "dataType", is_nullable AS "nullable"
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'KnowledgeGeneration'
        AND column_name = 'graphSourceGenerationId'
    `;
    expect(columns).toEqual([{ dataType: "uuid", nullable: "YES" }]);
  });
});

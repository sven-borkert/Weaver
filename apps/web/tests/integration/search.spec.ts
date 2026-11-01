import { createHash, randomUUID } from "node:crypto";

import pgvector from "pgvector";
import { PrismaPg } from "@prisma/adapter-pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Prisma, PrismaClient } from "@weaver/db/client";
import type { KnowledgeRouting } from "@weaver/core/services/llmRoutes";
import {
  invalidateLlmRouteCache,
  resolveKnowledgeRouting,
} from "@weaver/core/services/llmRoutes";
import type { AiProvider, EmbeddingResult } from "@weaver/core/ai/types";
import { AiProviderError } from "@weaver/core/ai/types";
import { searchKnowledge } from "@weaver/core/services/search";
import { updateLlmModel } from "@weaver/core/services/llmConnections";
import {
  addMembership,
  callerFor,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  seedTestLlmRouting,
  securityContextFor,
  testEncryptionKeys,
} from "./_harness";
import { sizedEmbeddingsFetch } from "./_knowledgePipeline";

const EMBEDDING_MODEL = "search-test-embedding";
const QUERY_USAGE = {
  inputTokens: 3,
  outputTokens: 0,
  cachedTokens: 0,
  totalTokens: 3,
  durationMs: 4,
};

let configSequence = 0;
let routing: KnowledgeRouting;
let routingAdmin: Awaited<ReturnType<typeof seedTestLlmRouting>>["admin"];

beforeEach(async () => {
  await resetDb();
  configSequence += 1;
  const seeded = await seedTestLlmRouting({
    endpoint: `https://search-${configSequence}.test/v1`,
    embeddingModel: EMBEDDING_MODEL,
    pricing: { input: 1_000_000, output: 1_000_000, currency: "USD" },
  });
  routing = seeded.routing;
  routingAdmin = seeded.admin;
});

describe("permission-aware hybrid search", () => {
  it("scans past closer embeddings from inaccessible projects with HNSW", async () => {
    const fixture = await setupSearchFixture("hnsw-filtered");
    const foreign = fixture.inaccessibleProject;
    const vector = pgvector.toSql(directionVector(1, 0));
    await fixture.db.$executeRaw(Prisma.sql`
      INSERT INTO "KnowledgeEmbedding" ("id", "projectId", "generationId", "ownerType", "ownerId",
        "contentHash", "configFingerprint", "model", "embeddingDimensions", "embedding", "createdAt")
      SELECT gen_random_uuid(), ${foreign.id}::uuid, ${foreign.activeGenerationId}::uuid,
        'document_chunk', 'noise-' || item::text, md5(item::text), ${foreign.fingerprint}, ${EMBEDDING_MODEL},
        1536, ${vector}::vector, timezone('UTC', now()) FROM generate_series(1, 300) item
    `);
    await fixture.db.$executeRaw(Prisma.sql`
      UPDATE "KnowledgeEmbedding" SET "embedding" = ${pgvector.toSql(directionVector(0.9, 0.44))}::vector
      WHERE "projectId" = ${fixture.secondProject.id}::uuid AND "ownerType" = 'document_chunk'
    `);
    const queryDb = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: process.env.DATABASE_URL!,
        options: "-c enable_seqscan=off -c enable_sort=off",
      }),
    });
    const observations: RawQueryObservation[] = [];
    try {
      const result = await searchKnowledge(
        observeRawQueries(queryDb, observations),
        { query: "Nebula", limitPerGroup: 4 },
        fixture.user,
        queryProvider(queryVector()),
      );
      expect(result.documents.map((row) => row.documentId)).toContain(
        fixture.semanticDocument.documentId,
      );
      const query = findObservedQuery(
        observations,
        "WITH nearest_embeddings",
      ).query;
      const plan = await queryDb.$queryRaw(
        Prisma.sql`EXPLAIN (FORMAT JSON) ${query}`,
      );
      expect(JSON.stringify(plan)).toContain(
        "KnowledgeEmbedding_embedding_1536_hnsw_idx",
      );
    } finally {
      await queryDb.$disconnect();
    }
  });

  it("uses the halfvec HNSW index for a size above 2,000 dimensions", async () => {
    const db = getPrisma();
    const dims = 2560;
    await updateLlmModel(
      db,
      securityContextFor(routingAdmin),
      { modelId: routing.embedding.modelId, embeddingDimensions: dims },
      {
        ring: testEncryptionKeys(),
        fetchImpl: sizedEmbeddingsFetch(() => dims),
      },
    );
    const halfvecRouting = (await resolveKnowledgeRouting(db))!;

    const user = await makeUser("User", "search-halfvec");
    const project = await makeProject("Halfvec project");
    await addMembership(project.id, user.id, "Viewer");
    const generation = await db.knowledgeGeneration.create({
      data: {
        projectId: project.id,
        configFingerprint: halfvecRouting.configFingerprint,
        embeddingModel: halfvecRouting.embedding.providerModelId,
        embeddingDimensions: dims,
        extractionSchemaVersion: 1,
        promptVersion: "prompt-v1",
        status: "active",
        completedAt: new Date(),
        activatedAt: new Date(),
      },
    });

    const documentId = randomUUID();
    const sourceCommitSha = createHash("sha1")
      .update(`${project.id}:halfvec`)
      .digest("hex");
    const content = "Halfvec content about Nebula recovery.";
    const chunkId = createHash("sha256")
      .update(`${documentId}:${sourceCommitSha}:0:${content}`)
      .digest("hex");
    const now = new Date();
    await db.document.create({
      data: {
        id: documentId,
        projectId: project.id,
        path: "documents/halfvec.md",
        slug: "halfvec",
        title: "Halfvec Doc",
        excerpt: content,
        headCommitSha: sourceCommitSha,
        lastEditedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
    await db.documentIndexState.create({
      data: {
        documentId,
        projectId: project.id,
        targetSha: sourceCommitSha,
        keywordIndexedSha: sourceCommitSha,
        status: "ready",
        completedAt: now,
      },
    });
    await db.documentSearchChunk.create({
      data: {
        id: chunkId,
        projectId: project.id,
        documentId,
        ordinal: 0,
        sourceCommitSha,
        contentHash: createHash("sha256").update(content).digest("hex"),
        headingPath: ["Halfvec"],
        content,
      },
    });
    await db.knowledgeGenerationDocument.create({
      data: {
        generationId: generation.id,
        documentId,
        projectId: project.id,
        targetSha: sourceCommitSha,
        semanticIndexedSha: sourceCommitSha,
        graphIndexedSha: sourceCommitSha,
        configFingerprint: halfvecRouting.configFingerprint,
        status: "ready",
        completedAt: now,
      },
    });

    const closeVector = sizedDirectionVector(dims, 1, 0);
    const farVector = sizedDirectionVector(dims, 0, 1);
    await db.$executeRaw(Prisma.sql`
      INSERT INTO "KnowledgeEmbedding"
        ("id", "projectId", "generationId", "ownerType", "ownerId",
         "contentHash", "configFingerprint", "model",
         "embeddingDimensions", "embedding", "createdAt")
      VALUES
        (${randomUUID()}::uuid, ${project.id}::uuid, ${generation.id}::uuid,
         'document_chunk', ${chunkId},
         ${createHash("sha256").update(content).digest("hex")},
         ${halfvecRouting.configFingerprint}, ${halfvecRouting.embedding.providerModelId},
         ${dims}, ${pgvector.toSql(closeVector)}::vector, now())
    `);
    await db.$executeRaw(Prisma.sql`
      INSERT INTO "KnowledgeEmbedding" ("id", "projectId", "generationId", "ownerType", "ownerId",
        "contentHash", "configFingerprint", "model", "embeddingDimensions", "embedding", "createdAt")
      SELECT gen_random_uuid(), ${project.id}::uuid, ${generation.id}::uuid,
        'document_chunk', 'noise-' || item::text, md5(item::text), ${halfvecRouting.configFingerprint}, ${halfvecRouting.embedding.providerModelId},
        ${dims}, ${pgvector.toSql(farVector)}::vector, timezone('UTC', now()) FROM generate_series(1, 300) item
    `);

    const queryDb = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: process.env.DATABASE_URL!,
        options: "-c enable_seqscan=off -c enable_sort=off",
      }),
    });
    const observations: RawQueryObservation[] = [];
    try {
      const result = await searchKnowledge(
        observeRawQueries(queryDb, observations),
        { query: "Nebula", projectIds: [project.id], limitPerGroup: 4 },
        securityContextFor(user),
        fixedVectorProvider(halfvecRouting, closeVector),
      );
      expect(result.documents.map((row) => row.documentId)).toContain(
        documentId,
      );
      const query = findObservedQuery(
        observations,
        "WITH nearest_embeddings",
      ).query;
      const plan = await queryDb.$queryRaw(
        Prisma.sql`EXPLAIN (FORMAT JSON) ${query}`,
      );
      expect(JSON.stringify(plan)).toContain(
        "KnowledgeEmbedding_embedding_2560_halfvec_hnsw_idx",
      );
    } finally {
      await queryDb.$disconnect();
    }
  });

  it("keeps semantic results through an extraction-only configuration change", async () => {
    const fixture = await setupSearchFixture("extraction-change");
    const result = await searchKnowledge(
      fixture.db,
      { query: "Atlas", limitPerGroup: 8 },
      fixture.user,
      {
        routing: {
          ...routing,
          extraction: {
            ...routing.extraction,
            providerModelId: "new-extraction",
          },
          extractionFingerprint: "new-extraction-fingerprint",
        },
        provider: queryProvider(queryVector()).provider,
      },
    );
    expect(result.mode).toBe("hybrid");
    expect(result.documents.map((row) => row.documentId)).toContain(
      fixture.semanticDocument.documentId,
    );
  });

  it("finds vectors of a compatible embedding model with another model name", async () => {
    const fixture = await setupSearchFixture("compatible-embedding-name");
    const result = await searchKnowledge(
      fixture.db,
      { query: "Atlas", limitPerGroup: 8 },
      fixture.user,
      {
        routing: {
          ...routing,
          embedding: {
            ...routing.embedding,
            providerModelId: "qwen/qwen3-embedding-4b",
          },
        },
        provider: queryProvider(queryVector()).provider,
      },
    );
    expect(result.partial).toEqual([]);
    expect(result.documents.map((row) => row.documentId)).toContain(
      fixture.semanticDocument.documentId,
    );
  });

  it("knowledge review: semantic search remains available when graph extraction fails", async () => {
    const fixture = await setupSearchFixture("graph-failed");
    await fixture.db.knowledgeGenerationDocument.updateMany({
      where: { documentId: fixture.semanticDocument.documentId },
      data: {
        status: "failed",
        failureKind: "validation",
        completedAt: new Date(),
        graphIndexedSha: null,
      },
    });
    const result = await searchKnowledge(
      fixture.db,
      { query: "Atlas", limitPerGroup: 8 },
      fixture.user,
      queryProvider(queryVector()),
    );
    expect(result.documents.map((item) => item.documentId)).toContain(
      fixture.semanticDocument.documentId,
    );
  });

  it("fuses stable live-source groups without leaking inaccessible or building data", async () => {
    const fixture = await setupSearchFixture("rank");

    const result = await searchKnowledge(
      fixture.db,
      { query: "Atlas", limitPerGroup: 8 },
      fixture.user,
      queryProvider(queryVector()),
    );

    expect(Object.keys(result)).toEqual([
      "mode",
      "documents",
      "tables",
      "entities",
      "partial",
    ]);
    expect(result.mode).toBe("hybrid");
    expect(result.partial).toEqual([]);
    expect(result.documents.map((item) => item.documentId)).toEqual([
      fixture.exactDocument.documentId,
      fixture.bodyDocument.documentId,
      fixture.semanticDocument.documentId,
    ]);
    expect(result.documents[0]).toMatchObject({
      documentId: fixture.exactDocument.documentId,
      projectId: fixture.firstProject.id,
      sourceCommitSha: fixture.exactDocument.sourceCommitSha,
      title: "Ａｔｌａｓ",
      navigationAnchor: null,
    });
    expect(result.documents[1]).toMatchObject({
      documentId: fixture.bodyDocument.documentId,
      projectId: fixture.firstProject.id,
      sourceCommitSha: fixture.bodyDocument.sourceCommitSha,
      headingPath: ["Deployment Guide", "Runtime"],
      navigationAnchor: "section-deployment",
    });
    expect(result.documents[1]!.snippet).toContain("Atlas");
    expect(result.documents[2]).toMatchObject({
      projectId: fixture.secondProject.id,
      sourceCommitSha: fixture.semanticDocument.sourceCommitSha,
      title: "Orion Notes",
    });
    expect(result.documents.every((item) => item.snippet.length <= 240)).toBe(
      true,
    );

    expect(result.tables.map((item) => item.tableId)).toEqual([
      fixture.exactTable.tableId,
      fixture.schemaTable.tableId,
    ]);
    expect(result.tables[1]).toMatchObject({
      projectId: fixture.firstProject.id,
      sourceCommitSha: fixture.schemaTable.sourceCommitSha,
      matchingColumns: ["Atlas owner (text)"],
    });

    expect(result.entities[0]).toMatchObject({
      projectId: fixture.firstProject.id,
      generationId: fixture.firstProject.activeGenerationId,
      entityId: fixture.exactEntity.entityId,
      canonicalName: "Ａｔｌａｓ",
    });
    expect(
      result.entities.find(
        (item) => item.entityId === fixture.aliasEntity.entityId,
      ),
    ).toMatchObject({
      canonicalName: "Operations Platform",
      aliases: ["Atlas"],
    });
    expect(result.entities[0]!.score).toBeGreaterThan(
      result.entities.find(
        (item) => item.entityId === fixture.aliasEntity.entityId,
      )!.score,
    );
    expect(
      result.entities.some(
        (item) => item.entityId === fixture.semanticEntity.entityId,
      ),
    ).toBe(true);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(fixture.inaccessibleProject.id);
    expect(serialized).not.toContain(fixture.inaccessibleProject.marker);
    expect(serialized).not.toContain(fixture.buildingEntity.entityId);
    expect(serialized).not.toContain(fixture.buildingEntity.marker);
    expect(serialized).not.toContain(fixture.staleDocument.documentId);
    expect(serialized).not.toContain(fixture.staleDocument.marker);
    expect(serialized).not.toContain(fixture.deletedTable.tableId);
    expect(serialized).not.toContain(fixture.deletedTable.marker);
    expect(serialized).not.toContain(fixture.aliasEntity.internalName);
    expect(serialized).not.toContain("normalizedName");

    expect(
      await fixture.db.aiUsage.findMany({
        select: {
          projectId: true,
          operation: true,
          documentId: true,
          connectionId: true,
          provider: true,
          model: true,
          outcome: true,
        },
      }),
    ).toEqual([
      {
        projectId: null,
        operation: "search_query_embedding",
        documentId: null,
        provider: "openai_compatible",
        connectionId: routing.embedding.connectionId,
        model: EMBEDDING_MODEL,
        outcome: "success",
      },
    ]);
  });

  it("intersects requested projects with live canonical access", async () => {
    const fixture = await setupSearchFixture("filter");

    const filtered = await searchKnowledge(
      fixture.db,
      {
        query: "Atlas",
        projectIds: [fixture.secondProject.id, fixture.inaccessibleProject.id],
        limitPerGroup: 8,
      },
      fixture.user,
      queryProvider(queryVector()),
    );

    expect(filtered.documents.map((item) => item.documentId)).toEqual([
      fixture.semanticDocument.documentId,
    ]);
    expect(filtered.tables).toEqual([]);
    expect(filtered.entities.map((item) => item.entityId)).toEqual([
      fixture.semanticEntity.entityId,
    ]);
    expect(
      [...filtered.documents, ...filtered.tables, ...filtered.entities].every(
        (item) => item.projectId === fixture.secondProject.id,
      ),
    ).toBe(true);

    const hiddenOnly = await searchKnowledge(
      fixture.db,
      {
        query: "Atlas",
        projectIds: [fixture.inaccessibleProject.id],
        limitPerGroup: 8,
      },
      fixture.user,
      queryProvider(queryVector()),
    );
    expect(hiddenOnly.documents).toEqual([]);
    expect(hiddenOnly.tables).toEqual([]);
    expect(hiddenOnly.entities).toEqual([]);
    expect(JSON.stringify(hiddenOnly)).not.toContain(
      fixture.inaccessibleProject.marker,
    );
  });

  it("hides a project's results for a member once it is soft-deleted", async () => {
    const fixture = await setupSearchFixture("soft-delete");

    const beforeDelete = await searchKnowledge(
      fixture.db,
      {
        query: "Atlas",
        projectIds: [fixture.firstProject.id],
        limitPerGroup: 8,
      },
      fixture.user,
      queryProvider(queryVector()),
    );
    expect(beforeDelete.documents.length).toBeGreaterThan(0);

    await fixture.db.project.update({
      where: { id: fixture.firstProject.id },
      data: { deletedAt: new Date() },
    });

    const afterDelete = await searchKnowledge(
      fixture.db,
      {
        query: "Atlas",
        projectIds: [fixture.firstProject.id],
        limitPerGroup: 8,
      },
      fixture.user,
      queryProvider(queryVector()),
    );
    expect(afterDelete.documents).toEqual([]);
    expect(afterDelete.tables).toEqual([]);
    expect(afterDelete.entities).toEqual([]);
  });

  it("does not give a non-member Admin access to inaccessible projects", async () => {
    const fixture = await setupSearchFixture("admin");
    const admin = await makeUser("Admin", "search-admin");

    const hidden = await searchKnowledge(
      fixture.db,
      {
        query: "Atlas",
        projectIds: [fixture.inaccessibleProject.id],
        limitPerGroup: 8,
      },
      securityContextFor(admin),
      queryProvider(queryVector()),
    );
    expect(hidden.documents).toEqual([]);
    expect(hidden.tables).toEqual([]);
    expect(hidden.entities).toEqual([]);
  });

  it("returns a ready exact-title document that has no search chunks", async () => {
    const fixture = await setupSearchFixture("zero-chunk");
    const emptyDocument = await seedZeroChunkDocument(
      fixture.db,
      fixture.firstProject,
      {
        slug: "empty-atlas",
        title: "Ｅｍｐｔｙ　Ａｔｌａｓ",
      },
    );
    await disableRouting();

    expect(
      await fixture.db.documentSearchChunk.count({
        where: { documentId: emptyDocument.documentId },
      }),
    ).toBe(0);

    const result = await searchKnowledge(
      fixture.db,
      { query: "Empty Atlas", limitPerGroup: 8 },
      fixture.user,
    );

    expect(result.documents).toEqual([
      expect.objectContaining({
        documentId: emptyDocument.documentId,
        sourceCommitSha: emptyDocument.sourceCommitSha,
        headingPath: [],
        snippet: "",
      }),
    ]);
  });

  it("uses ECMAScript Unicode and whitespace normalization for exact titles", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "search-unicode-normalization");
    const fingerprint = routing.configFingerprint;
    const project = await seedProject(db, {
      name: "Unicode normalization",
      fingerprint,
    });
    await addMembership(project.id, user.id, "Viewer");
    const cases = [
      { slug: "feff", title: "A\uFEFFB", query: "A B" },
      { slug: "turkish-i", title: "İSTANBUL", query: "İSTANBUL" },
      { slug: "final-sigma", title: "ΟΣ", query: "ΟΣ" },
    ];
    const sources = await Promise.all(
      cases.map(async (entry) => ({
        document: await seedZeroChunkDocument(db, project, entry),
        table: await seedTable(db, project, {
          slug: entry.slug,
          title: entry.title,
          schemaText: "Value (text)",
        }),
      })),
    );
    await disableRouting();

    for (const [index, entry] of cases.entries()) {
      const result = await searchKnowledge(
        db,
        { query: entry.query, limitPerGroup: 8 },
        securityContextFor(user),
      );

      expect(result.documents[0]?.documentId).toBe(
        sources[index]!.document.documentId,
      );
      expect(result.tables[0]?.tableId).toBe(sources[index]!.table.tableId);
    }
  });

  it("writes and searches expansion-heavy valid document and table titles", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "search-expanded-title");
    const fingerprint = routing.configFingerprint;
    const project = await seedProject(db, {
      name: "Expanded title",
      fingerprint,
    });
    await addMembership(project.id, user.id, "Viewer");
    const title = "ﷺ".repeat(200);
    expect(Buffer.byteLength(title.normalize("NFKC"), "utf8")).toBeGreaterThan(
      6_000,
    );

    const document = await seedZeroChunkDocument(db, project, {
      slug: "expanded-title",
      title,
    });
    const table = await seedTable(db, project, {
      slug: "expanded-title",
      title,
      schemaText: "Value (text)",
    });
    const [storedKeys] = await db.$queryRaw<
      Array<{ documentHashBytes: number; tableHashBytes: number }>
    >(Prisma.sql`
      SELECT octet_length(document."normalizedTitleHash")::integer
               AS "documentHashBytes",
             octet_length(table_row."normalizedTitleHash")::integer
               AS "tableHashBytes"
      FROM "Document" AS document
      CROSS JOIN "DataTable" AS table_row
      WHERE document."id" = ${document.documentId}::uuid
        AND table_row."id" = ${table.tableId}::uuid
    `);
    expect(storedKeys).toEqual({
      documentHashBytes: 32,
      tableHashBytes: 32,
    });
    await disableRouting();

    const result = await searchKnowledge(
      db,
      { query: title, limitPerGroup: 8 },
      securityContextFor(user),
    );

    expect(result.documents[0]?.documentId).toBe(document.documentId);
    expect(result.tables[0]?.tableId).toBe(table.tableId);
  });

  it("limits semantic candidates after choosing each document's best chunk", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "search-semantic-crowding");
    const fingerprint = routing.configFingerprint;
    const project = await seedProject(db, {
      name: "Semantic crowding",
      fingerprint,
    });
    await addMembership(project.id, user.id, "Viewer");

    const crowded = await seedDocument(db, project, {
      slug: "crowded",
      title: "Crowded source",
      content: "The deterministic best semantic passage.",
      headingPath: ["Crowded", "Best"],
      vector: directionVector(1, 0),
    });
    await seedAdditionalSemanticChunks(db, project, crowded, 19);
    const distinctDocuments = await Promise.all([
      seedDocument(db, project, {
        slug: "distinct-1",
        title: "Distinct source 1",
        content: "First independent semantic source.",
        headingPath: ["Distinct 1"],
        vector: directionVector(0.9, 0.44),
      }),
      seedDocument(db, project, {
        slug: "distinct-2",
        title: "Distinct source 2",
        content: "Second independent semantic source.",
        headingPath: ["Distinct 2"],
        vector: directionVector(0.8, 0.6),
      }),
      seedDocument(db, project, {
        slug: "distinct-3",
        title: "Distinct source 3",
        content: "Third independent semantic source.",
        headingPath: ["Distinct 3"],
        vector: directionVector(0.7, 0.71),
      }),
      seedDocument(db, project, {
        slug: "distinct-4",
        title: "Distinct source 4",
        content: "Fourth independent semantic source.",
        headingPath: ["Distinct 4"],
        vector: directionVector(0.6, 0.8),
      }),
    ]);
    const observations: RawQueryObservation[] = [];

    const result = await searchKnowledge(
      observeRawQueries(db, observations),
      { query: "Nebula", limitPerGroup: 4 },
      securityContextFor(user),
      queryProvider(queryVector()),
    );

    expect(result.documents.map((item) => item.documentId)).toEqual([
      crowded.documentId,
      distinctDocuments[0].documentId,
      distinctDocuments[1].documentId,
      distinctDocuments[2].documentId,
    ]);
    expect(result.documents[0]).toMatchObject({
      headingPath: ["Crowded", "Best"],
      snippet: "The deterministic best semantic passage.",
    });
    const semanticRows = findObservedQuery(
      observations,
      "e.\"ownerType\" = 'document_chunk'",
    ).rows as Array<{ documentId: string }>;
    expect(semanticRows.length).toBeLessThanOrEqual(16);
    expect(new Set(semanticRows.map((row) => row.documentId)).size).toBe(
      semanticRows.length,
    );
  });

  it("bounds exact-title execution while keeping the match in the candidate window", async () => {
    const fixture = await setupSearchFixture("candidate-window");
    await seedLexicalCompetition(fixture.db, fixture.firstProject, 33, {
      prefix: "matching",
      term: "Atlas",
    });
    await seedLexicalCompetition(fixture.db, fixture.firstProject, 5000, {
      prefix: "nonmatching",
      term: "Orion",
    });
    await seedTableCompetition(fixture.db, fixture.firstProject, 33, {
      prefix: "matching",
      term: "Atlas",
    });
    await seedTableCompetition(fixture.db, fixture.firstProject, 5000, {
      prefix: "nonmatching",
      term: "Orion",
    });
    await fixture.db.$executeRaw(Prisma.sql`ANALYZE "Document"`);
    await fixture.db.$executeRaw(Prisma.sql`ANALYZE "DataTable"`);
    await fixture.db.$executeRaw(Prisma.sql`ANALYZE "DocumentSearchChunk"`);
    await fixture.db.$executeRaw(Prisma.sql`ANALYZE "TableSearchProjection"`);
    await disableRouting();
    const observations: RawQueryObservation[] = [];

    const result = await searchKnowledge(
      observeRawQueries(fixture.db, observations),
      { query: "Atlas", limitPerGroup: 8 },
      fixture.user,
    );

    expect(result.mode).toBe("keyword");
    expect(result.documents[0]!.documentId).toBe(
      fixture.exactDocument.documentId,
    );
    expect(result.documents).toHaveLength(8);
    expect(result.tables[0]!.tableId).toBe(fixture.exactTable.tableId);
    expect(result.tables).toHaveLength(8);

    await expectDefaultExactTitlePlanToExamineAtMostRows(
      fixture.db,
      findObservedQuery(observations, '"DocumentSearchChunk" AS chunk').query,
      ["Document", "DocumentIndexState"],
      128,
    );
    await expectDefaultExactTitlePlanToExamineAtMostRows(
      fixture.db,
      findObservedQuery(observations, '"TableSearchProjection" AS projection')
        .query,
      ["DataTable", "TableSearchProjection"],
      128,
    );
  });

  it("bounds duplicate exact-title work per allowed project", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "search-exact-duplicates");
    const fingerprint = routing.configFingerprint;
    const projectCount = 8;
    const projects = await Promise.all(
      Array.from({ length: projectCount }, async (_, index) => {
        const project = await seedProject(db, {
          name: `Exact duplicates ${index}`,
          fingerprint,
        });
        await addMembership(project.id, user.id, "Viewer");
        return project;
      }),
    );
    const duplicates = await seedExactTitleDuplicates(db, projects, 128);
    await analyzeExactTitleRelations(db);
    await disableRouting();
    const observations: RawQueryObservation[] = [];

    const result = await searchKnowledge(
      observeRawQueries(db, observations),
      { query: "Atlas Duplicate", limitPerGroup: 8 },
      securityContextFor(user),
    );

    expect(result.documents.map((item) => item.documentId)).toEqual(
      [...duplicates.documentIds].sort().slice(0, 8),
    );
    expect(result.tables.map((item) => item.tableId)).toEqual(
      [...duplicates.tableIds].sort().slice(0, 8),
    );
    const maximumExactRows = projectCount * 32;
    await expectDefaultExactTitlePlanToExamineAtMostRows(
      db,
      findObservedQuery(observations, '"DocumentSearchChunk" AS chunk').query,
      ["Document", "DocumentIndexState"],
      maximumExactRows,
    );
    await expectDefaultExactTitlePlanToExamineAtMostRows(
      db,
      findObservedQuery(observations, '"TableSearchProjection" AS projection')
        .query,
      ["DataTable", "TableSearchProjection"],
      maximumExactRows,
    );
  });

  it("bounds ineligible exact-title work without hiding a later eligible source", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "search-exact-ineligible-before");
    const fingerprint = routing.configFingerprint;
    const project = await seedProject(db, {
      name: "Exact eligibility",
      fingerprint,
    });
    await addMembership(project.id, user.id, "Viewer");
    const eligible = await seedIneligibleExactTitleCandidates(db, project, {
      title: "Atlas Eligibility",
      count: 512,
      includeEligible: true,
    });
    await analyzeExactTitleRelations(db);
    await disableRouting();
    const observations: RawQueryObservation[] = [];

    const result = await searchKnowledge(
      observeRawQueries(db, observations),
      { query: "Atlas Eligibility", limitPerGroup: 8 },
      securityContextFor(user),
    );

    expect(result.documents.map((item) => item.documentId)).toEqual([
      eligible.documentId,
    ]);
    expect(result.tables.map((item) => item.tableId)).toEqual([
      eligible.tableId,
    ]);
    await expectDefaultExactTitlePlanToExamineAtMostRows(
      db,
      findObservedQuery(observations, '"DocumentSearchChunk" AS chunk').query,
      ["Document", "DocumentIndexState"],
      64,
    );
    await expectDefaultExactTitlePlanToExamineAtMostRows(
      db,
      findObservedQuery(observations, '"TableSearchProjection" AS projection')
        .query,
      ["DataTable", "TableSearchProjection"],
      64,
    );
  });

  it("bounds exact-title work when every same-title source is ineligible", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "search-exact-all-ineligible");
    const fingerprint = routing.configFingerprint;
    const project = await seedProject(db, {
      name: "All exact candidates ineligible",
      fingerprint,
    });
    await addMembership(project.id, user.id, "Viewer");
    await seedIneligibleExactTitleCandidates(db, project, {
      title: "Atlas Rejected",
      count: 512,
      includeEligible: false,
    });
    await analyzeExactTitleRelations(db);
    await disableRouting();
    const observations: RawQueryObservation[] = [];

    const result = await searchKnowledge(
      observeRawQueries(db, observations),
      { query: "Atlas Rejected", limitPerGroup: 8 },
      securityContextFor(user),
    );

    expect(result.documents).toEqual([]);
    expect(result.tables).toEqual([]);
    await expectDefaultExactTitlePlanToExamineAtMostRows(
      db,
      findObservedQuery(observations, '"DocumentSearchChunk" AS chunk').query,
      ["Document", "DocumentIndexState"],
      32,
    );
    await expectDefaultExactTitlePlanToExamineAtMostRows(
      db,
      findObservedQuery(observations, '"TableSearchProjection" AS projection')
        .query,
      ["DataTable", "TableSearchProjection"],
      32,
    );
  });

  it("publishes and invalidates exact-title eligibility with source currentness", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "search-exact-boundaries");
    const fingerprint = routing.configFingerprint;
    const project = await seedProject(db, {
      name: "Exact publication boundaries",
      fingerprint,
    });
    await addMembership(project.id, user.id, "Viewer");
    const source = await seedIneligibleExactTitleCandidates(db, project, {
      title: "Atlas Boundary",
      count: 0,
      includeEligible: true,
    });

    await expectExactEligibilityKeys(db, source, {
      documentTitle: "Atlas Boundary",
      tableTitle: "Atlas Boundary",
    });

    const nextDocumentSha = "c".repeat(40);
    const nextTableSha = "d".repeat(40);
    await db.document.update({
      where: { id: source.documentId! },
      data: { headCommitSha: nextDocumentSha },
    });
    await db.dataTable.update({
      where: { id: source.tableId! },
      data: { headCommitSha: nextTableSha },
    });
    await expectExactEligibilityKeys(db, source, {
      documentTitle: null,
      tableTitle: null,
    });
    await disableRouting();
    const invalidated = await searchKnowledge(
      db,
      { query: "Atlas Boundary", limitPerGroup: 8 },
      securityContextFor(user),
    );
    expect(invalidated.documents).toEqual([]);
    expect(invalidated.tables).toEqual([]);

    await db.documentIndexState.update({
      where: { documentId: source.documentId! },
      data: {
        targetSha: nextDocumentSha,
        keywordIndexedSha: nextDocumentSha,
        status: "ready",
      },
    });
    await db.tableSearchProjection.update({
      where: { tableId: source.tableId! },
      data: { sourceCommitSha: nextTableSha },
    });
    await expectExactEligibilityKeys(db, source, {
      documentTitle: "Atlas Boundary",
      tableTitle: "Atlas Boundary",
    });

    const republished = await searchKnowledge(
      db,
      { query: "Atlas Boundary", limitPerGroup: 8 },
      securityContextFor(user),
    );
    expect(republished.documents.map((item) => item.documentId)).toEqual([
      source.documentId,
    ]);
    expect(republished.tables.map((item) => item.tableId)).toEqual([
      source.tableId,
    ]);

    await db.document.delete({ where: { id: source.documentId! } });
    await db.dataTable.delete({ where: { id: source.tableId! } });
    await expectExactEligibilityKeys(db, source, {
      documentTitle: null,
      tableTitle: null,
    });
    const recreatedAt = new Date();
    await db.document.create({
      data: {
        id: source.documentId!,
        projectId: project.id,
        path: "documents/eligible.md",
        slug: "eligible-document",
        title: "Atlas Boundary",
        excerpt: "",
        headCommitSha: nextDocumentSha,
        lastEditedAt: recreatedAt,
        createdAt: recreatedAt,
        updatedAt: recreatedAt,
      },
    });
    await db.dataTable.create({
      data: {
        id: source.tableId!,
        projectId: project.id,
        path: "tables/eligible",
        slug: "eligible-table",
        title: "Atlas Boundary",
        rowCount: 0,
        headCommitSha: nextTableSha,
        lastEditedAt: recreatedAt,
        createdAt: recreatedAt,
      },
    });
    await expectExactEligibilityKeys(db, source, {
      documentTitle: "Atlas Boundary",
      tableTitle: "Atlas Boundary",
    });
  });

  it("moves document exact-title eligibility across a source ID transition", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "search-document-id-transition");
    const fingerprint = routing.configFingerprint;
    const project = await seedProject(db, {
      name: "Document identity transition",
      fingerprint,
    });
    await addMembership(project.id, user.id, "Viewer");
    const oldDocumentId = randomUUID();
    const newDocumentId = randomUUID();
    const sourceCommitSha = "e".repeat(40);
    const now = new Date();
    await db.document.create({
      data: {
        id: oldDocumentId,
        projectId: project.id,
        path: "documents/identity-transition.md",
        slug: "identity-transition",
        title: "Atlas Identity Transition",
        excerpt: "",
        headCommitSha: sourceCommitSha,
        lastEditedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
    await db.documentIndexState.createMany({
      data: [oldDocumentId, newDocumentId].map((documentId) => ({
        documentId,
        projectId: project.id,
        targetSha: sourceCommitSha,
        keywordIndexedSha: sourceCommitSha,
        status: "ready" as const,
        completedAt: now,
      })),
    });

    await db.document.update({
      where: { id: oldDocumentId },
      data: { id: newDocumentId },
    });

    expect(
      await db.documentIndexState.findMany({
        where: { documentId: { in: [oldDocumentId, newDocumentId] } },
        orderBy: { documentId: "asc" },
        select: { documentId: true, exactTitle: true },
      }),
    ).toEqual(
      [
        { documentId: oldDocumentId, exactTitle: null },
        {
          documentId: newDocumentId,
          exactTitle: "Atlas Identity Transition",
        },
      ].sort((left, right) => left.documentId.localeCompare(right.documentId)),
    );
    const result = await searchKnowledge(
      db,
      { query: "Atlas Identity Transition", limitPerGroup: 8 },
      securityContextFor(user),
      queryProvider(queryVector()),
    );
    expect(result.documents.map((item) => item.documentId)).toEqual([
      newDocumentId,
    ]);
  });

  it("moves table exact-title eligibility across a source ID transition", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "search-table-id-transition");
    const fingerprint = routing.configFingerprint;
    const project = await seedProject(db, {
      name: "Table identity transition",
      fingerprint,
    });
    await addMembership(project.id, user.id, "Viewer");
    const oldTableId = randomUUID();
    const newTableId = randomUUID();
    const sourceCommitSha = "f".repeat(40);
    const now = new Date();
    await db.dataTable.create({
      data: {
        id: oldTableId,
        projectId: project.id,
        path: "tables/identity-transition",
        slug: "identity-transition",
        title: "Atlas Identity Transition",
        rowCount: 0,
        headCommitSha: sourceCommitSha,
        lastEditedAt: now,
        createdAt: now,
      },
    });
    await db.tableSearchProjection.createMany({
      data: [oldTableId, newTableId].map((tableId) => ({
        tableId,
        projectId: project.id,
        sourceCommitSha,
        title: "Atlas Identity Transition",
        schemaText: "Owner (text)",
      })),
    });

    await db.dataTable.update({
      where: { id: oldTableId },
      data: { id: newTableId },
    });

    expect(
      await db.tableSearchProjection.findMany({
        where: { tableId: { in: [oldTableId, newTableId] } },
        orderBy: { tableId: "asc" },
        select: { tableId: true, exactTitle: true },
      }),
    ).toEqual(
      [
        { tableId: oldTableId, exactTitle: null },
        { tableId: newTableId, exactTitle: "Atlas Identity Transition" },
      ].sort((left, right) => left.tableId.localeCompare(right.tableId)),
    );
    const result = await searchKnowledge(
      db,
      { query: "Atlas Identity Transition", limitPerGroup: 8 },
      securityContextFor(user),
      queryProvider(queryVector()),
    );
    expect(result.tables.map((item) => item.tableId)).toEqual([newTableId]);
  });

  it("degrades provider failures to accounted keyword-only results", async () => {
    const fixture = await setupSearchFixture("fallback");
    const provider = queryProvider(async () => {
      throw new AiProviderError("credential=do-not-expose", {
        kind: "provider",
        retryable: true,
      });
    });

    const result = await searchKnowledge(
      fixture.db,
      { query: "Atlas", limitPerGroup: 8 },
      fixture.user,
      provider,
    );
    expect(result.mode).toBe("keyword");
    expect(result.partial).toEqual(["semantic_unavailable"]);
    expect(result.documents.map((item) => item.documentId)).toEqual([
      fixture.exactDocument.documentId,
      fixture.bodyDocument.documentId,
    ]);
    expect(result.tables).toHaveLength(2);
    expect(result.entities.map((item) => item.entityId)).toEqual([
      fixture.exactEntity.entityId,
      fixture.aliasEntity.entityId,
    ]);
    expect(JSON.stringify(result)).not.toContain("credential=do-not-expose");
    expect(
      await fixture.db.aiUsage.findMany({
        select: {
          projectId: true,
          documentId: true,
          operation: true,
          outcome: true,
          inputTokens: true,
          outputTokens: true,
        },
      }),
    ).toEqual([
      {
        projectId: null,
        documentId: null,
        operation: "search_query_embedding",
        outcome: "provider_failure",
        inputTokens: null,
        outputTokens: null,
      },
    ]);
  });

  it("degrades query-embedding accounting failures to keyword-only results", async () => {
    const fixture = await setupSearchFixture("accounting-fallback");
    const usageWrite = vi
      .spyOn(fixture.db.aiUsage, "create")
      .mockRejectedValueOnce(new Error("usage database unavailable"));
    try {
      const result = await searchKnowledge(
        fixture.db,
        { query: "Atlas", limitPerGroup: 8 },
        fixture.user,
        queryProvider(queryVector()),
      );

      expect(result.mode).toBe("keyword");
      expect(result.partial).toEqual(["semantic_unavailable"]);
      expect(result.documents.map((item) => item.documentId)).toEqual([
        fixture.exactDocument.documentId,
        fixture.bodyDocument.documentId,
      ]);
    } finally {
      usageWrite.mockRestore();
    }
  });

  it("does not compare live query vectors with an active generation from another configuration", async () => {
    const fixture = await setupSearchFixture("configuration-identity");
    const movedRouting = {
      ...routing,
      configFingerprint: "f".repeat(64),
      embedding: {
        ...routing.embedding,
        endpoint: "https://moved-provider.test/v1",
      },
    };
    const provider = queryProvider(queryVector()).provider;

    const result = await searchKnowledge(
      fixture.db,
      { query: "Atlas", limitPerGroup: 8 },
      fixture.user,
      { routing: movedRouting, provider },
    );

    expect(result.mode).toBe("keyword");
    expect(result.partial).toEqual(["semantic_unavailable"]);
    expect(result.documents.map((item) => item.documentId)).toEqual([
      fixture.exactDocument.documentId,
      fixture.bodyDocument.documentId,
    ]);
    expect(result.entities.map((item) => item.entityId)).toEqual([
      fixture.exactEntity.entityId,
      fixture.aliasEntity.entityId,
    ]);
  });

  it("falls back to keyword results when the query embedding outlasts the interactive timeout", async () => {
    const fixture = await setupSearchFixture("query-timeout");
    const slow = queryProvider(queryVector());
    const provider: AiProvider = {
      ...slow.provider,
      embed: (_input, options) =>
        new Promise((resolve, reject) => {
          const late = setTimeout(
            () => resolve({ vectors: [queryVector()], usage: QUERY_USAGE }),
            3_000,
          );
          options?.signal?.addEventListener("abort", () => {
            clearTimeout(late);
            reject(new DOMException("Query embedding aborted", "AbortError"));
          });
        }),
    };
    const startedAt = Date.now();

    const result = await searchKnowledge(
      fixture.db,
      { query: "Atlas", limitPerGroup: 8 },
      fixture.user,
      { routing, provider, queryEmbeddingTimeoutMs: 50 },
    );

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(result.mode).toBe("keyword");
    expect(result.partial).toEqual(["semantic_unavailable"]);
    expect(result.documents.map((item) => item.documentId)).toEqual([
      fixture.exactDocument.documentId,
      fixture.bodyDocument.documentId,
    ]);
  });

  it("treats invalid AI configuration as a safe lexical partial result", async () => {
    const fixture = await setupSearchFixture("config-fallback");
    await disableRouting();

    const result = await searchKnowledge(
      fixture.db,
      { query: "Atlas", limitPerGroup: 8 },
      fixture.user,
    );

    expect(result.mode).toBe("keyword");
    expect(result.partial).toEqual(["semantic_unavailable"]);
    expect(result.documents.map((item) => item.documentId)).toEqual([
      fixture.exactDocument.documentId,
      fixture.bodyDocument.documentId,
    ]);
    expect(await fixture.db.aiUsage.count()).toBe(0);
  });

  it("degrades query-vector validation failures to accounted keyword results", async () => {
    const fixture = await setupSearchFixture("validation-fallback");

    const result = await searchKnowledge(
      fixture.db,
      { query: "Atlas", limitPerGroup: 8 },
      fixture.user,
      queryProvider([]),
    );

    expect(result.mode).toBe("keyword");
    expect(result.partial).toEqual(["semantic_unavailable"]);
    expect(
      await fixture.db.aiUsage.findMany({
        select: { operation: true, outcome: true },
      }),
    ).toEqual([
      {
        operation: "search_query_embedding",
        outcome: "validation_failure",
      },
    ]);
  });

  it("propagates semantic SQL failures instead of returning a lexical partial", async () => {
    const fixture = await setupSearchFixture("semantic-sql-failure");
    const failure = new Error("injected semantic SQL failure");
    const failingDb = interceptRawQueries(fixture.db, (query) => {
      if (query.sql.includes("e.\"ownerType\" = 'document_chunk'")) {
        throw failure;
      }
    });

    await expect(
      searchKnowledge(
        failingDb,
        { query: "Atlas", limitPerGroup: 8 },
        fixture.user,
        queryProvider(queryVector()),
      ),
    ).rejects.toBe(failure);
  });

  it("degrades AiUsage persistence failures to keyword results", async () => {
    const fixture = await setupSearchFixture("usage-failure");
    await fixture.db.$executeRaw(Prisma.sql`
      CREATE OR REPLACE FUNCTION "search_test_reject_ai_usage"()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'injected AiUsage persistence failure';
      END;
      $$ LANGUAGE plpgsql
    `);
    await fixture.db.$executeRaw(Prisma.sql`
      CREATE TRIGGER "search_test_reject_ai_usage_trigger"
      BEFORE INSERT ON "AiUsage"
      FOR EACH ROW EXECUTE FUNCTION "search_test_reject_ai_usage"()
    `);

    try {
      await expect(
        searchKnowledge(
          fixture.db,
          { query: "Atlas", limitPerGroup: 8 },
          fixture.user,
          queryProvider(queryVector()),
        ),
      ).resolves.toMatchObject({
        mode: "keyword",
        partial: ["semantic_unavailable"],
      });
    } finally {
      await fixture.db.$executeRaw(Prisma.sql`
        DROP TRIGGER IF EXISTS "search_test_reject_ai_usage_trigger" ON "AiUsage"
      `);
      await fixture.db.$executeRaw(Prisma.sql`
        DROP FUNCTION IF EXISTS "search_test_reject_ai_usage"()
      `);
    }
  });

  it("registers bounded trimmed input on the authenticated search router", async () => {
    const user = await makeUser("User", "search-router");
    const caller = callerFor(user);

    await expect(caller.search.query({ query: " x " })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      caller.search.query({
        query: "valid query",
        projectIds: Array.from(
          { length: 51 },
          () => "11111111-1111-4111-8111-111111111111",
        ),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.search.query({ query: "valid query", limitPerGroup: 21 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await disableRouting();
    await expect(
      caller.search.query({ query: "  valid query  " }),
    ).resolves.toEqual({
      mode: "keyword",
      documents: [],
      tables: [],
      entities: [],
      partial: ["semantic_unavailable"],
    });
  });
});

async function setupSearchFixture(suffix: string) {
  const db = getPrisma();
  const user = await makeUser("User", `search-${suffix}`);
  const fingerprint = routing.configFingerprint;

  const firstProject = await seedProject(db, {
    name: `Accessible Alpha ${suffix}`,
    fingerprint,
  });
  const secondProject = await seedProject(db, {
    name: `Accessible Beta ${suffix}`,
    fingerprint,
  });
  const inaccessibleProject = await seedProject(db, {
    name: `Forbidden Project ${suffix}`,
    fingerprint,
    marker: `FORBIDDEN-${suffix}`,
  });
  await addMembership(firstProject.id, user.id, "Viewer");
  await addMembership(secondProject.id, user.id, "Viewer");

  const exactDocument = await seedDocument(db, firstProject, {
    slug: `atlas-${suffix}`,
    title: "Ａｔｌａｓ",
    content: "An exact title result with ordinary searchable content.",
    headingPath: ["Atlas"],
    vector: directionVector(0, 1),
  });
  const bodyDocument = await seedDocument(db, firstProject, {
    slug: `deployment-${suffix}`,
    title: "Deployment Guide",
    content: "Runtime operators use Atlas during every production rollout.",
    headingPath: ["Deployment Guide", "Runtime"],
    navigationAnchor: "section-deployment",
    vector: directionVector(0.8, 0.6),
  });
  const semanticDocument = await seedDocument(db, secondProject, {
    slug: `orion-${suffix}`,
    title: "Orion Notes",
    content: "A constellation map for incident response and recovery.",
    headingPath: ["Orion Notes", "Recovery"],
    vector: directionVector(1, 0),
  });
  const inaccessibleDocument = await seedDocument(db, inaccessibleProject, {
    slug: `forbidden-atlas-${suffix}`,
    title: "Ａｔｌａｓ",
    content: `${inaccessibleProject.marker} hidden document snippet`,
    headingPath: [inaccessibleProject.marker],
    vector: directionVector(1, 0),
  });

  const staleDocument = await seedStaleDocument(db, firstProject, suffix);

  const exactTable = await seedTable(db, firstProject, {
    slug: `atlas-table-${suffix}`,
    title: "Atlas",
    schemaText: "Owner (text)",
  });
  const schemaTable = await seedTable(db, firstProject, {
    slug: `inventory-${suffix}`,
    title: "Service Inventory",
    schemaText: "Atlas owner (text)\nTier (number)",
  });
  await seedTable(db, inaccessibleProject, {
    slug: `forbidden-table-${suffix}`,
    title: "Forbidden Inventory",
    schemaText: `${inaccessibleProject.marker} Atlas count (number)`,
  });
  const deletedTable = await seedDeletedTable(db, firstProject, suffix);

  const exactEntity = await seedEntity(db, firstProject, {
    canonicalName: "Ａｔｌａｓ",
    entityType: "Product",
    description: "The exact entity name.",
    aliases: [],
    vector: directionVector(0, 1),
  });
  const aliasEntity = await seedEntity(db, firstProject, {
    canonicalName: "Operations Platform",
    entityType: "Product",
    description: "Used by operations teams.",
    aliases: ["Atlas"],
    vector: directionVector(0.8, 0.6),
    disambiguateInternalName: true,
  });
  const semanticEntity = await seedEntity(db, secondProject, {
    canonicalName: "Incident Constellation",
    entityType: "Concept",
    description: "A semantically related operational map.",
    aliases: ["Orion"],
    vector: directionVector(1, 0),
  });
  await seedEntity(db, inaccessibleProject, {
    canonicalName: inaccessibleProject.marker,
    entityType: "Secret",
    description: `${inaccessibleProject.marker} hidden entity description`,
    aliases: ["Atlas"],
    vector: directionVector(1, 0),
  });
  const buildingEntity = await seedBuildingEntity(db, firstProject, suffix);

  return {
    db,
    user: securityContextFor(user),
    firstProject,
    secondProject,
    inaccessibleProject,
    exactDocument,
    bodyDocument,
    semanticDocument,
    inaccessibleDocument,
    staleDocument,
    exactTable,
    schemaTable,
    deletedTable,
    exactEntity,
    aliasEntity,
    semanticEntity,
    buildingEntity,
  };
}

async function seedProject(
  db: PrismaClient,
  input: { name: string; fingerprint: string; marker?: string },
) {
  const project = await makeProject(input.name);
  const activeGeneration = await db.knowledgeGeneration.create({
    data: {
      projectId: project.id,
      configFingerprint: input.fingerprint,
      embeddingModel: EMBEDDING_MODEL,
      embeddingDimensions: 1536,
      extractionSchemaVersion: 1,
      promptVersion: "prompt-v1",
      status: "active",
      completedAt: new Date(),
      activatedAt: new Date(),
    },
  });
  return {
    id: project.id,
    name: input.name,
    marker: input.marker ?? input.name,
    fingerprint: input.fingerprint,
    activeGenerationId: activeGeneration.id,
  };
}

async function seedDocument(
  db: PrismaClient,
  project: {
    id: string;
    fingerprint: string;
    activeGenerationId: string;
  },
  input: {
    slug: string;
    title: string;
    content: string;
    headingPath: string[];
    navigationAnchor?: string | null;
    vector: number[];
  },
) {
  const documentId = randomUUID();
  const sourceCommitSha = createHash("sha1")
    .update(`${project.id}:${input.slug}`)
    .digest("hex");
  const chunkId = createHash("sha256")
    .update(`${documentId}:${sourceCommitSha}:0:${input.content}`)
    .digest("hex");
  const now = new Date();
  await db.document.create({
    data: {
      id: documentId,
      projectId: project.id,
      path: `documents/${input.slug}.md`,
      slug: input.slug,
      title: input.title,
      excerpt: input.content.slice(0, 160),
      headCommitSha: sourceCommitSha,
      lastEditedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
  await db.documentIndexState.create({
    data: {
      documentId,
      projectId: project.id,
      targetSha: sourceCommitSha,
      keywordIndexedSha: sourceCommitSha,
      status: "ready",
      completedAt: now,
    },
  });
  await db.documentSearchChunk.create({
    data: {
      id: chunkId,
      projectId: project.id,
      documentId,
      ordinal: 0,
      sourceCommitSha,
      contentHash: createHash("sha256").update(input.content).digest("hex"),
      headingPath: input.headingPath,
      navigationAnchor: input.navigationAnchor ?? null,
      content: input.content,
    },
  });
  await db.knowledgeGenerationDocument.create({
    data: {
      generationId: project.activeGenerationId,
      documentId,
      projectId: project.id,
      targetSha: sourceCommitSha,
      semanticIndexedSha: sourceCommitSha,
      graphIndexedSha: sourceCommitSha,
      configFingerprint: project.fingerprint,
      status: "ready",
      completedAt: now,
    },
  });
  await seedEmbedding(db, {
    projectId: project.id,
    generationId: project.activeGenerationId,
    ownerType: "document_chunk",
    ownerId: chunkId,
    contentHash: createHash("sha256").update(input.content).digest("hex"),
    configFingerprint: project.fingerprint,
    vector: input.vector,
  });
  return { documentId, sourceCommitSha, chunkId };
}

async function seedZeroChunkDocument(
  db: PrismaClient,
  project: { id: string },
  input: { slug: string; title: string },
) {
  const documentId = randomUUID();
  const sourceCommitSha = createHash("sha1")
    .update(`${project.id}:${input.slug}`)
    .digest("hex");
  const now = new Date();
  await db.document.create({
    data: {
      id: documentId,
      projectId: project.id,
      path: `documents/${input.slug}.md`,
      slug: input.slug,
      title: input.title,
      excerpt: "",
      headCommitSha: sourceCommitSha,
      lastEditedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
  await db.documentIndexState.create({
    data: {
      documentId,
      projectId: project.id,
      targetSha: sourceCommitSha,
      keywordIndexedSha: sourceCommitSha,
      status: "ready",
      completedAt: now,
    },
  });
  return { documentId, sourceCommitSha };
}

async function seedAdditionalSemanticChunks(
  db: PrismaClient,
  project: {
    id: string;
    fingerprint: string;
    activeGenerationId: string;
  },
  document: { documentId: string; sourceCommitSha: string },
  count: number,
): Promise<void> {
  for (let index = 1; index <= count; index += 1) {
    const content = `Crowded semantic passage ${index}.`;
    const chunkId = createHash("sha256")
      .update(
        `${document.documentId}:${document.sourceCommitSha}:${index}:${content}`,
      )
      .digest("hex");
    const contentHash = createHash("sha256").update(content).digest("hex");
    await db.documentSearchChunk.create({
      data: {
        id: chunkId,
        projectId: project.id,
        documentId: document.documentId,
        ordinal: index,
        sourceCommitSha: document.sourceCommitSha,
        contentHash,
        headingPath: ["Crowded", `Passage ${index}`],
        content,
      },
    });
    await seedEmbedding(db, {
      projectId: project.id,
      generationId: project.activeGenerationId,
      ownerType: "document_chunk",
      ownerId: chunkId,
      contentHash,
      configFingerprint: project.fingerprint,
      vector: directionVector(1, index / 100),
    });
  }
}

async function seedStaleDocument(
  db: PrismaClient,
  project: {
    id: string;
    fingerprint: string;
    activeGenerationId: string;
  },
  suffix: string,
) {
  const documentId = randomUUID();
  const oldSha = "a".repeat(40);
  const liveSha = "b".repeat(40);
  const marker = `STALE-ATLAS-${suffix}`;
  const chunkId = createHash("sha256").update(marker).digest("hex");
  const now = new Date();
  await db.document.create({
    data: {
      id: documentId,
      projectId: project.id,
      path: `documents/stale-${suffix}.md`,
      slug: `stale-${suffix}`,
      title: "Stale Guide",
      excerpt: marker,
      headCommitSha: liveSha,
      lastEditedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
  await db.documentIndexState.create({
    data: {
      documentId,
      projectId: project.id,
      targetSha: oldSha,
      keywordIndexedSha: oldSha,
      status: "ready",
    },
  });
  await db.documentSearchChunk.create({
    data: {
      id: chunkId,
      projectId: project.id,
      documentId,
      ordinal: 0,
      sourceCommitSha: oldSha,
      contentHash: createHash("sha256").update(marker).digest("hex"),
      headingPath: ["Stale"],
      content: `${marker} hidden old content`,
    },
  });
  await db.knowledgeGenerationDocument.create({
    data: {
      generationId: project.activeGenerationId,
      documentId,
      projectId: project.id,
      targetSha: oldSha,
      semanticIndexedSha: oldSha,
      graphIndexedSha: oldSha,
      configFingerprint: project.fingerprint,
      status: "ready",
    },
  });
  await seedEmbedding(db, {
    projectId: project.id,
    generationId: project.activeGenerationId,
    ownerType: "document_chunk",
    ownerId: chunkId,
    contentHash: createHash("sha256").update(marker).digest("hex"),
    configFingerprint: project.fingerprint,
    vector: directionVector(1, 0),
  });
  return { documentId, marker };
}

async function seedLexicalCompetition(
  db: PrismaClient,
  project: { id: string },
  count: number,
  input: { prefix: string; term: string },
): Promise<void> {
  const now = new Date();
  const documents = Array.from({ length: count }, (_, index) => {
    const documentId = randomUUID();
    const sourceCommitSha = createHash("sha1")
      .update(`${project.id}:${input.prefix}:competition:${index}`)
      .digest("hex");
    const content = `${input.term} ${input.term} ${input.term} ranked body candidate ${index}`;
    return {
      document: {
        id: documentId,
        projectId: project.id,
        path: `documents/${input.prefix}-competition-${index}.md`,
        slug: `${input.prefix}-competition-${index}`,
        title: `${input.prefix} Body Candidate ${index}`,
        excerpt: content,
        headCommitSha: sourceCommitSha,
        lastEditedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      state: {
        documentId,
        projectId: project.id,
        targetSha: sourceCommitSha,
        keywordIndexedSha: sourceCommitSha,
        status: "ready" as const,
        completedAt: now,
      },
      chunk: {
        id: createHash("sha256")
          .update(`${documentId}:${sourceCommitSha}:${content}`)
          .digest("hex"),
        projectId: project.id,
        documentId,
        ordinal: 0,
        sourceCommitSha,
        contentHash: createHash("sha256").update(content).digest("hex"),
        headingPath: [`${input.prefix} Body Candidate ${index}`],
        content,
      },
    };
  });
  await db.document.createMany({
    data: documents.map((entry) => entry.document),
  });
  await db.documentIndexState.createMany({
    data: documents.map((entry) => entry.state),
  });
  await db.documentSearchChunk.createMany({
    data: documents.map((entry) => entry.chunk),
  });
}

async function seedTableCompetition(
  db: PrismaClient,
  project: { id: string },
  count: number,
  input: { prefix: string; term: string },
): Promise<void> {
  const now = new Date();
  const tables = Array.from({ length: count }, (_, index) => {
    const tableId = randomUUID();
    const sourceCommitSha = createHash("sha1")
      .update(`${project.id}:${input.prefix}:table-competition:${index}`)
      .digest("hex");
    return {
      table: {
        id: tableId,
        projectId: project.id,
        path: `tables/${input.prefix}-competition-${index}`,
        slug: `${input.prefix}-table-competition-${index}`,
        title: `${input.prefix} Table Candidate ${index}`,
        rowCount: index,
        headCommitSha: sourceCommitSha,
        lastEditedAt: now,
        createdAt: now,
      },
      projection: {
        tableId,
        projectId: project.id,
        sourceCommitSha,
        title: `${input.prefix} Table Candidate ${index}`,
        schemaText: `${input.term} ${input.term} ${input.term} column ${index} (text)`,
      },
    };
  });
  await db.dataTable.createMany({
    data: tables.map((entry) => entry.table),
  });
  await db.tableSearchProjection.createMany({
    data: tables.map((entry) => entry.projection),
  });
}

async function seedExactTitleDuplicates(
  db: PrismaClient,
  projects: Array<{ id: string }>,
  countPerProject: number,
): Promise<{ documentIds: string[]; tableIds: string[] }> {
  const now = new Date();
  const documents = projects.flatMap((project, projectIndex) =>
    Array.from({ length: countPerProject }, (_, index) => {
      const documentId = randomUUID();
      const tableId = randomUUID();
      const documentSha = createHash("sha1")
        .update(`${project.id}:duplicate-document:${index}`)
        .digest("hex");
      const tableSha = createHash("sha1")
        .update(`${project.id}:duplicate-table:${index}`)
        .digest("hex");
      return {
        document: {
          id: documentId,
          projectId: project.id,
          path: `documents/duplicate-${projectIndex}-${index}.md`,
          slug: `duplicate-${projectIndex}-${index}`,
          title: "Atlas Duplicate",
          excerpt: "",
          headCommitSha: documentSha,
          lastEditedAt: now,
          createdAt: now,
          updatedAt: now,
        },
        state: {
          documentId,
          projectId: project.id,
          targetSha: documentSha,
          keywordIndexedSha: documentSha,
          status: "ready" as const,
          completedAt: now,
        },
        table: {
          id: tableId,
          projectId: project.id,
          path: `tables/duplicate-${projectIndex}-${index}`,
          slug: `duplicate-${projectIndex}-${index}`,
          title: "Atlas Duplicate",
          rowCount: 0,
          headCommitSha: tableSha,
          lastEditedAt: now,
          createdAt: now,
        },
        projection: {
          tableId,
          projectId: project.id,
          sourceCommitSha: tableSha,
          title: "Atlas Duplicate",
          schemaText: "Value (text)",
        },
      };
    }),
  );
  await db.document.createMany({
    data: documents.map((entry) => entry.document),
  });
  await db.documentIndexState.createMany({
    data: documents.map((entry) => entry.state),
  });
  await db.dataTable.createMany({
    data: documents.map((entry) => entry.table),
  });
  await db.tableSearchProjection.createMany({
    data: documents.map((entry) => entry.projection),
  });
  return {
    documentIds: documents.map((entry) => entry.document.id),
    tableIds: documents.map((entry) => entry.table.id),
  };
}

async function seedIneligibleExactTitleCandidates(
  db: PrismaClient,
  project: { id: string },
  input: { title: string; count: number; includeEligible: boolean },
): Promise<{ documentId: string | null; tableId: string | null }> {
  const now = new Date();
  const candidates = Array.from({ length: input.count }, (_, index) => {
    const documentId = orderedExactCandidateUuid(1, index);
    const tableId = orderedExactCandidateUuid(2, index);
    const documentSha = createHash("sha1")
      .update(`${project.id}:ineligible-document:${input.title}:${index}`)
      .digest("hex");
    const tableSha = createHash("sha1")
      .update(`${project.id}:ineligible-table:${input.title}:${index}`)
      .digest("hex");
    const category = index % 4;
    return {
      document: {
        id: documentId,
        projectId: project.id,
        path: `documents/ineligible-${index}.md`,
        slug: `ineligible-document-${index}`,
        title: input.title,
        excerpt: "",
        headCommitSha: documentSha,
        lastEditedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      state:
        category === 0
          ? null
          : {
              documentId,
              projectId: project.id,
              targetSha: category === 3 ? "a".repeat(40) : documentSha,
              keywordIndexedSha: category === 3 ? "a".repeat(40) : undefined,
              status:
                category === 1
                  ? ("pending" as const)
                  : category === 2
                    ? ("failed" as const)
                    : ("ready" as const),
              completedAt: category === 3 ? now : undefined,
            },
      table: {
        id: tableId,
        projectId: project.id,
        path: `tables/ineligible-${index}`,
        slug: `ineligible-table-${index}`,
        title: input.title,
        rowCount: 0,
        headCommitSha: tableSha,
        lastEditedAt: now,
        createdAt: now,
      },
      projection:
        index % 2 === 0
          ? null
          : {
              tableId,
              projectId: project.id,
              sourceCommitSha: "b".repeat(40),
              title: input.title,
              schemaText: "Rejected value (text)",
            },
    };
  });
  await db.document.createMany({
    data: candidates.map((candidate) => candidate.document),
  });
  await db.documentIndexState.createMany({
    data: candidates.flatMap((candidate) =>
      candidate.state ? [candidate.state] : [],
    ),
  });
  await db.dataTable.createMany({
    data: candidates.map((candidate) => candidate.table),
  });
  await db.tableSearchProjection.createMany({
    data: candidates.flatMap((candidate) =>
      candidate.projection ? [candidate.projection] : [],
    ),
  });

  if (!input.includeEligible) {
    return { documentId: null, tableId: null };
  }

  const documentId = "ffffffff-ffff-4fff-bfff-fffffffffff1";
  const tableId = "ffffffff-ffff-4fff-bfff-fffffffffff2";
  const documentSha = createHash("sha1")
    .update(`${project.id}:eligible-document:${input.title}`)
    .digest("hex");
  const tableSha = createHash("sha1")
    .update(`${project.id}:eligible-table:${input.title}`)
    .digest("hex");
  await db.document.create({
    data: {
      id: documentId,
      projectId: project.id,
      path: "documents/eligible.md",
      slug: "eligible-document",
      title: input.title,
      excerpt: "",
      headCommitSha: documentSha,
      lastEditedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
  await db.documentIndexState.create({
    data: {
      documentId,
      projectId: project.id,
      targetSha: documentSha,
      keywordIndexedSha: documentSha,
      status: "ready",
      completedAt: now,
    },
  });
  await db.dataTable.create({
    data: {
      id: tableId,
      projectId: project.id,
      path: "tables/eligible",
      slug: "eligible-table",
      title: input.title,
      rowCount: 0,
      headCommitSha: tableSha,
      lastEditedAt: now,
      createdAt: now,
    },
  });
  await db.tableSearchProjection.create({
    data: {
      tableId,
      projectId: project.id,
      sourceCommitSha: tableSha,
      title: input.title,
      schemaText: "Eligible value (text)",
    },
  });
  return { documentId, tableId };
}

function orderedExactCandidateUuid(namespace: number, index: number): string {
  return `00000000-0000-4${namespace.toString(16).padStart(3, "0")}-8000-${index
    .toString(16)
    .padStart(12, "0")}`;
}

async function analyzeExactTitleRelations(db: PrismaClient): Promise<void> {
  await db.$executeRaw(Prisma.sql`ANALYZE "Document"`);
  await db.$executeRaw(Prisma.sql`ANALYZE "DocumentIndexState"`);
  await db.$executeRaw(Prisma.sql`ANALYZE "DataTable"`);
  await db.$executeRaw(Prisma.sql`ANALYZE "TableSearchProjection"`);
}

async function expectExactEligibilityKeys(
  db: PrismaClient,
  source: { documentId: string | null; tableId: string | null },
  expected: { documentTitle: string | null; tableTitle: string | null },
): Promise<void> {
  const [keys] = await db.$queryRaw<
    Array<{
      documentTitle: string | null;
      documentProjectEligible: boolean | null;
      documentHashBytes: number | null;
      tableTitle: string | null;
      tableHashBytes: number | null;
    }>
  >(Prisma.sql`
    SELECT state."exactTitle" AS "documentTitle",
           state."exactProjectId" = state."projectId"
             AS "documentProjectEligible",
           octet_length(state."exactNormalizedTitleHash")::integer
             AS "documentHashBytes",
           projection."exactTitle" AS "tableTitle",
           octet_length(projection."exactNormalizedTitleHash")::integer
             AS "tableHashBytes"
    FROM "DocumentIndexState" AS state
    CROSS JOIN "TableSearchProjection" AS projection
    WHERE state."documentId" = ${source.documentId!}::uuid
      AND projection."tableId" = ${source.tableId!}::uuid
  `);
  expect(keys).toEqual({
    ...expected,
    documentProjectEligible: expected.documentTitle === null ? null : true,
    documentHashBytes: expected.documentTitle === null ? null : 32,
    tableHashBytes: expected.tableTitle === null ? null : 32,
  });
}

async function seedTable(
  db: PrismaClient,
  project: { id: string },
  input: { slug: string; title: string; schemaText: string },
) {
  const tableId = randomUUID();
  const sourceCommitSha = createHash("sha1")
    .update(`${project.id}:${input.slug}`)
    .digest("hex");
  const now = new Date();
  await db.dataTable.create({
    data: {
      id: tableId,
      projectId: project.id,
      path: `tables/${input.slug}`,
      slug: input.slug,
      title: input.title,
      rowCount: 7,
      headCommitSha: sourceCommitSha,
      lastEditedAt: now,
      createdAt: now,
    },
  });
  await db.tableSearchProjection.create({
    data: {
      tableId,
      projectId: project.id,
      sourceCommitSha,
      title: input.title,
      schemaText: input.schemaText,
    },
  });
  return { tableId, sourceCommitSha };
}

async function seedDeletedTable(
  db: PrismaClient,
  project: { id: string },
  suffix: string,
) {
  const marker = `DELETED-ATLAS-${suffix}`;
  const table = await seedTable(db, project, {
    slug: `deleted-${suffix}`,
    title: marker,
    schemaText: `${marker} Atlas value (text)`,
  });
  await db.dataTable.delete({ where: { id: table.tableId } });
  return { ...table, marker };
}

async function seedEntity(
  db: PrismaClient,
  project: {
    id: string;
    fingerprint: string;
    activeGenerationId: string;
  },
  input: {
    canonicalName: string;
    entityType: string;
    description: string;
    aliases: string[];
    vector: number[];
    disambiguateInternalName?: boolean;
  },
) {
  const entityId = randomUUID();
  const rawNormalized = input.canonicalName.normalize("NFKC").toLowerCase();
  const internalName = input.disambiguateInternalName
    ? `${rawNormalized}::${entityId}`
    : rawNormalized;
  await db.graphEntity.create({
    data: {
      id: entityId,
      projectId: project.id,
      generationId: project.activeGenerationId,
      entityType: input.entityType,
      canonicalName: input.canonicalName,
      normalizedName: internalName,
      description: input.description,
      aliases: {
        create: input.aliases.map((alias) => ({
          projectId: project.id,
          alias,
          normalizedAlias: alias.toLowerCase(),
        })),
      },
    },
  });
  const source = await db.documentSearchChunk.findFirstOrThrow({
    where: { projectId: project.id },
  });
  await db.entityMention.create({
    data: {
      entityId,
      projectId: project.id,
      generationId: project.activeGenerationId,
      documentId: source.documentId,
      sourceChunkId: source.id,
      sourceCommitSha: source.sourceCommitSha,
      mentionText: input.canonicalName,
      confidence: 1,
    },
  });
  await seedEmbedding(db, {
    projectId: project.id,
    generationId: project.activeGenerationId,
    ownerType: "entity",
    ownerId: entityId,
    contentHash: createHash("sha256").update(input.canonicalName).digest("hex"),
    configFingerprint: project.fingerprint,
    vector: input.vector,
  });
  return { entityId, internalName };
}

async function seedBuildingEntity(
  db: PrismaClient,
  project: { id: string; fingerprint: string },
  suffix: string,
) {
  const marker = `BUILDING-ATLAS-${suffix}`;
  const generation = await db.knowledgeGeneration.create({
    data: {
      projectId: project.id,
      configFingerprint: project.fingerprint,
      embeddingModel: EMBEDDING_MODEL,
      embeddingDimensions: 1536,
      extractionSchemaVersion: 1,
      promptVersion: "prompt-v1",
      status: "building",
    },
  });
  const entityId = randomUUID();
  await db.graphEntity.create({
    data: {
      id: entityId,
      projectId: project.id,
      generationId: generation.id,
      entityType: "Secret",
      canonicalName: marker,
      normalizedName: marker.toLowerCase(),
      description: marker,
      aliases: {
        create: {
          projectId: project.id,
          alias: "Atlas",
          normalizedAlias: "atlas",
        },
      },
    },
  });
  await seedEmbedding(db, {
    projectId: project.id,
    generationId: generation.id,
    ownerType: "entity",
    ownerId: entityId,
    contentHash: createHash("sha256").update(marker).digest("hex"),
    configFingerprint: project.fingerprint,
    vector: directionVector(1, 0),
  });
  return { entityId, marker };
}

async function seedEmbedding(
  db: PrismaClient,
  input: {
    projectId: string;
    generationId: string;
    ownerType: "document_chunk" | "entity";
    ownerId: string;
    contentHash: string;
    configFingerprint: string;
    vector: number[];
  },
) {
  const vector = pgvector.toSql(input.vector);
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "KnowledgeEmbedding"
      ("id", "projectId", "generationId", "ownerType", "ownerId",
       "contentHash", "configFingerprint", "model",
       "embeddingDimensions", "embedding", "createdAt")
    VALUES
      (${randomUUID()}::uuid, ${input.projectId}::uuid,
       ${input.generationId}::uuid, ${input.ownerType}, ${input.ownerId},
       ${input.contentHash}, ${input.configFingerprint}, ${EMBEDDING_MODEL},
       1536, ${vector}::vector, now())
  `);
}

type RawQueryObservation = {
  query: Prisma.Sql;
  rows: unknown[];
};

type RawQueryRunner = <T>(query: Prisma.Sql) => Promise<T>;

function observeRawQueries(
  db: PrismaClient,
  observations: RawQueryObservation[],
): PrismaClient {
  const runQuery = db.$queryRaw.bind(db) as unknown as RawQueryRunner;
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "$transaction") {
        return (
          operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
          options?: { timeout?: number; maxWait?: number },
        ) =>
          db.$transaction(
            (tx) =>
              operation(observeRawQueries(tx as PrismaClient, observations)),
            options,
          );
      }
      if (property === "$queryRaw") {
        return async (query: Prisma.Sql) => {
          const rows = await runQuery<unknown[]>(query);
          observations.push({ query, rows });
          return rows;
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return value;
    },
  });
}

function interceptRawQueries(
  db: PrismaClient,
  beforeQuery: (query: Prisma.Sql) => void,
): PrismaClient {
  const runQuery = db.$queryRaw.bind(db) as unknown as RawQueryRunner;
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "$transaction") {
        return (
          operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
          options?: { timeout?: number; maxWait?: number },
        ) =>
          db.$transaction(
            (tx) =>
              operation(interceptRawQueries(tx as PrismaClient, beforeQuery)),
            options,
          );
      }
      if (property === "$queryRaw") {
        return async (query: Prisma.Sql) => {
          beforeQuery(query);
          return runQuery(query);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return value;
    },
  });
}

function findObservedQuery(
  observations: RawQueryObservation[],
  sqlFragment: string,
): RawQueryObservation {
  const observation = observations.find(({ query }) =>
    query.sql.includes(sqlFragment),
  );
  if (!observation) {
    throw new Error(`Expected observed SQL fragment: ${sqlFragment}`);
  }
  return observation;
}

type ExplainPlanNode = {
  "Relation Name"?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Index Cond"?: string;
  Filter?: string;
  "Recheck Cond"?: string;
  "Rows Removed by Filter"?: number;
  "Rows Removed by Index Recheck"?: number;
  Plans?: ExplainPlanNode[];
};

async function expectDefaultExactTitlePlanToExamineAtMostRows(
  db: PrismaClient,
  query: Prisma.Sql,
  relationNames: string | string[],
  maximumRows: number,
): Promise<void> {
  const plan = await db.$queryRaw<
    Array<{ "QUERY PLAN": Array<{ Plan: ExplainPlanNode }> }>
  >(Prisma.sql`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`);
  const root = plan[0]?.["QUERY PLAN"][0]?.Plan;
  if (!root) throw new Error("Expected EXPLAIN ANALYZE plan root");
  const names = Array.isArray(relationNames) ? relationNames : [relationNames];
  const exactNodes = collectExactTitlePlanNodes(root, new Set(names));
  expect(exactNodes.length).toBeGreaterThan(0);
  const examinedRows = countExaminedExactTitleRows(exactNodes);
  expect
    .soft(examinedRows, JSON.stringify(exactNodes, null, 2))
    .toBeLessThanOrEqual(maximumRows);
}

function collectExactTitlePlanNodes(
  node: ExplainPlanNode,
  relationNames: Set<string>,
): ExplainPlanNode[] {
  const predicate = [node["Index Cond"], node.Filter, node["Recheck Cond"]]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return [
    ...(node["Relation Name"] &&
    relationNames.has(node["Relation Name"]) &&
    /normalizedTitle/i.test(predicate)
      ? [node]
      : []),
    ...(node.Plans ?? []).flatMap((child) =>
      collectExactTitlePlanNodes(child, relationNames),
    ),
  ];
}

function countExaminedExactTitleRows(nodes: ExplainPlanNode[]): number {
  return nodes.reduce((total, node) => {
    const loops = node["Actual Loops"] ?? 0;
    return (
      total +
      loops *
        ((node["Actual Rows"] ?? 0) +
          (node["Rows Removed by Filter"] ?? 0) +
          (node["Rows Removed by Index Recheck"] ?? 0))
    );
  }, 0);
}

function queryProvider(
  vector: number[] | (() => Promise<never>) | (() => Promise<number[]>),
): { routing: KnowledgeRouting; provider: AiProvider } {
  return {
    routing,
    provider: {
      embeddingRequestByteLength(input) {
        return Buffer.byteLength(
          JSON.stringify({ model: EMBEDDING_MODEL, input }),
          "utf8",
        );
      },
      async embed(): Promise<EmbeddingResult> {
        const resolved = typeof vector === "function" ? await vector() : vector;
        return { vectors: [resolved], usage: QUERY_USAGE };
      },
      async extract() {
        throw new Error("Search never performs extraction");
      },
    },
  };
}

function queryVector(): number[] {
  return directionVector(1, 0);
}

function directionVector(first: number, second: number): number[] {
  return sizedDirectionVector(1536, first, second);
}

function sizedDirectionVector(
  size: number,
  first: number,
  second: number,
): number[] {
  const vector = Array<number>(size).fill(0);
  vector[0] = first;
  vector[1] = second;
  return vector;
}

/** A query provider bound to a fixed vector rather than the module-level `routing`. */
function fixedVectorProvider(
  routing: KnowledgeRouting,
  vector: number[],
): { routing: KnowledgeRouting; provider: AiProvider } {
  return {
    routing,
    provider: {
      embeddingRequestByteLength(input) {
        return Buffer.byteLength(JSON.stringify({ input }), "utf8");
      },
      async embed(): Promise<EmbeddingResult> {
        return { vectors: [vector], usage: QUERY_USAGE };
      },
      async extract() {
        throw new Error("Search never performs extraction");
      },
    },
  };
}

async function disableRouting(): Promise<void> {
  await getPrisma().llmRoute.deleteMany({});
  invalidateLlmRouteCache();
}

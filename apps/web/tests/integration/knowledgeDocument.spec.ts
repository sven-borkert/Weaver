import { randomUUID } from "node:crypto";

import pgvector from "pgvector";
import { beforeEach, describe, expect, it } from "vitest";

import { Prisma, type PrismaClient } from "@weaver/db/client";
import type { KnowledgeRouting } from "@weaver/core/services/llmRoutes";
import {
  addMembership,
  callerFor,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  seedTestLlmRouting,
} from "./_harness";

const ACTIVE_MODEL = "doc-index-embedding-large";
const BUILDING_MODEL = "doc-index-embedding-small";
const EXTRACTION_MODEL = "doc-index-extraction";

let routing: KnowledgeRouting;

beforeEach(async () => {
  await resetDb();
  routing = (await seedTestLlmRouting()).routing;
});

describe("knowledge.document", () => {
  it("shows a Viewer every index layer of one document without model names", async () => {
    const fixture = await indexedDocumentFixture("viewer");

    const result = await callerFor(fixture.viewer).knowledge.document({
      projectId: fixture.project.id,
      documentId: fixture.document.id,
    });

    const head = fixture.document.headCommitSha;
    expect(result).toEqual({
      documentId: fixture.document.id,
      headCommitSha: head,
      lights: {
        keyword: "ready",
        semantic: "ready",
        graph: "ready",
        summary: null,
      },
      keyword: {
        status: "ready",
        targetSha: head,
        indexedSha: head,
        chunkCount: 3,
        attempts: 1,
        lastAttemptAt: fixture.completedAt,
        completedAt: fixture.completedAt,
        failureKind: null,
        failureSummary: null,
      },
      generations: [
        {
          id: fixture.active.id,
          status: "active",
          graphCarried: false,
          embedding: {
            model: null,
            dimensions: 3072,
            dimensionMode: "matryoshka",
            vectorType: "halfvec",
          },
          document: {
            status: "ready",
            targetSha: head,
            semanticIndexedSha: head,
            graphIndexedSha: head,
            embeddedChunks: 2,
            extractionModel: null,
            extractionOutdated: false,
            attempts: 1,
            lastAttemptAt: fixture.completedAt,
            completedAt: fixture.completedAt,
            failureKind: null,
            failureSummary: null,
          },
        },
        {
          id: fixture.building.id,
          status: "building",
          graphCarried: true,
          embedding: {
            model: null,
            dimensions: 1024,
            dimensionMode: "native",
            vectorType: "vector",
          },
          document: {
            status: "pending",
            targetSha: head,
            semanticIndexedSha: null,
            graphIndexedSha: null,
            embeddedChunks: 0,
            extractionModel: null,
            extractionOutdated: false,
            attempts: 0,
            lastAttemptAt: null,
            completedAt: null,
            failureKind: null,
            failureSummary: null,
          },
        },
      ],
      graph: {
        generationId: fixture.active.id,
        entityTotal: 2,
        relationTotal: 1,
        entities: [
          { id: fixture.atlas.id, name: "Atlas", type: "Product", mentions: 2 },
          {
            id: fixture.acme.id,
            name: "Acme",
            type: "Organization",
            mentions: 1,
          },
        ],
        truncated: false,
      },
    });
    const serialized = JSON.stringify(result);
    for (const hidden of [
      ACTIVE_MODEL,
      BUILDING_MODEL,
      EXTRACTION_MODEL,
      "SOURCE-TEXT",
      "Chunk body",
      "Hidden",
      "Foreign",
    ]) {
      expect(serialized).not.toContain(hidden);
    }
  });

  it("adds embedding and extraction model names for a Maintainer", async () => {
    const fixture = await indexedDocumentFixture("maintainer");

    const result = await callerFor(fixture.maintainer).knowledge.document({
      projectId: fixture.project.id,
      documentId: fixture.document.id,
    });

    expect(result.generations.map((entry) => entry.embedding.model)).toEqual([
      ACTIVE_MODEL,
      BUILDING_MODEL,
    ]);
    expect(
      result.generations.map((entry) => entry.document?.extractionModel),
    ).toEqual([EXTRACTION_MODEL, null]);
  });

  it("hides the document from non-members and other projects", async () => {
    const fixture = await indexedDocumentFixture("access");
    const outsider = await makeUser("Admin", "doc-index-outsider");
    const otherProject = await makeProject("Doc index other");
    await addMembership(otherProject.id, fixture.viewer.id, "Viewer");

    await expect(
      callerFor(outsider).knowledge.document({
        projectId: fixture.project.id,
        documentId: fixture.document.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      callerFor(fixture.viewer).knowledge.document({
        projectId: otherProject.id,
        documentId: fixture.document.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      callerFor(fixture.viewer).knowledge.document({
        projectId: fixture.project.id,
        documentId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("reports an unindexed document without generations", async () => {
    const viewer = await makeUser("User", "doc-index-empty");
    const project = await makeProject("Doc index empty");
    await addMembership(project.id, viewer.id, "Viewer");
    const document = await createDocument(getPrisma(), project.id, "empty");

    const result = await callerFor(viewer).knowledge.document({
      projectId: project.id,
      documentId: document.id,
    });

    expect(result).toEqual({
      documentId: document.id,
      headCommitSha: document.headCommitSha,
      lights: {
        keyword: "pending",
        semantic: "unavailable",
        graph: "unavailable",
        summary: null,
      },
      keyword: {
        status: null,
        targetSha: null,
        indexedSha: null,
        chunkCount: 0,
        attempts: 0,
        lastAttemptAt: null,
        completedAt: null,
        failureKind: null,
        failureSummary: null,
      },
      generations: [],
      graph: {
        generationId: null,
        entityTotal: 0,
        relationTotal: 0,
        entities: [],
        truncated: false,
      },
    });
  });

  it("explains a failed document and an extraction from an older model", async () => {
    const viewer = await makeUser("User", "doc-index-failure");
    const project = await makeProject("Doc index failure");
    await addMembership(project.id, viewer.id, "Viewer");
    const db = getPrisma();
    const failed = await createDocument(db, project.id, "failed");
    const outdated = await createDocument(db, project.id, "outdated");
    const active = await createGeneration(db, project.id, "active", {
      dimensions: 1536,
      mode: "native",
      model: ACTIVE_MODEL,
    });
    await db.knowledgeGenerationDocument.createMany({
      data: [
        {
          generationId: active.id,
          documentId: failed.id,
          projectId: project.id,
          targetSha: failed.headCommitSha,
          configFingerprint: active.configFingerprint,
          status: "failed",
          attempts: 6,
          failureKind: "provider",
          failureSummary: "Provider unavailable",
        },
        {
          generationId: active.id,
          documentId: outdated.id,
          projectId: project.id,
          targetSha: outdated.headCommitSha,
          semanticIndexedSha: outdated.headCommitSha,
          graphIndexedSha: outdated.headCommitSha,
          configFingerprint: active.configFingerprint,
          extractionFingerprint: "older-extraction",
          extractionModel: "older-model",
          status: "ready",
        },
      ],
    });

    const caller = callerFor(viewer);
    const failedResult = await caller.knowledge.document({
      projectId: project.id,
      documentId: failed.id,
    });
    const outdatedResult = await caller.knowledge.document({
      projectId: project.id,
      documentId: outdated.id,
    });

    expect(failedResult.lights).toMatchObject({
      semantic: "failed",
      graph: "failed",
      summary: "Provider unavailable",
    });
    expect(failedResult.generations[0]?.document).toMatchObject({
      status: "failed",
      attempts: 6,
      failureKind: "provider",
      failureSummary: "Provider unavailable",
      extractionOutdated: false,
    });
    expect(outdatedResult.generations[0]?.document).toMatchObject({
      status: "ready",
      extractionOutdated: true,
      extractionModel: null,
    });
    expect(routing.extractionFingerprint).not.toBe("older-extraction");
  });

  it("caps the entity list at 50, most-mentioned first", async () => {
    const viewer = await makeUser("User", "doc-index-cap");
    const project = await makeProject("Doc index cap");
    await addMembership(project.id, viewer.id, "Viewer");
    const db = getPrisma();
    const document = await createDocument(db, project.id, "cap");
    const active = await createGeneration(db, project.id, "active", {
      dimensions: 1536,
      mode: "native",
      model: ACTIVE_MODEL,
    });
    const chunkId = await createChunk(db, project.id, document, 0);
    for (let index = 0; index < 51; index += 1) {
      const entity = await createEntity(db, project.id, active.id, {
        name: `Entity ${String(index).padStart(2, "0")}`,
        type: "Concept",
      });
      await createMention(db, {
        projectId: project.id,
        generationId: active.id,
        entityId: entity.id,
        documentId: document.id,
        chunkId,
        sha: document.headCommitSha,
        count: index === 50 ? 3 : 1,
      });
    }

    const result = await callerFor(viewer).knowledge.document({
      projectId: project.id,
      documentId: document.id,
    });

    expect(result.graph.entityTotal).toBe(51);
    expect(result.graph.truncated).toBe(true);
    expect(result.graph.entities).toHaveLength(50);
    expect(result.graph.entities[0]).toMatchObject({
      name: "Entity 50",
      mentions: 3,
    });
    expect(result.graph.entities[1]?.name).toBe("Entity 00");
    expect(result.graph.entities[49]?.name).toBe("Entity 48");
  });
});

async function indexedDocumentFixture(suffix: string) {
  const db = getPrisma();
  const viewer = await makeUser("User", `doc-index-viewer-${suffix}`);
  const maintainer = await makeUser("User", `doc-index-maintainer-${suffix}`);
  const project = await makeProject(`Doc index ${suffix}`);
  await addMembership(project.id, viewer.id, "Viewer");
  await addMembership(project.id, maintainer.id, "Maintainer");
  const document = await createDocument(db, project.id, suffix);
  const head = document.headCommitSha;
  const completedAt = new Date("2026-09-27T08:00:00.000Z");

  await db.documentIndexState.create({
    data: {
      documentId: document.id,
      projectId: project.id,
      targetSha: head,
      keywordIndexedSha: head,
      status: "ready",
      attempts: 1,
      lastAttemptAt: completedAt,
      completedAt,
    },
  });
  const chunkIds = [
    await createChunk(db, project.id, document, 0),
    await createChunk(db, project.id, document, 1),
    await createChunk(db, project.id, document, 2),
  ];
  // A chunk of an older revision is not part of the current projection.
  await createChunk(
    db,
    project.id,
    { ...document, headCommitSha: "e".repeat(40) },
    0,
  );

  const active = await createGeneration(db, project.id, "active", {
    dimensions: 3072,
    mode: "matryoshka",
    model: ACTIVE_MODEL,
  });
  const building = await createGeneration(db, project.id, "building", {
    dimensions: 1024,
    mode: "native",
    model: BUILDING_MODEL,
    graphSourceGenerationId: active.id,
  });
  await db.knowledgeGenerationDocument.createMany({
    data: [
      {
        generationId: active.id,
        documentId: document.id,
        projectId: project.id,
        targetSha: head,
        semanticIndexedSha: head,
        graphIndexedSha: head,
        configFingerprint: active.configFingerprint,
        extractionFingerprint: routing.extractionFingerprint,
        extractionModel: EXTRACTION_MODEL,
        status: "ready",
        attempts: 1,
        lastAttemptAt: completedAt,
        completedAt,
      },
      {
        generationId: building.id,
        documentId: document.id,
        projectId: project.id,
        targetSha: head,
        configFingerprint: building.configFingerprint,
        status: "pending",
      },
    ],
  });
  await createChunkEmbedding(db, active, chunkIds[0]!);
  await createChunkEmbedding(db, active, chunkIds[1]!);

  const atlas = await createEntity(db, project.id, active.id, {
    name: "Atlas",
    type: "Product",
  });
  const acme = await createEntity(db, project.id, active.id, {
    name: "Acme",
    type: "Organization",
  });
  const hidden = await createEntity(db, project.id, active.id, {
    name: "Hidden",
    type: "Concept",
  });
  const mention = {
    projectId: project.id,
    generationId: active.id,
    documentId: document.id,
    chunkId: chunkIds[0]!,
    sha: head,
  };
  await createMention(db, { ...mention, entityId: atlas.id, count: 2 });
  await createMention(db, { ...mention, entityId: acme.id, count: 1 });
  await createMention(db, {
    ...mention,
    entityId: hidden.id,
    count: 1,
    invalidated: true,
  });
  const liveRelation = await createRelation(
    db,
    project.id,
    active.id,
    atlas.id,
    acme.id,
  );
  const staleRelation = await createRelation(
    db,
    project.id,
    active.id,
    acme.id,
    atlas.id,
  );
  await db.relationEvidence.createMany({
    data: [
      {
        projectId: project.id,
        generationId: active.id,
        relationId: liveRelation.id,
        documentId: document.id,
        sourceChunkId: chunkIds[0]!,
        sourceCommitSha: head,
        evidenceText: "Atlas is built by Acme.",
        confidence: 0.9,
      },
      {
        projectId: project.id,
        generationId: active.id,
        relationId: staleRelation.id,
        documentId: document.id,
        sourceChunkId: chunkIds[0]!,
        sourceCommitSha: head,
        evidenceText: "Old evidence.",
        confidence: 0.9,
        invalidatedAt: new Date(),
      },
    ],
  });

  // Rows of another project that claim the same document id stay invisible.
  const foreignProject = await makeProject(`Doc index foreign ${suffix}`);
  const foreignGeneration = await createGeneration(
    db,
    foreignProject.id,
    "active",
    {
      dimensions: 1536,
      mode: "native",
      model: ACTIVE_MODEL,
    },
  );
  const foreign = await createEntity(
    db,
    foreignProject.id,
    foreignGeneration.id,
    {
      name: "Foreign",
      type: "Concept",
    },
  );
  await createMention(db, {
    projectId: foreignProject.id,
    generationId: foreignGeneration.id,
    entityId: foreign.id,
    documentId: document.id,
    chunkId: chunkIds[0]!,
    sha: head,
    count: 1,
  });

  return {
    viewer,
    maintainer,
    project,
    document,
    completedAt,
    active,
    building,
    atlas,
    acme,
  };
}

async function createDocument(
  db: PrismaClient,
  projectId: string,
  suffix: string,
) {
  return db.document.create({
    data: {
      id: randomUUID(),
      projectId,
      path: `doc-index-${suffix}.md`,
      slug: `doc-index-${suffix}`,
      title: `Doc index ${suffix}`,
      excerpt: `SOURCE-TEXT-${suffix}`,
      headCommitSha: randomUUID().replaceAll("-", "").padEnd(40, "a"),
      lastEditedAt: new Date("2026-09-27T07:00:00.000Z"),
      createdAt: new Date("2026-09-27T07:00:00.000Z"),
      updatedAt: new Date("2026-09-27T07:00:00.000Z"),
    },
  });
}

async function createGeneration(
  db: PrismaClient,
  projectId: string,
  status: "active" | "building",
  options: {
    dimensions: number;
    mode: "native" | "matryoshka";
    model: string;
    graphSourceGenerationId?: string;
  },
) {
  return db.knowledgeGeneration.create({
    data: {
      projectId,
      configFingerprint: `doc-index-${status}-${randomUUID()}`,
      embeddingModel: options.model,
      embeddingDimensions: options.dimensions,
      extractionSchemaVersion: 1,
      promptVersion: "prompt-v1",
      routeSnapshot: {
        extraction: { embeddingDimensionMode: "native" },
        embedding: { embeddingDimensionMode: options.mode },
      },
      status,
      graphSourceGenerationId: options.graphSourceGenerationId ?? null,
      activatedAt: status === "active" ? new Date() : null,
    },
  });
}

async function createChunk(
  db: PrismaClient,
  projectId: string,
  document: { id: string; headCommitSha: string },
  ordinal: number,
): Promise<string> {
  const id = `${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
  await db.documentSearchChunk.create({
    data: {
      id,
      projectId,
      documentId: document.id,
      ordinal,
      sourceCommitSha: document.headCommitSha,
      contentHash: id,
      headingPath: ["Doc index"],
      content: `Chunk body ${ordinal}`,
    },
  });
  return id;
}

async function createChunkEmbedding(
  db: PrismaClient,
  generation: {
    id: string;
    projectId: string;
    configFingerprint: string;
    embeddingModel: string;
    embeddingDimensions: number;
  },
  chunkId: string,
) {
  const vector = pgvector.toSql(
    Array.from({ length: generation.embeddingDimensions }, (_, index) =>
      index === 0 ? 1 : 0,
    ),
  );
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "KnowledgeEmbedding"
      ("id", "projectId", "generationId", "ownerType", "ownerId",
       "contentHash", "configFingerprint", "model",
       "embeddingDimensions", "embedding", "createdAt")
    VALUES
      (${randomUUID()}::uuid, ${generation.projectId}::uuid,
       ${generation.id}::uuid, 'document_chunk', ${chunkId},
       ${chunkId}, ${generation.configFingerprint}, ${generation.embeddingModel},
       ${generation.embeddingDimensions}, ${vector}::vector, now())
  `);
}

async function createEntity(
  db: PrismaClient,
  projectId: string,
  generationId: string,
  input: { name: string; type: string },
) {
  return db.graphEntity.create({
    data: {
      projectId,
      generationId,
      entityType: input.type,
      canonicalName: input.name,
      normalizedName: input.name.toLowerCase(),
    },
  });
}

async function createMention(
  db: PrismaClient,
  input: {
    projectId: string;
    generationId: string;
    entityId: string;
    documentId: string;
    chunkId: string;
    sha: string;
    count: number;
    invalidated?: boolean;
  },
) {
  await db.entityMention.createMany({
    data: Array.from({ length: input.count }, () => ({
      projectId: input.projectId,
      generationId: input.generationId,
      entityId: input.entityId,
      documentId: input.documentId,
      sourceChunkId: input.chunkId,
      sourceCommitSha: input.sha,
      mentionText: "mention",
      confidence: 0.8,
      invalidatedAt: input.invalidated ? new Date() : null,
    })),
  });
}

async function createRelation(
  db: PrismaClient,
  projectId: string,
  generationId: string,
  sourceEntityId: string,
  targetEntityId: string,
) {
  return db.graphRelation.create({
    data: {
      projectId,
      generationId,
      sourceEntityId,
      targetEntityId,
      relationType: "built_by",
      normalizedType: "built_by",
    },
  });
}

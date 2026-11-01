import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  KNOWLEDGE_EXTRACTION_SCHEMA_VERSION,
  parseKnowledgeConfig,
} from "@weaver/core/knowledge/config";
import { registerKnowledgeJobHandlers } from "@weaver/core/jobs/runtime";
import { knowledgeSystemContextForTests } from "@weaver/core/jobs/systemContext";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import { updateLlmModel } from "@weaver/core/services/llmConnections";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import { resolveKnowledgeRouting } from "@weaver/core/services/llmRoutes";
import { searchKnowledge } from "@weaver/core/services/search";

import {
  getPrisma,
  resetDb,
  securityContextFor,
  seedTestLlmRouting,
  testEncryptionKeys,
} from "./_harness";
import {
  drain,
  indexProject,
  sizedEmbeddingsFetch,
  sizedProvider,
  sizedRoutingSource,
  type ProviderCalls,
} from "./_knowledgePipeline";

async function graphCounts(generationId: string) {
  const db = getPrisma();
  const [entities, aliases, mentions, relations, evidence] = await Promise.all([
    db.graphEntity.count({ where: { generationId } }),
    db.graphEntityAlias.count({ where: { entity: { generationId } } }),
    db.entityMention.count({ where: { generationId } }),
    db.graphRelation.count({ where: { generationId } }),
    db.relationEvidence.count({ where: { generationId } }),
  ]);
  return { entities, aliases, mentions, relations, evidence };
}

describe("graph-preserving re-embed", () => {
  let queue: FakeJobQueue;
  const calls: ProviderCalls = { extract: [], embed: [] };

  beforeEach(async () => {
    await resetDb();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("WEAVER_JOBS_ENABLED", "true");
    queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    calls.extract.length = 0;
    calls.embed.length = 0;
    calls.rejectEntityEmbeddings = false;
    await registerKnowledgeJobHandlers({
      queue,
      context: knowledgeSystemContextForTests(),
      db: getPrisma(),
      config: parseKnowledgeConfig({ WEAVER_JOBS_ENABLED: "true" }),
      routing: sizedRoutingSource(calls),
    });
  });
  afterEach(() => {
    setJobQueueForTests(null);
    vi.unstubAllEnvs();
  });

  async function resize(adminId: string, modelId: string, size: number) {
    const db = getPrisma();
    const admin = await db.user.findUniqueOrThrow({ where: { id: adminId } });
    return updateLlmModel(
      db,
      securityContextFor(admin),
      { modelId, embeddingDimensions: size },
      {
        ring: testEncryptionKeys(),
        fetchImpl: sizedEmbeddingsFetch(() => size),
      },
    );
  }

  it("copies the graph into the new generation instead of re-extracting", async () => {
    const db = getPrisma();
    const { admin, routing } = await seedTestLlmRouting();
    const { project } = await indexProject(queue, ["Alpha", "Beta"]);
    const source = await db.knowledgeGeneration.findFirstOrThrow({
      where: { projectId: project.id, status: "active" },
    });
    const before = await graphCounts(source.id);
    expect(before.entities).toBeGreaterThan(0);
    expect(before.relations).toBeGreaterThan(0);

    expect(
      (await resize(admin.id, routing.embedding.modelId, 1024)).reindexProjects,
    ).toBe(1);
    await queue.run("project.reconcile", { projectId: project.id });

    const target = await db.knowledgeGeneration.findFirstOrThrow({
      where: { projectId: project.id, status: "building" },
    });
    expect(target).toMatchObject({
      graphSourceGenerationId: source.id,
      embeddingDimensions: 1024,
    });
    expect(await graphCounts(target.id)).toEqual(before);

    const sourceEntityIds = new Set(
      (
        await db.graphEntity.findMany({
          where: { generationId: source.id },
          select: { id: true },
        })
      ).map((row) => row.id),
    );
    const targetEntities = await db.graphEntity.findMany({
      where: { generationId: target.id },
      select: { id: true },
    });
    expect(targetEntities.some((row) => sourceEntityIds.has(row.id))).toBe(
      false,
    );

    const [crossings] = await db.$queryRaw<[{ count: number }]>`
      SELECT (
        (SELECT count(*) FROM "EntityMention" m JOIN "GraphEntity" e ON e."id" = m."entityId"
          WHERE m."generationId" = ${target.id}::uuid AND e."generationId" <> m."generationId")
        + (SELECT count(*) FROM "GraphRelation" r
            JOIN "GraphEntity" s ON s."id" = r."sourceEntityId"
            JOIN "GraphEntity" t ON t."id" = r."targetEntityId"
          WHERE r."generationId" = ${target.id}::uuid
            AND (s."generationId" <> r."generationId" OR t."generationId" <> r."generationId"))
        + (SELECT count(*) FROM "RelationEvidence" v JOIN "GraphRelation" r ON r."id" = v."relationId"
          WHERE v."generationId" = ${target.id}::uuid AND r."generationId" <> v."generationId")
      )::int AS count
    `;
    expect(crossings.count).toBe(0);

    const states = await db.knowledgeGenerationDocument.findMany({
      where: { generationId: target.id },
      select: {
        status: true,
        targetSha: true,
        semanticIndexedSha: true,
        graphIndexedSha: true,
        extractionModel: true,
        extractionFingerprint: true,
      },
    });
    expect(states).toHaveLength(2);
    for (const state of states) {
      expect(state).toMatchObject({
        status: "pending",
        semanticIndexedSha: null,
        graphIndexedSha: state.targetSha,
        extractionModel: "test-extraction",
        extractionFingerprint: routing.extractionFingerprint,
      });
    }
    await expect(
      db.knowledgeEmbedding.count({ where: { generationId: target.id } }),
    ).resolves.toBe(0);
  });

  it("builds and activates an empty project's new generation", async () => {
    const db = getPrisma();
    const { admin, routing } = await seedTestLlmRouting();
    const { project, cursor } = await indexProject(queue, []);
    const source = await db.knowledgeGeneration.findFirstOrThrow({
      where: { projectId: project.id, status: "active" },
    });

    await resize(admin.id, routing.embedding.modelId, 1024);
    await drain(queue, cursor);

    await expect(
      db.knowledgeGeneration.findFirstOrThrow({
        where: { projectId: project.id, status: "active" },
        select: { embeddingDimensions: true, graphSourceGenerationId: true },
      }),
    ).resolves.toEqual({
      embeddingDimensions: 1024,
      graphSourceGenerationId: source.id,
    });
  });

  it("does not carry a graph across an extraction schema change", async () => {
    const db = getPrisma();
    const { admin, routing } = await seedTestLlmRouting();
    const { project } = await indexProject(queue, ["Alpha"]);
    await db.knowledgeGeneration.updateMany({
      where: { projectId: project.id, status: "active" },
      data: {
        extractionSchemaVersion: KNOWLEDGE_EXTRACTION_SCHEMA_VERSION + 1,
      },
    });

    await resize(admin.id, routing.embedding.modelId, 1024);
    await queue.run("project.reconcile", { projectId: project.id });

    const target = await db.knowledgeGeneration.findFirstOrThrow({
      where: { projectId: project.id, status: "building" },
    });
    expect(target.graphSourceGenerationId).toBeNull();
    expect((await graphCounts(target.id)).entities).toBe(0);
  });

  it("does not carry a graph into a manual rebuild", async () => {
    const db = getPrisma();
    await seedTestLlmRouting();
    const { caller, project } = await indexProject(queue, ["Alpha"]);

    await caller.knowledge.rebuild({ projectId: project.id });

    await expect(
      db.knowledgeGeneration.findFirstOrThrow({
        where: { projectId: project.id, status: "building" },
        select: { graphSourceGenerationId: true },
      }),
    ).resolves.toEqual({ graphSourceGenerationId: null });
  });

  it("does not carry a graph when a resize supersedes a still-building manual rebuild", async () => {
    const db = getPrisma();
    const { admin, routing } = await seedTestLlmRouting();
    const { caller, project } = await indexProject(queue, ["Alpha"]);

    await caller.knowledge.rebuild({ projectId: project.id });
    const afterRebuild = queue.jobs.length;
    const rebuild = await db.knowledgeGeneration.findFirstOrThrow({
      where: { projectId: project.id, status: "building" },
      select: { id: true },
    });

    calls.extract.length = 0;

    await resize(admin.id, routing.embedding.modelId, 1024);
    await drain(queue, afterRebuild);

    expect(calls.extract.length).toBeGreaterThan(0);
    const active = await db.knowledgeGeneration.findFirstOrThrow({
      where: { projectId: project.id, status: "active" },
      select: { graphSourceGenerationId: true, embeddingDimensions: true },
    });
    expect(active).toEqual({
      graphSourceGenerationId: null,
      embeddingDimensions: 1024,
    });
    await expect(
      db.knowledgeGeneration.findUniqueOrThrow({
        where: { id: rebuild.id },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "superseded" });
  });

  async function missingEntityVectors(generationId: string) {
    const [row] = await getPrisma().$queryRaw<[{ count: number }]>`
      SELECT count(*)::int AS count FROM "GraphEntity" entity
      WHERE entity."generationId" = ${generationId}::uuid
        AND EXISTS (SELECT 1 FROM "EntityMention" m
          WHERE m."entityId" = entity."id" AND m."invalidatedAt" IS NULL)
        AND NOT EXISTS (SELECT 1 FROM "KnowledgeEmbedding" k
          WHERE k."generationId" = entity."generationId" AND k."ownerType" = 'entity'
            AND k."ownerId" = entity."id"::text)
    `;
    return row.count;
  }

  it("re-embeds chunks and entities without extraction and activates the carried graph", async () => {
    const db = getPrisma();
    const { admin, routing } = await seedTestLlmRouting();
    const { editor, project, cursor } = await indexProject(queue, [
      "Alpha",
      "Beta",
    ]);
    const source = await db.knowledgeGeneration.findFirstOrThrow({
      where: { projectId: project.id, status: "active" },
    });
    calls.extract.length = 0;
    calls.embed.length = 0;

    await resize(admin.id, routing.embedding.modelId, 1024);
    await drain(queue, cursor);

    expect(calls.extract).toEqual([]);
    const active = await db.knowledgeGeneration.findFirstOrThrow({
      where: { projectId: project.id, status: "active" },
    });
    expect(active).toMatchObject({
      embeddingDimensions: 1024,
      graphSourceGenerationId: source.id,
    });
    await expect(
      db.knowledgeGeneration.findUniqueOrThrow({
        where: { id: source.id },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "superseded" });
    expect(await missingEntityVectors(active.id)).toBe(0);
    const entityTexts = calls.embed
      .flat()
      .filter((text) => text.includes("\nType: "));
    expect(new Set(entityTexts).size).toBe(entityTexts.length);

    const live = (await resolveKnowledgeRouting(db))!;
    const result = await searchKnowledge(
      db,
      { query: "Weaver", projectIds: [project.id] },
      securityContextFor(editor),
      { routing: live, provider: sizedProvider(1024, calls) },
    );
    expect(result.mode).toBe("hybrid");
    expect(result.entities.map((row) => row.canonicalName)).toContain("Weaver");
  });

  it("re-extracts only a document edited before the switch", async () => {
    const db = getPrisma();
    const { admin, routing } = await seedTestLlmRouting();
    const { caller, project, documents, cursor } = await indexProject(queue, [
      "Alpha",
      "Beta",
    ]);
    const alpha = documents[0]!;
    await caller.document.update({
      projectId: project.id,
      documentId: alpha.id,
      baseCommitSha: alpha.headCommitSha,
      content: {
        kind: "markdown",
        contentJson: parseDocumentBody(
          "# Alpha\n\nAlpha changed for Weaver.\n",
        ),
      },
      changeSummary: "Edit before the size change",
    });
    for (const job of queue.jobs.slice(cursor)) {
      if (job.name === "document.search-sync")
        await queue.run(job.name, job.data as never);
    }
    // Skip the old generation's enrichment of the edit.
    const next = queue.jobs.length;
    calls.extract.length = 0;

    await resize(admin.id, routing.embedding.modelId, 1024);
    await drain(queue, next);

    expect(calls.extract.length).toBeGreaterThan(0);
    expect(new Set(calls.extract.map((request) => request.documentId))).toEqual(
      new Set([alpha.id]),
    );
    const active = await db.knowledgeGeneration.findFirstOrThrow({
      where: { projectId: project.id, status: "active" },
    });
    const head = (
      await db.document.findUniqueOrThrow({ where: { id: alpha.id } })
    ).headCommitSha;
    const mentions = await db.entityMention.findMany({
      where: { generationId: active.id, documentId: alpha.id },
      select: { sourceCommitSha: true, invalidatedAt: true },
    });
    expect(
      mentions
        .filter((mention) => mention.invalidatedAt === null)
        .every((mention) => mention.sourceCommitSha === head),
    ).toBe(true);
    expect(mentions.some((mention) => mention.invalidatedAt !== null)).toBe(
      true,
    );
  });

  it("carries the graph again and reuses stored vectors when switching back", async () => {
    const db = getPrisma();
    const { admin, routing } = await seedTestLlmRouting();
    const { project, cursor } = await indexProject(queue, ["Alpha", "Beta"]);
    await resize(admin.id, routing.embedding.modelId, 1024);
    const next = await drain(queue, cursor);
    calls.extract.length = 0;
    calls.embed.length = 0;

    await resize(admin.id, routing.embedding.modelId, 1536);
    await drain(queue, next);

    expect(calls.extract).toEqual([]);
    expect(calls.embed).toEqual([]);
    const active = await db.knowledgeGeneration.findFirstOrThrow({
      where: { projectId: project.id, status: "active" },
    });
    expect(active.embeddingDimensions).toBe(1536);
    expect(active.graphSourceGenerationId).not.toBeNull();
    expect(await missingEntityVectors(active.id)).toBe(0);
  });

  it("keeps a document deleted before the switch out of the live graph", async () => {
    const db = getPrisma();
    const { admin, routing } = await seedTestLlmRouting();
    const { caller, project, documents, cursor } = await indexProject(queue, [
      "Alpha",
      "Beta",
    ]);
    const beta = documents[1]!;
    await caller.document.delete({
      projectId: project.id,
      documentId: beta.id,
    });
    const next = await drain(queue, cursor);

    await resize(admin.id, routing.embedding.modelId, 1024);
    await drain(queue, next);

    const active = await db.knowledgeGeneration.findFirstOrThrow({
      where: { projectId: project.id, status: "active" },
    });
    expect(active.embeddingDimensions).toBe(1024);
    await expect(
      db.entityMention.count({
        where: {
          generationId: active.id,
          documentId: beta.id,
          invalidatedAt: null,
        },
      }),
    ).resolves.toBe(0);
  });

  it("carries from the active generation when the size changes again mid-build", async () => {
    const db = getPrisma();
    const { admin, routing } = await seedTestLlmRouting();
    const { project } = await indexProject(queue, ["Alpha", "Beta"]);
    const source = await db.knowledgeGeneration.findFirstOrThrow({
      where: { projectId: project.id, status: "active" },
    });
    calls.extract.length = 0;

    await resize(admin.id, routing.embedding.modelId, 1024);
    await queue.run("project.reconcile", { projectId: project.id });
    const next = queue.jobs.length;
    await resize(admin.id, routing.embedding.modelId, 768);
    await drain(queue, next);

    expect(calls.extract).toEqual([]);
    await expect(
      db.knowledgeGeneration.findFirstOrThrow({
        where: { projectId: project.id, status: "active" },
        select: { embeddingDimensions: true, graphSourceGenerationId: true },
      }),
    ).resolves.toEqual({
      embeddingDimensions: 768,
      graphSourceGenerationId: source.id,
    });
  });

  it("does not finish a carried document whose entities cannot be embedded", async () => {
    const db = getPrisma();
    const { admin, routing } = await seedTestLlmRouting();
    const { project, cursor } = await indexProject(queue, ["Alpha", "Beta"]);
    const source = await db.knowledgeGeneration.findFirstOrThrow({
      where: { projectId: project.id, status: "active" },
    });

    calls.rejectEntityEmbeddings = true;
    await resize(admin.id, routing.embedding.modelId, 1024);
    await expect(drain(queue, cursor)).rejects.toThrow();

    await expect(
      db.knowledgeGeneration.findUniqueOrThrow({
        where: { id: source.id },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "active" });
    const target = await db.knowledgeGeneration.findFirstOrThrow({
      where: { projectId: project.id, status: "building" },
    });
    expect(target.embeddingDimensions).toBe(1024);
    const states = await db.knowledgeGenerationDocument.findMany({
      where: { generationId: target.id },
      select: { status: true },
    });
    expect(states.some((state) => state.status === "ready")).toBe(false);
  });

  it("reports the carried graph in project status", async () => {
    const { admin, routing } = await seedTestLlmRouting();
    const { caller, project } = await indexProject(queue, ["Alpha"]);

    await resize(admin.id, routing.embedding.modelId, 1024);
    await queue.run("project.reconcile", { projectId: project.id });

    const status = await caller.knowledge.status({ projectId: project.id });
    expect(status.activeGeneration?.graphCarried).toBe(false);
    expect(status.buildingGeneration?.graphCarried).toBe(true);
  });
});

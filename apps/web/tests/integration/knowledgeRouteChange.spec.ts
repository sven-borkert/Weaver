import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AiProvider } from "@weaver/core/ai/types";
import type { KnowledgeRoutingSource } from "@weaver/core/ai/registry";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import { parseKnowledgeConfig } from "@weaver/core/knowledge/config";
import { registerKnowledgeJobHandlers } from "@weaver/core/jobs/runtime";
import { knowledgeSystemContextForTests } from "@weaver/core/jobs/systemContext";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import type { KnowledgeJobName } from "@weaver/core/jobs/types";
import {
  createLlmModel,
  updateLlmConnection,
  updateLlmModel,
} from "@weaver/core/services/llmConnections";
import {
  resolveKnowledgeRouting,
  setLlmRoute,
} from "@weaver/core/services/llmRoutes";
import {
  clearEmbeddingCompatibility,
  verifyEmbeddingCompatibility,
} from "@weaver/core/services/llmVectorSpace";
import { LAST_ROUTING_CHANGE_SETTING } from "@weaver/core/services/knowledgeRoutingChange";

import {
  addMembership,
  callerFor,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
  seedTestLlmRouting,
  testEncryptionKeys,
} from "./_harness";
import { sizedEmbeddingsFetch } from "./_knowledgePipeline";

const embeddingDeps = (size: number, onRequest?: () => Promise<void>) => {
  const answer = sizedEmbeddingsFetch(() => size);
  return {
    ring: testEncryptionKeys(),
    fetchImpl: (async (url, init) => {
      await onRequest?.();
      return answer(url, init);
    }) as typeof fetch,
  };
};

function reconciledProjects(queue: FakeJobQueue): string[] {
  return queue.jobs
    .filter((job) => job.name === "project.reconcile")
    .map((job) => (job.data as { projectId: string }).projectId)
    .sort();
}

describe("knowledge route changes", () => {
  let queue: FakeJobQueue;

  beforeEach(async () => {
    await resetDb();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("WEAVER_JOBS_ENABLED", "true");
    queue = new FakeJobQueue();
    setJobQueueForTests(queue);
  });
  afterEach(() => {
    setJobQueueForTests(null);
    vi.unstubAllEnvs();
  });

  async function seedWithProjects() {
    const seeded = await seedTestLlmRouting();
    const live = [
      await makeProject("Route live A"),
      await makeProject("Route live B"),
    ];
    const deleted = await makeProject("Route deleted");
    await getPrisma().project.update({
      where: { id: deleted.id },
      data: { deletedAt: new Date() },
    });
    queue.jobs.length = 0;
    return { ...seeded, actor: securityContextFor(seeded.admin), live };
  }

  it("queues reconciliation for every live project when the embedding model changes", async () => {
    const db = getPrisma();
    const { actor, connection, live } = await seedWithProjects();
    const embedding = await createLlmModel(db, actor, {
      connectionId: connection.id,
      providerModelId: "test-embedding-2",
      displayName: "Embedding 2",
      capabilities: ["embedding"],
      embeddingDimensions: 1536,
    });

    const route = await setLlmRoute(
      db,
      actor,
      {
        purpose: "knowledge_embedding",
        modelId: embedding.id,
      },
      embeddingDeps(1536),
    );

    expect(route.reindexProjects).toBe(2);
    expect(reconciledProjects(queue)).toEqual(live.map((p) => p.id).sort());
    const setting = await db.systemSetting.findUniqueOrThrow({
      where: { key: LAST_ROUTING_CHANGE_SETTING },
    });
    expect(setting.value).toMatchObject({
      userId: actor.userId,
      indexFingerprint: (await resolveKnowledgeRouting(db))!.configFingerprint,
    });
  });

  function routingChangeRecord() {
    return getPrisma().systemSetting.findUnique({
      where: { key: LAST_ROUTING_CHANGE_SETTING },
    });
  }

  it("queues nothing for extraction-only, thinking-effort and no-op saves", async () => {
    const db = getPrisma();
    const { actor, connection, routing } = await seedWithProjects();
    const seeded = await routingChangeRecord();
    expect(seeded).not.toBeNull();
    const extraction = await createLlmModel(db, actor, {
      connectionId: connection.id,
      providerModelId: "test-extraction-2",
      displayName: "Extraction 2",
      capabilities: ["chat", "json_output", "tool_use"],
    });

    const switched = await setLlmRoute(db, actor, {
      purpose: "knowledge_extraction",
      modelId: extraction.id,
    });
    const effort = await setLlmRoute(db, actor, {
      purpose: "knowledge_extraction",
      modelId: extraction.id,
      reasoningMode: "none",
    });
    const same = await setLlmRoute(db, actor, {
      purpose: "knowledge_embedding",
      modelId: routing.embedding.modelId,
    });

    expect([switched, effort, same].map((r) => r.reindexProjects)).toEqual([
      0, 0, 0,
    ]);
    expect(reconciledProjects(queue)).toEqual([]);
    await expect(routingChangeRecord()).resolves.toEqual(seeded);
  });

  it("queues nothing when the save fails", async () => {
    const db = getPrisma();
    const { actor, routing } = await seedWithProjects();
    const seeded = await routingChangeRecord();
    expect(seeded).not.toBeNull();

    await expect(
      setLlmRoute(db, actor, {
        purpose: "knowledge_embedding",
        modelId: routing.extraction.modelId,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(reconciledProjects(queue)).toEqual([]);
    await expect(routingChangeRecord()).resolves.toEqual(seeded);
  });

  it("queues nothing while the routed connection is disabled and reconciles when it is re-enabled", async () => {
    const db = getPrisma();
    const { actor, connection, live } = await seedWithProjects();
    const deps = { ring: testEncryptionKeys() };

    const disabled = await updateLlmConnection(db, actor, deps, {
      connectionId: connection.id,
      enabled: false,
    });
    expect(disabled.reindexProjects).toBe(0);
    expect(queue.jobs).toEqual([]);

    const enabled = await updateLlmConnection(db, actor, deps, {
      connectionId: connection.id,
      enabled: true,
    });
    expect(enabled.reindexProjects).toBe(2);
    expect(reconciledProjects(queue)).toEqual(live.map((p) => p.id).sort());
  });

  it("queues reconciliation when a routed embedding model or its connection changes identity", async () => {
    const db = getPrisma();
    const { actor, connection, routing } = await seedWithProjects();

    const model = await updateLlmModel(
      db,
      actor,
      {
        modelId: routing.embedding.modelId,
        providerModelId: "test-embedding-renamed",
      },
      embeddingDeps(1536),
    );
    expect(model.reindexProjects).toBe(2);

    queue.jobs.length = 0;
    const updated = await updateLlmConnection(
      db,
      actor,
      { ring: testEncryptionKeys() },
      { connectionId: connection.id, endpoint: "https://ai.test/v2" },
    );
    expect(updated.reindexProjects).toBe(2);
    expect(reconciledProjects(queue)).toHaveLength(2);
  });

  it("checks a new size with one sample embedding before rebuilding", async () => {
    const db = getPrisma();
    const { actor, routing } = await seedWithProjects();

    const saved = await updateLlmModel(
      db,
      actor,
      { modelId: routing.embedding.modelId, embeddingDimensions: 1024 },
      embeddingDeps(1024),
    );

    expect(saved.reindexProjects).toBe(2);
    expect((await resolveKnowledgeRouting(db))!.embeddingDimensions).toBe(1024);
    await expect(
      db.aiUsage.count({ where: { operation: "llm_model_test" } }),
    ).resolves.toBe(1);
  });

  it("refuses a size the model does not return and queues nothing", async () => {
    const db = getPrisma();
    const { actor, routing } = await seedWithProjects();

    await expect(
      updateLlmModel(
        db,
        actor,
        { modelId: routing.embedding.modelId, embeddingDimensions: 1024 },
        embeddingDeps(1536),
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "embeddingDimensions" },
    });
    expect(reconciledProjects(queue)).toEqual([]);
    await expect(
      db.llmModel.findUniqueOrThrow({
        where: { id: routing.embedding.modelId },
      }),
    ).resolves.toMatchObject({ embeddingDimensions: 1536 });
  });

  it("refuses a Matryoshka size above the model's native size", async () => {
    const db = getPrisma();
    const { actor, routing } = await seedWithProjects();

    await expect(
      updateLlmModel(
        db,
        actor,
        {
          modelId: routing.embedding.modelId,
          embeddingDimensionMode: "matryoshka",
          embeddingDimensions: 3072,
        },
        embeddingDeps(2560),
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "embeddingDimensions" },
    });
    expect(reconciledProjects(queue)).toEqual([]);
  });

  it("refuses an unsupported size without calling the provider", async () => {
    const db = getPrisma();
    const { actor, routing } = await seedWithProjects();
    let requests = 0;

    await expect(
      updateLlmModel(
        db,
        actor,
        { modelId: routing.embedding.modelId, embeddingDimensions: 5000 },
        embeddingDeps(5000, async () => {
          requests += 1;
        }),
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "embeddingDimensions" },
    });
    expect(requests).toBe(0);
  });

  it("refuses a route switch whose sample embedding fails", async () => {
    const db = getPrisma();
    const { actor, connection, routing } = await seedWithProjects();
    const other = await createLlmModel(db, actor, {
      connectionId: connection.id,
      providerModelId: "test-embedding-1024",
      displayName: "Embedding 1024",
      capabilities: ["embedding"],
      embeddingDimensions: 1024,
    });

    await expect(
      setLlmRoute(
        db,
        actor,
        { purpose: "knowledge_embedding", modelId: other.id },
        embeddingDeps(1536),
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "modelId" },
    });
    expect((await resolveKnowledgeRouting(db))!.embedding.modelId).toBe(
      routing.embedding.modelId,
    );
    expect(reconciledProjects(queue)).toEqual([]);
  });

  it("fails with a conflict when the model changes during the sample", async () => {
    const db = getPrisma();
    const { actor, routing } = await seedWithProjects();

    await expect(
      updateLlmModel(
        db,
        actor,
        { modelId: routing.embedding.modelId, embeddingDimensions: 1024 },
        embeddingDeps(1024, async () => {
          await db.llmModel.update({
            where: { id: routing.embedding.modelId },
            data: { providerModelId: "changed-meanwhile" },
          });
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(reconciledProjects(queue)).toEqual([]);
  });

  it("passes the tRPC context's provider fetch to the sample", async () => {
    const { admin, routing } = await seedWithProjects();
    const caller = callerFor(admin, {
      llmFetch: sizedEmbeddingsFetch(() => 1024),
    });

    await expect(
      caller.llm.updateModel({
        modelId: routing.embedding.modelId,
        embeddingDimensions: 1024,
      }),
    ).resolves.toMatchObject({ embeddingDimensions: 1024, reindexProjects: 2 });
  });
});

const provider: AiProvider = {
  embeddingRequestByteLength: (input) =>
    Buffer.byteLength(JSON.stringify({ input })),
  async embed(values) {
    return {
      vectors: values.map(() => Array(1536).fill(0.1) as number[]),
      usage: {
        inputTokens: 1,
        outputTokens: 0,
        cachedTokens: 0,
        totalTokens: 1,
        durationMs: 1,
      },
    };
  },
  async extract() {
    return {
      data: { entities: [], relations: [] },
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cachedTokens: 0,
        totalTokens: 2,
        durationMs: 1,
      },
    };
  },
};

/** Every embedding model returns the same vectors, so any pair verifies as compatible. */
const identicalEmbeddingsFetch = (async (_url, init) => {
  const body = JSON.parse(
    typeof init?.body === "string" ? init.body : '{"input":[]}',
  ) as { input: string[] };
  return Response.json({
    data: body.input.map((text, index) => ({
      index,
      embedding: Array.from(
        { length: 1536 },
        (_, i) => Math.sin(text.length + i) + 0.01 * i,
      ),
    })),
    usage: { prompt_tokens: 8, total_tokens: 8 },
  });
}) as typeof fetch;

const PIPELINE_JOBS: KnowledgeJobName[] = [
  "document.search-sync",
  "document.ai-enrich",
  "project.reconcile",
  "project.generation-build",
];

function liveRoutingSource(): KnowledgeRoutingSource {
  const db = getPrisma();
  return {
    resolve: () => resolveKnowledgeRouting(db),
    resolveFresh: () => resolveKnowledgeRouting(db),
    providerFor: () => provider,
  };
}

async function drain(queue: FakeJobQueue, from = 0): Promise<number> {
  let index = from;
  for (let guard = 0; index < queue.jobs.length && guard < 500; guard += 1) {
    const job = queue.jobs[index++]!;
    if (PIPELINE_JOBS.includes(job.name))
      await queue.run(job.name, job.data as never);
  }
  return index;
}

describe("knowledge route change pipeline", () => {
  let queue: FakeJobQueue;

  beforeEach(async () => {
    await resetDb();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("WEAVER_JOBS_ENABLED", "true");
    queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    await registerKnowledgeJobHandlers({
      queue,
      context: knowledgeSystemContextForTests(),
      db: getPrisma(),
      config: parseKnowledgeConfig({ WEAVER_JOBS_ENABLED: "true" }),
      routing: liveRoutingSource(),
    });
  });
  afterEach(() => {
    setJobQueueForTests(null);
    vi.unstubAllEnvs();
  });

  async function indexedProject() {
    const seeded = await seedTestLlmRouting();
    const editor = await makeUser(
      "User",
      `pipeline-${randomUUID().slice(0, 8)}`,
    );
    const project = await makeProject("Route pipeline");
    await addMembership(project.id, editor.id, "Maintainer");
    const caller = callerFor(editor);
    const created = [];
    for (const title of ["Alpha", "Beta"]) {
      created.push(
        await caller.document.create({
          projectId: project.id,
          folderPath: [],
          title,
          contentJson: parseDocumentBody(`# ${title}\n\nOriginal body.\n`),
        }),
      );
    }
    let cursor = await drain(queue);
    await queue.run("project.reconcile", { projectId: project.id });
    cursor = await drain(queue, cursor);
    const generation = await getPrisma().knowledgeGeneration.findFirstOrThrow({
      where: { projectId: project.id, status: "active" },
    });
    return {
      ...seeded,
      caller,
      project,
      documents: created,
      generation,
      cursor,
    };
  }

  it("indexes an edit with the new extraction model inside the active generation", async () => {
    const db = getPrisma();
    const {
      admin,
      connection,
      caller,
      project,
      documents,
      generation,
      cursor,
    } = await indexedProject();
    const actor = securityContextFor(admin);
    const extraction = await createLlmModel(db, actor, {
      connectionId: connection.id,
      providerModelId: "test-extraction-2",
      displayName: "Extraction 2",
      capabilities: ["chat", "json_output", "tool_use"],
    });
    const route = await setLlmRoute(db, actor, {
      purpose: "knowledge_extraction",
      modelId: extraction.id,
    });
    expect(route.reindexProjects).toBe(0);

    const alpha = documents[0]!;
    await caller.document.update({
      projectId: project.id,
      documentId: alpha.id,
      baseCommitSha: alpha.headCommitSha,
      content: {
        kind: "markdown",
        contentJson: parseDocumentBody("# Alpha\n\nEdited body.\n"),
      },
      changeSummary: "Edit after the extraction switch",
    });
    await drain(queue, cursor);

    expect(
      await db.knowledgeGeneration.findMany({
        where: { projectId: project.id },
        select: { id: true, status: true },
      }),
    ).toEqual([{ id: generation.id, status: "active" }]);
    const live = (await resolveKnowledgeRouting(db))!;
    await expect(
      db.knowledgeGenerationDocument.findUniqueOrThrow({
        where: {
          generationId_documentId: {
            generationId: generation.id,
            documentId: alpha.id,
          },
        },
        select: {
          status: true,
          extractionModel: true,
          extractionFingerprint: true,
        },
      }),
    ).resolves.toEqual({
      status: "ready",
      extractionModel: "test-extraction-2",
      extractionFingerprint: live.extractionFingerprint,
    });
    const status = await caller.knowledge.status({ projectId: project.id });
    expect(status.outdatedExtraction).toBe(1);
  });

  it("rebuilds with the new vector space right after an embedding switch", async () => {
    const db = getPrisma();
    const { admin, connection, project, generation, cursor } =
      await indexedProject();
    const actor = securityContextFor(admin);
    const embedding = await createLlmModel(db, actor, {
      connectionId: connection.id,
      providerModelId: "test-embedding-2",
      displayName: "Embedding 2",
      capabilities: ["embedding"],
      embeddingDimensions: 1536,
    });

    const route = await setLlmRoute(
      db,
      actor,
      {
        purpose: "knowledge_embedding",
        modelId: embedding.id,
      },
      embeddingDeps(1536),
    );
    expect(route.reindexProjects).toBe(1);
    await drain(queue, cursor);

    const live = (await resolveKnowledgeRouting(db))!;
    const generations = await db.knowledgeGeneration.findMany({
      where: { projectId: project.id },
      select: { id: true, status: true, configFingerprint: true },
    });
    expect(generations).toContainEqual({
      id: generation.id,
      status: "superseded",
      configFingerprint: generation.configFingerprint,
    });
    expect(
      generations.filter(
        (row) =>
          row.status === "active" &&
          row.configFingerprint === live.configFingerprint,
      ),
    ).toHaveLength(1);
    const shadow = await db.knowledgeGeneration.findFirstOrThrow({
      where: {
        projectId: project.id,
        configFingerprint: live.configFingerprint,
      },
      select: { buildTrigger: true, requestedById: true },
    });
    expect(shadow).toEqual({
      buildTrigger: "embedding_change",
      requestedById: admin.id,
    });
    const first = await db.knowledgeGeneration.findUniqueOrThrow({
      where: { id: generation.id },
      select: { buildTrigger: true },
    });
    expect(first.buildTrigger).toBe("initial");
  });

  async function routeToVerifiedEmbedding() {
    const indexed = await indexedProject();
    const db = getPrisma();
    const actor = securityContextFor(indexed.admin);
    const compatible = await createLlmModel(db, actor, {
      connectionId: indexed.connection.id,
      providerModelId: "test-embedding-2",
      displayName: "Embedding 2",
      capabilities: ["embedding"],
      embeddingDimensions: 1536,
    });
    const verified = await verifyEmbeddingCompatibility(
      db,
      actor,
      { ring: testEncryptionKeys(), fetchImpl: identicalEmbeddingsFetch },
      {
        modelId: compatible.id,
        referenceModelId: indexed.routing.embedding.modelId,
      },
    );
    expect(verified).toMatchObject({
      outcome: "compatible",
      reindexProjects: 0,
    });
    const route = await setLlmRoute(db, actor, {
      purpose: "knowledge_embedding",
      modelId: compatible.id,
    });
    return { ...indexed, actor, compatible, route };
  }

  it("keeps the index when the embedding route switches to a verified compatible model", async () => {
    const db = getPrisma();
    const { project, generation, cursor, route } =
      await routeToVerifiedEmbedding();

    expect(route.reindexProjects).toBe(0);
    expect(
      queue.jobs
        .slice(cursor)
        .filter((job) => job.name === "project.reconcile"),
    ).toEqual([]);
    await drain(queue, cursor);
    expect((await resolveKnowledgeRouting(db))!.configFingerprint).toBe(
      generation.configFingerprint,
    );
    await expect(
      db.knowledgeGeneration.findMany({
        where: { projectId: project.id },
        select: { id: true, status: true },
      }),
    ).resolves.toEqual([{ id: generation.id, status: "active" }]);
  });

  it("rebuilds and attributes the admin when compatibility of the routed model is removed", async () => {
    const db = getPrisma();
    const { admin, actor, compatible, project, generation, cursor } =
      await routeToVerifiedEmbedding();
    const liveProjects = await db.project.count({ where: { deletedAt: null } });

    const cleared = await clearEmbeddingCompatibility(db, actor, {
      modelId: compatible.id,
    });
    expect(cleared.reindexProjects).toBe(liveProjects);
    await drain(queue, cursor);

    const live = (await resolveKnowledgeRouting(db))!;
    expect(live.configFingerprint).not.toBe(generation.configFingerprint);
    await expect(
      db.knowledgeGeneration.findFirstOrThrow({
        where: {
          projectId: project.id,
          configFingerprint: live.configFingerprint,
        },
        select: { status: true, buildTrigger: true, requestedById: true },
      }),
    ).resolves.toEqual({
      status: "active",
      buildTrigger: "embedding_change",
      requestedById: admin.id,
    });
  });

  it("attributes a clear-then-set embedding switch to the admin", async () => {
    const db = getPrisma();
    const { admin, connection, project, cursor } = await indexedProject();
    const actor = securityContextFor(admin);
    const embedding = await createLlmModel(db, actor, {
      connectionId: connection.id,
      providerModelId: "test-embedding-2",
      displayName: "Embedding 2",
      capabilities: ["embedding"],
      embeddingDimensions: 1536,
    });

    const cleared = await setLlmRoute(db, actor, {
      purpose: "knowledge_embedding",
      modelId: null,
    });
    const switched = await setLlmRoute(db, actor, {
      purpose: "knowledge_embedding",
      modelId: embedding.id,
    });
    expect([cleared.reindexProjects, switched.reindexProjects]).toEqual([0, 1]);
    await drain(queue, cursor);

    const live = (await resolveKnowledgeRouting(db))!;
    await expect(
      db.knowledgeGeneration.findFirstOrThrow({
        where: {
          projectId: project.id,
          configFingerprint: live.configFingerprint,
        },
        select: { status: true, buildTrigger: true, requestedById: true },
      }),
    ).resolves.toEqual({
      status: "active",
      buildTrigger: "embedding_change",
      requestedById: admin.id,
    });
  });

  it("labels a rebuild without a matching route change as an index upgrade", async () => {
    const db = getPrisma();
    const { project } = await indexedProject();
    await db.systemSetting.deleteMany({
      where: { key: LAST_ROUTING_CHANGE_SETTING },
    });
    await db.knowledgeGeneration.updateMany({
      where: { projectId: project.id, status: "active" },
      data: { configFingerprint: "previous-schema-version" },
    });
    await queue.run("project.reconcile", { projectId: project.id });
    const created = await db.knowledgeGeneration.findFirstOrThrow({
      where: {
        projectId: project.id,
        status: { in: ["building", "active"] },
        NOT: { configFingerprint: "previous-schema-version" },
      },
      select: { buildTrigger: true, requestedById: true },
    });
    expect(created).toEqual({
      buildTrigger: "index_upgrade",
      requestedById: null,
    });
  });

  it("treats a pre-migration job fingerprint as stale", async () => {
    const db = getPrisma();
    const { project, documents, generation } = await indexedProject();
    const beta = documents[1]!;

    await queue.run("document.ai-enrich", {
      projectId: project.id,
      generationId: generation.id,
      documentId: beta.id,
      sourceCommitSha: beta.headCommitSha,
      pathAtSha: beta.path,
      configFingerprint: "legacy-v1-fingerprint",
    });

    await expect(
      db.knowledgeGenerationDocument.findUniqueOrThrow({
        where: {
          generationId_documentId: {
            generationId: generation.id,
            documentId: beta.id,
          },
        },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "ready" });
  });
});

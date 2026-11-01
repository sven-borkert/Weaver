import { beforeEach, describe, expect, it } from "vitest";

import {
  createLlmConnection,
  createLlmModel,
  updateLlmConnection,
  updateLlmModel,
} from "@weaver/core/services/llmConnections";
import {
  knowledgeRouteSnapshot,
  resolveKnowledgeRouting,
  setLlmRoute,
} from "@weaver/core/services/llmRoutes";
import {
  clearEmbeddingCompatibility,
  previewClearEmbeddingCompatibility,
  previewKnowledgeModelChange,
  previewKnowledgeRouteChange,
  verifyEmbeddingCompatibility,
} from "@weaver/core/services/llmVectorSpace";
import { defaultVectorSpaceKey } from "@weaver/core/knowledge/identity";

import {
  callerFor,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
  seedTestLlmRouting,
  testEncryptionKeys,
} from "./_harness";

function vectorFor(text: string, drift: number): number[] {
  const seed = [...text].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return Array.from(
    { length: 1536 },
    (_, i) => Math.sin(seed + i) + drift * Math.cos(i * 1.7 + 0.5),
  );
}

const hrefOf = (url: Parameters<typeof fetch>[0]) =>
  typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
const requestBody = (init: RequestInit | undefined) =>
  typeof init?.body === "string"
    ? (JSON.parse(init.body) as { input: string[]; model: string })
    : { input: [], model: "" };

function embeddingsFetch(
  drifts: Record<string, number | "error" | "short">,
  onRequest?: (model: string) => Promise<void>,
): typeof fetch {
  return (async (url, init) => {
    const href = hrefOf(url);
    const body = requestBody(init);
    await onRequest?.(body.model);
    const drift = drifts[body.model];
    if (drift === "error")
      return new Response("upstream down", { status: 503 });
    const data = body.input.map((text, index) => ({
      index,
      embedding: drift === "short" ? [0.1, 0.2] : vectorFor(text, drift ?? 0),
    }));
    if (!href.endsWith("/embeddings"))
      return new Response("{}", { status: 404 });
    return Response.json({
      data,
      usage: { prompt_tokens: 8, total_tokens: 8 },
    });
  }) as typeof fetch;
}

describe("embedding vector-space compatibility", () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function fixture(
    drifts: Record<string, number | "error" | "short">,
    onRequest?: (model: string) => Promise<void>,
  ) {
    const db = getPrisma();
    const { admin, connection, routing } = await seedTestLlmRouting();
    const actor = securityContextFor(admin);
    const deps = {
      ring: testEncryptionKeys(),
      fetchImpl: embeddingsFetch(drifts, onRequest),
    };
    const other = await createLlmConnection(db, actor, deps, {
      name: "Second provider",
      providerType: "openai_compatible",
      endpoint: "https://other.test/v1",
      credential: "test-key",
      requestTimeoutMs: 1000,
    });
    const candidate = await createLlmModel(db, actor, {
      connectionId: other.id,
      providerModelId: "other-embedding",
      displayName: "Other embedding",
      capabilities: ["embedding"],
      embeddingDimensions: 1536,
    });
    return { db, actor, deps, connection, other, candidate, routing };
  }

  it("shares the routed model's key without changing the live fingerprint", async () => {
    const { db, actor, deps, candidate, routing } = await fixture({
      "test-embedding": 0,
      "other-embedding": 0.01,
    });
    const before = (await resolveKnowledgeRouting(db))!.configFingerprint;

    const result = await verifyEmbeddingCompatibility(db, actor, deps, {
      modelId: candidate.id,
      referenceModelId: routing.embedding.modelId,
    });

    expect(result).toMatchObject({ outcome: "compatible", reindexProjects: 0 });
    expect(result.minSimilarity).toBeGreaterThanOrEqual(0.98);
    const [stored, reference] = await Promise.all([
      db.llmModel.findUniqueOrThrow({ where: { id: candidate.id } }),
      db.llmModel.findUniqueOrThrow({
        where: { id: routing.embedding.modelId },
      }),
    ]);
    expect(stored.vectorSpaceKey).toHaveLength(64);
    expect(stored.vectorSpaceKey).toBe(reference.vectorSpaceKey);
    expect(stored.vectorSpaceReferenceModelId).toBe(routing.embedding.modelId);
    const after = (await resolveKnowledgeRouting(db))!;
    expect(after.configFingerprint).toBe(before);
    expect(knowledgeRouteSnapshot(after).embedding.vectorSpaceKey).toBe(
      reference.vectorSpaceKey,
    );
  });

  it("gives the reference the verified model's key when the verified model is routed", async () => {
    const { db, actor, deps, connection, candidate, routing } = await fixture({
      "test-embedding": 0,
      "other-embedding": 0.01,
    });
    const before = (await resolveKnowledgeRouting(db))!.configFingerprint;
    const routedKey = defaultVectorSpaceKey({
      providerType: "openai_compatible",
      endpoint: connection.endpoint,
      providerModelId: "test-embedding",
      upstreamProvider: null,
    });

    await expect(
      verifyEmbeddingCompatibility(db, actor, deps, {
        modelId: routing.embedding.modelId,
        referenceModelId: candidate.id,
      }),
    ).resolves.toMatchObject({ outcome: "compatible", reindexProjects: 0 });

    const keys = await db.llmModel.findMany({
      where: { id: { in: [routing.embedding.modelId, candidate.id] } },
      select: { id: true, vectorSpaceKey: true },
    });
    expect(keys.map((row) => row.vectorSpaceKey)).toEqual([
      routedKey,
      routedKey,
    ]);
    expect((await resolveKnowledgeRouting(db))!.configFingerprint).toBe(before);
  });

  it("joins the reference's existing group", async () => {
    const { db, actor, deps, other, candidate, routing } = await fixture({
      "test-embedding": 0,
      "other-embedding": 0.01,
      "third-embedding": 0.01,
    });
    const third = await createLlmModel(db, actor, {
      connectionId: other.id,
      providerModelId: "third-embedding",
      displayName: "Third embedding",
      capabilities: ["embedding"],
      embeddingDimensions: 1536,
    });
    await verifyEmbeddingCompatibility(db, actor, deps, {
      modelId: routing.embedding.modelId,
      referenceModelId: candidate.id,
    });

    await verifyEmbeddingCompatibility(db, actor, deps, {
      modelId: third.id,
      referenceModelId: candidate.id,
    });

    const rows = await db.llmModel.findMany({
      where: {
        id: { in: [routing.embedding.modelId, candidate.id, third.id] },
      },
      select: { vectorSpaceKey: true },
    });
    const keys = new Set(rows.map((row) => row.vectorSpaceKey));
    expect(keys.size).toBe(1);
    expect([...keys][0]).not.toBe(
      defaultVectorSpaceKey({
        providerType: "openai_compatible",
        endpoint: other.endpoint,
        providerModelId: "other-embedding",
        upstreamProvider: null,
      }),
    );
  });

  it("refuses to store a key when a model changed while it was being verified", async () => {
    let changed = false;
    const { db, actor, deps, other, candidate, routing } = await fixture(
      { "test-embedding": 0, "other-embedding": 0 },
      async (model) => {
        if (model !== "other-embedding" || changed) return;
        changed = true;
        await getPrisma().llmConnection.update({
          where: { id: other.id },
          data: { endpoint: "https://moved.test/v1" },
        });
      },
    );

    await expect(
      verifyEmbeddingCompatibility(db, actor, deps, {
        modelId: candidate.id,
        referenceModelId: routing.embedding.modelId,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "The model changed while it was being verified",
    });
    const rows = await db.llmModel.findMany({
      where: { id: { in: [candidate.id, routing.embedding.modelId] } },
      select: { vectorSpaceKey: true },
    });
    expect(rows.map((row) => row.vectorSpaceKey)).toEqual([null, null]);
  });

  it("previews whether removing compatibility rebuilds the index", async () => {
    const { db, actor, deps, candidate, routing } = await fixture({
      "test-embedding": 0,
      "other-embedding": 0,
    });
    await makeProject("Clear preview A");
    await makeProject("Clear preview B");
    const preview = (modelId: string) =>
      previewClearEmbeddingCompatibility(db, actor, { modelId });
    await verifyEmbeddingCompatibility(db, actor, deps, {
      modelId: candidate.id,
      referenceModelId: routing.embedding.modelId,
    });

    await expect(preview(candidate.id)).resolves.toEqual({
      effect: "none",
      projects: 0,
    });
    await expect(preview(routing.embedding.modelId)).resolves.toEqual({
      effect: "none",
      projects: 0,
    });

    await setLlmRoute(db, actor, {
      purpose: "knowledge_embedding",
      modelId: candidate.id,
    });
    await expect(preview(candidate.id)).resolves.toEqual({
      effect: "reindex",
      projects: 2,
    });
    await expect(preview(routing.embedding.modelId)).resolves.toEqual({
      effect: "none",
      projects: 0,
    });
    const admin = await db.user.findUniqueOrThrow({
      where: { id: actor.userId },
    });
    await expect(
      callerFor(admin).llm.previewClearEmbeddingCompatibility({
        modelId: candidate.id,
      }),
    ).resolves.toEqual({ effect: "reindex", projects: 2 });
    await expect(
      callerFor(await makeUser("User")).llm.previewClearEmbeddingCompatibility({
        modelId: candidate.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("stores nothing for incompatible vectors", async () => {
    const { db, actor, deps, candidate, routing } = await fixture({
      "test-embedding": 0,
      "other-embedding": 3,
    });
    const result = await verifyEmbeddingCompatibility(db, actor, deps, {
      modelId: candidate.id,
      referenceModelId: routing.embedding.modelId,
    });
    expect(result.outcome).toBe("incompatible");
    expect(
      (await db.llmModel.findUniqueOrThrow({ where: { id: candidate.id } }))
        .vectorSpaceKey,
    ).toBeNull();
  });

  it.each(["error", "short"] as const)(
    "reports provider failures without storing compatibility (%s)",
    async (failure) => {
      const { db, actor, deps, candidate, routing } = await fixture({
        "test-embedding": 0,
        "other-embedding": failure,
      });
      const result = await verifyEmbeddingCompatibility(db, actor, deps, {
        modelId: candidate.id,
        referenceModelId: routing.embedding.modelId,
      });
      expect(result).toMatchObject({ outcome: "failure", minSimilarity: null });
      expect(
        (await db.llmModel.findUniqueOrThrow({ where: { id: candidate.id } }))
          .vectorSpaceKey,
      ).toBeNull();
    },
  );

  it("refuses models that are not comparable", async () => {
    const { db, actor, deps, connection, candidate, routing } = await fixture(
      {},
    );
    const small = await createLlmModel(db, actor, {
      connectionId: connection.id,
      providerModelId: "small-embedding",
      displayName: "Small",
      capabilities: ["embedding"],
      embeddingDimensions: 768,
    });
    await expect(
      verifyEmbeddingCompatibility(db, actor, deps, {
        modelId: small.id,
        referenceModelId: routing.embedding.modelId,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(
      verifyEmbeddingCompatibility(db, actor, deps, {
        modelId: routing.extraction.modelId,
        referenceModelId: candidate.id,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(
      verifyEmbeddingCompatibility(db, actor, deps, {
        modelId: candidate.id,
        referenceModelId: candidate.id,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("clears compatibility on identity edits and explicit removal", async () => {
    const { db, actor, deps, other, candidate, routing } = await fixture({
      "test-embedding": 0,
      "other-embedding": 0,
    });
    const verify = () =>
      verifyEmbeddingCompatibility(db, actor, deps, {
        modelId: candidate.id,
        referenceModelId: routing.embedding.modelId,
      });
    const key = async () =>
      (await db.llmModel.findUniqueOrThrow({ where: { id: candidate.id } }))
        .vectorSpaceKey;

    await verify();
    await updateLlmModel(db, actor, {
      modelId: candidate.id,
      displayName: "Renamed",
    });
    expect(await key()).not.toBeNull();
    await updateLlmModel(db, actor, {
      modelId: candidate.id,
      providerModelId: "other-embedding-v2",
    });
    expect(await key()).toBeNull();

    await updateLlmModel(db, actor, {
      modelId: candidate.id,
      providerModelId: "other-embedding",
    });
    await verify();
    await updateLlmConnection(db, actor, deps, {
      connectionId: other.id,
      endpoint: "https://other.test/v2",
    });
    expect(await key()).toBeNull();

    await verify();
    await clearEmbeddingCompatibility(db, actor, { modelId: candidate.id });
    expect(await key()).toBeNull();
  });

  it("previews what a knowledge route change will do", async () => {
    const { db, actor, deps, connection, candidate, routing } = await fixture({
      "test-embedding": 0,
      "other-embedding": 0,
    });
    await makeProject("Preview project");
    const extraction = await createLlmModel(db, actor, {
      connectionId: connection.id,
      providerModelId: "extract-2",
      displayName: "Extract 2",
      capabilities: ["chat", "json_output"],
    });
    const preview = (
      purpose: "knowledge_extraction" | "knowledge_embedding",
      modelId: string,
    ) => previewKnowledgeRouteChange(db, actor, { purpose, modelId });

    await expect(
      preview("knowledge_embedding", routing.embedding.modelId),
    ).resolves.toEqual({ effect: "none", projects: 0 });
    await expect(
      preview("knowledge_extraction", extraction.id),
    ).resolves.toEqual({ effect: "extraction_only", projects: 0 });
    await expect(preview("knowledge_embedding", candidate.id)).resolves.toEqual(
      { effect: "reindex", projects: 1 },
    );
    await verifyEmbeddingCompatibility(db, actor, deps, {
      modelId: candidate.id,
      referenceModelId: routing.embedding.modelId,
    });
    await expect(preview("knowledge_embedding", candidate.id)).resolves.toEqual(
      { effect: "compatible", projects: 0 },
    );
  });

  it("exposes verification through tRPC and MCP", async () => {
    const { db, candidate, routing } = await fixture({
      "test-embedding": 0,
      "other-embedding": 0,
    });
    const admin = await db.user.findFirstOrThrow({ where: { role: "Admin" } });
    const caller = callerFor(admin, {
      llmFetch: embeddingsFetch({ "test-embedding": 0, "other-embedding": 0 }),
    });

    await expect(
      caller.llm.previewKnowledgeRouteChange({
        purpose: "knowledge_embedding",
        modelId: candidate.id,
      }),
    ).resolves.toMatchObject({ effect: "reindex" });
    await expect(
      caller.llm.verifyEmbeddingCompatibility({
        modelId: candidate.id,
        referenceModelId: routing.embedding.modelId,
      }),
    ).resolves.toMatchObject({ outcome: "compatible" });
    await expect(
      caller.llm.clearEmbeddingCompatibility({ modelId: candidate.id }),
    ).resolves.toEqual({ reindexProjects: 0 });
  });

  it("previews an edit of the routed embedding model", async () => {
    const { db, actor, candidate, routing } = await fixture({
      "test-embedding": 0,
      "other-embedding": 0,
    });
    await makeProject("Preview edit project");
    const preview = (
      change: Omit<
        Parameters<typeof previewKnowledgeModelChange>[2],
        "modelId"
      >,
      modelId = routing.embedding.modelId,
    ) => previewKnowledgeModelChange(db, actor, { modelId, ...change });

    await expect(preview({})).resolves.toEqual({ effect: "none", projects: 0 });
    await expect(preview({ embeddingDimensions: 1536 })).resolves.toEqual({
      effect: "none",
      projects: 0,
    });
    await expect(preview({ embeddingDimensions: 1024 })).resolves.toEqual({
      effect: "reembed",
      projects: 1,
    });
    await expect(
      preview({ embeddingDimensionMode: "matryoshka" }),
    ).resolves.toEqual({ effect: "reembed", projects: 1 });
    await expect(
      preview({ embeddingDimensions: 1024 }, candidate.id),
    ).resolves.toEqual({ effect: "none", projects: 0 });

    const admin = await db.user.findUniqueOrThrow({
      where: { id: actor.userId },
    });
    await expect(
      callerFor(admin).llm.previewKnowledgeModelChange({
        modelId: routing.embedding.modelId,
        embeddingDimensions: 1024,
      }),
    ).resolves.toEqual({ effect: "reembed", projects: 1 });
  });
});

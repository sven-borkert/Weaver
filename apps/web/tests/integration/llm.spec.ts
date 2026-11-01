import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseEncryptionKeyRing } from "@weaver/config/encryptionKeys";
import {
  createSessionSecurityContext,
  type SecurityContext,
} from "@weaver/core/security/context";
import {
  assertConnectionSecretsDecryptable,
  adapterForConnection,
  createLlmModel,
  decryptConnectionCredential,
  rotateConnectionSecrets,
} from "@weaver/core/services/llmConnections";
import {
  cachedKnowledgeRouting,
  invalidateLlmRouteCache,
  knowledgeRouteSnapshot,
  resolveKnowledgeRouting,
  resolveLlmRoute,
} from "@weaver/core/services/llmRoutes";
import {
  callerFor,
  getPrisma,
  makeUser,
  resetDb,
  seedTestLlmRouting,
  testEncryptionKeys,
} from "./_harness";

const hrefOf = (url: Parameters<typeof fetch>[0]) =>
  typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
const jsonFetch = (body: unknown) => new Response(JSON.stringify(body));
const unitVector = (length: number) =>
  Array.from({ length }, (_, i) => (i === 0 ? 1 : 0));
const requestBody = (init: RequestInit | undefined) =>
  typeof init?.body === "string"
    ? (JSON.parse(init.body) as Record<string, unknown>)
    : {};

const okFetch: typeof fetch = async (url, init) => {
  const path = new URL(hrefOf(url)).pathname;
  if (init?.method === "GET" && path.endsWith("/models")) {
    return new Response(
      JSON.stringify({ data: [{ id: "m-chat" }, { id: "m-embed" }] }),
    );
  }
  if (path.endsWith("/embeddings")) {
    return new Response(
      JSON.stringify({
        data: [
          {
            index: 0,
            embedding: [...unitVector(1536), 99],
          },
        ],
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }),
    );
  }
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: "" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );
};
const failingFetch: typeof fetch = async () =>
  new Response("nope", { status: 503 });

beforeEach(async () => {
  await resetDb();
});
afterEach(() => vi.restoreAllMocks());

describe("llm connections", () => {
  it("detects an embedding model's native size without requesting a size", async () => {
    const admin = await makeUser("Admin");
    const requestBodies: Record<string, unknown>[] = [];
    const caller = callerFor(admin, {
      llmFetch: async (_url, init) => {
        requestBodies.push(requestBody(init));
        return jsonFetch({
          data: [{ index: 0, embedding: unitVector(2560) }],
          usage: { prompt_tokens: 3, total_tokens: 3 },
        });
      },
    });
    const connection = await caller.llm.createConnection({
      name: "OpenRouter",
      providerType: "openrouter",
      credential: "openrouter-key",
    });

    await expect(
      caller.llm.detectEmbeddingDimensions({
        connectionId: connection.id,
        providerModelId: "qwen/qwen3-embedding-4b",
        upstreamProvider: "nebius",
      }),
    ).resolves.toEqual({ dimensions: 2560 });
    expect(requestBodies.at(-1)).toMatchObject({
      model: "qwen/qwen3-embedding-4b",
      provider: { only: ["nebius"] },
    });
    expect(requestBodies.at(-1)).not.toHaveProperty("dimensions");
    await expect(
      getPrisma().aiUsage.count({ where: { operation: "llm_model_test" } }),
    ).resolves.toBe(1);
    await expect(
      callerFor(await makeUser("User")).llm.detectEmbeddingDimensions({
        connectionId: connection.id,
        providerModelId: "qwen/qwen3-embedding-4b",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("reports a native size it cannot detect on the dimensions field", async () => {
    const admin = await makeUser("Admin");
    const connection = await callerFor(admin, {
      llmFetch: okFetch,
    }).llm.createConnection({
      name: "Compatible",
      providerType: "openai_compatible",
      endpoint: "https://ai.example/v1",
      credential: "key",
    });

    await expect(
      callerFor(admin, {
        llmFetch: failingFetch,
      }).llm.detectEmbeddingDimensions({
        connectionId: connection.id,
        providerModelId: "m-embed",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      cause: expect.objectContaining({ field: "embeddingDimensions" }),
    });
  });

  it("uses the fixed OpenRouter endpoint and stores a model upstream provider", async () => {
    const admin = await makeUser("Admin");
    const requestBodies: Record<string, unknown>[] = [];
    const caller = callerFor(admin, {
      llmFetch: async (_url, init) => {
        requestBodies.push(requestBody(init));
        return jsonFetch({
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });
    const connection = await caller.llm.createConnection({
      name: "OpenRouter",
      providerType: "openrouter",
      endpoint: "https://other.example/v1",
      credential: "openrouter-key",
    });
    expect(connection.endpoint).toBe("https://openrouter.ai/api/v1");

    const model = await caller.llm.createModel({
      connectionId: connection.id,
      providerModelId: "anthropic/example-model",
      displayName: "Example model",
      capabilities: ["chat"],
      upstreamProvider: "  anthropic  ",
    });
    expect(model.upstreamProvider).toBe("anthropic");
    expect(
      (await caller.llm.overview()).connections[0]?.models[0]?.upstreamProvider,
    ).toBe("anthropic");
    expect(await caller.llm.testModel({ modelId: model.id })).toMatchObject({
      outcome: "success",
    });
    expect(requestBodies.at(-1)?.provider).toEqual({ only: ["anthropic"] });

    const automatic = await caller.llm.updateModel({
      modelId: model.id,
      upstreamProvider: null,
    });
    expect(automatic.upstreamProvider).toBeNull();
    expect(await caller.llm.testModel({ modelId: model.id })).toMatchObject({
      outcome: "success",
    });
    expect(requestBodies.at(-1)).not.toHaveProperty("provider");

    const openai = await caller.llm.createConnection({
      name: "OpenAI",
      providerType: "openai",
      credential: "openai-key",
    });
    await expect(
      caller.llm.createModel({
        connectionId: openai.id,
        providerModelId: "some-model",
        displayName: "Some model",
        capabilities: ["chat"],
        upstreamProvider: "anthropic",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      cause: expect.objectContaining({ field: "upstreamProvider" }),
    });
  });

  it("lists upstream providers for an OpenRouter model", async () => {
    const admin = await makeUser("Admin");
    const caller = callerFor(admin, {
      llmFetch: async (url) => {
        expect(new URL(hrefOf(url)).pathname).toBe(
          "/api/v1/models/anthropic/example-model/endpoints",
        );
        return jsonFetch({
          data: {
            endpoints: [
              { name: "Anthropic", tag: "anthropic" },
              { name: "Vertex US", tag: "google-vertex/us-east5" },
            ],
          },
        });
      },
    });
    const connection = await caller.llm.createConnection({
      name: "OpenRouter",
      providerType: "openrouter",
      credential: "openrouter-key",
    });
    expect(
      await caller.llm.listOpenRouterUpstreamProviders({
        connectionId: connection.id,
        providerModelId: "anthropic/example-model",
      }),
    ).toEqual([
      { label: "Anthropic", slug: "anthropic" },
      { label: "Vertex US", slug: "google-vertex/us-east5" },
    ]);
  });

  it("enforces positive persisted model budgets", async () => {
    const { routing } = await seedTestLlmRouting();
    const model = await getPrisma().llmModel.findFirstOrThrow({
      where: { providerModelId: routing.extraction.providerModelId },
    });
    for (const field of ["contextWindow", "maxOutputTokens"] as const) {
      await expect(
        getPrisma().llmModel.update({
          where: { id: model.id },
          data: { [field]: 0 },
        }),
      ).rejects.toThrow();
    }
    expect(
      await getPrisma().llmModel.findUnique({ where: { id: model.id } }),
    ).toMatchObject({
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
    });
  });
  it("preserves concurrent disjoint model patches blocked on the same row", async () => {
    const admin = await makeUser("Admin");
    const caller = callerFor(admin);
    const db = getPrisma();
    const connection = await caller.llm.createConnection({
      name: "Concurrent",
      providerType: "openai",
      credential: "key",
    });
    const model = await caller.llm.createModel({
      connectionId: connection.id,
      providerModelId: "chat",
      displayName: "Before",
      contextWindow: 1000,
      capabilities: ["chat"],
    });
    let release!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "LlmModel" WHERE "id" = ${model.id}::uuid FOR UPDATE`;
        locked();
        await gate;
      },
      { timeout: 10_000 },
    );
    await ready;
    const updates = Promise.all([
      caller.llm.updateModel({ modelId: model.id, displayName: "After" }),
      caller.llm.updateModel({ modelId: model.id, contextWindow: 2000 }),
    ]);
    try {
      await vi.waitFor(
        async () => {
          const [waiting] = await db.$queryRaw<
            { count: number }[]
          >`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%LlmModel%'`;
          expect(waiting?.count).toBeGreaterThanOrEqual(2);
        },
        { timeout: 3000, interval: 10 },
      );
    } finally {
      release();
      await blocker;
      await updates;
    }
    expect(
      await db.llmModel.findUniqueOrThrow({ where: { id: model.id } }),
    ).toMatchObject({ displayName: "After", contextWindow: 2000 });
  });

  it("calculates actual embedding usage with only an input price configured", async () => {
    const admin = await makeUser("Admin");
    const caller = callerFor(admin, {
      llmFetch: async () =>
        jsonFetch({
          data: [{ index: 0, embedding: [1] }],
          usage: { prompt_tokens: 100, total_tokens: 100 },
        }),
    });
    const connection = await caller.llm.createConnection({
      name: "Priced embedding",
      providerType: "openai",
      credential: "key",
    });
    const model = await caller.llm.createModel({
      connectionId: connection.id,
      providerModelId: "embed",
      displayName: "Embed",
      capabilities: ["embedding"],
      embeddingDimensions: 1,
      inputCostMicrosPerMillion: 20_000,
      currency: "USD",
    });
    expect(await caller.llm.testModel({ modelId: model.id })).toMatchObject({
      outcome: "success",
      usage: { inputTokens: 100, outputTokens: 0 },
    });
    expect(
      await getPrisma().aiUsage.findFirstOrThrow({
        where: { operation: "llm_model_test" },
      }),
    ).toMatchObject({ costMicros: 2n, currency: "USD", outputTokens: 0 });
  });

  it("allows an explicitly keyless new local origin without forwarding the old key", async () => {
    const admin = await makeUser("Admin");
    const seen: (string | null)[] = [];
    const caller = callerFor(admin, {
      llmFetch: async (_url, init) => {
        seen.push(new Headers(init?.headers).get("authorization"));
        return jsonFetch({ choices: [] });
      },
    });
    const connection = await caller.llm.createConnection({
      name: "Local move",
      providerType: "ollama",
      credential: "old-key",
    });
    await caller.llm.updateConnection({
      connectionId: connection.id,
      endpoint: "http://127.0.0.1:9999",
      credential: "",
    });
    const model = await caller.llm.createModel({
      connectionId: connection.id,
      providerModelId: "chat",
      displayName: "Chat",
      capabilities: ["chat"],
    });
    await caller.llm.testModel({ modelId: model.id });
    expect(seen).toEqual([null]);
    expect(
      await decryptConnectionCredential(
        getPrisma(),
        testEncryptionKeys(),
        connection.id,
      ),
    ).toBe("");
  });

  it("accounts for deadline-aborted import probes and commits rows needing no probe", async () => {
    const admin = await makeUser("Admin");
    const deadline = new AbortController();
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
      ms === 60_000 ? deadline.signal : realTimeout(ms),
    );
    let attempts = 0;
    const caller = callerFor(admin, {
      llmFetch: async () => {
        attempts += 1;
        deadline.abort(new DOMException("deadline", "TimeoutError"));
        throw deadline.signal.reason;
      },
    });
    const connection = await caller.llm.createConnection({
      name: "Deadline import",
      providerType: "openai",
      credential: "key",
    });
    const result = await caller.llm.importModels({
      connectionId: connection.id,
      updateExisting: false,
      models: [
        {
          providerModelId: "chat",
          displayName: "Chat",
          capabilities: ["chat"],
        },
        {
          providerModelId: "embed",
          displayName: "Embed",
          capabilities: ["embedding"],
        },
      ],
    });
    expect(result).toMatchObject({
      created: 1,
      skipped: [
        {
          providerModelId: "embed",
          reason: expect.stringContaining("deadline"),
        },
      ],
    });
    expect(attempts).toBe(1);
    expect(
      await getPrisma().aiUsage.findMany({
        where: { operation: "llm_model_import_probe" },
      }),
    ).toEqual([
      expect.objectContaining({
        outcome: "provider_failure",
        connectionId: connection.id,
      }),
    ]);
    expect(
      await getPrisma().llmModel.findMany({
        where: { connectionId: connection.id },
      }),
    ).toEqual([expect.objectContaining({ providerModelId: "chat" })]);
  });

  it("requires a fresh credential when changing a connection origin", async () => {
    const admin = await makeUser("Admin");
    const caller = callerFor(admin);
    const connection = await caller.llm.createConnection({
      name: "Destination guard",
      providerType: "openai_compatible",
      endpoint: "https://first.example",
      credential: "original-key",
    });
    await expect(
      caller.llm.updateConnection({
        connectionId: connection.id,
        endpoint: "https://second.example",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const unchanged = await getPrisma().llmConnection.findUniqueOrThrow({
      where: { id: connection.id },
    });
    expect(unchanged.endpoint).toContain("first.example");
    await caller.llm.updateConnection({
      connectionId: connection.id,
      endpoint: "https://second.example",
      credential: "replacement-key",
    });
  });
  it("keeps retained adapters bound to their credential destination across live edits", async () => {
    const admin = await makeUser("Admin");
    const caller = callerFor(admin);
    const connection = await caller.llm.createConnection({
      name: "Destination migration",
      providerType: "openai_compatible",
      endpoint: "http://127.0.0.1:1234/v1",
      credential: "original-key",
    });
    const sent: Array<{ url: string; credential: string | null }> = [];
    const adapter = adapterForConnection(
      connection,
      getPrisma(),
      testEncryptionKeys(),
      async (input, init) => {
        sent.push({
          url: hrefOf(input),
          credential: new Headers(init?.headers).get("authorization"),
        });
        return Response.json({ choices: [] });
      },
    );
    await adapter.ping("fake");
    await caller.llm.updateConnection({
      connectionId: connection.id,
      credential: "rotated-key",
    });
    await adapter.ping("fake");
    await caller.llm.updateConnection({
      connectionId: connection.id,
      endpoint: "http://127.0.0.1:5678/v1",
      credential: "other-destination-key",
    });
    await expect(adapter.ping("fake")).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(sent).toEqual([
      {
        url: "http://127.0.0.1:1234/v1/chat/completions",
        credential: "Bearer original-key",
      },
      {
        url: "http://127.0.0.1:1234/v1/chat/completions",
        credential: "Bearer rotated-key",
      },
    ]);
  });

  it("requires llm:admin", async () => {
    const user = await makeUser("User");
    await expect(callerFor(user).llm.overview()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("accepts connection timeouts up to two minutes", async () => {
    const caller = callerFor(await makeUser("Admin"));
    const created = await caller.llm.createConnection({
      name: "Slow local Ollama",
      providerType: "ollama",
      endpoint: "http://127.0.0.1:11434",
      credential: "",
      requestTimeoutMs: 120_000,
    });
    expect(created.requestTimeoutMs).toBe(120_000);

    await expect(
      caller.llm.updateConnection({
        connectionId: created.id,
        requestTimeoutMs: 120_001,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("creates, lists (without secrets), edits, and deletes a connection", async () => {
    const admin = await makeUser("Admin");
    const caller = callerFor(admin);
    const created = await caller.llm.createConnection({
      name: "Local LM Studio",
      providerType: "openai_compatible",
      endpoint: "http://127.0.0.1:1234/v1/",
      credential: "sk-local-secret",
      requestTimeoutMs: 5000,
    });
    expect(created.endpoint).toBe("http://127.0.0.1:1234/v1");
    expect(created.credentialKeyVersion).toBe(
      testEncryptionKeys().activeVersion,
    );
    expect(JSON.stringify(created)).not.toContain("sk-local-secret");
    expect("credentialCiphertext" in created).toBe(false);

    const row = await getPrisma().llmConnection.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(
      Buffer.from(row.credentialCiphertext).toString("utf8"),
    ).not.toContain("sk-local-secret");
    expect(row.credentialNonce.byteLength).toBe(12);
    expect(row.credentialTag.byteLength).toBe(16);

    await expect(
      caller.llm.createConnection({
        name: "Local LM Studio",
        providerType: "openai",
        credential: "x",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      cause: expect.objectContaining({ field: "name" }),
    });

    const openai = await caller.llm.createConnection({
      name: "OpenAI",
      providerType: "openai",
      endpoint: "https://evil.test",
      credential: "sk-openai",
    });
    expect(openai.endpoint).toBe("https://api.openai.com/v1");

    await expect(
      caller.llm.createConnection({
        name: "Bad",
        providerType: "openai_compatible",
        endpoint: "ftp://x",
        credential: "k",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      cause: expect.objectContaining({ field: "endpoint" }),
    });
    for (const [name, endpoint] of [
      ["Bad query", "https://models.example/v1?tenant=other"],
      ["Bare query", "https://models.example/v1?"],
      ["Bare fragment", "https://models.example/v1#"],
    ] as const) {
      await expect(
        caller.llm.createConnection({
          name,
          providerType: "openai_compatible",
          endpoint,
          credential: "k",
        }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        cause: expect.objectContaining({ field: "endpoint" }),
      });
    }

    const updated = await caller.llm.updateConnection({
      connectionId: created.id,
      name: "LM Studio",
      enabled: false,
      credential: "sk-rotated",
    });
    expect(updated.name).toBe("LM Studio");
    expect(updated.enabled).toBe(false);
    expect(updated.credentialUpdatedAt.getTime()).toBeGreaterThan(
      created.credentialUpdatedAt.getTime(),
    );

    const overview = await caller.llm.overview();
    expect(overview.connections.map((c) => c.name).sort()).toEqual([
      "LM Studio",
      "OpenAI",
    ]);
    expect(overview.encryptionConfigured).toBe(true);

    await caller.llm.deleteConnection({ connectionId: openai.id });
    expect((await caller.llm.overview()).connections).toHaveLength(1);
  });

  it("manages models with capability validation", async () => {
    const admin = await makeUser("Admin");
    const caller = callerFor(admin);
    const connection = await caller.llm.createConnection({
      name: "C",
      providerType: "openai_compatible",
      endpoint: "http://127.0.0.1:1/v1",
      credential: "k",
    });
    const chat = await caller.llm.createModel({
      connectionId: connection.id,
      providerModelId: "m-chat",
      displayName: "Chat",
      capabilities: ["chat", "json_output", "tool_use"],
      contextWindow: 128000,
    });
    expect(chat.capabilities).toEqual(["chat", "json_output", "tool_use"]);
    await expect(
      caller.llm.createModel({
        connectionId: connection.id,
        providerModelId: "m-chat",
        displayName: "Dup",
        capabilities: ["chat"],
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      cause: expect.objectContaining({ field: "providerModelId" }),
    });
    await expect(
      caller.llm.createModel({
        connectionId: connection.id,
        providerModelId: "m-embed",
        displayName: "Embed",
        capabilities: ["embedding"],
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      cause: expect.objectContaining({ field: "embeddingDimensions" }),
    });
    const embed = await caller.llm.createModel({
      connectionId: connection.id,
      providerModelId: "m-embed",
      displayName: "Embed",
      capabilities: ["embedding"],
      embeddingDimensions: 1536,
      inputCostMicrosPerMillion: 20000,
      currency: "USD",
    });
    const fixed = await caller.llm.createModel({
      connectionId: connection.id,
      providerModelId: "fixed-embed",
      displayName: "Fixed",
      capabilities: ["embedding"],
      embeddingDimensions: 1536,
    });
    expect(fixed.embeddingDimensionMode).toBe("native");

    const resizable = await caller.llm.createModel({
      connectionId: connection.id,
      providerModelId: "qwen3-embedding:4b",
      displayName: "Qwen3 Embedding 4B",
      capabilities: ["embedding"],
      embeddingDimensions: 1536,
      embeddingDimensionMode: "matryoshka",
    });
    expect(resizable.embeddingDimensionMode).toBe("matryoshka");

    expect(chat.upstreamProvider).toBeNull();

    const chatAgain = await caller.llm.updateModel({
      modelId: resizable.id,
      capabilities: ["chat"],
    });
    expect(chatAgain.embeddingDimensions).toBeNull();
    expect(chatAgain.embeddingDimensionMode).toBe("native");
    await expect(
      createLlmModel(
        getPrisma(),
        createSessionSecurityContext({
          userId: admin.id,
          globalRole: "Admin",
          sessionId: "llm-service-boundary",
        }),
        {
          connectionId: connection.id,
          providerModelId: "long-currency",
          displayName: "Long currency",
          capabilities: ["chat"],
          currency: "TOO-LONG!",
        },
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: expect.objectContaining({ field: "currency" }),
    });
    const renamed = await caller.llm.updateModel({
      modelId: embed.id,
      displayName: "Embedding v1",
    });
    expect(renamed.displayName).toBe("Embedding v1");
    await caller.llm.deleteModel({ modelId: chat.id });
    expect(
      (await caller.llm.overview()).connections[0]?.models.map((m) => m.id),
    ).toEqual([embed.id, fixed.id, resizable.id]);
  });

  it("tests connections and models through the adapter and records the outcome", async () => {
    const admin = await makeUser("Admin");
    const ok = callerFor(admin, { llmFetch: okFetch });
    const connection = await ok.llm.createConnection({
      name: "C",
      providerType: "openai_compatible",
      endpoint: "http://127.0.0.1:1/v1",
      credential: "k",
    });
    const result = await ok.llm.testConnection({ connectionId: connection.id });
    expect(result.outcome).toBe("success");
    expect(result.models?.map((model) => model.providerModelId)).toEqual([
      "m-chat",
      "m-embed",
    ]);
    expect(result.models?.[1]).toMatchObject({
      capabilities: ["embedding"],
      embeddingDimensions: null,
      source: "inferred",
    });
    const embed = await ok.llm.createModel({
      connectionId: connection.id,
      providerModelId: "m-embed",
      displayName: "E",
      capabilities: ["embedding"],
      embeddingDimensions: 1536,
      embeddingDimensionMode: "matryoshka",
    });
    const modelTest = await ok.llm.testModel({ modelId: embed.id });
    expect(modelTest).toMatchObject({
      outcome: "success",
      usage: {
        inputTokens: 1,
        outputTokens: 0,
        totalTokens: 1,
      },
    });
    const usage = await getPrisma().aiUsage.findMany({
      where: { operation: "llm_model_test" },
    });
    expect(usage).toHaveLength(1);
    expect(usage[0]?.model).toBe("m-embed");
    expect(usage[0]?.connectionId).toBe(connection.id);

    const failing = callerFor(admin, { llmFetch: failingFetch });
    expect(await failing.llm.testModel({ modelId: embed.id })).toMatchObject({
      outcome: "failure",
      usage: null,
    });
    const failed = await failing.llm.testConnection({
      connectionId: connection.id,
    });
    expect(failed.outcome).toBe("failure");
    expect(failed.summary).toMatch(/status 503/);
    const row = await getPrisma().llmConnection.findUniqueOrThrow({
      where: { id: connection.id },
    });
    expect(row.lastTestOutcome).toBe("failure");
    expect(row.lastTestSummary).toMatch(/status 503/);
  });

  it("bounds model ids returned by connection tests", async () => {
    const admin = await makeUser("Admin");
    const manyModelsFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          data: Array.from({ length: 700 }, (_, index) => ({
            id: `model-${index}`,
          })),
        }),
      );
    const caller = callerFor(admin, { llmFetch: manyModelsFetch });
    const connection = await caller.llm.createConnection({
      name: "Many models",
      providerType: "openai_compatible",
      endpoint: "http://127.0.0.1:1/v1",
      credential: "k",
    });

    const result = await caller.llm.testConnection({
      connectionId: connection.id,
    });
    expect(result.summary).toBe("Listed 700 model(s)");
    expect(result.models).toHaveLength(500);
  });

  it("creates local provider connections without a credential and stores the server root", async () => {
    const admin = await makeUser("Admin");
    const caller = callerFor(admin);
    const lmstudio = await caller.llm.createConnection({
      name: "LM Studio",
      providerType: "lmstudio",
      credential: "",
    });
    expect(lmstudio.endpoint).toBe("http://127.0.0.1:1234");
    const ollama = await caller.llm.createConnection({
      name: "Ollama",
      providerType: "ollama",
      endpoint: "http://gpu.local:11434/v1/",
      credential: "",
    });
    expect(ollama.endpoint).toBe("http://gpu.local:11434");

    const db = getPrisma();
    const row = await db.llmConnection.findUniqueOrThrow({
      where: { id: lmstudio.id },
    });
    expect(row.credentialCiphertext.byteLength).toBe(0);
    expect(row.credentialNonce.byteLength).toBe(12);
    expect(row.credentialTag.byteLength).toBe(16);
    expect(
      await decryptConnectionCredential(db, testEncryptionKeys(), lmstudio.id),
    ).toBe("");
    await expect(
      assertConnectionSecretsDecryptable(db, testEncryptionKeys()),
    ).resolves.toBeUndefined();

    for (const providerType of [
      "openai",
      "anthropic",
      "openai_compatible",
    ] as const) {
      await expect(
        caller.llm.createConnection({
          name: `Keyless ${providerType}`,
          providerType,
          endpoint: "http://127.0.0.1:1/v1",
          credential: "",
        }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        cause: expect.objectContaining({ field: "credential" }),
      });
    }
  });

  it("discovers model metadata from LM Studio, Ollama, and the hosted catalog", async () => {
    const admin = await makeUser("Admin");

    const lmCalls: { href: string; authorization: string | null }[] = [];
    const lmFetch: typeof fetch = async (url, init) => {
      lmCalls.push({
        href: hrefOf(url),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return jsonFetch({
        data: [
          { id: "qwen3", type: "llm", max_context_length: 32_768 },
          { id: "nomic", type: "embeddings", max_context_length: 2048 },
        ],
      });
    };
    const lm = callerFor(admin, { llmFetch: lmFetch });
    const lmConnection = await lm.llm.createConnection({
      name: "LM Studio",
      providerType: "lmstudio",
      credential: "",
    });
    const lmResult = await lm.llm.testConnection({
      connectionId: lmConnection.id,
    });
    expect(lmCalls).toEqual([
      { href: "http://127.0.0.1:1234/api/v0/models", authorization: null },
    ]);
    expect(lmResult.summary).toBe("Listed 2 model(s)");
    expect(lmResult.models).toEqual([
      expect.objectContaining({
        providerModelId: "qwen3",
        contextWindow: 32_768,
        capabilities: ["chat", "json_output", "tool_use"],
        source: "endpoint",
      }),
      expect.objectContaining({
        providerModelId: "nomic",
        capabilities: ["embedding"],
        embeddingDimensions: null,
      }),
    ]);

    const ollamaFetch: typeof fetch = async (url, init) => {
      const path = new URL(hrefOf(url)).pathname;
      if (path === "/api/tags") {
        return jsonFetch({
          models: [{ name: "llama3.1:8b" }, { name: "nomic-embed-text" }],
        });
      }
      expect(path).toBe("/api/show");
      return requestBody(init).model === "llama3.1:8b"
        ? jsonFetch({
            capabilities: ["completion", "tools"],
            model_info: {
              "general.architecture": "llama",
              "llama.context_length": 131_072,
              "llama.embedding_length": 4096,
            },
          })
        : jsonFetch({
            capabilities: ["embedding"],
            model_info: {
              "general.architecture": "nomic-bert",
              "nomic-bert.context_length": 2048,
              "nomic-bert.embedding_length": 768,
            },
          });
    };
    const ollama = callerFor(admin, { llmFetch: ollamaFetch });
    const ollamaConnection = await ollama.llm.createConnection({
      name: "Ollama",
      providerType: "ollama",
      credential: "",
    });
    const ollamaResult = await ollama.llm.testConnection({
      connectionId: ollamaConnection.id,
    });
    expect(ollamaResult.models).toEqual([
      expect.objectContaining({
        providerModelId: "llama3.1:8b",
        contextWindow: 131_072,
        embeddingDimensions: null,
        capabilities: ["chat", "json_output", "tool_use"],
        source: "endpoint",
      }),
      expect.objectContaining({
        providerModelId: "nomic-embed-text",
        contextWindow: 2048,
        embeddingDimensions: 768,
        capabilities: ["embedding"],
      }),
    ]);

    const openaiFetch: typeof fetch = async () =>
      jsonFetch({
        data: [
          { id: "gpt-4o" },
          { id: "text-embedding-3-small" },
          { id: "whisper-1" },
        ],
      });
    const openai = callerFor(admin, { llmFetch: openaiFetch });
    const openaiConnection = await openai.llm.createConnection({
      name: "OpenAI",
      providerType: "openai",
      credential: "sk",
    });
    const openaiResult = await openai.llm.testConnection({
      connectionId: openaiConnection.id,
    });
    expect(openaiResult.models).toEqual([
      expect.objectContaining({
        providerModelId: "gpt-4o",
        contextWindow: 128_000,
        maxOutputTokens: 16_384,
        capabilities: ["chat", "json_output", "tool_use", "vision"],
        source: "catalog",
      }),
      expect.objectContaining({
        providerModelId: "text-embedding-3-small",
        embeddingDimensions: 1536,
        capabilities: ["embedding"],
        source: "catalog",
      }),
      expect.objectContaining({
        providerModelId: "whisper-1",
        capabilities: [],
        source: "inferred",
      }),
    ]);
  });

  it("imports discovered models, probes embedding dimensions, and updates existing limits", async () => {
    const admin = await makeUser("Admin");
    const probeFetch: typeof fetch = async (url, init) => {
      const path = new URL(hrefOf(url)).pathname;
      if (!path.endsWith("/embeddings")) return jsonFetch({ data: [] });
      const body = requestBody(init);
      expect(body.input).toEqual(["Weaver dimension probe"]);
      if (body.model === "broken-embed") {
        return new Response("nope", { status: 503 });
      }
      return jsonFetch({
        data: [{ index: 0, embedding: unitVector(768) }],
        usage: { prompt_tokens: 2, total_tokens: 2 },
      });
    };
    const caller = callerFor(admin, { llmFetch: probeFetch });
    const connection = await caller.llm.createConnection({
      name: "C",
      providerType: "openai_compatible",
      endpoint: "http://127.0.0.1:1/v1",
      credential: "k",
    });
    await caller.llm.createModel({
      connectionId: connection.id,
      providerModelId: "declared",
      displayName: "Declared",
      capabilities: ["chat"],
      contextWindow: 1000,
    });

    const first = await caller.llm.importModels({
      connectionId: connection.id,
      updateExisting: false,
      models: [
        {
          providerModelId: "chat-a",
          displayName: "Chat A",
          capabilities: ["chat", "json_output"],
          contextWindow: 32_000,
          maxOutputTokens: 4096,
          embeddingDimensions: null,
        },
        {
          providerModelId: "embed-a",
          displayName: "Embed A",
          capabilities: ["embedding"],
          contextWindow: 2048,
          maxOutputTokens: null,
          embeddingDimensions: null,
        },
        {
          providerModelId: "broken-embed",
          displayName: "Broken",
          capabilities: ["embedding"],
        },
        {
          providerModelId: "declared",
          displayName: "Renamed",
          capabilities: ["chat", "tool_use"],
          contextWindow: 5000,
          maxOutputTokens: 500,
        },
        {
          providerModelId: "chat-a",
          displayName: "Dup",
          capabilities: ["chat"],
        },
      ],
    });
    expect(first.created).toBe(2);
    expect(first.updated).toBe(0);
    expect(first.skipped).toHaveLength(3);
    expect(first.skipped).toEqual(
      expect.arrayContaining([
        {
          providerModelId: "broken-embed",
          reason: expect.stringMatching(/embedding dimensions.*status 503/),
        },
        {
          providerModelId: "declared",
          reason: "Already declared on this connection",
        },
        { providerModelId: "chat-a", reason: "Duplicate row" },
      ]),
    );

    const byId = async () =>
      new Map(
        (await caller.llm.overview()).connections[0]!.models.map((model) => [
          model.providerModelId,
          model,
        ]),
      );
    const models = await byId();
    expect(
      ["chat-a", "embed-a"].map(
        (providerModelId) =>
          models.get(providerModelId)?.embeddingDimensionMode,
      ),
    ).toEqual(["native", "native"]);
    expect(models.get("embed-a")).toMatchObject({
      embeddingDimensions: 768,
      contextWindow: 2048,
    });
    expect(models.get("chat-a")).toMatchObject({
      displayName: "Chat A",
      maxOutputTokens: 4096,
      capabilities: ["chat", "json_output"],
    });
    expect(models.get("declared")).toMatchObject({
      displayName: "Declared",
      contextWindow: 1000,
      maxOutputTokens: null,
    });
    const usage = await getPrisma().aiUsage.findMany({
      where: { operation: "llm_model_import_probe" },
    });
    expect(usage.map((row) => [row.model, row.outcome]).sort()).toEqual([
      ["broken-embed", "provider_failure"],
      ["embed-a", "success"],
    ]);

    const second = await caller.llm.importModels({
      connectionId: connection.id,
      updateExisting: true,
      models: [
        {
          providerModelId: "declared",
          displayName: "Renamed",
          capabilities: ["chat", "tool_use"],
          contextWindow: 5000,
          maxOutputTokens: 500,
        },
        { providerModelId: "chat-a", displayName: "X", capabilities: ["chat"] },
      ],
    });
    expect(second).toEqual({
      created: 0,
      updated: 1,
      skipped: [{ providerModelId: "chat-a", reason: "No limits to update" }],
    });
    const after = await byId();
    expect(after.get("declared")).toMatchObject({
      displayName: "Declared",
      capabilities: ["chat"],
      contextWindow: 5000,
      maxOutputTokens: 500,
    });
    expect(after.get("chat-a")).toMatchObject({
      contextWindow: 32_000,
      maxOutputTokens: 4096,
    });

    const anthropic = await caller.llm.createConnection({
      name: "Anthropic",
      providerType: "anthropic",
      credential: "sk-ant",
    });
    expect(
      await caller.llm.importModels({
        connectionId: anthropic.id,
        updateExisting: false,
        models: [
          {
            providerModelId: "claude-embed",
            displayName: "E",
            capabilities: ["embedding"],
            embeddingDimensions: 10,
          },
        ],
      }),
    ).toEqual({
      created: 0,
      updated: 0,
      skipped: [
        {
          providerModelId: "claude-embed",
          reason: "Anthropic connections do not provide embeddings",
        },
      ],
    });
    await expect(
      caller.llm.importModels({
        connectionId: connection.id,
        updateExisting: false,
        models: Array.from({ length: 501 }, (_, index) => ({
          providerModelId: `m-${index}`,
          displayName: `M ${index}`,
          capabilities: ["chat" as const],
        })),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("invalidates cached routing after an import updates a routed model", async () => {
    const { admin, connection, routing } = await seedTestLlmRouting();
    const db = getPrisma();
    expect((await cachedKnowledgeRouting(db))?.extraction.contextWindow).toBe(
      128_000,
    );
    const result = await callerFor(admin).llm.importModels({
      connectionId: connection.id,
      updateExisting: true,
      models: [
        {
          providerModelId: routing.extraction.providerModelId,
          displayName: "ignored",
          capabilities: ["chat"],
          contextWindow: 64_000,
          maxOutputTokens: 8000,
        },
      ],
    });
    expect(result.updated).toBe(1);
    expect((await cachedKnowledgeRouting(db))?.extraction.contextWindow).toBe(
      64_000,
    );
  });

  it("stores max output tokens on declared models", async () => {
    const admin = await makeUser("Admin");
    const caller = callerFor(admin);
    const connection = await caller.llm.createConnection({
      name: "C",
      providerType: "openai_compatible",
      endpoint: "http://127.0.0.1:1/v1",
      credential: "k",
    });
    const model = await caller.llm.createModel({
      connectionId: connection.id,
      providerModelId: "m",
      displayName: "M",
      capabilities: ["chat"],
      maxOutputTokens: 8192,
    });
    expect(model.maxOutputTokens).toBe(8192);
    expect(
      (
        await caller.llm.updateModel({
          modelId: model.id,
          maxOutputTokens: null,
        })
      ).maxOutputTokens,
    ).toBeNull();
    await expect(
      caller.llm.createModel({
        connectionId: connection.id,
        providerModelId: "bad",
        displayName: "Bad",
        capabilities: ["chat"],
        maxOutputTokens: -1,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses to store credentials without an encryption key ring", async () => {
    const admin = await makeUser("Admin");
    const caller = callerFor(admin, { encryptionKeys: null });
    await expect(
      caller.llm.createConnection({
        name: "C",
        providerType: "openai",
        credential: "k",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await caller.llm.overview()).encryptionConfigured).toBe(false);
  });
});

describe("secret rotation and startup coverage", () => {
  it("re-encrypts rows under the active key and fails startup when a version is missing", async () => {
    const admin = await makeUser("Admin");
    const ring = testEncryptionKeys();
    const activeKey = Buffer.from(ring.keys.get(ring.activeVersion)!).toString(
      "base64",
    );
    const nextVersion = ring.activeVersion + 1;
    const rotated = parseEncryptionKeyRing(
      `${ring.activeVersion}:${activeKey},${nextVersion}:${Buffer.alloc(32, 7).toString("base64")}`,
    )!;
    const nextOnly = parseEncryptionKeyRing(
      `${nextVersion}:${Buffer.alloc(32, 7).toString("base64")}`,
    )!;
    const wrongCurrentKey = parseEncryptionKeyRing(
      `${ring.activeVersion}:${Buffer.alloc(32, 9).toString("base64")}`,
    )!;
    const db = getPrisma();

    const connection = await callerFor(admin).llm.createConnection({
      name: "C",
      providerType: "openai",
      credential: "sk-rotate-me",
    });
    await expect(
      assertConnectionSecretsDecryptable(db, ring),
    ).resolves.toBeUndefined();
    await expect(
      assertConnectionSecretsDecryptable(db, nextOnly),
    ).rejects.toThrow(new RegExp(`version\\(s\\) ${ring.activeVersion}`));
    await expect(assertConnectionSecretsDecryptable(db, null)).rejects.toThrow(
      /WEAVER_ENCRYPTION_KEYS/,
    );
    await expect(
      assertConnectionSecretsDecryptable(db, wrongCurrentKey),
    ).rejects.toThrow(/cannot be decrypted/i);

    expect(await rotateConnectionSecrets(db, rotated)).toEqual({
      rotated: 1,
      skipped: 0,
    });
    expect(await rotateConnectionSecrets(db, rotated)).toEqual({
      rotated: 0,
      skipped: 1,
    });
    const row = await db.llmConnection.findUniqueOrThrow({
      where: { id: connection.id },
    });
    expect(row.credentialKeyVersion).toBe(nextVersion);
    expect(await decryptConnectionCredential(db, nextOnly, connection.id)).toBe(
      "sk-rotate-me",
    );
    await expect(
      assertConnectionSecretsDecryptable(db, nextOnly),
    ).resolves.toBeUndefined();
  });
});

describe("llm routes", () => {
  it("sets different thinking efforts on routes sharing one model", async () => {
    const admin = await makeUser("Admin");
    const caller = callerFor(admin);
    const connection = await caller.llm.createConnection({
      name: "Shared model",
      providerType: "openai",
      credential: "key",
    });
    const model = await caller.llm.createModel({
      connectionId: connection.id,
      providerModelId: "shared-chat",
      displayName: "Shared chat",
      capabilities: ["chat", "tool_use", "json_output"],
    });
    await caller.llm.setRoute({
      purpose: "assistant",
      modelId: model.id,
      reasoningMode: "none",
    });
    await caller.llm.setRoute({
      purpose: "jobs",
      modelId: model.id,
      reasoningMode: "high",
    });

    expect(
      (await resolveLlmRoute(getPrisma(), "assistant"))?.reasoningMode,
    ).toBe("none");
    expect((await resolveLlmRoute(getPrisma(), "jobs"))?.reasoningMode).toBe(
      "high",
    );
    await caller.llm.setRoute({ purpose: "assistant", modelId: model.id });
    expect(
      (await resolveLlmRoute(getPrisma(), "assistant"))?.reasoningMode,
    ).toBe("none");
    await caller.llm.setRoute({
      purpose: "knowledge_extraction",
      modelId: model.id,
      reasoningMode: "medium",
    });
    const embedding = await caller.llm.createModel({
      connectionId: connection.id,
      providerModelId: "shared-embedding",
      displayName: "Shared embedding",
      capabilities: ["embedding"],
      embeddingDimensions: 1536,
    });
    await caller.llm.setRoute({
      purpose: "knowledge_embedding",
      modelId: embedding.id,
    });
    expect(
      (await resolveKnowledgeRouting(getPrisma()))?.extraction.reasoningMode,
    ).toBe("medium");
    await expect(
      caller.llm.setRoute({
        purpose: "knowledge_embedding",
        modelId: model.id,
        reasoningMode: "high",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      cause: expect.objectContaining({ field: "reasoningMode" }),
    });
  });

  it("validates capabilities and dimensions, resolves ready routes, and reports health", async () => {
    const admin = await makeUser("Admin");
    const caller = callerFor(admin);
    const connection = await caller.llm.createConnection({
      name: "C",
      providerType: "openai_compatible",
      endpoint: "http://127.0.0.1:1/v1",
      credential: "k",
      requestTimeoutMs: 4321,
    });
    const chat = await caller.llm.createModel({
      connectionId: connection.id,
      providerModelId: "chat",
      displayName: "Chat",
      capabilities: ["chat", "json_output", "tool_use"],
      contextWindow: 32_000,
      inputCostMicrosPerMillion: 11,
      outputCostMicrosPerMillion: 22,
      currency: "EUR",
    });
    const embed = await caller.llm.createModel({
      connectionId: connection.id,
      providerModelId: "embed",
      displayName: "Embed",
      capabilities: ["embedding"],
      embeddingDimensions: 1536,
      embeddingDimensionMode: "matryoshka",
      contextWindow: 8_192,
      inputCostMicrosPerMillion: 33,
      outputCostMicrosPerMillion: 44,
      currency: "USD",
    });
    const small = await caller.llm.createModel({
      connectionId: connection.id,
      providerModelId: "embed-4096",
      displayName: "Oversized",
      capabilities: ["embedding"],
      embeddingDimensions: 4096,
    });

    const before = await caller.llm.overview();
    expect(before.routes.map((route) => [route.purpose, route.health])).toEqual(
      [
        ["assistant", "unassigned"],
        ["knowledge_extraction", "unassigned"],
        ["knowledge_embedding", "unassigned"],
        ["ingestion", "unassigned"],
        ["jobs", "unassigned"],
        ["document_summary", "unassigned"],
      ],
    );
    expect(await resolveKnowledgeRouting(getPrisma())).toBeNull();

    const summaryModel = await caller.llm.createModel({
      connectionId: connection.id,
      providerModelId: "summary-chat",
      displayName: "Summary chat",
      capabilities: ["chat"],
      contextWindow: 8_000,
    });
    expect(
      await caller.llm.setRoute({
        purpose: "document_summary",
        modelId: summaryModel.id,
      }),
    ).toMatchObject({ health: "ready" });
    await expect(
      caller.llm.setRoute({ purpose: "document_summary", modelId: embed.id }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(
      await caller.llm.setRoute({ purpose: "document_summary", modelId: null }),
    ).toMatchObject({ health: "unassigned", model: null });

    await expect(
      caller.llm.setRoute({ purpose: "knowledge_embedding", modelId: chat.id }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      cause: expect.objectContaining({ field: "modelId" }),
    });
    await expect(
      caller.llm.setRoute({
        purpose: "knowledge_embedding",
        modelId: small.id,
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      cause: expect.objectContaining({ field: "modelId" }),
    });

    await caller.llm.setRoute({
      purpose: "knowledge_extraction",
      modelId: chat.id,
    });
    expect(await resolveKnowledgeRouting(getPrisma())).toBeNull();
    const embeddingRoute = await caller.llm.setRoute({
      purpose: "knowledge_embedding",
      modelId: embed.id,
    });
    expect(embeddingRoute.health).toBe("ready");

    const ingestion = await caller.llm.setRoute({
      purpose: "ingestion",
      modelId: chat.id,
    });
    expect(ingestion.health).toBe("ready");

    const routing = await resolveKnowledgeRouting(getPrisma());
    expect(routing?.extraction).toEqual({
      connectionId: connection.id,
      connectionName: "C",
      providerType: "openai_compatible",
      endpoint: "http://127.0.0.1:1/v1",
      requestTimeoutMs: 4321,
      enabled: true,
      modelId: chat.id,
      providerModelId: "chat",
      displayName: "Chat",
      contextWindow: 32_000,
      maxOutputTokens: null,
      embeddingDimensions: null,
      embeddingDimensionMode: "native",
      upstreamProvider: null,
      vectorSpaceKey: null,
      reasoningMode: "provider_default",
      capabilities: ["chat", "json_output", "tool_use"],
      inputCostMicrosPerMillion: 11,
      outputCostMicrosPerMillion: 22,
      currency: "EUR",
    });
    expect(routing?.embedding).toEqual({
      connectionId: connection.id,
      connectionName: "C",
      providerType: "openai_compatible",
      endpoint: "http://127.0.0.1:1/v1",
      requestTimeoutMs: 4321,
      enabled: true,
      modelId: embed.id,
      providerModelId: "embed",
      displayName: "Embed",
      contextWindow: 8_192,
      maxOutputTokens: null,
      embeddingDimensions: 1536,
      embeddingDimensionMode: "matryoshka",
      upstreamProvider: null,
      vectorSpaceKey: null,
      reasoningMode: "provider_default",
      capabilities: ["embedding"],
      inputCostMicrosPerMillion: 33,
      outputCostMicrosPerMillion: 44,
      currency: "USD",
    });
    expect(routing?.embeddingDimensions).toBe(1536);
    expect(routing?.configFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(knowledgeRouteSnapshot(routing!).embedding).toMatchObject({
      embeddingDimensionMode: "matryoshka",
    });
    expect(JSON.stringify(routing)).not.toContain("credential");

    await caller.llm.updateConnection({
      connectionId: connection.id,
      enabled: false,
    });
    invalidateLlmRouteCache();
    expect(
      await resolveLlmRoute(getPrisma(), "knowledge_extraction"),
    ).toBeNull();
    expect(
      (await caller.llm.overview()).routes.find(
        (route) => route.purpose === "knowledge_extraction",
      )?.health,
    ).toBe("connection_disabled");
    await caller.llm.updateConnection({
      connectionId: connection.id,
      enabled: true,
    });

    await expect(
      caller.llm.deleteModel({ modelId: chat.id }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      caller.llm.deleteConnection({ connectionId: connection.id }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await caller.llm.setRoute({
      purpose: "knowledge_extraction",
      modelId: null,
    });
    await caller.llm.setRoute({ purpose: "assistant", modelId: null });
    await caller.llm.setRoute({ purpose: "ingestion", modelId: null });
    await caller.llm.deleteModel({ modelId: chat.id });
  });

  it("caches resolved routing briefly and invalidates on mutation", async () => {
    const { admin, connection, routing } = await seedTestLlmRouting();
    const db = getPrisma();
    const caller = callerFor(admin);
    expect((await cachedKnowledgeRouting(db))?.configFingerprint).toBe(
      routing.configFingerprint,
    );
    await caller.llm.updateConnection({
      connectionId: connection.id,
      enabled: false,
    });
    expect(await cachedKnowledgeRouting(db)).toBeNull();
    await caller.llm.updateConnection({
      connectionId: connection.id,
      enabled: true,
    });
    expect(await cachedKnowledgeRouting(db)).not.toBeNull();
    await caller.llm.updateModel({
      modelId: routing.extraction.modelId,
      inputCostMicrosPerMillion: 123,
    });
    expect(
      (await cachedKnowledgeRouting(db))?.extraction.inputCostMicrosPerMillion,
    ).toBe(123);
    await caller.llm.setRoute({
      purpose: "knowledge_extraction",
      modelId: null,
    });
    expect(await cachedKnowledgeRouting(db)).toBeNull();
    await caller.llm.setRoute({
      purpose: "knowledge_extraction",
      modelId: routing.extraction.modelId,
    });
    expect(await cachedKnowledgeRouting(db)).not.toBeNull();
    await db.llmRoute.deleteMany({});
    expect((await cachedKnowledgeRouting(db))?.configFingerprint).toBe(
      routing.configFingerprint,
    );
    invalidateLlmRouteCache();
    expect(await cachedKnowledgeRouting(db)).toBeNull();
  });

  it("rejects service calls from a session without llm:admin", async () => {
    const user = await makeUser("User");
    const security = createSessionSecurityContext({
      userId: user.id,
      globalRole: "User",
      sessionId: "s",
    });
    expect(security.capabilities.has("llm:admin")).toBe(false);
    await expect(listLlmRoutesDirect(security)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("lists the jobs purpose as an active route and marks it ready once a chat model is routed", async () => {
    const admin = await makeUser("Admin", "jobs-route");
    const before = await callerFor(admin).llm.overview();
    expect(before.routes.map((route) => route.purpose)).toContain("jobs");
    expect(
      before.routes.find((route) => route.purpose === "jobs")?.health,
    ).toBe("unassigned");
    await seedTestLlmRouting({ jobs: true });
    const after = await callerFor(admin).llm.overview();
    expect(after.routes.find((route) => route.purpose === "jobs")?.health).toBe(
      "ready",
    );
  });
});

async function listLlmRoutesDirect(security: SecurityContext) {
  const { listLlmRoutes } = await import("@weaver/core/services/llmRoutes");
  return listLlmRoutes(getPrisma(), security);
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@weaver/db/client";
import { createSessionSecurityContext } from "../security/context";
import { encryptSecret } from "../security/encryption";
import { emitDiagnostic } from "../diagnostics/writer";
import { recordAiUsage } from "./aiUsage";
import {
  credentialAad,
  createLlmModel,
  importLlmModels,
  testLlmConnection,
  updateLlmModel,
} from "./llmConnections";

vi.mock("./aiUsage", () => ({ recordAiUsage: vi.fn() }));
vi.mock("../diagnostics/writer", () => ({ emitDiagnostic: vi.fn() }));

const actor = createSessionSecurityContext({
  userId: "11111111-1111-4111-8111-111111111111",
  globalRole: "Admin",
  sessionId: "llm-unit",
});
const ring = {
  activeVersion: 1,
  keys: new Map([[1, new Uint8Array(32).fill(1)]]),
};
const connectionId = "22222222-2222-4222-8222-222222222222";

function connectionDb(providerType = "openai_compatible") {
  const secret = encryptSecret(ring, "secret", credentialAad(connectionId));
  const connection = {
    id: connectionId,
    providerType,
    endpoint: "https://provider.example/v1",
    requestTimeoutMs: 120_000,
    enabled: true,
    credentialCiphertext: secret.ciphertext,
    credentialNonce: secret.nonce,
    credentialTag: secret.tag,
    credentialKeyVersion: secret.keyVersion,
  };
  const created: unknown[] = [];
  const update = vi.fn();
  const transaction = {
    llmModel: {
      createMany: async ({ data }: { data: unknown[] }) => {
        created.push(...data);
        return { count: data.length };
      },
    },
  };
  const db = {
    llmConnection: { findUnique: async () => connection, update },
    llmModel: { findMany: async () => [] },
    $transaction: async (
      callback: (tx: typeof transaction) => Promise<unknown>,
    ) => callback(transaction),
  } as unknown as PrismaClient;
  return { db, created, update };
}

function installDeadline() {
  const deadline = new AbortController();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
    ms === 60_000 ? deadline.signal : timeout(ms),
  );
  return deadline;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("LLM admin operation deadlines", () => {
  it("returns and persists a controlled discovery failure with a diagnostic", async () => {
    const { db, update } = connectionDb("ollama");
    const deadline = installDeadline();
    const result = await testLlmConnection(
      db,
      actor,
      {
        ring,
        fetchImpl: async () => {
          deadline.abort(new DOMException("deadline", "TimeoutError"));
          throw deadline.signal.reason;
        },
      },
      connectionId,
    );
    expect(result).toMatchObject({
      outcome: "failure",
      summary: "AI provider model discovery deadline exceeded",
    });
    expect(update.mock.calls[0]?.[0]).toMatchObject({
      data: { lastTestOutcome: "failure" },
    });
    expect(emitDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "llm.connection.tested",
        outcome: "timeout",
      }),
    );
  });

  it("retains valid imports and accounts for every attempted probe at the deadline", async () => {
    const { db, created } = connectionDb();
    const deadline = installDeadline();
    let attempts = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      attempts += 1;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("deadline", "AbortError")),
          { once: true },
        );
        if (attempts === 4)
          queueMicrotask(() =>
            deadline.abort(new DOMException("deadline", "TimeoutError")),
          );
      });
    };
    const result = await importLlmModels(
      db,
      actor,
      { ring, fetchImpl },
      {
        connectionId,
        updateExisting: false,
        models: [
          {
            providerModelId: "chat",
            displayName: "Chat",
            capabilities: ["chat"],
          },
          ...Array.from({ length: 5 }, (_, index) => ({
            providerModelId: `embed-${index}`,
            displayName: `Embed ${index}`,
            capabilities: ["embedding" as const],
          })),
        ],
      },
    );
    expect(result.created).toBe(1);
    expect(created).toEqual([
      expect.objectContaining({ providerModelId: "chat" }),
    ]);
    expect(result.skipped).toHaveLength(5);
    expect(result.skipped.every((row) => row.reason.includes("deadline"))).toBe(
      true,
    );
    expect(attempts).toBe(4);
    expect(recordAiUsage).toHaveBeenCalledTimes(attempts);
    expect(
      vi
        .mocked(recordAiUsage)
        .mock.calls.every(([, input]) => input.outcome === "provider_failure"),
    ).toBe(true);
    const diagnostic = vi
      .mocked(emitDiagnostic)
      .mock.calls.find(
        ([entry]) => entry.event === "llm.model.import_probe_failed",
      );
    expect(diagnostic?.[0]).toMatchObject({
      details: { reason: "deadline" },
    });
  });

  it("retains a successful probe when usage persistence fails and emits a closed diagnostic", async () => {
    const { db } = connectionDb();
    vi.mocked(recordAiUsage).mockRejectedValueOnce(
      new Error("private database detail"),
    );
    const result = await importLlmModels(
      db,
      actor,
      {
        ring,
        fetchImpl: async () =>
          Response.json({
            data: [{ index: 0, embedding: [1] }],
            usage: { prompt_tokens: 1, total_tokens: 1 },
          }),
      },
      {
        connectionId,
        updateExisting: false,
        models: [
          {
            providerModelId: "embed",
            displayName: "Embed",
            capabilities: ["embedding"],
          },
        ],
      },
    );
    expect(result).toMatchObject({ created: 1, skipped: [] });
    expect(emitDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "ai.usage.failed", severity: "warn" }),
    );
    expect(JSON.stringify(vi.mocked(emitDiagnostic).mock.calls)).not.toContain(
      "private database detail",
    );
  });
});

describe("concurrent model patches", () => {
  it("preserves disjoint updates while merging against the locked current row", async () => {
    let model = {
      id: "33333333-3333-4333-8333-333333333333",
      providerModelId: "chat",
      displayName: "Before",
      capabilities: ["chat"],
      contextWindow: 1000,
      maxOutputTokens: null,
      embeddingDimensions: null,
      embeddingDimensionMode: "native",
      upstreamProvider: null,
      inputCostMicrosPerMillion: null,
      outputCostMicrosPerMillion: null,
      currency: null,
      connection: { providerType: "openai" },
    };
    let lock = Promise.resolve();
    const db = {
      // withKnowledgeRoutingChange resolves routing outside the tx; no rows keeps it null.
      $queryRaw: async () => [],
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
        let unlock: (() => void) | undefined;
        const tx = {
          $queryRaw: async () => {
            const previous = lock;
            lock = new Promise<void>((resolve) => {
              unlock = resolve;
            });
            await previous;
          },
          llmModel: {
            findUnique: async () => structuredClone(model),
            update: async ({ data }: { data: Partial<typeof model> }) => {
              model = { ...model, ...data };
              return model;
            },
          },
        };
        try {
          return await callback(tx);
        } finally {
          unlock?.();
        }
      },
    } as unknown as PrismaClient;
    await Promise.all([
      updateLlmModel(db, actor, { modelId: model.id, displayName: "After" }),
      updateLlmModel(db, actor, { modelId: model.id, contextWindow: 2000 }),
    ]);
    expect(model).toMatchObject({ displayName: "After", contextWindow: 2000 });
  });
});

it.each(["contextWindow", "maxOutputTokens"])(
  "rejects zero %s at the service boundary",
  async (field) => {
    await expect(
      createLlmModel({} as PrismaClient, actor, {
        connectionId,
        providerModelId: "test",
        displayName: "Test",
        capabilities: ["chat"],
        [field]: 0,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", details: { field } });
  },
);

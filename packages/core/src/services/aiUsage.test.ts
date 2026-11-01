import { afterEach, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@weaver/db/client";
import type { AiProvider } from "../ai/types";
import { AiProviderError } from "../ai/types";
import { calculateCostMicros, recordAiUsage } from "./aiUsage";
import { QueryEmbeddingCache, embedQuery } from "./knowledgeEmbeddings";

const embeddingIdentity = {
  providerName: "test-provider",
  embeddingConnectionId: "embedding-connection",
  embeddingModel: "test-embedding",
  embeddingDimensions: 1536 as const,
  inputCostMicrosPerMillion: 1_000_000,
  outputCostMicrosPerMillion: 4_000_000,
  currency: "USD",
};

function usageDb() {
  const rows: Array<Record<string, unknown>> = [];
  const db = {
    aiUsage: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        rows.push({ ...data });
        return data;
      },
    },
  } as unknown as PrismaClient;
  return { db, rows };
}

function embeddingRequestByteLength(input: string[]): number {
  return Buffer.byteLength(
    JSON.stringify({ model: embeddingIdentity.embeddingModel, input }),
    "utf8",
  );
}

function embeddingProvider(onEmbed?: (input: string[]) => void): AiProvider {
  return {
    embeddingRequestByteLength,
    async embed(input) {
      onEmbed?.(input);
      return {
        vectors: input.map(() => Array(1536).fill(0.25) as number[]),
        usage: {
          inputTokens: 2,
          outputTokens: 0,
          cachedTokens: 0,
          totalTokens: 2,
          durationMs: 7,
        },
      };
    },
    async extract() {
      throw new Error("not used");
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AI usage cost", () => {
  it("does not require a price for a known zero-token output", () => {
    expect(
      calculateCostMicros(
        { inputTokens: 100, outputTokens: 0 },
        { inputCostMicrosPerMillion: 20_000, outputCostMicrosPerMillion: null },
      ),
    ).toBe(2n);
  });

  it("does not treat unknown usage as zero even with a missing price", () => {
    expect(
      calculateCostMicros(
        { inputTokens: null, outputTokens: 0 },
        { inputCostMicrosPerMillion: 20_000, outputCostMicrosPerMillion: null },
      ),
    ).toBeNull();
  });
  it("uses integer micros per million tokens", () => {
    expect(
      calculateCostMicros(
        { inputTokens: 2_000, outputTokens: 500 },
        {
          inputCostMicrosPerMillion: 1_000_000,
          outputCostMicrosPerMillion: 4_000_000,
        },
      ),
    ).toBe(4_000n);
  });

  it("rounds a fractional micro half up", () => {
    expect(
      calculateCostMicros(
        { inputTokens: 1, outputTokens: 0 },
        {
          inputCostMicrosPerMillion: 500_000,
          outputCostMicrosPerMillion: 0,
        },
      ),
    ).toBe(1n);
  });

  it("returns null when prices or counts are unavailable", () => {
    expect(
      calculateCostMicros(
        { inputTokens: null, outputTokens: 1 },
        {
          inputCostMicrosPerMillion: 1,
          outputCostMicrosPerMillion: 1,
        },
      ),
    ).toBeNull();
    expect(
      calculateCostMicros(
        { inputTokens: 1, outputTokens: 1 },
        {
          inputCostMicrosPerMillion: null,
          outputCostMicrosPerMillion: 1,
        },
      ),
    ).toBeNull();
  });

  it("rejects usage outside database integer ranges before persistence", async () => {
    const { db, rows } = usageDb();

    await expect(
      recordAiUsage(db, {
        projectId: null,
        operation: "test",
        provider: "provider",
        model: "model",
        configFingerprint: "fingerprint",
        usage: {
          inputTokens: 2_147_483_648,
          outputTokens: 0,
          cachedTokens: 0,
          totalTokens: 2_147_483_648,
          durationMs: 1,
        },
        outcome: "success",
        pricing: {
          inputCostMicrosPerMillion: null,
          outputCostMicrosPerMillion: null,
        },
      }),
    ).rejects.toThrow("AI usage exceeds database limits");
    expect(rows).toEqual([]);
  });
});

describe("query embeddings", () => {
  it("normalizes and caches a query for five minutes with one usage row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T12:00:00.000Z"));
    const { db, rows } = usageDb();
    const calls: string[][] = [];
    const provider = embeddingProvider((input) => calls.push(input));
    const cache = new QueryEmbeddingCache();
    const input = {
      query: "  incident   response  ",
      configFingerprint: "config-a",
      ...embeddingIdentity,
    };

    const first = await embedQuery(db, provider, input, cache);
    const cached = await embedQuery(
      db,
      provider,
      { ...input, query: "incident response" },
      cache,
    );

    expect(cached).toEqual(first);
    expect(calls).toEqual([["incident response"]]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      projectId: null,
      documentId: null,
      operation: "search_query_embedding",
      provider: "test-provider",
      connectionId: "embedding-connection",
      model: "test-embedding",
      configFingerprint: "config-a",
      inputTokens: 2,
      outputTokens: 0,
      durationMs: 7,
      outcome: "success",
      costMicros: 2n,
      currency: "USD",
    });

    await vi.advanceTimersByTimeAsync(5 * 60 * 1_000 + 1);
    await embedQuery(db, provider, input, cache);

    expect(calls).toHaveLength(2);
    expect(rows).toHaveLength(2);
  });

  it("does not share cached vectors across model identities", async () => {
    const { db } = usageDb();
    let calls = 0;
    const provider = embeddingProvider(() => {
      calls += 1;
    });
    const cache = new QueryEmbeddingCache();
    const input = {
      query: "same query",
      configFingerprint: "shared-fingerprint",
      ...embeddingIdentity,
    };

    await embedQuery(db, provider, input, cache);
    await embedQuery(
      db,
      provider,
      { ...input, embeddingModel: "other-embedding" },
      cache,
    );

    expect(calls).toBe(2);
  });

  it("records every failed cache miss without caching it", async () => {
    const { db, rows } = usageDb();
    let calls = 0;
    const provider: AiProvider = {
      embeddingRequestByteLength,
      async embed() {
        calls += 1;
        throw new Error("provider unavailable");
      },
      async extract() {
        throw new Error("not used");
      },
    };
    const cache = new QueryEmbeddingCache();
    const input = {
      query: "uncached failure",
      configFingerprint: "failure-config",
      ...embeddingIdentity,
    };

    await expect(embedQuery(db, provider, input, cache)).rejects.toThrow(
      "provider unavailable",
    );
    await expect(embedQuery(db, provider, input, cache)).rejects.toThrow(
      "provider unavailable",
    );

    expect(calls).toBe(2);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.outcome)).toEqual([
      "provider_failure",
      "provider_failure",
    ]);
  });

  it("accounts for an invalid query vector as a validation failure", async () => {
    const { db, rows } = usageDb();
    const provider: AiProvider = {
      embeddingRequestByteLength,
      async embed() {
        return {
          vectors: [[Number.POSITIVE_INFINITY]],
          usage: {
            inputTokens: 3,
            outputTokens: 0,
            cachedTokens: 0,
            totalTokens: 3,
            durationMs: 4,
          },
        };
      },
      async extract() {
        throw new Error("not used");
      },
    };

    await expect(
      embedQuery(db, provider, {
        query: "invalid vector",
        configFingerprint: "validation-config",
        ...embeddingIdentity,
      }),
    ).rejects.toMatchObject({ retryable: false });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "validation_failure",
      inputTokens: 3,
      outputTokens: 0,
    });
  });

  it.each([
    {
      name: "float32 overflow",
      vector: [Number.MAX_VALUE, ...Array.from({ length: 1535 }, () => 0.25)],
    },
    {
      name: "zero cosine norm",
      vector: Array.from({ length: 1536 }, () => 0),
    },
  ])("rejects a query vector with $name before caching", async ({ vector }) => {
    const { db, rows } = usageDb();
    const provider: AiProvider = {
      embeddingRequestByteLength,
      async embed() {
        return {
          vectors: [vector],
          usage: {
            inputTokens: 3,
            outputTokens: 0,
            cachedTokens: 0,
            totalTokens: 3,
            durationMs: 4,
          },
        };
      },
      async extract() {
        throw new Error("not used");
      },
    };

    await expect(
      embedQuery(db, provider, {
        query: "invalid vector",
        configFingerprint: "validation-config",
        ...embeddingIdentity,
      }),
    ).rejects.toMatchObject({ retryable: false });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "validation_failure" });
  });

  it("uses structured provider failure usage without inspecting error text", async () => {
    const { db, rows } = usageDb();
    const provider: AiProvider = {
      embeddingRequestByteLength,
      async embed() {
        throw new AiProviderError("safe provider validation failure", {
          kind: "validation",
          retryable: false,
          usage: {
            inputTokens: 11,
            outputTokens: 0,
            cachedTokens: 1,
            totalTokens: 11,
            durationMs: 9,
          },
        });
      },
      async extract() {
        throw new Error("not used");
      },
    };

    await expect(
      embedQuery(db, provider, {
        query: "structured failure",
        configFingerprint: "structured-config",
        ...embeddingIdentity,
      }),
    ).rejects.toThrow("safe provider validation failure");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "validation_failure",
      inputTokens: 11,
      outputTokens: 0,
      cachedTokens: 1,
      totalTokens: 11,
      durationMs: 9,
    });
  });

  it("does not cache a query vector until accounting succeeds", async () => {
    const rows: Array<Record<string, unknown>> = [];
    let accountingAttempts = 0;
    const db = {
      aiUsage: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          accountingAttempts += 1;
          if (accountingAttempts === 1) {
            throw new Error("accounting unavailable");
          }
          rows.push({ ...data });
          return data;
        },
      },
    } as unknown as PrismaClient;
    let providerCalls = 0;
    const provider = embeddingProvider(() => {
      providerCalls += 1;
    });
    const cache = new QueryEmbeddingCache();
    const input = {
      query: "durable accounting",
      configFingerprint: "durable-config",
      ...embeddingIdentity,
    };

    await expect(embedQuery(db, provider, input, cache)).rejects.toThrow(
      "accounting unavailable",
    );
    await expect(embedQuery(db, provider, input, cache)).resolves.toHaveLength(
      1536,
    );

    expect(providerCalls).toBe(2);
    expect(accountingAttempts).toBe(2);
    expect(rows).toHaveLength(1);
  });

  it("evicts the oldest insertion when entry 501 is added", async () => {
    const { db, rows } = usageDb();
    let calls = 0;
    const provider = embeddingProvider(() => {
      calls += 1;
    });
    const cache = new QueryEmbeddingCache();

    for (let index = 0; index <= 500; index += 1) {
      await embedQuery(
        db,
        provider,
        {
          query: `query ${index}`,
          configFingerprint: "bounded-config",
          ...embeddingIdentity,
        },
        cache,
      );
    }
    await embedQuery(
      db,
      provider,
      {
        query: "query 1",
        configFingerprint: "bounded-config",
        ...embeddingIdentity,
      },
      cache,
    );
    await embedQuery(
      db,
      provider,
      {
        query: "query 0",
        configFingerprint: "bounded-config",
        ...embeddingIdentity,
      },
      cache,
    );

    expect(calls).toBe(502);
    expect(rows).toHaveLength(502);
  });
});

import type { PrismaClient } from "@weaver/db/client";
import { parseEncryptionKeyRing } from "@weaver/config/encryptionKeys";
import { encryptSecret, secretAad } from "../security/encryption";
import { describe, expect, it, vi } from "vitest";

import type { KnowledgeRouting, LlmModelSnapshot } from "../services/llmRoutes";
import {
  createKnowledgeProvider,
  createDbCredentialSource,
  createAdapterForSnapshot,
  createKnowledgeRoutingSource,
  knowledgeAiIdentity,
  type ProviderCredentialSource,
} from "./registry";

function snapshot(
  connection: "extraction-connection" | "embedding-connection",
  overrides: Partial<LlmModelSnapshot> = {},
): LlmModelSnapshot {
  const extraction = connection === "extraction-connection";
  return {
    connectionId: connection,
    connectionName: extraction ? "Extraction provider" : "Embedding provider",
    providerType: "openai_compatible",
    endpoint: extraction
      ? "https://extract.example/v1"
      : "https://embed.example/v1",
    requestTimeoutMs: extraction ? 2_000 : 3_000,
    enabled: true,
    modelId: extraction ? "extraction-model-id" : "embedding-model-id",
    providerModelId: extraction ? "extract-v1" : "embed-v1",
    displayName: extraction ? "Extract" : "Embed",
    contextWindow: extraction ? 32_000 : null,
    embeddingDimensions: extraction ? null : 1536,
    embeddingDimensionMode: extraction ? "native" : "matryoshka",
    reasoningMode: "provider_default",
    upstreamProvider: null,
    capabilities: extraction
      ? ["chat", "json_output", "tool_use"]
      : ["embedding"],
    inputCostMicrosPerMillion: extraction ? 11 : 33,
    outputCostMicrosPerMillion: extraction ? 22 : 44,
    currency: extraction ? "EUR" : "USD",
    ...overrides,
  };
}

const routing: KnowledgeRouting = {
  extraction: snapshot("extraction-connection"),
  embedding: snapshot("embedding-connection"),
  embeddingDimensions: 1536,
  configFingerprint: "a".repeat(64),
  extractionFingerprint: "extraction-a",
  extractionSchemaVersion: 1,
  promptVersion: "prompt-v1",
};

describe("knowledge provider registry", () => {
  it("pins a snapshot adapter to its OpenRouter upstream", async () => {
    let body: Record<string, unknown> = {};
    const adapter = createAdapterForSnapshot(
      snapshot("extraction-connection", {
        providerType: "openrouter",
        upstreamProvider: "anthropic",
      }),
      { resolveCredential: async () => "key" },
      async (_input, init) => {
        body = JSON.parse(init?.body as string) as Record<string, unknown>;
        return Response.json({ choices: [] });
      },
    );

    await adapter.ping("anthropic/claude-sonnet");

    expect(body.provider).toEqual({ only: ["anthropic"] });
  });

  it("uses the embedding upstream when two knowledge routes share a connection", async () => {
    let body: Record<string, unknown> = {};
    const shared = snapshot("extraction-connection", {
      providerType: "openrouter",
      endpoint: "https://openrouter.ai/api/v1",
      upstreamProvider: "anthropic",
    });
    const provider = createKnowledgeProvider(
      {
        ...routing,
        extraction: shared,
        embedding: {
          ...snapshot("embedding-connection"),
          connectionId: shared.connectionId,
          providerType: "openrouter",
          endpoint: shared.endpoint,
          requestTimeoutMs: shared.requestTimeoutMs,
          upstreamProvider: "openai",
          embeddingDimensionMode: "native",
        },
      },
      { resolveCredential: async () => "key" },
      async (_input, init) => {
        body = JSON.parse(init?.body as string) as Record<string, unknown>;
        return Response.json({
          data: [{ index: 0, embedding: Array(1536).fill(0.25) }],
        });
      },
    );

    await provider.embed(["query"]);

    expect(body.provider).toEqual({ only: ["openai"] });
  });
  it("routes each operation through its connection and resolves plaintext per request", async () => {
    const credentialRequests: string[] = [];
    const credentials: ProviderCredentialSource = {
      async resolveCredential(connectionId) {
        credentialRequests.push(connectionId);
        return `${connectionId}-secret`;
      },
    };
    const requests: Array<{ url: string; authorization: string | undefined }> =
      [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const headers = init?.headers as Record<string, string> | undefined;
      requests.push({ url, authorization: headers?.Authorization });
      if (url.endsWith("/embeddings")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                index: 0,
                embedding: [1, ...Array.from({ length: 1535 }, () => 0), 99],
              },
            ],
            usage: { prompt_tokens: 2, total_tokens: 2 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify({ entities: [], relations: [] }),
              },
            },
          ],
          usage: {
            prompt_tokens: 3,
            completion_tokens: 1,
            total_tokens: 4,
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    };
    const provider = createKnowledgeProvider(routing, credentials, fetchImpl);

    const embedding = await provider.embed(["query"]);
    await provider.extract({
      documentId: "11111111-1111-4111-8111-111111111111",
      chunkId: "chunk-1",
      title: "Runbook",
      headingPath: ["Runbook"],
      text: "Deploy safely.",
    });

    expect(credentialRequests).toEqual([
      "embedding-connection",
      "extraction-connection",
    ]);
    expect(requests).toEqual([
      {
        url: "https://embed.example/v1/embeddings",
        authorization: "Bearer embedding-connection-secret",
      },
      {
        url: "https://extract.example/v1/chat/completions",
        authorization: "Bearer extraction-connection-secret",
      },
    ]);
    expect(embedding.vectors).toEqual([
      [1, ...Array.from({ length: 1535 }, () => 0)],
    ]);
  });

  it("maps embedding and extraction pricing to their own identities", () => {
    expect(knowledgeAiIdentity(routing)).toEqual({
      providerName: "openai_compatible",
      embeddingConnectionId: "embedding-connection",
      embeddingModel: "embed-v1",
      embeddingDimensions: 1536,
      extractionModel: "extract-v1",
      extractionProviderName: "openai_compatible",
      extractionConnectionId: "extraction-connection",
      configFingerprint: "a".repeat(64),
      extractionFingerprint: "extraction-a",
      inputCostMicrosPerMillion: 33,
      outputCostMicrosPerMillion: 44,
      currency: "USD",
      extractionInputCostMicrosPerMillion: 11,
      extractionOutputCostMicrosPerMillion: 22,
      extractionCurrency: "EUR",
    });
  });

  it("does not reuse an adapter when same-connection snapshots have different adapter configuration", async () => {
    const requests: string[] = [];
    const inconsistentRouting: KnowledgeRouting = {
      ...routing,
      embedding: snapshot("embedding-connection", {
        connectionId: routing.extraction.connectionId,
      }),
    };
    const provider = createKnowledgeProvider(
      inconsistentRouting,
      { resolveCredential: async () => "secret" },
      async (input) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        requests.push(url);
        return new Response(
          JSON.stringify({
            data: [{ index: 0, embedding: Array(1536).fill(0.25) }],
            usage: { prompt_tokens: 1, total_tokens: 1 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    );

    await provider.embed(["query"]);

    expect(requests).toEqual(["https://embed.example/v1/embeddings"]);
  });

  it("paces embedding requests from the embedding connection's measured throughput", async () => {
    let timeOut = false;
    const provider = createKnowledgeProvider(
      routing,
      { resolveCredential: async () => "secret" },
      async () => {
        if (timeOut) {
          throw new DOMException("The operation timed out.", "TimeoutError");
        }
        return new Response(
          JSON.stringify({
            data: [{ index: 0, embedding: Array(1536).fill(0.25) }],
            usage: { prompt_tokens: 1, total_tokens: 1 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    );

    expect(provider.embeddingCharacterBudget?.()).toBe(0);
    await provider.embed(["x".repeat(3_000)]);
    const measured = provider.embeddingCharacterBudget?.() ?? 0;
    expect(measured).toBeGreaterThan(0);

    timeOut = true;
    await expect(provider.embed(["y"])).rejects.toThrow(
      "AI provider request timed out",
    );
    const reduced = provider.embeddingCharacterBudget?.() ?? 0;
    expect(reduced).toBeLessThanOrEqual(measured / 2);
    expect(reduced).toBeGreaterThanOrEqual(measured / 2 - 1);
  });
});

describe("knowledge routing source", () => {
  it("replaces the retained provider when only the reasoning mode changes", () => {
    const source = createKnowledgeRoutingSource(
      {} as PrismaClient,
      null,
      vi.fn<typeof fetch>(),
    );
    const low = source.providerFor(routing);
    expect(source.providerFor({ ...routing })).toBe(low);
    // Same rebuild fingerprint: a reasoning edit must not reindex the corpus.
    const high = source.providerFor({
      ...routing,
      extraction: { ...routing.extraction, reasoningMode: "high" },
    });
    expect(high).not.toBe(low);
  });

  it("replaces a retained provider when the upstream changes", () => {
    const source = createKnowledgeRoutingSource(
      {} as PrismaClient,
      null,
      vi.fn<typeof fetch>(),
    );
    const first = source.providerFor(routing);
    const changed = source.providerFor({
      ...routing,
      extraction: { ...routing.extraction, upstreamProvider: "anthropic" },
    });

    expect(changed).not.toBe(first);
  });

  it("builds a fresh knowledge provider when only the extraction model changes", () => {
    const source = createKnowledgeRoutingSource({} as never, null);
    const first = source.providerFor(routing);
    expect(source.providerFor(routing)).toBe(first);
    const switched = source.providerFor({
      ...routing,
      extraction: { ...routing.extraction, providerModelId: "extract-v2" },
      extractionFingerprint: "extraction-b",
    });
    expect(switched).not.toBe(first);
  });
});

describe("retained adapter credentials", () => {
  it("rotates keys at the same destination and rejects endpoint, provider, or enabled changes before HTTP", async () => {
    const snap = snapshot("extraction-connection");
    const ring = parseEncryptionKeyRing(
      `1:${Buffer.alloc(32, 1).toString("base64")}`,
    )!;
    const row = {
      endpoint: snap.endpoint,
      providerType: snap.providerType,
      enabled: true,
      credentialCiphertext: new Uint8Array(),
      credentialNonce: new Uint8Array(),
      credentialTag: new Uint8Array(),
      credentialKeyVersion: 1,
    };
    const rotate = (value: string) => {
      const encrypted = encryptSecret(
        ring,
        value,
        secretAad("llm-connection", snap.connectionId),
      );
      Object.assign(row, {
        credentialCiphertext: encrypted.ciphertext,
        credentialNonce: encrypted.nonce,
        credentialTag: encrypted.tag,
        credentialKeyVersion: encrypted.keyVersion,
      });
    };
    const db = {
      llmConnection: { findUnique: async () => ({ ...row }) },
    } as unknown as PrismaClient;
    const sent: string[] = [];
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get("authorization")!);
      return Response.json({ choices: [] });
    });
    const adapter = createAdapterForSnapshot(
      snap,
      createDbCredentialSource(db, ring),
      fetchImpl,
    );
    rotate("destination-a-key");
    await adapter.ping("model");
    rotate("rotated-a-key");
    await adapter.ping("model");
    row.endpoint = "https://destination-b.test/v1";
    rotate("destination-b-key");
    await expect(adapter.ping("model")).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    row.endpoint = snap.endpoint;
    row.enabled = false;
    await expect(adapter.ping("model")).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    row.enabled = true;
    row.providerType = "anthropic";
    await expect(adapter.ping("model")).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(sent).toEqual(["Bearer destination-a-key", "Bearer rotated-a-key"]);
  });
});

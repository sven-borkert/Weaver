import { describe, expect, it } from "vitest";

import type { PrismaClient } from "@weaver/db/client";
import {
  ACTIVE_LLM_PURPOSES,
  REQUIRED_CAPABILITIES,
  resolveKnowledgeRouting,
  routeHealth,
  type LlmModelSnapshot,
} from "./llmRoutes";

function routeRow(
  purpose: "knowledge_extraction" | "knowledge_embedding",
  snapshot: "a" | "b",
) {
  const embedding = purpose === "knowledge_embedding";
  return {
    purpose,
    updatedAt: new Date(`2026-09-0${snapshot === "a" ? "1" : "2"}T00:00:00Z`),
    reasoningMode: embedding ? "provider_default" : "high",
    model: {
      id: `${snapshot}-${embedding ? "embedding" : "extraction"}-model-id`,
      providerModelId: `${snapshot}-${embedding ? "embedding" : "extraction"}`,
      displayName: `Snapshot ${snapshot.toUpperCase()} ${embedding ? "embedding" : "extraction"}`,
      contextWindow: embedding ? null : 32_000,
      maxOutputTokens: embedding ? null : 1024,
      embeddingDimensions: embedding ? 1536 : null,
      embeddingDimensionMode: embedding ? "matryoshka" : "native",
      upstreamProvider: null,
      capabilities: embedding
        ? (["embedding"] as const)
        : (["chat", "json_output"] as const),
      inputCostMicrosPerMillion: null,
      outputCostMicrosPerMillion: null,
      currency: null,
      connection: {
        id: `${snapshot}-connection-id`,
        name: `Snapshot ${snapshot.toUpperCase()}`,
        providerType: "openai_compatible" as const,
        endpoint: `https://${snapshot}.example/v1`,
        requestTimeoutMs: 1_000,
        enabled: true,
      },
    },
  };
}

function rawRouteRow(
  purpose: "knowledge_extraction" | "knowledge_embedding",
  snapshot: "a" | "b",
) {
  const row = routeRow(purpose, snapshot);
  return {
    purpose: row.purpose,
    connectionId: row.model.connection.id,
    connectionName: row.model.connection.name,
    providerType: row.model.connection.providerType,
    endpoint: row.model.connection.endpoint,
    requestTimeoutMs: row.model.connection.requestTimeoutMs,
    enabled: row.model.connection.enabled,
    modelId: row.model.id,
    providerModelId: row.model.providerModelId,
    displayName: row.model.displayName,
    contextWindow: row.model.contextWindow,
    maxOutputTokens: row.model.maxOutputTokens,
    embeddingDimensions: row.model.embeddingDimensions,
    embeddingDimensionMode: row.model.embeddingDimensionMode,
    upstreamProvider: row.model.upstreamProvider,
    reasoningMode: row.reasoningMode,
    capabilities: row.model.capabilities,
    inputCostMicrosPerMillion: row.model.inputCostMicrosPerMillion,
    outputCostMicrosPerMillion: row.model.outputCostMicrosPerMillion,
    currency: row.model.currency,
  };
}

describe("resolved knowledge routing", () => {
  it("exposes an optional chat-only document summary route", () => {
    expect(ACTIVE_LLM_PURPOSES).toContain("document_summary");
    expect(REQUIRED_CAPABILITIES).toHaveProperty("document_summary", ["chat"]);
  });
  it("exposes an optional wiki route that needs chat and tool use", () => {
    expect(ACTIVE_LLM_PURPOSES).toContain("wiki");
    expect(REQUIRED_CAPABILITIES).toHaveProperty("wiki", ["chat", "tool_use"]);
  });
  it("assembles both purposes from one raw database statement", async () => {
    const coherentRows = [
      rawRouteRow("knowledge_extraction", "a"),
      rawRouteRow("knowledge_embedding", "a"),
    ];
    let statements = 0;
    const db = {
      $queryRaw: async () => {
        statements += 1;
        return coherentRows;
      },
      llmRoute: {
        findMany: async () => {
          statements += 1;
          return [
            routeRow("knowledge_extraction", "a"),
            routeRow("knowledge_embedding", "b"),
          ];
        },
      },
    } as unknown as PrismaClient;

    const routing = await resolveKnowledgeRouting(db);

    expect({
      extraction: routing?.extraction.connectionName,
      embedding: routing?.embedding.connectionName,
    }).toEqual({ extraction: "Snapshot A", embedding: "Snapshot A" });
    expect(routing?.embedding.embeddingDimensionMode).toBe("matryoshka");
    expect(routing?.extraction.reasoningMode).toBe("high");
    expect(statements).toBe(1);
  });
});

function embeddingSnapshot(
  embeddingDimensions: number | null,
): LlmModelSnapshot {
  return {
    connectionId: "connection-id",
    connectionName: "Connection",
    providerType: "openai_compatible",
    endpoint: "https://a.example/v1",
    requestTimeoutMs: 1_000,
    enabled: true,
    modelId: "model-id",
    providerModelId: "embedding",
    displayName: "Embedding",
    contextWindow: null,
    maxOutputTokens: null,
    embeddingDimensions,
    embeddingDimensionMode: "native",
    upstreamProvider: null,
    vectorSpaceKey: null,
    reasoningMode: "provider_default",
    capabilities: ["embedding"],
    inputCostMicrosPerMillion: null,
    outputCostMicrosPerMillion: null,
    currency: null,
  };
}

describe("knowledge embedding route health", () => {
  it("accepts any size from 1 to 4,000", () => {
    for (const size of [1, 768, 1000, 1536, 2560, 4000]) {
      expect(routeHealth("knowledge_embedding", embeddingSnapshot(size))).toBe(
        "ready",
      );
    }
  });

  it("rejects a missing or oversized size", () => {
    for (const size of [null, 4001]) {
      expect(routeHealth("knowledge_embedding", embeddingSnapshot(size))).toBe(
        "dimensions_mismatch",
      );
    }
  });

  it("carries the routed model's size into knowledge routing", async () => {
    const rows = [
      rawRouteRow("knowledge_extraction", "a"),
      { ...rawRouteRow("knowledge_embedding", "a"), embeddingDimensions: 1024 },
    ];
    const db = { $queryRaw: async () => rows } as unknown as PrismaClient;

    expect((await resolveKnowledgeRouting(db))?.embeddingDimensions).toBe(1024);
  });
});

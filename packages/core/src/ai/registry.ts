import { createPinnedFetch } from "@weaver/config/outboundFetch";
import type { PrismaClient } from "@weaver/db/client";

import type { EncryptionKeyRing } from "../security/encryption";
import { diagnosticFetch } from "../diagnostics/fetch";
import { decryptConnectionCredential } from "../services/llmConnections";
import {
  cachedKnowledgeRouting,
  resolveKnowledgeRouting,
  type KnowledgeRouting,
  type LlmModelSnapshot,
} from "../services/llmRoutes";
import type { ProviderAdapter } from "./adapter";
import { createProviderAdapter } from "./adapters";
import { createEmbeddingPacer } from "./embeddingPacer";
import { PROVIDER_TIMEOUT_MESSAGE } from "./http";
import { AiProviderError, type AiProvider } from "./types";

export type ProviderCredentialSource = {
  resolveCredential(
    connectionId: string,
    expected: Pick<LlmModelSnapshot, "endpoint" | "providerType" | "enabled">,
  ): Promise<string>;
};

export type KnowledgeRoutingSource = {
  resolve(): Promise<KnowledgeRouting | null>;
  resolveFresh(): Promise<KnowledgeRouting | null>;
  providerFor(routing: KnowledgeRouting): AiProvider;
};

export type KnowledgeAiIdentity = {
  providerName: string;
  embeddingConnectionId: string;
  embeddingModel: string;
  embeddingDimensions: number;
  extractionModel: string;
  extractionProviderName: string;
  extractionConnectionId: string;
  configFingerprint: string;
  extractionFingerprint: string;
  inputCostMicrosPerMillion: number | null;
  outputCostMicrosPerMillion: number | null;
  currency: string | null;
  extractionInputCostMicrosPerMillion: number | null;
  extractionOutputCostMicrosPerMillion: number | null;
  extractionCurrency: string | null;
};

export function createDbCredentialSource(
  db: PrismaClient,
  ring: EncryptionKeyRing | null,
): ProviderCredentialSource {
  return {
    resolveCredential: (connectionId, expected) =>
      decryptConnectionCredential(db, ring, connectionId, expected),
  };
}

export function createAdapterForSnapshot(
  snapshot: LlmModelSnapshot,
  credentials: ProviderCredentialSource,
  fetchImpl: typeof fetch = createPinnedFetch(),
): ProviderAdapter {
  return createProviderAdapter(
    snapshot.providerType,
    {
      baseUrl: snapshot.endpoint,
      requestTimeoutMs: snapshot.requestTimeoutMs,
      upstreamProvider: snapshot.upstreamProvider,
      resolveCredential: () =>
        credentials.resolveCredential(snapshot.connectionId, snapshot),
    },
    diagnosticFetch(fetchImpl, {
      connectionId: snapshot.connectionId,
      providerType: snapshot.providerType,
      requestTimeoutMs: snapshot.requestTimeoutMs,
    }),
  );
}

export function createKnowledgeProvider(
  routing: KnowledgeRouting,
  credentials: ProviderCredentialSource,
  fetchImpl: typeof fetch = createPinnedFetch(),
): AiProvider {
  const extraction = createAdapterForSnapshot(
    routing.extraction,
    credentials,
    fetchImpl,
  );
  const embedding =
    routing.embedding.connectionId === routing.extraction.connectionId &&
    routing.embedding.providerType === routing.extraction.providerType &&
    routing.embedding.endpoint === routing.extraction.endpoint &&
    routing.embedding.requestTimeoutMs ===
      routing.extraction.requestTimeoutMs &&
    routing.embedding.upstreamProvider === routing.extraction.upstreamProvider
      ? extraction
      : createAdapterForSnapshot(routing.embedding, credentials, fetchImpl);
  const pacer = createEmbeddingPacer(routing.embedding.requestTimeoutMs);
  return {
    async embed(input, options) {
      const startedAt = Date.now();
      try {
        const result = await embedding.embed(
          routing.embedding.providerModelId,
          input,
          {
            size: routing.embeddingDimensions,
            mode: routing.embedding.embeddingDimensionMode,
          },
          options,
        );
        pacer.recordSuccess(
          input.reduce((total, text) => total + text.length, 0),
          Date.now() - startedAt,
        );
        return result;
      } catch (error) {
        if (
          error instanceof AiProviderError &&
          error.message === PROVIDER_TIMEOUT_MESSAGE
        ) {
          pacer.recordTimeout();
        }
        throw error;
      }
    },
    embeddingCharacterBudget: () => pacer.characterBudget(),
    embeddingRequestByteLength: (input) =>
      embedding.embeddingRequestByteLength(
        routing.embedding.providerModelId,
        input,
        {
          size: routing.embeddingDimensions,
          mode: routing.embedding.embeddingDimensionMode,
        },
      ),
    extract: (input, options) =>
      extraction.extract(routing.extraction.providerModelId, input, {
        ...options,
        reasoning: routing.extraction.reasoningMode,
      }),
  };
}

export function knowledgeAiIdentity(
  routing: KnowledgeRouting,
): KnowledgeAiIdentity {
  return {
    providerName: routing.embedding.providerType,
    embeddingConnectionId: routing.embedding.connectionId,
    embeddingModel: routing.embedding.providerModelId,
    embeddingDimensions: routing.embeddingDimensions,
    extractionModel: routing.extraction.providerModelId,
    extractionProviderName: routing.extraction.providerType,
    extractionConnectionId: routing.extraction.connectionId,
    configFingerprint: routing.configFingerprint,
    extractionFingerprint: routing.extractionFingerprint,
    inputCostMicrosPerMillion: routing.embedding.inputCostMicrosPerMillion,
    outputCostMicrosPerMillion: routing.embedding.outputCostMicrosPerMillion,
    currency: routing.embedding.currency,
    extractionInputCostMicrosPerMillion:
      routing.extraction.inputCostMicrosPerMillion,
    extractionOutputCostMicrosPerMillion:
      routing.extraction.outputCostMicrosPerMillion,
    extractionCurrency: routing.extraction.currency,
  };
}

export function createKnowledgeRoutingSource(
  db: PrismaClient,
  ring: EncryptionKeyRing | null,
  fetchImpl: typeof fetch = createPinnedFetch(),
): KnowledgeRoutingSource {
  const credentials = createDbCredentialSource(db, ring);
  const providers = new Map<string, AiProvider>();
  return {
    resolve: () => cachedKnowledgeRouting(db),
    resolveFresh: () => resolveKnowledgeRouting(db),
    providerFor(routing) {
      // Keyed by the non-secret snapshot; credentials are still resolved per request.
      const key = JSON.stringify([
        routing.extraction.connectionId,
        routing.extraction.endpoint,
        routing.extraction.requestTimeoutMs,
        // Request-affecting but not in the rebuild fingerprint.
        routing.extraction.reasoningMode,
        routing.extraction.upstreamProvider,
        routing.embedding.connectionId,
        routing.embedding.endpoint,
        routing.embedding.requestTimeoutMs,
        routing.embedding.upstreamProvider,
        routing.extraction.providerModelId,
        routing.embedding.providerModelId,
        routing.embedding.embeddingDimensions,
        routing.embedding.embeddingDimensionMode,
        routing.configFingerprint,
        routing.extractionFingerprint,
      ]);
      let provider = providers.get(key);
      if (!provider) {
        provider = createKnowledgeProvider(routing, credentials, fetchImpl);
        providers.clear();
        providers.set(key, provider);
      }
      return provider;
    },
  };
}

export const noKnowledgeRouting: KnowledgeRoutingSource = {
  resolve: async () => null,
  resolveFresh: async () => null,
  providerFor() {
    throw new Error("No knowledge routing is configured");
  },
};

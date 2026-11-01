import type { LlmModelCapability, LlmProviderType } from "@weaver/db/client";

import type {
  AiCallOptions,
  AiUsageSample,
  EmbeddingResult,
  ExtractionRequest,
  ExtractionResult,
  TextCompletionRequest,
  TextCompletionResult,
} from "./types";
import type { EmbeddingDimensionsRequest } from "./embeddingDimensions";

export type ProviderAdapterConfig = {
  baseUrl: string;
  resolveCredential: () => Promise<string>;
  requestTimeoutMs: number;
  upstreamProvider?: string | null;
};

/** Connection tests return at most this many discovered models to the UI. */
export const MAX_DISCOVERED_MODELS = 500;

export type DiscoveredModelSource = "endpoint" | "catalog" | "inferred";

export type DiscoveredModel = {
  providerModelId: string;
  displayName: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  embeddingDimensions: number | null;
  /** Empty means unknown (or not a language model); the import defaults it. */
  capabilities: LlmModelCapability[];
  source: DiscoveredModelSource;
};

export type ModelListing = { models: DiscoveredModel[]; durationMs: number };
export type PingResult = { usage: AiUsageSample };
export type EmbeddingProbeResult = { dimensions: number; usage: AiUsageSample };

export interface ProviderAdapter {
  readonly providerType: LlmProviderType;
  readonly supportsEmbeddings: boolean;
  listModels(options?: AiCallOptions): Promise<ModelListing>;
  ping(model: string, options?: AiCallOptions): Promise<PingResult>;
  completeText(
    model: string,
    input: TextCompletionRequest,
    options?: AiCallOptions,
  ): Promise<TextCompletionResult>;
  embed(
    model: string,
    input: string[],
    dimensions: EmbeddingDimensionsRequest,
    options?: AiCallOptions,
  ): Promise<EmbeddingResult>;
  embeddingRequestByteLength(
    model: string,
    input: string[],
    dimensions: EmbeddingDimensionsRequest,
  ): number;
  probeEmbeddingDimensions(
    model: string,
    options?: AiCallOptions,
  ): Promise<EmbeddingProbeResult>;
  extract(
    model: string,
    input: ExtractionRequest,
    options?: AiCallOptions,
  ): Promise<ExtractionResult>;
}

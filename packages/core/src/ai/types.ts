import type { LlmReasoningMode } from "@weaver/db/client";

import type { ExtractionResponse } from "@weaver/core/knowledge/extraction";

export type AiUsageSample = {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  totalTokens: number | null;
  durationMs: number;
};

export type EmbeddingResult = {
  vectors: number[][];
  usage: AiUsageSample;
};

export type ExtractionRequest = {
  documentId: string;
  chunkId: string;
  title: string;
  headingPath: string[];
  text: string;
};

/** The model's rejected response and the validation issues shown back to it for one corrected answer. */
export type ExtractionCorrection = {
  previousContent: string;
  message: string;
};

/** `correction` reports the first response's rejection when a corrected one was accepted; `usage` then covers both calls. */
export type ExtractionResult = {
  data: ExtractionResponse;
  usage: AiUsageSample;
  correction?: { stage: string; issues: string[] };
};

/** `reasoning` is the routed model's configured effort; adapters translate or omit it per provider. */
export type AiCallOptions = {
  signal?: AbortSignal;
  reasoning?: LlmReasoningMode;
};

export type TextCompletionRequest = {
  system: string;
  prompt: string;
  maxOutputTokens: number;
};

export type TextCompletionResult = {
  text: string;
  usage: AiUsageSample;
};

export interface AiProvider {
  embed(input: string[], options?: AiCallOptions): Promise<EmbeddingResult>;
  embeddingRequestByteLength(input: string[]): number;
  /** Paced providers size each embedding request to their measured throughput. */
  embeddingCharacterBudget?(): number;
  extract(
    input: ExtractionRequest,
    options?: AiCallOptions,
  ): Promise<ExtractionResult>;
}

export type AiProviderErrorKind = "provider" | "validation";

/** Safe metadata about a rejected response: stages, counts, issue paths; never provider text. */
export type AiProviderErrorDetails = Readonly<Record<string, unknown>>;

export type AiProviderErrorOptions = {
  kind: AiProviderErrorKind;
  retryable: boolean;
  usage?: AiUsageSample | null;
  details?: AiProviderErrorDetails | null;
};

export class AiProviderError extends Error {
  readonly kind: AiProviderErrorKind;
  readonly retryable: boolean;
  readonly usage: AiUsageSample | null;
  readonly details: AiProviderErrorDetails | null;

  constructor(message: string, options: AiProviderErrorOptions) {
    super(message);
    this.name = "AiProviderError";
    this.kind = options.kind;
    this.retryable = options.retryable;
    this.usage = options.usage ? { ...options.usage } : null;
    this.details = options.details ? { ...options.details } : null;
  }
}

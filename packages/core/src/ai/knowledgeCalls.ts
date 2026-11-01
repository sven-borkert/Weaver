import {
  AiProviderError,
  type AiProviderErrorDetails,
  type AiUsageSample,
} from "./types";
import { isValidEmbeddingVector } from "./validation";

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancellationError();
}

export function cancellationError(): DOMException {
  return new DOMException("Knowledge enrichment cancelled", "AbortError");
}

export function assertVector(
  vector: number[],
  dimensions: number,
  usage?: AiUsageSample,
): void {
  if (!isValidEmbeddingVector(vector, dimensions)) {
    throw validationError("AI provider returned invalid embeddings", usage);
  }
}

export function validationError(
  message: string,
  usage?: AiUsageSample,
  details?: AiProviderErrorDetails,
): AiProviderError {
  return new AiProviderError(message, {
    kind: "validation",
    retryable: false,
    usage,
    details,
  });
}

export function emptyUsage(durationMs: number): AiUsageSample {
  return {
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    totalTokens: null,
    durationMs,
  };
}

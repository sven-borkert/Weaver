import type { LlmEmbeddingDimensionMode } from "@weaver/db/client";

import { validationError } from "./http";
import { isValidEmbeddingVector } from "./validation";

export type EmbeddingDimensionsRequest = {
  size: number;
  mode: LlmEmbeddingDimensionMode;
};

export function finalizeEmbeddingVector(
  vector: unknown,
  dimensions: EmbeddingDimensionsRequest,
): number[] {
  if (dimensions.mode === "native") {
    if (!isValidEmbeddingVector(vector, dimensions.size)) {
      throw validationError("AI provider returned invalid embeddings");
    }
    return [...vector];
  }

  if (
    !isValidEmbeddingVector(vector, null) ||
    vector.length < dimensions.size
  ) {
    throw validationError("AI provider returned invalid embeddings");
  }
  const retained = vector.slice(0, dimensions.size);
  let squaredNorm = 0;
  for (const component of retained) squaredNorm += component * component;
  const norm = Math.sqrt(squaredNorm);
  if (!Number.isFinite(norm) || norm === 0) {
    throw validationError("AI provider returned invalid embeddings");
  }
  const normalized = retained.map((component) => component / norm);
  if (!isValidEmbeddingVector(normalized, dimensions.size)) {
    throw validationError("AI provider returned invalid embeddings");
  }
  return normalized;
}

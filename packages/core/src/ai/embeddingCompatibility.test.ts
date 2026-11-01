import { describe, expect, it } from "vitest";

import {
  EMBEDDING_COMPATIBILITY_MIN_SIMILARITY,
  EMBEDDING_COMPATIBILITY_SAMPLES,
  compareEmbeddingSamples,
  cosineSimilarity,
} from "./embeddingCompatibility";

function unit(seed: number): number[] {
  const vector = Array.from({ length: 1536 }, (_, i) =>
    Math.sin(seed * 31 + i),
  );
  const norm = Math.hypot(...vector);
  return vector.map((value) => value / norm);
}

describe("embedding compatibility", () => {
  it("ships eight fixed samples and the agreed threshold", () => {
    expect(EMBEDDING_COMPATIBILITY_SAMPLES).toHaveLength(8);
    expect(new Set(EMBEDDING_COMPATIBILITY_SAMPLES).size).toBe(8);
    expect(EMBEDDING_COMPATIBILITY_MIN_SIMILARITY).toBe(0.98);
  });

  it("computes cosine similarity and rejects malformed vectors", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow();
    expect(() => cosineSimilarity([0, 0], [1, 0])).toThrow();
  });

  it("accepts near-identical vectors and rejects when one sample drifts", () => {
    const reference = EMBEDDING_COMPATIBILITY_SAMPLES.map((_, i) => unit(i));
    const quantized = reference.map((vector) =>
      vector.map((value, i) => value + (i % 7 === 0 ? 0.002 : -0.001)),
    );
    const near = compareEmbeddingSamples(quantized, reference);
    expect(near.compatible).toBe(true);
    expect(near.minSimilarity).toBeGreaterThanOrEqual(0.98);

    const drifted = [...quantized];
    drifted[5] = unit(99);
    const far = compareEmbeddingSamples(drifted, reference);
    expect(far.compatible).toBe(false);
    expect(far.minSimilarity).toBeLessThan(0.98);
    expect(far.meanSimilarity).toBeGreaterThan(far.minSimilarity);
  });

  it("rejects a result with the wrong number of vectors", () => {
    const reference = EMBEDDING_COMPATIBILITY_SAMPLES.map((_, i) => unit(i));
    expect(() =>
      compareEmbeddingSamples(reference.slice(1), reference),
    ).toThrow();
  });
});

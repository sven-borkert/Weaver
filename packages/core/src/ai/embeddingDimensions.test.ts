import { describe, expect, it } from "vitest";

import {
  finalizeEmbeddingVector,
  type EmbeddingDimensionsRequest,
} from "./embeddingDimensions";

const native: EmbeddingDimensionsRequest = { size: 3, mode: "native" };
const matryoshka: EmbeddingDimensionsRequest = {
  size: 2,
  mode: "matryoshka",
};

describe("embedding dimension finalization", () => {
  it("keeps an exact native vector unchanged", () => {
    expect(finalizeEmbeddingVector([1, 2, 3], native)).toEqual([1, 2, 3]);
  });

  it("rejects a larger vector in native mode", () => {
    expect(() => finalizeEmbeddingVector([1, 2, 3, 4], native)).toThrow(
      "invalid embeddings",
    );
  });

  it("truncates the leading Matryoshka components and L2-normalizes", () => {
    expect(finalizeEmbeddingVector([3, 4, 99], matryoshka)).toEqual([0.6, 0.8]);
  });

  it("normalizes an exact-target Matryoshka vector", () => {
    expect(finalizeEmbeddingVector([0, 5], matryoshka)).toEqual([0, 1]);
  });

  it.each([
    [[1], matryoshka],
    [[0, 0, 1], matryoshka],
    [[Number.NaN, 1], matryoshka],
    [[Number.POSITIVE_INFINITY, 1], matryoshka],
    [[Number.MAX_VALUE, 1], matryoshka],
  ])("rejects unsafe input %#", (vector, request) => {
    expect(() => finalizeEmbeddingVector(vector, request)).toThrow(
      "invalid embeddings",
    );
  });
});

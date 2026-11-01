import { describe, expect, it } from "vitest";

import {
  INDEXED_EMBEDDING_DIMENSIONS,
  isIndexedKnowledgeDimensions,
  isSupportedKnowledgeDimensions,
} from "./dimensions";

describe("knowledge embedding dimensions", () => {
  it("supports integers from 1 to 4,000", () => {
    expect([1, 1000, 1536, 4000].map(isSupportedKnowledgeDimensions)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(
      [0, 4001, 1.5, Number.NaN, null, undefined].map(
        isSupportedKnowledgeDimensions,
      ),
    ).toEqual([false, false, false, false, false, false]);
  });

  it("indexes the common sizes inside the supported range", () => {
    expect(INDEXED_EMBEDDING_DIMENSIONS).toEqual([
      256, 384, 512, 768, 1024, 1536, 2048, 2560, 3072, 4000,
    ]);
    expect(
      INDEXED_EMBEDDING_DIMENSIONS.every(isSupportedKnowledgeDimensions),
    ).toBe(true);
    expect(isIndexedKnowledgeDimensions(1024)).toBe(true);
    expect(isIndexedKnowledgeDimensions(1000)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { embeddingVectorType } from "./vectorSql";

describe("embeddingVectorType", () => {
  it("uses vector up to 2,000 dimensions and halfvec above", () => {
    expect(embeddingVectorType(1).sql).toBe("vector(1)");
    expect(embeddingVectorType(2000).sql).toBe("vector(2000)");
    expect(embeddingVectorType(2001).sql).toBe("halfvec(2001)");
    expect(embeddingVectorType(4000).sql).toBe("halfvec(4000)");
  });

  it("refuses sizes outside the supported range", () => {
    for (const size of [0, 4001, 1.5, Number.NaN]) {
      expect(() => embeddingVectorType(size)).toThrow(
        "Unsupported knowledge embedding dimensions",
      );
    }
  });
});

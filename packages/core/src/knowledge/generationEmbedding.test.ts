import { describe, expect, it } from "vitest";

import {
  describeGenerationEmbedding,
  generationEmbedding,
} from "./generationEmbedding";

const snapshot = (mode: unknown) => ({
  extraction: { embeddingDimensionMode: "native" },
  embedding: { embeddingDimensionMode: mode },
});

describe("generation embedding summary", () => {
  it("reads the dimension mode from the route snapshot and names the vector column type", () => {
    expect(
      generationEmbedding(
        {
          embeddingModel: "text-embedding-3-large",
          embeddingDimensions: 3072,
          routeSnapshot: snapshot("matryoshka"),
        },
        { includeModel: true },
      ),
    ).toEqual({
      model: "text-embedding-3-large",
      dimensions: 3072,
      dimensionMode: "matryoshka",
      vectorType: "halfvec",
    });
    expect(
      generationEmbedding(
        {
          embeddingModel: "nomic-embed-text",
          embeddingDimensions: 2000,
          routeSnapshot: snapshot("native"),
        },
        { includeModel: true },
      ),
    ).toMatchObject({ dimensionMode: "native", vectorType: "vector" });
  });

  it("withholds the model name unless the caller may see it", () => {
    expect(
      generationEmbedding(
        {
          embeddingModel: "text-embedding-3-large",
          embeddingDimensions: 1536,
          routeSnapshot: snapshot("native"),
        },
        { includeModel: false },
      ).model,
    ).toBeNull();
  });

  it("reports an unknown mode for a missing or malformed snapshot", () => {
    for (const routeSnapshot of [null, [], "native", { embedding: null }]) {
      expect(
        generationEmbedding(
          {
            embeddingModel: "legacy",
            embeddingDimensions: 1536,
            routeSnapshot,
          },
          { includeModel: true },
        ).dimensionMode,
      ).toBeNull();
    }
    expect(
      generationEmbedding(
        {
          embeddingModel: "legacy",
          embeddingDimensions: 1536,
          routeSnapshot: snapshot("sparse"),
        },
        { includeModel: true },
      ).dimensionMode,
    ).toBeNull();
  });

  it("describes the embedding in one line", () => {
    expect(
      describeGenerationEmbedding({
        model: "text-embedding-3-large",
        dimensions: 3072,
        dimensionMode: "matryoshka",
        vectorType: "halfvec",
      }),
    ).toBe("text-embedding-3-large · 3,072 dimensions · Matryoshka · halfvec");
    expect(
      describeGenerationEmbedding({
        model: null,
        dimensions: 1,
        dimensionMode: null,
        vectorType: "vector",
      }),
    ).toBe("1 dimension · vector");
  });
});

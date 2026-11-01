import { describe, expect, it } from "vitest";

import { QueryEmbeddingCache } from "./knowledgeEmbeddings";

describe("QueryEmbeddingCache", () => {
  it("returns a cached vector only for its own size", () => {
    const cache = new QueryEmbeddingCache();
    const vector = Array(1024).fill(0.1) as number[];
    cache.set("query", vector, 1024);

    expect(cache.get("query", 1024)).toHaveLength(1024);
    expect(cache.get("query", 1536)).toBeNull();
  });

  it("refuses to cache a vector of the wrong size", () => {
    const cache = new QueryEmbeddingCache();
    const vector = Array(10).fill(0.1) as number[];
    expect(() => cache.set("query", vector, 1024)).toThrow(
      "AI provider returned invalid embeddings",
    );
  });
});

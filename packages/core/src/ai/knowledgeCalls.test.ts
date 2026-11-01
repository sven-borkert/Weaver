import { describe, expect, it } from "vitest";

import { assertVector } from "./knowledgeCalls";

describe("assertVector", () => {
  it("accepts a vector of the expected size", () => {
    const vector = Array(1024).fill(0.1) as number[];
    expect(() => assertVector(vector, 1024)).not.toThrow();
  });

  it("rejects a vector of another size", () => {
    const vector = Array(1536).fill(0.1) as number[];
    expect(() => assertVector(vector, 1024)).toThrow(
      "AI provider returned invalid embeddings",
    );
  });
});

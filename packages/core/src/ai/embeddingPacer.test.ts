import { describe, expect, it } from "vitest";

import { createEmbeddingPacer } from "./embeddingPacer";

describe("embedding pacer", () => {
  it("allows only a single input until a request has been measured", () => {
    expect(createEmbeddingPacer(120_000).characterBudget()).toBe(0);
  });

  it("fills half the request timeout at the measured character rate", () => {
    const pacer = createEmbeddingPacer(120_000);
    pacer.recordSuccess(9_000, 30_000);

    expect(pacer.characterBudget()).toBe(18_000);
  });

  it("averages successive measurements", () => {
    const pacer = createEmbeddingPacer(60_000);
    pacer.recordSuccess(6_000, 10_000);
    pacer.recordSuccess(2_000, 10_000);

    expect(pacer.characterBudget()).toBe(12_000);
  });

  it("halves the estimate after a timeout", () => {
    const pacer = createEmbeddingPacer(60_000);
    pacer.recordSuccess(6_000, 10_000);
    pacer.recordTimeout();

    expect(pacer.characterBudget()).toBe(9_000);
  });

  it("ignores empty requests and treats instant responses as one millisecond", () => {
    const pacer = createEmbeddingPacer(1_000);
    pacer.recordSuccess(0, 5_000);
    expect(pacer.characterBudget()).toBe(0);

    pacer.recordSuccess(10, 0);
    expect(pacer.characterBudget()).toBe(5_000);
  });
});

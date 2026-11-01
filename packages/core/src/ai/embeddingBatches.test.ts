import { describe, expect, it } from "vitest";
import { makeEmbeddingBatches } from "./embeddingBatches";
import { MAX_AI_PROVIDER_REQUEST_BYTES } from "./http";

const provider = {
  embeddingRequestByteLength: (input: string[]) =>
    Buffer.byteLength(JSON.stringify({ model: "model-界", input }), "utf8"),
};

describe("embedding byte batches", () => {
  it.each(["界", '\\"\n', "😀"])(
    "includes JSON escaping and UTF-8 bytes for %j",
    (text) => {
      const items = Array.from({ length: 32 }, () => text.repeat(4000));
      const batches = [
        ...makeEmbeddingBatches(items, provider, (item) => item),
      ];
      expect(batches.length).toBeGreaterThan(1);
      expect(batches.flat()).toEqual(items);
      expect(
        batches.every(
          (batch) =>
            provider.embeddingRequestByteLength(batch) <=
            MAX_AI_PROVIDER_REQUEST_BYTES,
        ),
      ).toBe(true);
    },
  );
  it("caps item count and rejects an individually oversized request", () => {
    expect(
      [
        ...makeEmbeddingBatches(
          Array.from({ length: 33 }, () => "a"),
          provider,
          (item) => item,
        ),
      ].map((batch) => batch.length),
    ).toEqual([32, 1]);
    expect(() => [
      ...makeEmbeddingBatches(["界".repeat(50000)], provider, (item) => item),
    ]).toThrow("Embedding input exceeds batch limits");
  });

  it("rejects an oversized input before any batch can be requested", () => {
    expect(() =>
      makeEmbeddingBatches(["a", "界".repeat(50000)], provider, (item) => item),
    ).toThrow("Embedding input exceeds batch limits");
  });
});

describe("paced embedding batches", () => {
  const items = ["aaaaa", "bbbbb", "ccccc", "ddddd", "eeeee", "fffff"];

  it("reads the character budget again before every batch", () => {
    let budget = 0;
    const paced = { ...provider, embeddingCharacterBudget: () => budget };
    const sizes: number[] = [];

    for (const batch of makeEmbeddingBatches(items, paced, (item) => item)) {
      sizes.push(batch.length);
      budget = 10;
    }

    expect(sizes).toEqual([1, 2, 2, 1]);
  });

  it("still sends one input that exceeds the budget on its own", () => {
    const paced = { ...provider, embeddingCharacterBudget: () => 3 };

    expect(
      [...makeEmbeddingBatches(items, paced, (item) => item)].map(
        (batch) => batch.length,
      ),
    ).toEqual([1, 1, 1, 1, 1, 1]);
  });
});

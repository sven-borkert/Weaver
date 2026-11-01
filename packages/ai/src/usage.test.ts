import { describe, expect, it } from "vitest";
import { accumulateUsage, usageFromSdk, usageFromError } from "./usage";

describe("usageFromSdk", () => {
  it("reads flat and nested token shapes", () => {
    expect(
      usageFromSdk(
        { inputTokens: 5, outputTokens: 7, cachedInputTokens: 2 },
        10,
      ),
    ).toEqual({
      inputTokens: 5,
      outputTokens: 7,
      cachedTokens: 2,
      totalTokens: 12,
      durationMs: 10,
    });
    expect(
      usageFromSdk(
        { inputTokens: { total: 5, cacheRead: 1 }, outputTokens: { total: 7 } },
        10,
      ),
    ).toEqual({
      inputTokens: 5,
      outputTokens: 7,
      cachedTokens: 1,
      totalTokens: 12,
      durationMs: 10,
    });
    expect(usageFromSdk(undefined, 3)).toEqual({
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      totalTokens: null,
      durationMs: 3,
    });
  });

  it("reports unknown cached tokens when the provider sends no cache information", () => {
    // A flat inputTokens must never be mistaken for its own cacheRead sub-count.
    expect(usageFromSdk({ inputTokens: 5, outputTokens: 7 }, 1)).toEqual({
      inputTokens: 5,
      outputTokens: 7,
      cachedTokens: null,
      totalTokens: 12,
      durationMs: 1,
    });
  });

  it("reads the ai@7 LanguageModelUsage shape, including cached reads", () => {
    expect(
      usageFromSdk(
        {
          inputTokens: 10,
          inputTokenDetails: {
            noCacheTokens: 8,
            cacheReadTokens: 2,
            cacheWriteTokens: 0,
          },
          outputTokens: 4,
          outputTokenDetails: { textTokens: 4, reasoningTokens: 0 },
          totalTokens: 14,
        },
        5,
      ),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      cachedTokens: 2,
      totalTokens: 14,
      durationMs: 5,
    });
  });

  it("treats counts Postgres cannot store as unknown rather than failing the run at persist time", () => {
    // Core's assertPersistableUsage throws RangeError on floats, negatives, and > int4 max.
    expect(usageFromSdk({ inputTokens: 5.5, outputTokens: -1 }, 1)).toEqual({
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      totalTokens: null,
      durationMs: 1,
    });
    expect(
      usageFromSdk({ inputTokens: 3, outputTokens: 4, totalTokens: 7.5 }, 1),
    ).toEqual({
      inputTokens: 3,
      outputTokens: 4,
      cachedTokens: null,
      totalTokens: 7,
      durationMs: 1,
    });
    expect(usageFromSdk({ inputTokens: 2_147_483_648 }, 1).inputTokens).toBe(
      null,
    );
    // The derived total is checked too: two storable counts can still sum past int4.
    expect(
      usageFromSdk(
        { inputTokens: 2_147_483_647, outputTokens: 2_147_483_647 },
        1,
      ).totalTokens,
    ).toBe(null);
  });

  it("treats missing, undefined, and non-finite counts as unknown rather than zero", () => {
    expect(
      usageFromSdk(
        {
          inputTokens: undefined,
          outputTokens: Number.NaN,
          totalTokens: "12",
          inputTokenDetails: { cacheReadTokens: undefined },
        },
        1,
      ),
    ).toEqual({
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      totalTokens: null,
      durationMs: 1,
    });
    expect(usageFromSdk("nonsense", 2)).toEqual({
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      totalTokens: null,
      durationMs: 2,
    });
  });
});

it("accumulates completed step usage without inventing missing counts", () => {
  const first = usageFromSdk({ inputTokens: 10, outputTokens: 5 }, 1);
  expect(
    accumulateUsage(
      first,
      usageFromSdk({ inputTokens: 20, outputTokens: 4 }, 2),
    ),
  ).toMatchObject({
    inputTokens: 30,
    outputTokens: 9,
    totalTokens: 39,
    cachedTokens: null,
  });
});

it("preserves known consumption when the failing step has no usage", () => {
  expect(
    accumulateUsage(
      usageFromSdk({ inputTokens: 10, outputTokens: 5 }, 1),
      usageFromSdk({}, 2),
    ),
  ).toMatchObject({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
});

it("retains usage exposed on a failed SDK call or its cause", () => {
  const error = Object.assign(new Error("provider failed"), {
    usage: { inputTokens: 13, outputTokens: 7 },
  });
  expect(usageFromError(error, 3)).toMatchObject({
    inputTokens: 13,
    outputTokens: 7,
    totalTokens: 20,
  });
  expect(
    usageFromError(new Error("wrapped", { cause: error }), 3),
  ).toMatchObject({ totalTokens: 20 });
  expect(usageFromError(new Error("no usage"), 3)).toBeNull();
});

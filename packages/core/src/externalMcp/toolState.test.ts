import { describe, expect, it } from "vitest";
import { externalToolState, suggestedToolEffect } from "./toolState";

const base = {
  presentInCatalog: true,
  reviewedRemoteDigest: null as string | null,
  discoveredRemoteDigest: "a",
  discoveredDefinition: { supportStatus: { available: true } } as unknown,
};

describe("externalToolState", () => {
  it("classifies every catalog state", () => {
    expect(externalToolState(base)).toBe("new");
    expect(externalToolState({ ...base, reviewedRemoteDigest: "a" })).toBe(
      "reviewed",
    );
    expect(externalToolState({ ...base, reviewedRemoteDigest: "b" })).toBe(
      "changed",
    );
    expect(externalToolState({ ...base, presentInCatalog: false })).toBe(
      "unavailable",
    );
    expect(
      externalToolState({
        ...base,
        discoveredDefinition: { supportStatus: { available: false } },
      }),
    ).toBe("unsupported");
  });
});

describe("suggestedToolEffect", () => {
  it("suggests read only for a literal true readOnlyHint", () => {
    expect(suggestedToolEffect({ annotations: { readOnlyHint: true } })).toBe(
      "read",
    );
    for (const definition of [
      { annotations: { readOnlyHint: "true" } },
      { annotations: { readOnlyHint: 1 } },
      { annotations: { readOnlyHint: false } },
      { annotations: {} },
      {},
      null,
      "read",
    ])
      expect(suggestedToolEffect(definition)).toBe("write");
  });
});

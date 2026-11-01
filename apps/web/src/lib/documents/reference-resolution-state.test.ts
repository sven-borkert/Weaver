import { describe, expect, it } from "vitest";

import { referenceResolutionState } from "./reference-resolution-state";

describe("referenceResolutionState", () => {
  it("keeps cached resolved targets and reports that they may be stale", () => {
    const cached = [{ id: "target", exists: true as const, title: "Target" }];

    expect(referenceResolutionState(cached, new Error("offline"))).toEqual({
      targets: cached,
      warning: "References could not be refreshed. Showing cached results.",
    });
  });

  it("reports an unavailable resolution when there are no cached targets", () => {
    expect(referenceResolutionState(undefined, new Error("offline"))).toEqual({
      targets: undefined,
      warning:
        "References could not be resolved. Stored labels are shown instead.",
    });
  });

  it("has no warning when resolution succeeds", () => {
    expect(referenceResolutionState([], null)).toEqual({
      targets: [],
      warning: null,
    });
  });
});

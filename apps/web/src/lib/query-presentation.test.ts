import { describe, expect, it } from "vitest";

import { resolveQueryPresentation } from "./query-presentation";

describe("resolveQueryPresentation", () => {
  it("keeps rendering usable cached data after a refetch error", () => {
    expect(
      resolveQueryPresentation({
        data: { id: "cached" },
        error: new Error("refetch failed"),
        isLoading: false,
      }),
    ).toBe("data");
  });

  it("keeps rendering usable cached data while a refetch is pending", () => {
    expect(
      resolveQueryPresentation({
        data: { id: "cached" },
        error: null,
        isLoading: true,
      }),
    ).toBe("data");
  });

  it("renders an initial error when no cached data exists", () => {
    expect(
      resolveQueryPresentation({
        data: undefined,
        error: new Error("initial load failed"),
        isLoading: false,
      }),
    ).toBe("error");
  });

  it("renders initial loading and empty states without data", () => {
    expect(
      resolveQueryPresentation({
        data: undefined,
        error: null,
        isLoading: true,
      }),
    ).toBe("loading");
    expect(
      resolveQueryPresentation({
        data: undefined,
        error: null,
        isLoading: false,
      }),
    ).toBe("empty");
  });
});

it.each(["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"])(
  "hides cached data after %s",
  (code) => {
    expect(
      resolveQueryPresentation({
        data: { secret: "private" },
        error: { data: { code } },
        isLoading: false,
      }),
    ).toBe("error");
  },
);

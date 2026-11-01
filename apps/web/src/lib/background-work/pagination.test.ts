import { describe, expect, it } from "vitest";

import { changeWorkFilters } from "./pagination";

describe("background work pagination", () => {
  it("clears continuation cursors when filters change", () => {
    expect(
      changeWorkFilters(
        { audience: "mine", view: "all", cursors: [null, "next"], page: 1 },
        { audience: "projects" },
      ),
    ).toEqual({
      audience: "projects",
      view: "all",
      cursors: [null],
      page: 0,
    });
  });
});

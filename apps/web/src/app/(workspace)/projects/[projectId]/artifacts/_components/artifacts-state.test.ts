import { describe, expect, it } from "vitest";

import {
  artifactsListBody,
  clampPage,
  pageAfterDelete,
} from "./artifacts-state";

describe("artifactsListBody", () => {
  it("prefers loading and hides the list on an access error", () => {
    expect(artifactsListBody("loading", false, 0)).toBe("loading");
    expect(artifactsListBody("error", true, 3)).toBe("hidden");
  });

  it("separates an empty search result from an empty project", () => {
    expect(artifactsListBody("data", true, 0)).toBe("no-matches");
    expect(artifactsListBody("empty", false, 0)).toBe("table");
    expect(artifactsListBody("data", true, 1)).toBe("table");
  });
});

describe("pageAfterDelete", () => {
  it("steps back when the last row of a later page goes", () => {
    expect(pageAfterDelete(2, 1)).toBe(1);
    expect(pageAfterDelete(3, 0)).toBe(2);
  });

  it("stays on the page while other rows remain, and never below page 1", () => {
    expect(pageAfterDelete(2, 2)).toBe(2);
    expect(pageAfterDelete(1, 1)).toBe(1);
  });
});

describe("clampPage", () => {
  it("snaps a page beyond the last one back to the last page", () => {
    expect(clampPage(3, 1)).toBe(1);
    expect(clampPage(5, 2)).toBe(2);
  });

  it("leaves a page inside the range and treats an empty list as one page", () => {
    expect(clampPage(2, 4)).toBe(2);
    expect(clampPage(1, 0)).toBe(1);
  });
});

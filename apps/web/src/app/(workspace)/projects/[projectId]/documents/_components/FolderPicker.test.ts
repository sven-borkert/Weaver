import { describe, expect, it } from "vitest";

import { decodeFolderValue } from "./FolderPicker";

describe("decodeFolderValue", () => {
  it("maps the root select value to a canonical empty path", () => {
    expect(decodeFolderValue("/")).toEqual([]);
  });

  it("drops empty segments from a folder select value", () => {
    expect(decodeFolderValue("guides//release-notes/")).toEqual([
      "guides",
      "release-notes",
    ]);
  });
});

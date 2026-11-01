import { describe, expect, it } from "vitest";
import {
  MAX_FOLDER_DEPTH,
  PathError,
  assertSafeSegments,
  docPath,
  folderPathOfDocPath,
} from "./paths";

describe("assertSafeSegments", () => {
  it("accepts valid slug segments", () => {
    expect(() => assertSafeSegments(["guides", "how-to-2"])).not.toThrow();
  });
  it("rejects traversal, .git, bad chars, and empty segments", () => {
    for (const bad of [[".."], [".git"], ["Foo Bar"], ["a/b"], [""], ["-x"]]) {
      expect(() => assertSafeSegments(bad)).toThrow(PathError);
    }
  });
  it("rejects depth beyond MAX_FOLDER_DEPTH", () => {
    const deep = Array.from(
      { length: MAX_FOLDER_DEPTH + 1 },
      (_, i) => `d${i}`,
    );
    expect(() => assertSafeSegments(deep)).toThrow(PathError);
  });
});

describe("docPath / folderPathOfDocPath", () => {
  it("round-trips", () => {
    const p = docPath(["guides", "setup"], "getting-started", "markdown");
    expect(p).toBe("guides/setup/getting-started.md");
    expect(folderPathOfDocPath(p)).toEqual(["guides", "setup"]);
  });
  it("builds python paths", () => {
    expect(docPath(["scripts"], "deploy-prod", "python")).toBe(
      "scripts/deploy-prod.py",
    );
  });
  it("root documents have an empty folder path", () => {
    expect(docPath([], "readme", "markdown")).toBe("readme.md");
    expect(folderPathOfDocPath("readme.md")).toEqual([]);
  });
  it("rejects unsafe document slugs", () => {
    for (const bad of ["../outside", "a/b", ".git", "Foo Bar", "", "-x"]) {
      expect(() => docPath([], bad, "markdown")).toThrow(PathError);
    }
  });
});

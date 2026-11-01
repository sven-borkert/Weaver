import { describe, expect, it } from "vitest";
import { iconAssetPath, isIconAssetPath } from "./icons";
import { assertAppearancePatch } from "./metadata";

describe("appearance icons", () => {
  it("maps_valid_image_icons_to_the_reserved_root", () => {
    const digest = "a".repeat(64);
    for (const extension of ["png", "jpg", "webp"] as const) {
      expect(iconAssetPath({ type: "image", digest, extension })).toBe(
        `.weaver-icons/${digest}.${extension}`,
      );
      expect(isIconAssetPath(`.weaver-icons/${digest}.${extension}`)).toBe(
        true,
      );
    }
  });
  it("rejects_paths_outside_the_canonical_asset_shape", () => {
    for (const path of [
      ".weaver-icons/../a.png",
      `.weaver-icons/${"a".repeat(63)}.png`,
      `.weaver-icons/${"A".repeat(64)}.png`,
      `.weaver-icons/${"a".repeat(64)}.jpeg`,
      `.weaver-icons/${"a".repeat(64)}.gif`,
      `x/.weaver-icons/${"a".repeat(64)}.png`,
      `/.weaver-icons/${"a".repeat(64)}.png`,
      `.weaver-icons/${"a".repeat(64)}.png\n`,
    ]) {
      expect(isIconAssetPath(path)).toBe(false);
    }
    expect(() =>
      iconAssetPath({ type: "image", digest: "../x", extension: "png" }),
    ).toThrow();
  });
  it("accepts_the_shared_builtin_names_and_rejects_unknown_names", () => {
    for (const name of [
      "folder",
      "file-text",
      "table",
      "book-open",
      "briefcase",
      "calendar",
      "check-circle",
      "code",
      "database",
      "file",
      "heart",
      "lightbulb",
      "star",
      "tag",
    ]) {
      expect(
        assertAppearancePatch({ icon: { type: "builtin", name } }),
      ).toEqual({ icon: { type: "builtin", name } });
    }
    expect(() =>
      assertAppearancePatch({ icon: { type: "builtin", name: "arbitrary" } }),
    ).toThrow();
  });
});

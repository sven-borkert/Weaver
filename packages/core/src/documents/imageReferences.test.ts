import { describe, expect, it } from "vitest";
import { parseDocumentBody } from "../editor/markdown";
import {
  collectImageReferences,
  imageReference,
  markdownImage,
  parseImageReference,
  replaceImageReferences,
} from "./imageReferences";

const FILE = "11111111-1111-4111-8111-111111111111";
const ASSET = "a".repeat(64);

describe("image references", () => {
  it("round-trips file and notebook image references", () => {
    expect(parseImageReference(imageReference(FILE))).toEqual({
      artifactId: FILE,
      assetId: null,
    });
    expect(parseImageReference(imageReference(FILE, ASSET))).toEqual({
      artifactId: FILE,
      assetId: ASSET,
    });
    expect(parseImageReference("screenshots/one.png")).toBeNull();
  });

  it("rejects malformed references", () => {
    for (const bad of [
      "weaver-image:not-a-uuid",
      `weaver-image:${FILE}/short`,
      "weaver-image:AAAAAAAA-1111-4111-8111-111111111111",
      `weaver-image:${FILE}/${ASSET}/extra`,
    ])
      expect(() => parseImageReference(bad)).toThrow("malformed");
  });

  it("writes alt text that cannot close the brackets", () => {
    expect(markdownImage("Step [1]\nand \\ more", "x")).toBe(
      "![Step \\[1\\] and \\\\ more](x)",
    );
    expect(markdownImage("", "x")).toBe("![Image](x)");
  });

  it("survives Markdown parsing and is replaced once per source", () => {
    const src = imageReference(FILE, ASSET);
    const json = parseDocumentBody(
      `${markdownImage("One", src)}\n\nText\n\n${markdownImage("Again", src)}\n\n![Other](other.assets/x.png)\n`,
    );
    expect(collectImageReferences(json)).toEqual([src]);
    const replaced = replaceImageReferences(
      json,
      new Map([[src, "doc.assets/image.png"]]),
    );
    expect(collectImageReferences(replaced)).toEqual([]);
    expect(JSON.stringify(replaced)).toContain("doc.assets/image.png");
    expect(JSON.stringify(replaced)).toContain("other.assets/x.png");
  });
});

import { describe, expect, it } from "vitest";
import {
  allocateImageFileName,
  assetsDirForDocPath,
  assetsPrefixForSlug,
  classifyImageSrc,
  collectImageSources,
  hasAssetsSegment,
  imageBasename,
  imageExtension,
  isAssetsSegment,
  mapImageSources,
  resolveRelativeImagePath,
  rewriteOwnAssetsPrefix,
  sniffImageType,
} from "./images";

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0,
]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF = new TextEncoder().encode("GIF89a\0\0");
const WEBP = new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ");
const SVG = new TextEncoder().encode("<svg xmlns=");

describe("sniffImageType", () => {
  it("detects the four allowed types and nothing else", () => {
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(GIF)).toBe("image/gif");
    expect(sniffImageType(WEBP)).toBe("image/webp");
    expect(sniffImageType(SVG)).toBeNull();
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
  });

  it("maps types to extensions", () => {
    expect(imageExtension("image/jpeg")).toBe("jpg");
    expect(imageExtension("image/png")).toBe("png");
  });
});

describe("assets paths", () => {
  it("recognizes assets segments only with a nonempty stem", () => {
    expect(isAssetsSegment("guide.assets")).toBe(true);
    expect(isAssetsSegment(".assets")).toBe(false);
    expect(isAssetsSegment("guide")).toBe(false);
    expect(hasAssetsSegment("docs/guide.assets/a.png")).toBe(true);
    expect(hasAssetsSegment("docs/guide.md")).toBe(false);
  });

  it("derives the assets directory for every document kind", () => {
    expect(assetsDirForDocPath("a/b.md")).toBe("a/b.assets");
    expect(assetsDirForDocPath("a/b.py")).toBe("a/b.assets");
    expect(() => assetsDirForDocPath("a/b.txt")).toThrow("not a document path");
  });

  it("derives the assets directory and prefix", () => {
    expect(assetsDirForDocPath("docs/guide.md")).toBe("docs/guide.assets");
    expect(assetsDirForDocPath("guide.md")).toBe("guide.assets");
    expect(() => assetsDirForDocPath("docs/guide")).toThrow();
    expect(assetsPrefixForSlug("guide")).toBe("guide.assets/");
  });
});

describe("imageBasename", () => {
  it("lowercases, collapses runs, strips the extension and edges", () => {
    expect(imageBasename("Screen Shot 2026-09-11.PNG")).toBe(
      "screen-shot-2026-09-11",
    );
    expect(imageBasename("Übersicht__final.jpeg")).toBe("ubersicht-final");
    expect(imageBasename("--.png")).toMatch(/^image-\d{8}-\d{6}$/);
  });

  it("truncates to 80 characters without a trailing dash", () => {
    const long = `${"a".repeat(79)}-b.png`;
    expect(imageBasename(long)).toBe("a".repeat(79));
  });

  it("uses a UTC timestamp for nameless input", () => {
    expect(imageBasename(null, new Date("2026-09-11T14:30:12Z"))).toBe(
      "image-20260911-143012",
    );
    expect(imageBasename("", new Date("2026-09-11T14:30:12Z"))).toBe(
      "image-20260911-143012",
    );
  });
});

describe("allocateImageFileName", () => {
  it("appends numeric suffixes on collision and keeps 80 characters", () => {
    const taken = new Set(["shot.png", "shot-2.png"]);
    expect(allocateImageFileName("shot", "png", taken)).toBe("shot-3.png");
    expect(allocateImageFileName("shot", "png", new Set())).toBe("shot.png");
    const long = "a".repeat(80);
    expect(allocateImageFileName(long, "png", new Set([`${long}.png`]))).toBe(
      `${"a".repeat(78)}-2.png`,
    );
  });
});

describe("classifyImageSrc", () => {
  it("accepts http(s) and safe relative paths", () => {
    expect(classifyImageSrc("https://example.com/a.png")).toBe("absolute");
    expect(classifyImageSrc("http://example.com/a.png")).toBe("absolute");
    expect(classifyImageSrc("guide.assets/a.png")).toBe("relative");
    expect(classifyImageSrc("./guide.assets/a.png")).toBe("relative");
    expect(classifyImageSrc("../shared/a.png")).toBe("relative");
    expect(classifyImageSrc("Screenshot 1.png")).toBe("relative");
  });

  it("rejects other schemes, absolute paths, and unsafe segments", () => {
    for (const src of [
      "",
      "data:image/png;base64,AAAA",
      "javascript:alert(1)",
      "blob:https://x/y",
      "//cdn.example.com/a.png",
      "/etc/passwd",
      "a\\b.png",
      "a//b.png",
      "a/\tb.png",
      "guide.assets/",
      "x".repeat(2_049),
      `${"s".repeat(256)}.png`,
      42,
      null,
    ]) {
      expect(classifyImageSrc(src)).toBeNull();
    }
  });
});

describe("resolveRelativeImagePath", () => {
  it("resolves against the document directory and skips dots", () => {
    expect(
      resolveRelativeImagePath("docs/guide.md", "guide.assets/a.png"),
    ).toBe("docs/guide.assets/a.png");
    expect(resolveRelativeImagePath("docs/guide.md", "./a.png")).toBe(
      "docs/a.png",
    );
    expect(
      resolveRelativeImagePath("docs/sub/guide.md", "../shared/a.png"),
    ).toBe("docs/shared/a.png");
    expect(resolveRelativeImagePath("guide.md", "a.png")).toBe("a.png");
  });

  it("returns null when the path escapes the root or is not relative", () => {
    expect(resolveRelativeImagePath("guide.md", "../a.png")).toBeNull();
    expect(resolveRelativeImagePath("docs/guide.md", "../../a.png")).toBeNull();
    expect(
      resolveRelativeImagePath("docs/guide.md", "https://example.com/a.png"),
    ).toBeNull();
  });
});

describe("collectImageSources and rewriteOwnAssetsPrefix", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "image", attrs: { src: "old.assets/a.png", alt: "a" } },
      {
        type: "blockquote",
        content: [
          { type: "image", attrs: { src: "old.assets/b.png", alt: "b" } },
          { type: "image", attrs: { src: "other.assets/c.png", alt: "c" } },
          { type: "image", attrs: { src: "https://x/d.png", alt: "d" } },
        ],
      },
    ],
  };

  it("collects every image src in document order", () => {
    expect(collectImageSources(doc)).toEqual([
      "old.assets/a.png",
      "old.assets/b.png",
      "other.assets/c.png",
      "https://x/d.png",
    ]);
  });

  it("rewrites only the old own prefix and leaves the input untouched", () => {
    const out = rewriteOwnAssetsPrefix(doc, "old", "new");
    expect(collectImageSources(out)).toEqual([
      "new.assets/a.png",
      "new.assets/b.png",
      "other.assets/c.png",
      "https://x/d.png",
    ]);
    expect(collectImageSources(doc)[0]).toBe("old.assets/a.png");
    expect(rewriteOwnAssetsPrefix(doc, "old", "old")).toBe(doc);
  });
});

describe("mapImageSources", () => {
  it("maps every image source and leaves other nodes alone", () => {
    const json = {
      type: "doc",
      content: [
        { type: "image", attrs: { src: "a.assets/one.png", alt: "One" } },
        {
          type: "callout",
          content: [{ type: "image", attrs: { src: "https://x.test/y.png" } }],
        },
        { type: "paragraph", content: [{ type: "text", text: "a.assets/" }] },
      ],
    };

    const mapped = mapImageSources(json, (src) =>
      src.startsWith("a.assets/") ? `b.assets/${src.slice(9)}` : src,
    );

    expect(mapped.content![0]!.attrs).toEqual({
      src: "b.assets/one.png",
      alt: "One",
    });
    expect(mapped.content![1]!.content![0]!.attrs!.src).toBe(
      "https://x.test/y.png",
    );
    expect(mapped.content![2]).toEqual(json.content[2]);
    expect(json.content[0]!.attrs!.src).toBe("a.assets/one.png");
  });
});

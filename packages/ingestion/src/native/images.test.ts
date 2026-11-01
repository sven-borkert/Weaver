import { createCanvas, loadImage } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { pngFixture } from "../fixtures";
import { normalizeImageForOcr } from "./images";

describe("normalizeImageForOcr", () => {
  it("re-encodes small images as PNG at their size", async () => {
    const png = await normalizeImageForOcr(pngFixture(16, 8));
    expect(png).not.toBeNull();
    const image = await loadImage(Buffer.from(png!));
    expect([image.width, image.height]).toEqual([16, 8]);
  });

  it("scales the long edge down to 2048 px", async () => {
    const png = await normalizeImageForOcr(pngFixture(4096, 1024));
    const image = await loadImage(Buffer.from(png!));
    expect([image.width, image.height]).toEqual([2048, 512]);
  });

  it.each(["jpeg", "webp"] as const)(
    "reads %s headers before decoding",
    async (format) => {
      const canvas = createCanvas(16, 8);
      const png = await normalizeImageForOcr(await canvas.encode(format));
      expect(png).not.toBeNull();
      const image = await loadImage(Buffer.from(png!));
      expect([image.width, image.height]).toEqual([16, 8]);
    },
  );

  it("returns null for undecodable bytes", async () => {
    expect(await normalizeImageForOcr(Buffer.from("not an image"))).toBeNull();
  });
});

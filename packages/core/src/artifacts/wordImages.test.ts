import { createHash } from "node:crypto";
import {
  buildDocx,
  PNG_SIGNATURE,
} from "@weaver/artifact-readers/testing/docxFixture";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { findWordImages } from "./wordImages";

const png = (label: string) =>
  Buffer.concat([PNG_SIGNATURE, Buffer.from(label)]);
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const wanted = (...images: Uint8Array[]) => new Set(images.map(sha));

/** A docx whose media parts are written in the given order, stored or deflated. */
async function docxWithMedia(
  parts: Array<[name: string, bytes: Uint8Array]>,
  compression: "STORE" | "DEFLATE" = "DEFLATE",
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await buildDocx());
  for (const [name, bytes] of parts) zip.file(`word/media/${name}`, bytes);
  return zip.generateAsync({ type: "nodebuffer", compression });
}

describe("findWordImages", () => {
  it("keeps only the requested pictures", async () => {
    const first = png("first");
    const second = png("second");
    const docx = await docxWithMedia([
      ["image1.png", first],
      ["image2.png", second],
    ]);
    const found = findWordImages(docx, wanted(second), 1024);
    expect([...found.images.keys()]).toEqual([sha(second)]);
    expect(Buffer.from(found.images.get(sha(second))!)).toEqual(second);
    expect(found.complete).toBe(true);
    expect(found.oversized).toBe(0);
  });

  it("returns copies, never views into the Word file", async () => {
    const picture = png("stored picture");
    // Buffer.alloc gives the file its own ArrayBuffer, as a blob read does.
    const built = await docxWithMedia([["image1.png", picture]], "STORE");
    const docx = Buffer.alloc(built.byteLength);
    built.copy(docx);
    expect(docx.includes(picture)).toBe(true);
    const bytes = findWordImages(docx, wanted(picture), 1024).images.get(
      sha(picture),
    )!;
    expect(bytes.buffer).not.toBe(docx.buffer);
    docx.fill(0);
    expect(Buffer.from(bytes)).toEqual(picture);
  });

  it("finds nothing for an unknown hash, a part outside word/media and a non-archive", async () => {
    const hidden = png("hidden");
    const docx = await buildDocx({
      extraParts: {
        "word/embeddings/image.png": hidden,
        "word/media/nested/image.png": hidden,
      },
    });
    expect(findWordImages(docx, new Set(["0".repeat(64)]), 1024)).toEqual({
      images: new Map(),
      complete: true,
      oversized: 0,
    });
    expect(findWordImages(docx, wanted(hidden), 1024).images.size).toBe(0);
    expect(
      findWordImages(Buffer.from("plain text"), wanted(hidden), 1024),
    ).toEqual({ images: new Map(), complete: true, oversized: 0 });
  });

  it("counts media parts over the image size limit and still finds later ones", async () => {
    const big = png("x".repeat(4096));
    const later = png("later");
    const docx = await docxWithMedia(
      [
        ["a.png", big],
        ["b.png", big],
        ["z.png", later],
      ],
      "STORE",
    );
    const found = findWordImages(docx, wanted(big, later), 1024);
    expect([...found.images.keys()]).toEqual([sha(later)]);
    expect(found.oversized).toBe(2);
    expect(found.complete).toBe(true);
  });

  it("reports a scan cut short by the inflate budget", async () => {
    const filler = Array.from(
      { length: 4 },
      (_, index): [string, Uint8Array] => [
        `a${index}.png`,
        png(`${index}`.repeat(300)),
      ],
    );
    const later = png("later");
    const docx = await docxWithMedia([...filler, ["z.png", later]]);
    const limits = { maxEntries: 500, maxInflatedBytes: 1000 };
    const cut = findWordImages(docx, wanted(later), 1024, limits);
    expect(cut.images.size).toBe(0);
    expect(cut.complete).toBe(false);
    const whole = findWordImages(docx, wanted(later), 1024, {
      ...limits,
      maxInflatedBytes: 4096,
    });
    expect(whole.images.has(sha(later))).toBe(true);
    expect(whole.complete).toBe(true);
  });

  it("charges the per-image limit for a part that inflates past it", async () => {
    const later = png("later");
    const docx = await docxWithMedia([
      ["a.png", Buffer.alloc(50_000)],
      ["z.png", later],
    ]);
    // The central directory understates the size, so only inflating finds out.
    const record = docx.lastIndexOf("word/media/a.png") - 46;
    expect(docx.readUInt32LE(record + 24)).toBe(50_000);
    docx.writeUInt32LE(10, record + 24);
    const tight = { maxEntries: 500, maxInflatedBytes: 1024 };
    const cut = findWordImages(docx, wanted(later), 1024, tight);
    expect(cut).toMatchObject({ complete: false, oversized: 1 });
    expect(cut.images.size).toBe(0);
    const roomy = findWordImages(docx, wanted(later), 1024, {
      ...tight,
      maxInflatedBytes: 2048,
    });
    expect(roomy).toMatchObject({ complete: true, oversized: 1 });
    expect(roomy.images.has(sha(later))).toBe(true);
  });

  it("reports a scan cut short by the entry limit", async () => {
    const later = png("later");
    const docx = await docxWithMedia([
      ["a.png", png("a")],
      ["b.png", png("b")],
      ["z.png", later],
    ]);
    const limits = { maxEntries: 2, maxInflatedBytes: 1 << 20 };
    const cut = findWordImages(docx, wanted(later), 1024, limits);
    expect(cut.images.size).toBe(0);
    expect(cut.complete).toBe(false);
    expect(
      findWordImages(docx, wanted(later), 1024, { ...limits, maxEntries: 3 })
        .complete,
    ).toBe(true);
  });

  it("stops reading once every requested picture is found", async () => {
    const first = png("first");
    const docx = await docxWithMedia(
      [
        ["a.png", first],
        ["b.png", png("y".repeat(4096))],
      ],
      "STORE",
    );
    const found = findWordImages(docx, wanted(first), 1024);
    expect(found.images.has(sha(first))).toBe(true);
    expect(found.oversized).toBe(0);
    expect(found.complete).toBe(true);
  });
});

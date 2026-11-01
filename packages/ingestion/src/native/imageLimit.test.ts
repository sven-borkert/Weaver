import { describe, expect, it, vi } from "vitest";
const loadImage = vi
  .fn()
  .mockRejectedValue(new Error("decoder refused fixture"));
vi.mock("@napi-rs/canvas", () => ({ loadImage, createCanvas: vi.fn() }));

describe("image decode limits", () => {
  it("refuses oversized dimensions before the native decoder allocates", async () => {
    const bytes = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    bytes.write("IHDR", 12);
    bytes.writeUInt32BE(30000, 16);
    bytes.writeUInt32BE(30000, 20);
    const { normalizeImageForOcr } = await import("./images");
    expect(await normalizeImageForOcr(bytes)).toBeNull();
    expect(loadImage).not.toHaveBeenCalled();
  });
});

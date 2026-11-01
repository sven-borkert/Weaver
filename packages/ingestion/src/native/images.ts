import { createCanvas, loadImage } from "@napi-rs/canvas";

import { imageDimensions } from "./imageDimensions";

export const MAX_OCR_IMAGE_PIXELS = 50_000_000;
export const MAX_OCR_IMAGE_EDGE = 2048;

/** PNG, flattened on white, long edge at most 2048 px; null when the bytes do not decode. */
export async function normalizeImageForOcr(
  bytes: Uint8Array,
): Promise<Uint8Array | null> {
  const dimensions = imageDimensions(bytes);
  if (
    !dimensions ||
    dimensions.width * dimensions.height > MAX_OCR_IMAGE_PIXELS
  )
    return null;
  let image;
  try {
    image = await loadImage(Buffer.from(bytes));
  } catch {
    return null;
  }
  const scale = Math.min(
    1,
    MAX_OCR_IMAGE_EDGE / Math.max(image.width, image.height),
  );
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return new Uint8Array(await canvas.encode("png"));
}

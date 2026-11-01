/** Looks up embedded pictures of a .docx by content hash, in process and without parsing XML. */
import { createHash } from "node:crypto";
import {
  archiveProblem,
  readArchiveEntries,
  WORD_MEDIA_PART,
} from "@weaver/artifact-readers/archive";

export const WORD_IMAGE_SOURCE_MAX_BYTES = 64 * 1024 * 1024;
const MAX_MEDIA_ENTRIES = 500;
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;
const MAX_NAME_BYTES = 1024; // above the longest name WORD_MEDIA_PART matches

export interface WordImageLookup {
  /** Requested pictures found, by SHA-256; each a copy that does not pin the Word file. */
  images: Map<string, Uint8Array>;
  /** False when the entry or inflate budget ended the scan before every media part was seen. */
  complete: boolean;
  /** Media parts seen that exceed `maxImageBytes`. */
  oversized: number;
}

/** One pass over the media parts, keeping only the pictures whose hash is in `wanted`. Never throws. */
export function findWordImages(
  docx: Uint8Array,
  wanted: ReadonlySet<string>,
  maxImageBytes: number,
  limits: { maxEntries: number; maxInflatedBytes: number } = {
    maxEntries: MAX_MEDIA_ENTRIES,
    maxInflatedBytes: MAX_INFLATED_BYTES,
  },
): WordImageLookup {
  const images = new Map<string, Uint8Array>();
  if (archiveProblem(docx, false) !== null)
    return { images, complete: true, oversized: 0 };
  let spent = 0;
  let oversized = 0;
  let foundAll = false;
  const walked = readArchiveEntries(
    docx,
    (name) => WORD_MEDIA_PART.test(name),
    maxImageBytes,
    { maxEntries: limits.maxEntries, maxNameBytes: MAX_NAME_BYTES },
    (entry) => {
      if (entry.tooLarge) oversized += 1;
      spent += entry.bytes?.byteLength ?? entry.inflatedBytes;
      if (spent > limits.maxInflatedBytes) return false;
      if (!entry.bytes) return true;
      const hash = createHash("sha256").update(entry.bytes).digest("hex");
      if (wanted.has(hash) && !images.has(hash))
        images.set(hash, Buffer.from(entry.bytes));
      foundAll = images.size === wanted.size;
      return !foundAll;
    },
  );
  return { images, complete: walked || foundAll, oversized };
}

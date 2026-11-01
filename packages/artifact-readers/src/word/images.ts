/** Embedded pictures of a body paragraph or table cell, read from word/media by relationship. */
import { createHash } from "node:crypto";
import { readArchiveEntry, WORD_MEDIA_PART } from "../archive";
import { ArtifactReadError } from "../errors";
import {
  directElementChildren,
  readOptionalPartDocument,
  visitElements,
  WORD_PART_MAX_BYTES,
  type WordPackage,
  type XmlElement,
} from "./package";

const R_NS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const RELS_PART = "word/_rels/document.xml.rels";
const MAX_MEDIA_PARTS_PER_READ = 200; // distinct media parts inspected per read

export interface WordImageRead {
  /** SHA-256 of the media part, lower-case hex. */
  imageId: string;
  contentType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  byteSize: number;
  alt: string;
}

export const WORD_IMAGE_WARNINGS = {
  unsupported: "unsupported image format was omitted",
  missing: "image data is not included in the file",
  tooLarge: "image is too large",
  tooMany: "more images were omitted",
} as const;

type Resolved = { image: Omit<WordImageRead, "alt"> } | { warning: string };

function sniff(bytes: Uint8Array): WordImageRead["contentType"] | null {
  const head = Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    Math.min(bytes.byteLength, 12),
  );
  if (
    head.length >= 8 &&
    head.readUInt32BE(0) === 0x89504e47 &&
    head.readUInt32BE(4) === 0x0d0a1a0a
  )
    return "image/png";
  if (
    head.length >= 3 &&
    head[0] === 0xff &&
    head[1] === 0xd8 &&
    head[2] === 0xff
  )
    return "image/jpeg";
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.toString("latin1", 0, 6)))
    return "image/gif";
  if (
    head.length >= 12 &&
    head.toString("latin1", 0, 4) === "RIFF" &&
    head.toString("latin1", 8, 12) === "WEBP"
  )
    return "image/webp";
  return null;
}

/** Relationship id → part name under word/, or null for a linked picture. */
function loadRelationships(pkg: WordPackage): Map<string, string | null> {
  const targets = new Map<string, string | null>();
  const root = readOptionalPartDocument(pkg.data, RELS_PART)?.documentElement;
  if (!root) return targets;
  visitElements(root, (element) => {
    if (element.localName !== "Relationship") return;
    const id = element.getAttribute("Id");
    const target = element.getAttribute("Target");
    if (!id || !target) return;
    const external = element.getAttribute("TargetMode") === "External";
    const part = target.startsWith("/") ? target.slice(1) : `word/${target}`;
    targets.set(id, external || part.includes("..") ? null : part);
  });
  return targets;
}

/** First non-empty value; an empty attribute counts as absent. */
function firstFilled(...values: Array<string | null>): string | null {
  return values.find((value) => value) ?? null;
}

function relationshipId(element: XmlElement, name: string): string | null {
  return firstFilled(
    element.getAttributeNS(R_NS, name),
    element.getAttribute(`r:${name}`),
  );
}

/** Like visitElements, but skips mc:Fallback so a picture stored twice counts once. */
function visitPictureElements(
  element: XmlElement,
  visitor: (element: XmlElement) => void,
): void {
  for (const child of directElementChildren(element)) {
    if (child.localName === "Fallback") continue;
    visitor(child);
    visitPictureElements(child, visitor);
  }
}

/** Relationship id and alt text of every picture under `element`. */
function pictureRefs(
  element: XmlElement,
): Array<{ relId: string | null; alt: string }> {
  const refs: Array<{ relId: string | null; alt: string }> = [];
  let alt = "";
  visitPictureElements(element, (child) => {
    if (child.localName === "docPr") {
      alt =
        firstFilled(child.getAttribute("descr"), child.getAttribute("title")) ??
        "";
    } else if (child.localName === "shape") {
      alt = child.getAttribute("alt") ?? "";
    } else if (child.localName === "blip") {
      refs.push({
        relId: relationshipId(child, "embed") ?? relationshipId(child, "link"),
        alt,
      });
      alt = "";
    } else if (child.localName === "imagedata") {
      refs.push({ relId: relationshipId(child, "id"), alt });
      alt = "";
    }
  });
  return refs;
}

export function createImageResolver(
  pkg: WordPackage,
  maxPartBytes = WORD_PART_MAX_BYTES,
) {
  let relationships: Map<string, string | null> | undefined;
  const resolved = new Map<string, Resolved>();

  const resolvePart = (part: string): Resolved => {
    const cached = resolved.get(part);
    if (cached) return cached;
    let result: Resolved;
    try {
      const bytes = readArchiveEntry(pkg.data, part, maxPartBytes);
      const contentType = bytes ? sniff(bytes) : null;
      result = !bytes
        ? { warning: WORD_IMAGE_WARNINGS.missing }
        : !contentType
          ? { warning: WORD_IMAGE_WARNINGS.unsupported }
          : {
              image: {
                imageId: createHash("sha256").update(bytes).digest("hex"),
                contentType,
                byteSize: bytes.byteLength,
              },
            };
    } catch (cause) {
      const tooLarge =
        cause instanceof ArtifactReadError && cause.code === "resource_limit";
      result = {
        warning: tooLarge
          ? WORD_IMAGE_WARNINGS.tooLarge
          : WORD_IMAGE_WARNINGS.missing,
      };
    }
    resolved.set(part, result);
    return result;
  };

  return {
    /** Images and warnings of one paragraph or table cell element. */
    read(element: XmlElement): { images: WordImageRead[]; warnings: string[] } {
      const images: WordImageRead[] = [];
      const warnings = new Set<string>();
      for (const ref of pictureRefs(element)) {
        relationships ??= loadRelationships(pkg);
        const part = ref.relId ? relationships.get(ref.relId) : null;
        if (!part || !WORD_MEDIA_PART.test(part)) {
          warnings.add(WORD_IMAGE_WARNINGS.missing);
          continue;
        }
        if (!resolved.has(part) && resolved.size >= MAX_MEDIA_PARTS_PER_READ) {
          warnings.add(WORD_IMAGE_WARNINGS.tooMany);
          continue;
        }
        const result = resolvePart(part);
        if ("warning" in result) {
          warnings.add(result.warning);
          continue;
        }
        images.push({ ...result.image, alt: ref.alt });
      }
      return { images, warnings: [...warnings] };
    },
    count(element: XmlElement): number {
      return pictureRefs(element).length;
    },
  };
}

import type { JSONContent } from "@tiptap/core";
import { documentFileExtension, documentKindFromPath } from "./kinds";

export const ASSETS_SUFFIX = ".assets";
export const MAX_IMAGE_SRC_LENGTH = 2_048;
const MAX_SEGMENT_BYTES = 255;
const MAX_BASENAME_LENGTH = 80;

export const DOCUMENT_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;
export type DocumentImageType = (typeof DOCUMENT_IMAGE_TYPES)[number];

const EXTENSIONS: Record<DocumentImageType, "png" | "jpg" | "webp" | "gif"> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const encoder = new TextEncoder();
const CONTROL_RE = /[\x00-\x1f\x7f]/;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const COMBINING_RE = /[̀-ͯ]/g;

function bytesAt(head: Uint8Array, offset: number, bytes: readonly number[]) {
  if (head.length < offset + bytes.length) return false;
  return bytes.every((byte, index) => head[offset + index] === byte);
}

export function sniffImageType(head: Uint8Array): DocumentImageType | null {
  if (bytesAt(head, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return "image/png";
  if (bytesAt(head, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (
    bytesAt(head, 0, [0x52, 0x49, 0x46, 0x46]) &&
    bytesAt(head, 8, [0x57, 0x45, 0x42, 0x50])
  )
    return "image/webp";
  if (
    bytesAt(head, 0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    bytesAt(head, 0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  )
    return "image/gif";
  return null;
}

export function imageExtension(type: DocumentImageType) {
  return EXTENSIONS[type];
}

export function isAssetsSegment(segment: string): boolean {
  return (
    segment.length > ASSETS_SUFFIX.length && segment.endsWith(ASSETS_SUFFIX)
  );
}

export function hasAssetsSegment(relPath: string): boolean {
  return relPath.split("/").some(isAssetsSegment);
}

export function assetsDirForDocPath(docPath: string): string {
  const kind = documentKindFromPath(docPath);
  if (kind === null) throw new Error("not a document path");
  return `${docPath.slice(0, -documentFileExtension(kind).length)}${ASSETS_SUFFIX}`;
}

export function assetsPrefixForSlug(slug: string): string {
  return `${slug}${ASSETS_SUFFIX}/`;
}

function trimDashes(value: string): string {
  return value.replace(/^-+|-+$/g, "");
}

export function imageBasename(
  fileName: string | null | undefined,
  now: Date = new Date(),
): string {
  const stem = (fileName ?? "").replace(/\.[^.]*$/, "");
  const cleaned = trimDashes(
    trimDashes(
      stem
        .normalize("NFKD")
        .replace(COMBINING_RE, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-"),
    ).slice(0, MAX_BASENAME_LENGTH),
  );
  if (cleaned.length > 0) return cleaned;
  const iso = now.toISOString();
  const day = iso.slice(0, 10).replace(/-/g, "");
  const time = iso.slice(11, 19).replace(/:/g, "");
  return `image-${day}-${time}`;
}

export function allocateImageFileName(
  basename: string,
  extension: string,
  taken: ReadonlySet<string>,
): string {
  for (let i = 1; i < 10_000; i++) {
    const suffix = i === 1 ? "" : `-${i}`;
    const stem = `${trimDashes(
      basename.slice(0, MAX_BASENAME_LENGTH - suffix.length),
    )}${suffix}`;
    const name = `${stem}.${extension}`;
    if (!taken.has(name)) return name;
  }
  throw new Error("no available image file name");
}

export function classifyImageSrc(src: unknown): "absolute" | "relative" | null {
  if (typeof src !== "string") return null;
  if (src.length === 0 || src.length > MAX_IMAGE_SRC_LENGTH) return null;
  if (CONTROL_RE.test(src) || src.includes("\\")) return null;
  if (SCHEME_RE.test(src)) {
    try {
      const url = new URL(src);
      return url.protocol === "http:" || url.protocol === "https:"
        ? "absolute"
        : null;
    } catch {
      return null;
    }
  }
  if (src.startsWith("/")) return null;
  for (const segment of src.split("/")) {
    if (segment.length === 0) return null;
    if (encoder.encode(segment).byteLength > MAX_SEGMENT_BYTES) return null;
  }
  return "relative";
}

export function resolveRelativeImagePath(
  docPath: string,
  src: string,
): string | null {
  if (classifyImageSrc(src) !== "relative") return null;
  const stack = docPath.split("/").slice(0, -1);
  for (const segment of src.split("/")) {
    if (segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.join("/");
}

export function collectImageSources(json: JSONContent): string[] {
  const sources: string[] = [];
  const walk = (node: JSONContent): void => {
    if (node.type === "image" && typeof node.attrs?.src === "string") {
      sources.push(node.attrs.src);
    }
    node.content?.forEach(walk);
  };
  walk(json);
  return sources;
}

export function rewriteOwnAssetsPrefix(
  json: JSONContent,
  oldSlug: string,
  newSlug: string,
): JSONContent {
  if (oldSlug === newSlug) return json;
  const from = assetsPrefixForSlug(oldSlug);
  const to = assetsPrefixForSlug(newSlug);
  const walk = (node: JSONContent): JSONContent => {
    const next: JSONContent = { ...node };
    const src: unknown = node.attrs?.src;
    if (
      node.type === "image" &&
      typeof src === "string" &&
      src.startsWith(from)
    ) {
      next.attrs = { ...node.attrs, src: `${to}${src.slice(from.length)}` };
    }
    if (node.content) next.content = node.content.map(walk);
    return next;
  };
  return walk(json);
}

/** A copy of the content with every image source passed through `map`. */
export function mapImageSources(
  json: JSONContent,
  map: (src: string) => string,
): JSONContent {
  const walk = (node: JSONContent): JSONContent => {
    const next: JSONContent = { ...node };
    const src: unknown = node.attrs?.src;
    if (node.type === "image" && typeof src === "string")
      next.attrs = { ...node.attrs, src: map(src) };
    if (node.content) next.content = node.content.map(walk);
    return next;
  };
  return walk(json);
}

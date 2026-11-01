import type { JSONContent } from "@tiptap/core";

/** Markdown image link a write resolves into a copy in the document's own
 *  `.assets` directory: `weaver-image:<artifact id>` for an image file in
 *  Files, `weaver-image:<artifact id>/<asset id>` for a OneNote image. */
export const IMAGE_REFERENCE_SCHEME = "weaver-image:";

const REFERENCE_RE =
  /^weaver-image:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/([0-9a-f]{64}))?$/;

export type ImageReference = { artifactId: string; assetId: string | null };

export function imageReference(artifactId: string, assetId?: string): string {
  return `${IMAGE_REFERENCE_SCHEME}${artifactId}${assetId ? `/${assetId}` : ""}`;
}

/** Null when `src` is not an image reference; throws for a malformed one. */
export function parseImageReference(src: string): ImageReference | null {
  if (!src.startsWith(IMAGE_REFERENCE_SCHEME)) return null;
  const match = REFERENCE_RE.exec(src);
  if (!match) throw new Error(`malformed image reference ${src.slice(0, 200)}`);
  return { artifactId: match[1]!, assetId: match[2] ?? null };
}

/** A Markdown image whose alt text cannot break out of the brackets. */
export function markdownImage(alt: string, src: string): string {
  const text = alt
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/[\\[\]]/g, "\\$&")
    .trim();
  return `![${text || "Image"}](${src})`;
}

/** Every image reference in a document tree, in document order, once each. */
export function collectImageReferences(json: JSONContent): string[] {
  const found = new Set<string>();
  const walk = (node: JSONContent): void => {
    const src: unknown = node.attrs?.src;
    if (
      node.type === "image" &&
      typeof src === "string" &&
      src.startsWith(IMAGE_REFERENCE_SCHEME)
    )
      found.add(src);
    node.content?.forEach(walk);
  };
  walk(json);
  return [...found];
}

/** Replaces image references with the stored paths `targets` maps them to. */
export function replaceImageReferences(
  json: JSONContent,
  targets: ReadonlyMap<string, string>,
): JSONContent {
  const walk = (node: JSONContent): JSONContent => {
    const next: JSONContent = { ...node };
    const src: unknown = node.attrs?.src;
    if (node.type === "image" && typeof src === "string") {
      const target = targets.get(src);
      if (target) next.attrs = { ...node.attrs, src: target };
    }
    if (node.content) next.content = node.content.map(walk);
    return next;
  };
  return walk(json);
}

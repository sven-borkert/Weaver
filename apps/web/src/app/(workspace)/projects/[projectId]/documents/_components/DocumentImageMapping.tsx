"use client";

import { imageWidth } from "@weaver/core/editor/imageTag";
import type { RenderMappings } from "~/lib/editor/render";
import { resolveDocumentImageUrl } from "~/lib/documents/image-url";

export function createDocumentImageMapping(
  projectId: string,
  documentPath: string,
): RenderMappings {
  return {
    image: ({ node }) => {
      const src = typeof node.attrs.src === "string" ? node.attrs.src : "";
      const alt = typeof node.attrs.alt === "string" ? node.attrs.alt : "";
      const title =
        typeof node.attrs.title === "string" ? node.attrs.title : undefined;
      const url = resolveDocumentImageUrl({ projectId, documentPath, src });
      if (!url) {
        return (
          <span
            role="img"
            aria-label={alt || "Unavailable image"}
            className="border-line bg-subtle text-text-2 inline-flex rounded-[4px] border px-[0.3em] text-[12px]"
          >
            {alt || "Image unavailable"}
          </span>
        );
      }
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={alt}
          title={title}
          width={imageWidth(node.attrs.width) ?? undefined}
          loading="lazy"
        />
      );
    },
  };
}

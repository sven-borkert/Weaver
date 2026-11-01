import type { ImageOptions } from "@tiptap/extension-image";
import { MarkdownImage } from "@weaver/core/editor/extensions";

export type DocumentImageOptions = ImageOptions & {
  resolveSrc: (src: string) => string | undefined;
};

/** Renders relative sources through resolveSrc; keeps the relative path on data-weaver-src for copy/paste. */
export const DocumentImage = MarkdownImage.extend<DocumentImageOptions>({
  addOptions() {
    return {
      ...(this.parent?.() as ImageOptions),
      resolveSrc: (src: string) => src,
    };
  },
  addAttributes() {
    return {
      ...this.parent?.(),
      src: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute("data-weaver-src") ??
          element.getAttribute("src"),
        renderHTML: (attributes) => {
          const src = typeof attributes.src === "string" ? attributes.src : "";
          return {
            src: this.options.resolveSrc(src) ?? "",
            "data-weaver-src": src,
          };
        },
      },
    };
  },
});

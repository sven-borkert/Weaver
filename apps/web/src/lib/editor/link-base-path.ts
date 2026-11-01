import type { JSONContent } from "@tiptap/core";
import { APP_BASE_PATH, withBasePath } from "~/lib/basePath";

export function withDocumentBasePath(
  node: JSONContent,
  basePath = APP_BASE_PATH,
): JSONContent {
  const marks = node.marks?.map((mark) =>
    mark.type === "link" && typeof mark.attrs?.href === "string"
      ? {
          ...mark,
          attrs: {
            ...mark.attrs,
            href: withBasePath(mark.attrs.href, basePath),
          },
        }
      : mark,
  );
  const content = node.content?.map((child) =>
    withDocumentBasePath(child, basePath),
  );
  return {
    ...node,
    ...(marks ? { marks } : {}),
    ...(content ? { content } : {}),
  };
}

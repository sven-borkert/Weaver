import type { JSONContent } from "@tiptap/core";

export function documentEditingContent(content: JSONContent): JSONContent {
  if (content.content?.at(-1)?.type === "paragraph") return content;
  // TipTap's trailing paragraph must exist before focus can emit transactions.
  return {
    ...content,
    content: [...(content.content ?? []), { type: "paragraph" }],
  };
}

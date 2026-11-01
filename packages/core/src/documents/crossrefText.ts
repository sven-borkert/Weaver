import type { JSONContent } from "@tiptap/core";
import { crossrefTargetKey } from "../editor/markdown";

/** Cross-references only mean something on this instance; a transfer sends their text. */
export function crossrefsToText(
  json: JSONContent,
  titles: ReadonlyMap<string, string>,
): JSONContent {
  const walk = (node: JSONContent): JSONContent => {
    if (node.type === "crossref") {
      const targetType =
        node.attrs?.targetType === "table" ? "table" : "document";
      const label =
        titles.get(
          crossrefTargetKey(targetType, String(node.attrs?.targetId ?? "")),
        ) ??
        (typeof node.attrs?.label === "string" && node.attrs.label
          ? node.attrs.label
          : "Reference");
      return {
        type: "text",
        text: label,
        ...(node.marks?.length ? { marks: node.marks } : {}),
      };
    }
    return node.content ? { ...node, content: node.content.map(walk) } : node;
  };
  return walk(json);
}

import type { JSONContent } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { serializeDocumentBody } from "@weaver/core/editor/markdown";
import {
  createDocumentSectionAnchorAllocator,
  projectDocumentSectionAnchors,
} from "@weaver/core/knowledge/sectionAnchors";

export type DocumentHeadingAnchor = {
  node: Node;
  position: number;
  anchor: string;
  topLevel: boolean;
};

export type DocumentOutlineEntry = {
  anchor: string;
  level: number;
  text: string;
};

export function documentHeadingAnchors(documentNode: Node) {
  const projected = projectDocumentSectionAnchors(
    serializeDocumentBody(documentNode.toJSON() as JSONContent),
  );
  const reserved = new Set(projected.map(({ anchor }) => anchor));
  const omitted = createDocumentSectionAnchorAllocator();
  const headings: DocumentHeadingAnchor[] = [];
  let headingIndex = 0;
  documentNode.descendants((node, position, parent) => {
    if (node.type.name !== "heading") return;
    let anchor =
      node.childCount > 0 && parent === documentNode
        ? projected[headingIndex++]?.anchor
        : undefined;
    if (!anchor) {
      do {
        anchor = omitted.allocate([]);
      } while (reserved.has(anchor));
      reserved.add(anchor);
    }
    headings.push({
      node,
      position,
      anchor,
      topLevel: parent === documentNode,
    });
  });
  return headings;
}

const headingText = (node: Node) =>
  node
    .textBetween(0, node.content.size, " ", (leaf) =>
      leaf.type.name === "crossref"
        ? String(leaf.attrs.label ?? "")
        : leaf.type.name === "inlineMath"
          ? `$${String(leaf.attrs.source ?? "")}$`
          : " ",
    )
    .replace(/\s+/gu, " ")
    .trim();

/** Top-level headings with text: the sections search and navigation know. */
export function documentOutlineFromHeadingAnchors(
  headings: readonly DocumentHeadingAnchor[],
): DocumentOutlineEntry[] {
  return headings.flatMap(({ node, anchor, topLevel }) => {
    const text = topLevel ? headingText(node) : "";
    return text ? [{ anchor, level: Number(node.attrs.level) || 1, text }] : [];
  });
}

export function documentOutline(documentNode: Node): DocumentOutlineEntry[] {
  return documentOutlineFromHeadingAnchors(
    documentHeadingAnchors(documentNode),
  );
}

export function sameDocumentOutline(
  left: readonly DocumentOutlineEntry[],
  right: readonly DocumentOutlineEntry[],
) {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.anchor === right[index]?.anchor &&
        entry.level === right[index].level &&
        entry.text === right[index].text,
    )
  );
}

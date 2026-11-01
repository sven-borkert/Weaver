"use client";

import { Extension } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
  documentHeadingAnchors,
  documentOutlineFromHeadingAnchors,
  sameDocumentOutline,
  type DocumentOutlineEntry,
} from "./document-heading-anchors";

type Heading = { node: Node; topLevel: boolean };
type AnchorState = {
  headings: Heading[];
  decorations: DecorationSet;
  highlightedSection: string | null;
  outline: DocumentOutlineEntry[];
};
export const DOCUMENT_SECTION_HIGHLIGHT_META = "documentSectionHighlight";
const documentSectionAnchorsKey = new PluginKey<AnchorState>(
  "documentSectionAnchors",
);

function decorateDocument(
  doc: Node,
  highlightedSection: string | null = null,
  previousOutline?: DocumentOutlineEntry[],
): AnchorState {
  const anchors = documentHeadingAnchors(doc);
  const outline = documentOutlineFromHeadingAnchors(anchors);
  return {
    highlightedSection,
    outline:
      previousOutline && sameDocumentOutline(previousOutline, outline)
        ? previousOutline
        : outline,
    headings: anchors.map(({ node, topLevel }) => ({ node, topLevel })),
    decorations: DecorationSet.create(
      doc,
      anchors.map(({ node, position, anchor }) =>
        Decoration.node(position, position + node.nodeSize, {
          id: anchor,
          "data-document-section": "true",
          tabindex: "-1",
          ...(anchor === highlightedSection
            ? { "data-section-highlight": "true" }
            : {}),
        }),
      ),
    ),
  };
}

export function createDocumentSectionAnchorPlugin() {
  return new Plugin<AnchorState>({
    key: documentSectionAnchorsKey,
    state: {
      init: (_config, state) => decorateDocument(state.doc),
      apply(transaction, previous) {
        const highlight: unknown = transaction.getMeta(
          DOCUMENT_SECTION_HIGHLIGHT_META,
        );
        if (
          (typeof highlight === "string" || highlight === null) &&
          highlight !== previous.highlightedSection
        )
          return decorateDocument(transaction.doc, highlight, previous.outline);
        if (!transaction.docChanged) return previous;
        const headings: Heading[] = [];
        transaction.doc.descendants((node, _position, parent) => {
          if (node.type.name === "heading")
            headings.push({ node, topLevel: parent === transaction.doc });
        });
        const decorations = previous.decorations.map(
          transaction.mapping,
          transaction.doc,
        );
        if (
          headings.length !== previous.headings.length ||
          headings.some(
            (heading, index) =>
              heading.node !== previous.headings[index]?.node ||
              heading.topLevel !== previous.headings[index]?.topLevel,
          ) ||
          decorations.find().length !== headings.length
        ) {
          return decorateDocument(
            transaction.doc,
            previous.highlightedSection,
            previous.outline,
          );
        }
        return {
          highlightedSection: previous.highlightedSection,
          headings,
          decorations,
          outline: previous.outline,
        };
      },
    },
    props: {
      decorations(state) {
        return this.getState(state)?.decorations;
      },
    },
  });
}

/** The live heading outline; the same array until a heading changes. */
export function documentOutlineFromState(
  state: EditorState,
): DocumentOutlineEntry[] | undefined {
  return documentSectionAnchorsKey.getState(state)?.outline;
}

export const DocumentSectionAnchors = Extension.create({
  name: "documentSectionAnchors",
  addProseMirrorPlugins() {
    return [createDocumentSectionAnchorPlugin()];
  },
});

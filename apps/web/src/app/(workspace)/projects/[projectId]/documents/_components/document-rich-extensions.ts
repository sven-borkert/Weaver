import { ReactNodeViewRenderer, type Editor } from "@tiptap/react";
import { InlineMath, MathBlock } from "@weaver/core/editor/math";
import { MathPlot } from "@weaver/core/editor/math-plot";
import { Mermaid } from "@weaver/core/editor/mermaid";
import { stopFigureNodeViewEvent } from "~/lib/editor/figure-node-view";
import { CodeBlockWithCopy } from "./DocumentCodeBlock";
import { MathNodeView } from "./MathNodeView";
import { MathPlotNodeView } from "./MathPlotNodeView";
import { MermaidNodeView } from "./MermaidNodeView";

export const documentRichExtensions = {
  codeBlock: CodeBlockWithCopy,
  mermaid: Mermaid.extend({
    addNodeView() {
      return ReactNodeViewRenderer(MermaidNodeView, {
        stopEvent: stopFigureNodeViewEvent,
      });
    },
  }),
  inlineMath: InlineMath.extend({
    addNodeView() {
      return ReactNodeViewRenderer(MathNodeView, { as: "span" });
    },
  }),
  mathBlock: MathBlock.extend({
    addNodeView() {
      return ReactNodeViewRenderer(MathNodeView);
    },
  }),
  mathPlot: MathPlot.extend({
    addNodeView() {
      return ReactNodeViewRenderer(MathPlotNodeView, {
        stopEvent: stopFigureNodeViewEvent,
      });
    },
  }),
};

export function insertDocumentMermaid(editor: Editor) {
  if (!editor.isEditable) return;
  editor
    .chain()
    .focus()
    .insertContent({
      type: "mermaid",
      attrs: { source: "flowchart TD\n  A[Start] --> B[End]" },
    })
    .run();
}

export function insertDocumentMath(
  editor: Editor,
  type: "inlineMath" | "mathBlock",
) {
  if (!editor.isEditable) return;
  editor
    .chain()
    .focus()
    .insertContent({ type, attrs: { source: "x^2" } })
    .run();
}

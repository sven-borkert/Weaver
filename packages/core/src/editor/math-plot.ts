import { Node } from "@tiptap/core";
import { codeFence } from "./markdownEscapes";

export const MathPlot = Node.create({
  name: "mathPlot",
  group: "block",
  atom: true,
  isolating: true,

  addAttributes() {
    return { source: { default: "" } };
  },

  parseHTML() {
    return [
      {
        tag: "pre[data-math-plot]",
        getAttrs: (element) => ({
          source:
            element.querySelector("code")?.textContent ??
            element.textContent ??
            "",
        }),
      },
    ];
  },

  renderHTML({ node }) {
    return [
      "pre",
      { "data-math-plot": "" },
      ["code", {}, node.attrs.source as string],
    ];
  },

  markdownTokenName: "code",
  parseMarkdown: (token) =>
    token.lang === "plot"
      ? {
          type: "mathPlot",
          attrs: { source: typeof token.text === "string" ? token.text : "" },
        }
      : [],

  renderMarkdown: (node) => {
    const source =
      typeof node.attrs?.source === "string" ? node.attrs.source : "";
    const fence = codeFence(source);
    return `${fence}plot\n${source ? `${source}\n` : ""}${fence}`;
  },
});

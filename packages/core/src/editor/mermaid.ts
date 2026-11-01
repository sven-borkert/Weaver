import { Node } from "@tiptap/core";
import { codeFence } from "./markdownEscapes";

const MERMAID_RE =
  /^(`{3,})mermaid[^\S\r\n]*\n([\s\S]*?)\n\1[^\S\r\n]*(?:\n|$)/;
const MERMAID_START_RE = /(^|\n)(`{3,})mermaid[^\S\r\n]*\n/;

export const Mermaid = Node.create({
  name: "mermaid",
  group: "block",
  atom: true,
  isolating: true,

  addAttributes() {
    return { source: { default: "" } };
  },

  parseHTML() {
    return [
      {
        tag: "pre[data-mermaid]",
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
      { "data-mermaid": "" },
      ["code", {}, node.attrs.source as string],
    ];
  },

  markdownTokenizer: {
    name: "mermaid",
    level: "block",
    start: (src) => {
      const match = MERMAID_START_RE.exec(src);
      return match ? match.index + (match[1]?.length ?? 0) : -1;
    },
    tokenize: (src) => {
      const match = MERMAID_RE.exec(src);
      return match
        ? { type: "mermaid", raw: match[0], source: match[2] }
        : undefined;
    },
  },

  parseMarkdown: (token) => ({
    type: "mermaid",
    attrs: { source: token.source as string },
  }),

  renderMarkdown: (node) => {
    const source =
      typeof node.attrs?.source === "string" ? node.attrs.source : "";
    const fence = codeFence(source);
    return `${fence}mermaid\n${source}\n${fence}`;
  },
});

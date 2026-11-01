import { mergeAttributes, Node } from "@tiptap/core";

export const CROSSREF_URI_PREFIXES = {
  document: "weaver://document/",
  table: "weaver://table/",
} as const;
export type CrossrefTargetType = keyof typeof CROSSREF_URI_PREFIXES;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_RE = new RegExp(`^${UUID}$`);
const CROSSREF_MD_RE = new RegExp(
  `^\\[((?:\\\\.|[^\\]\\\\])*)\\]\\(weaver://(document|table)/(${UUID})\\)`,
);

function escapeLabel(label: string): string {
  return label.replace(/\\/g, "\\\\").replace(/[[\]]/g, "\\$&");
}

function unescapeLabel(label: string): string {
  return label.replace(/\\([\\[\]])/g, "$1");
}

function getTargetId(node: { attrs?: Record<string, unknown> }): string {
  const targetId = node.attrs?.targetId;
  if (typeof targetId !== "string" || !UUID_RE.test(targetId)) {
    throw new Error("Crossref targetId must be a canonical lowercase UUID");
  }
  return targetId;
}

export const Crossref = Node.create({
  name: "crossref",
  group: "inline",
  inline: true,
  atom: true,

  addAttributes() {
    return {
      targetType: { default: "document" },
      targetId: { default: null },
      label: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-crossref-id]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-crossref-id": node.attrs.targetId as string,
      }),
      (node.attrs.label as string | null) ?? "Untitled",
    ];
  },

  markdownTokenizer: {
    name: "crossref",
    level: "inline",
    start: (src) => src.indexOf("["),
    tokenize: (src) => {
      const match = CROSSREF_MD_RE.exec(src);
      if (!match) return undefined;

      return {
        type: "crossref",
        raw: match[0],
        label: match[1],
        targetType: match[2],
        targetId: match[3],
      };
    },
  },

  parseMarkdown: (token) => ({
    type: "crossref",
    attrs: {
      targetType: token.targetType === "table" ? "table" : "document",
      targetId: token.targetId as string,
      label: unescapeLabel(token.label as string) || null,
    },
  }),

  renderMarkdown: (node) => {
    const label = (node.attrs?.label as string | null) ?? "Untitled";
    const targetType =
      node.attrs?.targetType === "table" ? "table" : "document";
    return `[${escapeLabel(label)}](${CROSSREF_URI_PREFIXES[targetType]}${getTargetId(node)})`;
  },
});

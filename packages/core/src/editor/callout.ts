import { mergeAttributes, Node } from "@tiptap/core";

export const CALLOUT_VARIANTS = [
  "NOTE",
  "TIP",
  "IMPORTANT",
  "WARNING",
  "CAUTION",
] as const;
export type CalloutVariant = (typeof CALLOUT_VARIANTS)[number];

const CALLOUT_RE =
  /^> \[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][^\n]*(?:\n>[^\n]*)*/i;

const EMPTY_PARAGRAPH_MARKDOWN = "&nbsp;";

type MarkdownChild = {
  type?: string;
  text?: string;
  content?: MarkdownChild[];
};

const isBlankParagraph = (child: MarkdownChild) =>
  child.type === "paragraph" &&
  (child.content ?? []).every(
    (inline) => inline.type === "text" && /^\s*$/u.test(inline.text ?? ""),
  );

function normalizeVariant(value: unknown): CalloutVariant {
  const upper = typeof value === "string" ? value.toUpperCase() : "";
  return (CALLOUT_VARIANTS as readonly string[]).includes(upper)
    ? (upper as CalloutVariant)
    : "NOTE";
}

export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return { variant: { default: "NOTE" } };
  },

  parseHTML() {
    return [{ tag: "div[data-callout]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-callout": node.attrs.variant as string,
      }),
      0,
    ];
  },

  markdownTokenizer: {
    name: "callout",
    level: "block",
    start: (src) => src.indexOf("> [!"),
    tokenize: (src, _tokens, lexer) => {
      const match = CALLOUT_RE.exec(src);
      if (!match) return undefined;

      const inner = match[0]
        .replace(/^> \[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*/i, "> ")
        .split("\n")
        .map((line) => line.replace(/^> ?/, ""))
        .join("\n");
      return {
        type: "callout",
        raw: match[0],
        variant: normalizeVariant(match[1]),
        tokens: lexer.blockTokens(inner),
      };
    },
  },

  parseMarkdown: (token, helpers) => {
    const content = token.tokens?.length
      ? helpers.parseChildren(token.tokens)
      : [];
    return {
      type: "callout",
      attrs: { variant: token.variant as CalloutVariant },
      content: content.length ? content : [{ type: "paragraph", content: [] }],
    };
  },

  renderMarkdown: (node, helpers) => {
    // Implicit blank-line paragraphs only survive at the top level.
    const body = (node.content ?? [])
      .map((child) =>
        isBlankParagraph(child)
          ? EMPTY_PARAGRAPH_MARKDOWN
          : helpers.renderChildren([child]),
      )
      .join("\n\n")
      .trimEnd()
      .split("\n")
      .map((line) => (line.length > 0 ? `> ${line}` : ">"))
      .join("\n");
    return `> [!${normalizeVariant(node.attrs?.variant)}]\n${body}`;
  },
});

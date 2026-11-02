import { mergeAttributes, Node, nodeInputRule } from "@tiptap/core";

// Bounds every delimiter scan, so a line of unmatched dollars stays linear.
const MAX_MATH_CHARS = 5_000;

const MATH_BLOCK_RE = new RegExp(
  `^ {0,3}\\$\\$((?:(?!\\$\\$|\\n[ \\t]*\\n)[\\s\\S]){1,${MAX_MATH_CHARS}})\\$\\$[ \\t]*(?:\\n|$)`,
);
const MATH_BLOCK_START_RE = /(^|\n) {0,3}\$\$/g;

/** Typing the closing dollar of `$x$` makes a formula; a digit before the opener is a price. */
const INLINE_MATH_INPUT_RE = /(?<![\\$\d])\$[^\s$](?:[^$\n]*[^\s$\\])?\$$/;

type InlineMathMatch = { raw: string; source: string };

/** The formula `src` starts with: `$` hugs its content, and a closer before a digit is a price. */
function matchInlineMath(src: string): InlineMathMatch | null {
  if (!src.startsWith("$")) return null;
  if (src[1] === "$") {
    const end = src.slice(0, MAX_MATH_CHARS).indexOf("$$", 2);
    const source = end < 0 ? "" : src.slice(2, end);
    return source.trim() && !source.includes("\n")
      ? { raw: src.slice(0, end + 2), source }
      : null;
  }
  if (!src[1] || /\s/.test(src[1])) return null;
  const limit = Math.min(src.length, MAX_MATH_CHARS);
  for (let index = 1; index < limit; index++) {
    const char = src[index];
    if (char === "\n") return null;
    if (char === "\\") index++;
    else if (char === "$") {
      // A formula holds no bare dollar, so the first one closes it or it is no formula.
      return /\s/.test(src[index - 1]!) || /[0-9]/.test(src[index + 1] ?? "")
        ? null
        : { raw: src.slice(0, index + 1), source: src.slice(1, index) };
    }
  }
  return null;
}

/** Text that would read back as a formula gets its openers escaped. */
export function escapeMathInText(encoded: string): string {
  if (!encoded.includes("$")) return encoded;
  let result = "";
  for (let index = 0; index < encoded.length; index++) {
    const char = encoded[index]!;
    if (char === "\\") {
      result += char + (encoded[++index] ?? "");
    } else if (char === "$" && matchInlineMath(encoded.slice(index))) {
      result += "\\$";
    } else {
      result += char;
    }
  }
  return result;
}

/** Saving before math existed escaped formulas as text; undo that when reading.
 *  `\\` before a letter is taken for a doubled command, not a line break. */
export function normalizeMathSource(source: string, display: boolean): string {
  const unescaped = source
    .replace(/\\\\(?=[A-Za-z])/g, "\\")
    .replace(
      /\\\\|\\text\{[^{}]*\}|\\([_*[\]~`])/g,
      (match, char?: string) => char ?? match,
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  // Those saves also collapsed `\ ` and `\\ `; only a matrix or display formula means a break.
  return display || unescaped.includes("\\begin{")
    ? unescaped
    : unescaped.replace(/\\\\(?=\s)/g, "\\");
}

const sourceOf = (attrs: Record<string, unknown> | undefined): string =>
  typeof attrs?.source === "string" ? attrs.source : "";

function inlineMathMarkdown(source: string): string {
  const escaped = source
    .replace(/\s*\n\s*/g, " ")
    .trim()
    .replace(/\\[\s\S]|\$/g, (match) => (match === "$" ? "\\$" : match));
  if (!escaped) return "";
  // A trailing lone backslash would escape the closing dollar.
  const closed = /(?:^|[^\\])(?:\\\\)*\\$/.test(escaped)
    ? `${escaped}{}`
    : escaped;
  return `$${closed}$`;
}

function mathBlockMarkdown(source: string): string {
  const body = source
    .replace(/\$(?=\$)/g, "$ ")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!body) return "";
  return body.includes("\n") || body.endsWith("$")
    ? `$$\n${body}\n$$`
    : `$$${body}$$`;
}

const sourceAttribute = {
  source: {
    default: "",
    parseHTML: (element: HTMLElement) =>
      element.getAttribute("data-source") ?? element.textContent ?? "",
  },
};

export const InlineMath = Node.create({
  name: "inlineMath",
  group: "inline",
  inline: true,
  atom: true,

  addAttributes() {
    return sourceAttribute;
  },

  parseHTML() {
    return [{ tag: "span[data-inline-math]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const source = sourceOf(node.attrs);
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-inline-math": "",
        "data-source": source,
      }),
      source,
    ];
  },

  renderText: ({ node }) => `$${sourceOf(node.attrs)}$`,

  addInputRules() {
    return [
      nodeInputRule({
        find: INLINE_MATH_INPUT_RE,
        type: this.type,
        getAttributes: (match) => ({ source: match[0].slice(1, -1) }),
      }),
    ];
  },

  markdownTokenizer: {
    name: "inlineMath",
    level: "inline",
    start: (src) => src.indexOf("$"),
    tokenize: (src) => {
      const match = matchInlineMath(src);
      return match ? { type: "inlineMath", ...match } : undefined;
    },
  },

  parseMarkdown: (token) => ({
    type: "inlineMath",
    attrs: {
      source: normalizeMathSource((token.source as string).trim(), false),
    },
  }),

  renderMarkdown: (node) => inlineMathMarkdown(sourceOf(node.attrs)),
});

export const MathBlock = Node.create({
  name: "mathBlock",
  group: "block",
  atom: true,
  isolating: true,

  addAttributes() {
    return sourceAttribute;
  },

  parseHTML() {
    return [{ tag: "div[data-math-block]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const source = sourceOf(node.attrs);
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-math-block": "",
        "data-source": source,
      }),
      source,
    ];
  },

  renderText: ({ node }) => `$$${sourceOf(node.attrs)}$$`,

  markdownTokenizer: {
    name: "mathBlock",
    level: "block",
    start: (src) => {
      for (const match of src.matchAll(MATH_BLOCK_START_RE)) {
        const index = match.index + (match[1]?.length ?? 0);
        if (MATH_BLOCK_RE.test(src.slice(index))) return index;
      }
      return -1;
    },
    tokenize: (src) => {
      const match = MATH_BLOCK_RE.exec(src);
      return match?.[1]?.trim()
        ? { type: "mathBlock", raw: match[0], source: match[1] }
        : undefined;
    },
  },

  parseMarkdown: (token) => ({
    type: "mathBlock",
    attrs: {
      source: normalizeMathSource((token.source as string).trim(), true),
    },
  }),

  renderMarkdown: (node) => mathBlockMarkdown(sourceOf(node.attrs)),
});

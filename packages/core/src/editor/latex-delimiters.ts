import { MAX_MATH_CHARS } from "./math";

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
// Bounded and blank-line free, so an unmatched `\[` cannot swallow the rest of a reply.
const DISPLAY_RE = new RegExp(
  String.raw`(?<!\\)\\\[((?:(?!\n[ \t]*\n)[\s\S]){1,${MAX_MATH_CHARS}}?)\\\]`,
  "g",
);
const INLINE_RE = new RegExp(
  String.raw`(?<!\\)\\\(([^\n]{1,${MAX_MATH_CHARS}}?)\\\)`,
  "g",
);

const OPERAND = String.raw`(?:\d+(?:\.\d+)?|[A-Za-z])`;
// A single-letter or numeric term on each side, so `Ctrl+C`, `key=value` and `1-3` stay text.
const EQUATION_RE = new RegExp(
  String.raw`(?<![A-Za-z0-9.])${OPERAND}\s*[=+]\s*${OPERAND}(?![A-Za-z0-9])`,
);

/** Weaver writes literal brackets as `\[`/`\]`, so bracket delimiters count as
 *  math only on their own lines or around a command (`\frac`), a sub- or
 *  superscript with a base (`x^2`, `a_1`) or an equation of single terms (`x + y`). */
function looksLikeDisplayMath(inner: string): boolean {
  if (/^[ \t]*\n[\s\S]*\n[ \t]*$/.test(inner) || EQUATION_RE.test(inner))
    return true;
  for (let index = 0; index < inner.length; index++) {
    const char = inner[index]!;
    const next = inner[index + 1] ?? "";
    if (char === "\\") {
      if (/[A-Za-z]/.test(next)) return true;
      // A Markdown escape (`\_`, `\*`, `\\`) is literal text.
      index++;
    } else if (
      (char === "^" || char === "_") &&
      /\S/.test(inner[index - 1] ?? "") &&
      /\S/.test(next)
    ) {
      return true;
    }
  }
  return false;
}

function convertDelimiters(text: string): string {
  return text
    .replace(DISPLAY_RE, (match, inner: string) =>
      inner.trim() && !inner.includes("$") && looksLikeDisplayMath(inner)
        ? `$$${inner}$$`
        : match,
    )
    .replace(INLINE_RE, (match, inner: string) => {
      // Inline `$` must hug the formula.
      const source = inner.trim();
      return source && !source.includes("$") ? `$${source}$` : match;
    });
}

// Link destinations and autolinks are URLs: an escaped parenthesis there is never math.
const DESTINATION_RE =
  /(?<=(?:^|[^\\])(?:\\\\)*\]\()(?:<[^<>\n]*>|(?:\\.|[^\s()\\]|\((?:\\.|[^\s()\\])*\))+)|<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>/g;

function convertMath(text: string): string {
  let result = "";
  let index = 0;
  for (const match of text.matchAll(DESTINATION_RE)) {
    result += convertDelimiters(text.slice(index, match.index)) + match[0];
    index = match.index + match[0].length;
  }
  return result + convertDelimiters(text.slice(index));
}

function convertOutsideCodeSpans(text: string): string {
  let result = "";
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf("`", index);
    if (open < 0) break;
    let after = open;
    while (text[after] === "`") after++;
    const run = text.slice(open, after);
    let close = text.indexOf(run, after);
    while (close >= 0 && text[close + run.length] === "`")
      close = text.indexOf(run, close + run.length + 1);
    result += convertMath(text.slice(index, open));
    if (close < 0) {
      result += run;
      index = after;
    } else {
      result += text.slice(open, close + run.length);
      index = close + run.length;
    }
  }
  return result + convertMath(text.slice(index));
}

/** Chat models often write `\(…\)` and `\[…\]`; Weaver's Markdown reads `$…$` and `$$…$$`. Code, link destinations and escaped brackets around plain text stay literal. */
export function normalizeLatexDelimiters(markdown: string): string {
  if (!markdown.includes("\\(") && !markdown.includes("\\[")) return markdown;
  const output: string[] = [];
  let prose: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (prose.length) output.push(convertOutsideCodeSpans(prose.join("\n")));
    prose = [];
  };
  for (const line of markdown.split("\n")) {
    const marker = FENCE_RE.exec(line)?.[1];
    if (fence) {
      output.push(line);
      if (
        marker &&
        marker.startsWith(fence.charAt(0)) &&
        marker.length >= fence.length &&
        !line.slice(line.indexOf(marker) + marker.length).trim()
      )
        fence = null;
    } else if (marker) {
      flush();
      fence = marker;
      output.push(line);
    } else {
      prose.push(line);
    }
  }
  flush();
  return output.join("\n");
}

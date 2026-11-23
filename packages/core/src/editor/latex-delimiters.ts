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

function convertMath(text: string): string {
  return text
    .replace(DISPLAY_RE, (match, inner: string) =>
      inner.trim() && !inner.includes("$") ? `$$${inner}$$` : match,
    )
    .replace(INLINE_RE, (match, inner: string) => {
      // Inline `$` must hug the formula.
      const source = inner.trim();
      return source && !source.includes("$") ? `$${source}$` : match;
    });
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

/** Chat models often write `\(…\)` and `\[…\]`; Weaver's Markdown reads `$…$` and `$$…$$`. Code stays literal. */
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

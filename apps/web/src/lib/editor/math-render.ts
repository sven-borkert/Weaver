import katex from "katex";
import { MAX_MATH_CHARS } from "@weaver/core/editor/math";

const unrenderable = (source: string): string => {
  const text = source
    .slice(0, 200)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<span class="katex-error">${text}</span>`;
};

// Formulas arrive from imports and tools: `trust: false` refuses \href, \includegraphics
// and \html*. `maxSize` caps positive sizes only; the stylesheets clip negative ones.
export function renderMathHtml(source: string, display: boolean): string {
  if (source.length > MAX_MATH_CHARS) return unrenderable(source);
  try {
    return katex.renderToString(source, {
      displayMode: display,
      throwOnError: false,
      trust: false,
      maxSize: 50,
      strict: "ignore",
      output: "htmlAndMathml",
    });
  } catch {
    // Deep nesting overflows the parser's stack: one formula must not fail the page.
    return unrenderable(source);
  }
}

export const mathSource = (attrs: Record<string, unknown>): string =>
  typeof attrs.source === "string" ? attrs.source : "";

import katex from "katex";

// Formulas arrive from imports and tools: `trust: false` refuses \href, \includegraphics
// and \html*, and `maxSize` stops a \rule painting over the page.
export function renderMathHtml(source: string, display: boolean): string {
  return katex.renderToString(source, {
    displayMode: display,
    throwOnError: false,
    trust: false,
    maxSize: 50,
    strict: "ignore",
    output: "htmlAndMathml",
  });
}

export const mathSource = (attrs: Record<string, unknown>): string =>
  typeof attrs.source === "string" ? attrs.source : "";

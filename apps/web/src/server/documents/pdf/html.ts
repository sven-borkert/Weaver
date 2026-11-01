import type { JSONContent } from "@tiptap/core";
import { renderToHTMLString } from "@tiptap/static-renderer/pm/html-string";
import { documentExtensions } from "@weaver/core/editor/extensions";
import { imageWidth } from "@weaver/core/editor/imageTag";
import { crossrefTargetKey } from "@weaver/core/editor/markdown";
import { PRINT_STYLES } from "./styles";

export type PrintImage = { contentType: string; bytes: Uint8Array };

export type PrintHtmlInput = {
  title: string;
  metadata: {
    createdAt: Date;
    createdBy: { name: string } | null;
    updatedAt: Date;
    updatedBy: { name: string } | null;
  };
  contentJson: JSONContent;
  /** image src as written in the document → bytes; a missing entry renders a placeholder */
  images: ReadonlyMap<string, PrintImage>;
  /** `crossrefTargetKey(type, id)` → current title */
  crossrefTitles: ReadonlyMap<string, string>;
  /** the Mermaid browser bundle, inlined verbatim; empty renders Mermaid blocks as source */
  mermaidScript: string;
};

const MERMAID_WAIT_MS = 10_000;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function utcMinute(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function metadataLine(metadata: PrintHtmlInput["metadata"]): string {
  const by = (author: { name: string } | null) =>
    author ? ` by ${escapeHtml(author.name)}` : "";
  return `Created ${utcMinute(metadata.createdAt)}${by(metadata.createdBy)} · Updated ${utcMinute(metadata.updatedAt)}${by(metadata.updatedBy)}`;
}

function hasMermaid(node: JSONContent): boolean {
  if (node.type === "mermaid") return true;
  return (node.content ?? []).some(hasMermaid);
}

type NodeAttrs = Record<string, unknown>;
const attr = (attrs: NodeAttrs, key: string) =>
  typeof attrs[key] === "string" ? attrs[key] : "";

function renderBody(input: PrintHtmlInput, mermaid: boolean): string {
  return renderToHTMLString({
    extensions: documentExtensions(),
    content: input.contentJson,
    options: {
      nodeMapping: {
        image: ({ node }) => {
          const src = attr(node.attrs, "src");
          const image = input.images.get(src);
          if (!image)
            return `<div class="image-missing">Image unavailable: ${escapeHtml(src)}</div>`;
          const data = `data:${image.contentType};base64,${Buffer.from(image.bytes).toString("base64")}`;
          const width = imageWidth(node.attrs.width);
          return `<img src="${data}" alt="${escapeHtml(attr(node.attrs, "alt"))}"${width === null ? "" : ` width="${width}"`}>`;
        },
        mermaid: ({ node }) => {
          const source = escapeHtml(attr(node.attrs, "source"));
          return mermaid
            ? `<pre class="mermaid">${source}</pre>`
            : `<pre><code>${source}</code></pre>`;
        },
        crossref: ({ node }) => {
          const targetType =
            node.attrs.targetType === "table" ? "table" : "document";
          const label =
            input.crossrefTitles.get(
              crossrefTargetKey(targetType, attr(node.attrs, "targetId")),
            ) ??
            attr(node.attrs, "label") ??
            "Reference";
          return `<span class="crossref">${escapeHtml(label || "Reference")}</span>`;
        },
      },
    },
  });
}

// Runs inside Chromium only: render every diagram, then flag the page ready.
const MERMAID_RUNNER = `
(async () => {
  const done = () => document.documentElement.setAttribute("data-weaver-ready", "true");
  const timer = setTimeout(done, ${MERMAID_WAIT_MS});
  try {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, theme: "default" });
    for (const block of document.querySelectorAll("pre.mermaid")) {
      const source = block.textContent ?? "";
      try {
        const { svg } = await mermaid.render("d" + Math.random().toString(36).slice(2), source);
        block.innerHTML = svg;
      } catch {
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = source;
        pre.appendChild(code);
        block.replaceWith(pre);
      }
    }
  } finally {
    clearTimeout(timer);
    done();
  }
})();
`;

export function buildDocumentPrintHtml(input: PrintHtmlInput): string {
  const mermaid = Boolean(input.mermaidScript) && hasMermaid(input.contentJson);
  if (mermaid && /<\/script/i.test(input.mermaidScript))
    throw new Error("mermaid bundle contains a closing script tag");
  const body = renderBody(input, mermaid);
  const readyAttr = mermaid ? "" : ' data-weaver-ready="true"';
  const scripts = mermaid
    ? `<script>${input.mermaidScript}</script><script>${MERMAID_RUNNER}</script>`
    : "";
  return `<!doctype html>
<html lang="en"${readyAttr}>
<head>
<meta charset="utf-8">
<title>${escapeHtml(input.title)}</title>
<style>${PRINT_STYLES}</style>
</head>
<body>
<h1 class="title">${escapeHtml(input.title)}</h1>
<p class="meta">${metadataLine(input.metadata)}</p>
<article class="document-prose">${body}</article>
${scripts}
</body>
</html>
`;
}

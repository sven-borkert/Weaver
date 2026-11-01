import {
  Extension,
  flattenExtensions,
  type AnyExtension,
  type Node as TiptapNode,
} from "@tiptap/core";
import Code from "@tiptap/extension-code";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import {
  renderTableToMarkdown,
  Table,
  TableCell,
  TableHeader,
  TableKit,
} from "@tiptap/extension-table";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { common, createLowlight } from "lowlight";
import { Callout } from "./callout";
import { Crossref } from "./crossref";
import {
  ImageTagBlock,
  ImageTagInline,
  imageWidth,
  parseImageWidth,
  renderImageTag,
  TAG_LEAD_ATTR,
  TAG_TRAIL_ATTR,
} from "./imageTag";
import {
  altText,
  codeFence,
  escapeBlockStarts,
  escapeCellPipes,
  linkDestination,
  quotedTitle,
} from "./markdownEscapes";
import { Mermaid } from "./mermaid";

export const codeBlockLowlight = createLowlight(common);

const text = (value: unknown): string =>
  typeof value === "string" ? value : "";

const MarkdownCode = Code.extend({
  excludes: "",
  renderMarkdown: (node, helpers) => {
    if (!node.content) return "";
    const fence = "`".repeat(Number(node.attrs?.fence) || 1);
    const pad = node.attrs?.pad ? " " : "";
    return `${fence}${pad}${helpers.renderChildren(node.content)}${pad}${fence}`;
  },
});

export const MarkdownCodeBlock = CodeBlockLowlight.extend({
  renderMarkdown: (node, helpers) => {
    const body = node.content ? helpers.renderChildren(node.content) : "";
    const fence = codeFence(body);
    return `${fence}${text(node.attrs?.language)}\n${body}\n${fence}`;
  },
});

export const MarkdownImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        // Only an image copied out of a document carries a width worth keeping.
        parseHTML: (element: HTMLElement) =>
          element.hasAttribute("data-weaver-src")
            ? parseImageWidth(element.getAttribute("width"))
            : null,
      },
    };
  },
  renderMarkdown: (node) => {
    const src = text(node.attrs?.src);
    const alt = text(node.attrs?.alt);
    const title = text(node.attrs?.title);
    const width = imageWidth(node.attrs?.width);
    if (width !== null) {
      const tag = renderImageTag({ src, alt, title, width });
      // List items join their blocks with one line break; see withTagSpacing.
      return `${node.attrs?.[TAG_LEAD_ATTR] ? "\n" : ""}${tag}${
        node.attrs?.[TAG_TRAIL_ATTR] ? "\n" : ""
      }`;
    }
    return `![${altText(alt)}](${linkDestination(src)}${
      title ? quotedTitle(title) : ""
    })`;
  },
});

const MarkdownLink = Link.extend({
  renderMarkdown: (node, helpers) => {
    const title = text(node.attrs?.title);
    return `[${helpers.renderChildren(node)}](${linkDestination(
      text(node.attrs?.href),
    )}${title ? quotedTitle(title) : ""})`;
  },
});

const StockParagraph = flattenExtensions([StarterKit]).find(
  (extension) => extension.name === "paragraph",
) as TiptapNode;
const stockParagraphMarkdown = StockParagraph.config.renderMarkdown!;

const MarkdownParagraph = StockParagraph.extend({
  renderMarkdown: (node, helpers, context) =>
    escapeBlockStarts(stockParagraphMarkdown(node, helpers, context)),
});

const MarkdownTable = Table.extend({
  renderMarkdown: (node, helpers) =>
    renderTableToMarkdown(node, {
      ...helpers,
      renderChildren: (nodes, separator) =>
        escapeCellPipes(helpers.renderChildren(nodes, separator)),
    }),
});

// Pasted merged cells collapse to single cells; the server validator stays as backstop.
const unmergedSpans = {
  colspan: { default: 1, parseHTML: () => 1 },
  rowspan: { default: 1, parseHTML: () => 1 },
};

const UnmergedTableCell = TableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), ...unmergedSpans };
  },
});

const UnmergedTableHeader = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), ...unmergedSpans };
  },
});

// Cells emit `<br>` for hard breaks; the server has no DOMParser to read it back.
const HtmlLineBreak = Extension.create({
  name: "htmlLineBreak",
  markdownTokenizer: {
    name: "htmlLineBreak",
    level: "inline",
    start: (src) => src.indexOf("<br"),
    tokenize: (src) => {
      const match = /^<br\s*\/?>/i.exec(src);
      return match ? { type: "br", raw: match[0] } : undefined;
    },
  },
});

// Server serialization and the editor must use the same extensions.
// A MarkdownManager built from these leaves transient image-tag markers in its
// output; only parseDocumentBody removes them, so never call its parse directly.
export function documentExtensions(
  overrides: {
    mermaid?: AnyExtension;
    image?: AnyExtension;
    crossref?: AnyExtension;
    codeBlock?: AnyExtension;
  } = {},
): AnyExtension[] {
  return [
    StarterKit.configure({
      code: false,
      codeBlock: false,
      link: false,
      paragraph: false,
    }),
    MarkdownParagraph,
    MarkdownLink.configure({
      HTMLAttributes: {
        target: "_blank",
        rel: "noopener noreferrer",
      },
    }),
    // Markdown permits emphasis and links around inline code.
    MarkdownCode,
    overrides.mermaid ?? Mermaid,
    (overrides.codeBlock ?? MarkdownCodeBlock).configure({
      lowlight: codeBlockLowlight,
    }),
    TableKit.configure({ table: false, tableCell: false, tableHeader: false }),
    MarkdownTable,
    UnmergedTableCell,
    UnmergedTableHeader,
    HtmlLineBreak,
    overrides.image ?? MarkdownImage,
    ImageTagBlock,
    ImageTagInline,
    TaskList,
    TaskItem.configure({ nested: true }),
    Markdown,
    overrides.crossref ?? Crossref,
    Callout,
  ];
}

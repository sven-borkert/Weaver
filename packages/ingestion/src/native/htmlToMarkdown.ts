import TurndownService from "turndown";
import { escapeMarkdownCell } from "../markdown";

const service = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "_",
});
service.remove(["style", "script"]);
service.addRule("dropEmptyImage", {
  filter: (node) => node.nodeName === "IMG" && !node.getAttribute("src"),
  replacement: () => "",
});
service.addRule("table", {
  filter: "table",
  replacement: (_content, node) => tableToMarkdown(node),
});
// turndown pads bullet/number markers to 4 chars; use a single space instead.
service.addRule("listItem", {
  filter: "li",
  replacement: (content, node) => {
    const cleaned = content.replace(/^\n+/, "").replace(/\n+$/, "\n");
    const parent = node.parentElement;
    let prefix = `${service.options.bulletListMarker} `;
    if (parent?.nodeName === "OL") {
      const start = parent.getAttribute("start");
      const index = Array.prototype.indexOf.call(parent.children, node);
      prefix = `${start ? Number(start) + index : index + 1}. `;
    }
    const indented = cleaned.replace(/\n/g, `\n${" ".repeat(prefix.length)}`);
    return prefix + indented + (node.nextSibling ? "\n" : "");
  },
});

function cellText(cell: HTMLElement): string {
  // Strip the default hard-break padding so <br> collapses to a bare \n for escapeMarkdownCell.
  const text = service.turndown(cell.innerHTML).trim().replace(/ +\n/g, "\n");
  return escapeMarkdownCell(text);
}

function tableToMarkdown(table: HTMLElement): string {
  const rows = Array.from(table.querySelectorAll<HTMLElement>("tr")).map(
    (row) =>
      Array.from(row.querySelectorAll<HTMLElement>("th, td")).map(cellText),
  );
  const [header, ...body] = rows;
  if (!header || header.length === 0) return "";
  const width = Math.max(header.length, ...body.map((row) => row.length));
  const pad = (row: string[]) => [
    ...row,
    ...Array.from({ length: width - row.length }, () => ""),
  ];
  const line = (row: string[]) => `| ${pad(row).join(" | ")} |`;
  return `\n\n${[line(header), line(Array.from({ length: width }, () => "---")), ...body.map(line)].join("\n")}\n\n`;
}

export function htmlToMarkdown(html: string): string {
  const markdown = service
    .turndown(html)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return markdown.length === 0 ? "" : `${markdown}\n`;
}

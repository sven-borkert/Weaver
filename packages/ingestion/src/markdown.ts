export function escapeMarkdownCell(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r\n|\r|\n/g, "<br>");
}

export function markdownTable(columns: string[], rows: string[][]): string {
  const header = `| ${columns.map(escapeMarkdownCell).join(" | ")} |\n`;
  const separator = `| ${columns.map(() => "---").join(" | ")} |\n`;
  const body = rows
    .map((row) => `| ${row.map(escapeMarkdownCell).join(" | ")} |\n`)
    .join("");
  return header + separator + body;
}

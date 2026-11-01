import { parseDocumentFile, parseTitleHeading } from "./frontmatter";
import type { DocumentReview } from "./review";

const TITLE_MAX = 200;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n(?:\r?\n)?/;

const WEAVER_HEADER_RE = /^<!-- weaver\r?\n[\s\S]*?-->\r?\n(?:\r?\n)?/;
const LEADING_LINE_RE = /^(?:\r?\n)*([^\r\n]*)(?:\r?\n|$)(?:\r?\n)?/;

function yamlTitle(block: string): string | null {
  for (const line of block.split(/\r?\n/)) {
    const entry = /^title:\s*(.*)$/.exec(line);
    if (!entry) continue;
    const raw = entry[1]!.trim();
    if (raw.startsWith('"')) {
      try {
        const parsed: unknown = JSON.parse(raw);
        return typeof parsed === "string" ? parsed : null;
      } catch {
        return raw.slice(1, raw.endsWith('"') ? -1 : undefined);
      }
    }
    if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2)
      return raw.slice(1, -1);
    return raw;
  }
  return null;
}

/** Splits an imported file into its title and body. A leading YAML block
 *  (only `title` is read) or Weaver comment header is removed; a leading
 *  `# ` heading becomes the title and leaves the body, unless the YAML names
 *  a different title — Weaver writes the title as that heading. */
export function splitImportHeader(text: string): {
  title: string | null;
  body: string;
} {
  let title: string | null = null;
  let body = text;
  const yaml = FRONTMATTER_RE.exec(text);
  const comment = yaml ? null : WEAVER_HEADER_RE.exec(text);
  if (yaml) {
    title = yamlTitle(yaml[1]!);
    body = text.slice(yaml[0].length);
  } else if (comment) {
    body = text.slice(comment[0].length);
  }
  const lead = LEADING_LINE_RE.exec(body)!;
  const heading = parseTitleHeading(lead[1]!);
  if (heading !== null && (title === null || title === heading)) {
    title = heading;
    body = body.slice(lead[0].length);
  }
  return { title: title?.trim() ? title : null, body };
}

/** Drops a leading `# ` heading that repeats `title`: the file already carries
 *  the title as that heading, so the body would show it twice. */
export function withoutTitleHeading(markdown: string, title: string): string {
  const lead = LEADING_LINE_RE.exec(markdown)!;
  return parseTitleHeading(lead[1]!) === title.trim()
    ? markdown.slice(lead[0].length)
    : markdown;
}

export function titleFromFileName(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, "");
  const stem = base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base;
  const words = stem.replace(/[_-]+/g, " ").trim();
  if (!words) return "Untitled import";
  return (words.charAt(0).toUpperCase() + words.slice(1))
    .slice(0, TITLE_MAX)
    .trim();
}

export function importTitle(text: string, fileName: string): string {
  const { title } = splitImportHeader(text);
  const candidate = (title ?? titleFromFileName(fileName))
    .replace(/[\r\n\u2028\u2029\u0000]+/g, " ")
    .trim();
  return (candidate || titleFromFileName(fileName)).slice(0, TITLE_MAX).trim();
}

/** The review block of an imported Weaver document file, or null. */
export function importedReview(text: string): DocumentReview | null {
  try {
    return parseDocumentFile(text.replace(/\r\n/g, "\n"), "markdown").meta
      .review;
  } catch {
    return null;
  }
}

export function importedAppearance(text: string) {
  try {
    return parseDocumentFile(text.replace(/\r\n/g, "\n"), "markdown").meta
      .appearance;
  } catch {
    return undefined;
  }
}

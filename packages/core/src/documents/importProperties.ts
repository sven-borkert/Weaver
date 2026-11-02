import {
  wikiPagePropertiesInputSchema,
  type WikiPagePropertiesInput,
} from "../wiki/properties";
import { parseDocumentFile } from "./frontmatter";
import type { DocumentKind } from "./kinds";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

function scalar(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {
      /* fall through to the literal text */
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'"))
    return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

function inlineList(raw: string): string[] {
  const value = raw.trim();
  const inner =
    value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  return inner
    .split(",")
    .map(scalar)
    .filter((item) => item !== "");
}

/** Reads `key: value`, `key: [a, b]` and block lists of a YAML front matter block. */
function yamlFields(block: string): Map<string, string | string[]> {
  const fields = new Map<string, string | string[]>();
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const entry = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]!);
    if (!entry) continue;
    const key = entry[1]!.toLowerCase();
    if (fields.has(key)) continue;
    if (entry[2]!.trim() === "") {
      const items: string[] = [];
      while (i + 1 < lines.length) {
        const item = /^\s*-\s+(.*)$/.exec(lines[i + 1]!);
        if (!item) break;
        items.push(scalar(item[1]!));
        i++;
      }
      fields.set(key, items);
    } else if (key === "tags" || key === "aliases") {
      fields.set(key, inlineList(entry[2]!));
    } else {
      fields.set(key, scalar(entry[2]!));
    }
  }
  return fields;
}

/** Keeps each field that passes writer validation; one bad field never rejects the import. */
function validFields(candidate: {
  type?: unknown;
  summary?: unknown;
  tags?: unknown;
}): WikiPagePropertiesInput | undefined {
  const out: Record<string, unknown> = {};
  for (const key of ["type", "summary", "tags"] as const) {
    let value = candidate[key];
    if (value === undefined) continue;
    if (key === "tags" && Array.isArray(value))
      value = value
        .filter(
          (tag) =>
            wikiPagePropertiesInputSchema.safeParse({ tags: [tag] }).success,
        )
        .slice(0, 20);
    const parsed = wikiPagePropertiesInputSchema.safeParse({ [key]: value });
    if (parsed.success && parsed.data[key] != null) out[key] = parsed.data[key];
  }
  return Object.keys(out).length === 0
    ? undefined
    : wikiPagePropertiesInputSchema.parse(out);
}

/**
 * Properties an import may set: `type` (never `source`), `tags` and `summary`
 * from YAML front matter (`aliases` join the tags), or the same three fields of
 * a Weaver header. `reviewExempt` and `sources` never come through an import.
 */
export function importedProperties(
  text: string,
  kind: DocumentKind = "markdown",
): WikiPagePropertiesInput | undefined {
  const normalized = text.replace(/\r\n/g, "\n");
  const yaml = kind === "markdown" ? FRONTMATTER_RE.exec(normalized) : null;
  if (yaml) {
    const fields = yamlFields(yaml[1]!);
    const list = (value: string | string[] | undefined) =>
      value === undefined
        ? []
        : Array.isArray(value)
          ? value
          : inlineList(value);
    const tags = [...list(fields.get("tags")), ...list(fields.get("aliases"))];
    const type = fields.get("type");
    const summary = fields.get("summary");
    return validFields({
      ...(typeof type === "string" && { type }),
      ...(typeof summary === "string" && { summary }),
      ...(tags.length > 0 && { tags: tags.slice(0, 20) }),
    });
  }
  try {
    const properties = parseDocumentFile(normalized, kind).meta.properties;
    return properties
      ? validFields({
          type: properties.type,
          summary: properties.summary,
          tags: properties.tags,
        })
      : undefined;
  } catch {
    return undefined;
  }
}

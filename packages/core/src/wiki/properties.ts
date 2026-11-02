export const WIKI_PAGE_TYPES = [
  "summary",
  "entity",
  "concept",
  "topic",
  "synthesis",
  "overview",
  "guide",
  "report",
  "note",
] as const;
export type WikiPageType = (typeof WIKI_PAGE_TYPES)[number];

export const WIKI_SOURCE_KINDS = [
  "document",
  "table",
  "artifact",
  "url",
] as const;
export type WikiSourceRef = {
  kind: (typeof WIKI_SOURCE_KINDS)[number];
  id?: string;
  url?: string;
};
export type WikiPageProperties = {
  type?: string;
  summary?: string;
  tags?: string[];
  sources?: WikiSourceRef[];
  reviewExempt?: boolean;
};

export const MAX_WIKI_TYPE_CHARS = 40;
export const MAX_WIKI_SUMMARY_CHARS = 300;
export const MAX_WIKI_TAGS = 20;
export const MAX_WIKI_TAG_CHARS = 40;
export const MAX_WIKI_SOURCES = 50;
const MAX_ID_CHARS = 200;
const MAX_URL_CHARS = 2000;
export const MAX_PROPERTIES_LINE_CHARS = 60_000;

const CONTROL = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u;

function line(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length === 0 || [...value].length > max || CONTROL.test(value))
    return null;
  return value;
}

function httpUrl(raw: unknown): string | null {
  const value = line(raw, MAX_URL_CHARS);
  if (value === null || /\s/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

function normalizeSource(raw: unknown): WikiSourceRef | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return null;
  const r = raw as Record<string, unknown>;
  const kind = WIKI_SOURCE_KINDS.find((k) => k === r.kind);
  if (kind === undefined) return null;
  if (kind === "url") {
    const url = httpUrl(r.url);
    return url === null ? null : { kind, url };
  }
  const id = line(r.id, MAX_ID_CHARS);
  return id === null ? null : { kind, id };
}

/** Drops invalid values; null when nothing valid remains. Keys come out in canonical order. */
export function normalizeProperties(raw: unknown): WikiPageProperties | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return null;
  const r = raw as Record<string, unknown>;
  const out: WikiPageProperties = {};
  const type = line(r.type, MAX_WIKI_TYPE_CHARS);
  if (type !== null) out.type = type;
  const summary = line(r.summary, MAX_WIKI_SUMMARY_CHARS);
  if (summary !== null) out.summary = summary;
  if (Array.isArray(r.tags)) {
    const tags: string[] = [];
    for (const item of r.tags) {
      const tag = line(item, MAX_WIKI_TAG_CHARS);
      if (tag !== null && !tags.includes(tag)) tags.push(tag);
      if (tags.length === MAX_WIKI_TAGS) break;
    }
    if (tags.length > 0) out.tags = tags;
  }
  if (Array.isArray(r.sources)) {
    const sources: WikiSourceRef[] = [];
    for (const item of r.sources) {
      const source = normalizeSource(item);
      if (source !== null) sources.push(source);
      if (sources.length === MAX_WIKI_SOURCES) break;
    }
    if (sources.length > 0) out.sources = sources;
  }
  if (r.reviewExempt === true) out.reviewExempt = true;
  return Object.keys(out).length === 0 ? null : out;
}

/** Parses a header `properties` line value; never throws. */
export function parsePropertiesLine(raw: string): WikiPageProperties | null {
  if (raw.length > MAX_PROPERTIES_LINE_CHARS) return null;
  try {
    return normalizeProperties(JSON.parse(raw));
  } catch {
    return null;
  }
}

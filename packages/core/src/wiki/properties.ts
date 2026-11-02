import { z } from "zod";
import { CoreError } from "../errors";

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

function foldedType(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu, "")
    .trim()
    .toLowerCase();
}

/** True for any case, width or whitespace variant of the reserved `source` type. */
export function isReservedWikiType(value: string | undefined): boolean {
  return value !== undefined && foldedType(value) === "source";
}

const inputLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (value) => !CONTROL.test(value),
      "must not contain control characters",
    );

const sourceInput = z
  .strictObject({
    kind: z.enum(WIKI_SOURCE_KINDS),
    id: inputLine(MAX_ID_CHARS).optional(),
    url: inputLine(MAX_URL_CHARS).optional(),
  })
  .superRefine((source, ctx) => {
    if (source.kind === "url") {
      if (source.id !== undefined || httpUrl(source.url) === null)
        ctx.addIssue({
          code: "custom",
          message: "a url source needs an http(s) url and no id",
        });
    } else if (source.id === undefined || source.url !== undefined)
      ctx.addIssue({
        code: "custom",
        message: "a document, table or artifact source needs an id and no url",
      });
  });

/**
 * Writable page properties. `null` clears a field, an omitted field stays.
 * `reviewExempt` and the `source` type are reserved and not accepted.
 */
export const wikiPagePropertiesInputSchema = z
  .strictObject({
    type: inputLine(MAX_WIKI_TYPE_CHARS)
      .refine((value) => !isReservedWikiType(value), "type source is reserved")
      .nullable()
      .optional(),
    summary: inputLine(MAX_WIKI_SUMMARY_CHARS).nullable().optional(),
    tags: z
      .array(inputLine(MAX_WIKI_TAG_CHARS))
      .max(MAX_WIKI_TAGS)
      .nullable()
      .optional(),
    sources: z.array(sourceInput).max(MAX_WIKI_SOURCES).nullable().optional(),
  })
  .describe(
    "Page properties: type, summary, tags and sources. A field you omit stays; null clears it.",
  );
/** Tool-facing subset: sources stay with the UI and importers to keep schemas small. */
export const wikiPagePropertiesToolSchema = wikiPagePropertiesInputSchema
  .omit({ sources: true })
  .describe("Page properties. An omitted field stays; null clears it.");
export type WikiPagePropertiesInput = z.infer<
  typeof wikiPagePropertiesInputSchema
>;

/** Validates writer input; the error is BAD_REQUEST pinned to `properties`. */
export function parsePagePropertiesInput(
  raw: unknown,
): WikiPagePropertiesInput {
  const parsed = wikiPagePropertiesInputSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `.${issue.path.join(".")}` : "";
    throw new CoreError(
      "BAD_REQUEST",
      `invalid properties${where}: ${issue?.message ?? "invalid"}`,
      { field: "properties" },
    );
  }
  return parsed.data;
}

/** Patch merge: named fields replace, null clears; reserved fields on the page survive. */
export function applyPagePropertiesInput(
  existing: WikiPageProperties | undefined,
  rawInput: unknown,
): WikiPageProperties | undefined {
  const input = parsePagePropertiesInput(rawInput);
  if (
    input.type !== undefined &&
    isReservedWikiType(existing?.type) &&
    input.type !== existing?.type
  )
    throw new CoreError(
      "BAD_REQUEST",
      "the type of a source page is reserved",
      {
        field: "properties",
      },
    );
  const next: Record<string, unknown> = { ...existing };
  for (const key of ["type", "summary", "tags", "sources"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return normalizeProperties(next) ?? undefined;
}

/** Review settings written by a human end the system exemption. */
export function withoutReviewExempt(
  properties: WikiPageProperties | undefined,
): WikiPageProperties | undefined {
  if (!properties?.reviewExempt) return properties;
  const { reviewExempt: _drop, ...rest } = properties;
  return normalizeProperties(rest) ?? undefined;
}

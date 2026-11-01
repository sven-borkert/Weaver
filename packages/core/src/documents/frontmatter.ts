import type { DocumentKind } from "./kinds";
import { normalizeAppearance, type Appearance } from "../appearance/metadata";
import {
  canonicalReviewers,
  MAX_REVIEWERS,
  REVIEW_MONTHS_MAX,
  REVIEW_MONTHS_MIN,
  type DocumentReview,
  type ReviewerRef,
} from "./review";

/** `id` is null for an author outside Weaver; `name` is the name at write time. */
export type DocumentAuthor = { id: string | null; name: string };

/** `createdBy`/`updatedBy` are null only in files written before authorship was recorded. */
export type DocumentMeta = {
  id: string;
  title: string;
  created: string;
  createdBy: DocumentAuthor | null;
  updated: string;
  updatedBy: DocumentAuthor | null;
  /** Null only in files written before DOCUMENT_HEADER_VERSION 3. */
  review: DocumentReview | null;
  appearance?: Appearance;
};

export const MAX_AUTHOR_NAME_CHARS = 200;

export class FrontmatterError extends Error {}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** YAML frontmatter, the format before DOCUMENT_HEADER_VERSION 2. */
const FM_RE = new RegExp(
  `^---\\nid: (${UUID})\\ntitle: ("[^\\n]*")\\ncreated: (\\S+)\\n(?:createdBy: (\\{[^\\n]*\\})\\n)?updated: (\\S+)\\n(?:updatedBy: (\\{[^\\n]*\\})\\n)?---\\n\\n?`,
);
const UUID_RE = new RegExp(`^${UUID}$`);
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function assertCanonicalUuid(id: string): void {
  if (!UUID_RE.test(id)) {
    throw new FrontmatterError("id is not a canonical UUID");
  }
}

function assertCanonicalUtcTimestamp(timestamp: string): void {
  if (!UTC_TIMESTAMP.test(timestamp)) {
    throw new FrontmatterError("timestamp is not canonical ISO-8601 UTC");
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== timestamp) {
    throw new FrontmatterError("timestamp is not canonical ISO-8601 UTC");
  }
}

/** Throws unless `name` is a usable one-line author name. */
export function assertAuthorName(name: string): void {
  if (
    name.length === 0 ||
    [...name].length > MAX_AUTHOR_NAME_CHARS ||
    name.trim() !== name ||
    /[\p{Cc}\u2028\u2029]/u.test(name)
  ) {
    throw new FrontmatterError("author name is not a valid one-line name");
  }
}

/** The author for a Weaver user: display name, else email, as one line of at most MAX_AUTHOR_NAME_CHARS. */
export function authorForUser(user: {
  id: string;
  name: string | null;
  email: string;
}): DocumentAuthor {
  const oneLine = (value: string) =>
    [...value.replace(/[\p{Cc}\u2028\u2029\s]+/gu, " ").trim()]
      .slice(0, MAX_AUTHOR_NAME_CHARS)
      .join("")
      .trim();
  return { id: user.id, name: oneLine(user.name ?? "") || oneLine(user.email) };
}

function assertAuthor(author: DocumentAuthor | null): void {
  if (author === null) return;
  if (author.id !== null) assertCanonicalUuid(author.id);
  assertAuthorName(author.name);
}

function assertCanonicalMeta(meta: DocumentMeta): void {
  assertCanonicalUuid(meta.id);
  assertCanonicalUtcTimestamp(meta.created);
  assertCanonicalUtcTimestamp(meta.updated);
  assertAuthor(meta.createdBy);
  assertAuthor(meta.updatedBy);
  assertCanonicalReview(meta.review);
}

function assertCanonicalReview(review: DocumentReview | null): void {
  if (review === null) return;
  if (
    !Number.isInteger(review.everyMonths) ||
    review.everyMonths < REVIEW_MONTHS_MIN ||
    review.everyMonths > REVIEW_MONTHS_MAX
  )
    throw new FrontmatterError("reviewEvery is out of range");
  assertCanonicalUtcTimestamp(review.since);
  if ((review.lastReviewed === null) !== (review.reviewedBy === null))
    throw new FrontmatterError(
      "lastReviewed and reviewedBy must be set together",
    );
  if (review.lastReviewed !== null)
    assertCanonicalUtcTimestamp(review.lastReviewed);
  assertAuthor(review.reviewedBy);
  if (review.reviewers.length > MAX_REVIEWERS)
    throw new FrontmatterError("too many reviewers");
  for (const ref of review.reviewers) {
    if (ref.type !== "user" && ref.type !== "group")
      throw new FrontmatterError("reviewer type is invalid");
    assertCanonicalUuid(ref.id);
    assertAuthorName(ref.name);
  }
  if (
    JSON.stringify(canonicalReviewers(review.reviewers)) !==
    JSON.stringify(review.reviewers)
  )
    throw new FrontmatterError("reviewers are not in canonical order");
}

/** Keeps `-->` out of the comment block; JSON parsing reverses it. */
function encodeCommentJson(value: unknown): string {
  return JSON.stringify(value).replace(/>/g, "\\u003e");
}

function authorLine(key: string, author: DocumentAuthor): string {
  return `${key}: ${encodeCommentJson({ id: author.id, name: author.name })}`;
}

function reviewLines(review: DocumentReview | null): string[] {
  if (review === null) return [];
  const refs = review.reviewers.map(({ type, id, name }) => ({
    type,
    id,
    name,
  }));
  return [
    `reviewers: ${encodeCommentJson(refs)}`,
    `reviewEvery: ${review.everyMonths}`,
    `reviewSince: ${review.since}`,
    ...(review.lastReviewed === null
      ? []
      : [
          `lastReviewed: ${review.lastReviewed}`,
          ...(review.reviewedBy === null
            ? []
            : [authorLine("reviewedBy", review.reviewedBy)]),
        ]),
  ];
}

/** Header lines shared by both kinds, without the title. */
function headerLines(
  meta: DocumentMeta,
  appearance: Appearance | null,
): string[] {
  return [
    `id: ${meta.id}`,
    `created: ${meta.created}`,
    ...(meta.createdBy ? [authorLine("createdBy", meta.createdBy)] : []),
    `updated: ${meta.updated}`,
    ...(meta.updatedBy ? [authorLine("updatedBy", meta.updatedBy)] : []),
    ...reviewLines(meta.review),
    ...(appearance ? [`appearance: ${encodeCommentJson(appearance)}`] : []),
  ];
}

function parseReviewers(raw: string): ReviewerRef[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new FrontmatterError("reviewers is not valid JSON");
  }
  if (!Array.isArray(value))
    throw new FrontmatterError("reviewers must be an array");
  const refs = value.map((entry: unknown) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Object.keys(entry).join(",") !== "type,id,name"
    )
      throw new FrontmatterError("reviewer must have exactly type, id, name");
    const { type, id, name } = entry as Record<string, unknown>;
    if (
      typeof type !== "string" ||
      typeof id !== "string" ||
      typeof name !== "string"
    )
      throw new FrontmatterError("reviewer field has the wrong type");
    return { type, id, name } as ReviewerRef;
  });
  if (encodeCommentJson(refs) !== raw)
    throw new FrontmatterError("reviewers is not in canonical form");
  return refs;
}

function parseAuthor(
  raw: string | undefined,
  encode: (value: unknown) => string,
): DocumentAuthor | null {
  if (raw === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new FrontmatterError("author is not a valid JSON object");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Object.keys(value).sort().join(",") !== "id,name"
  ) {
    throw new FrontmatterError("author must have exactly id and name");
  }
  const { id, name } = value as { id: unknown; name: unknown };
  if ((id !== null && typeof id !== "string") || typeof name !== "string") {
    throw new FrontmatterError("author id or name has the wrong type");
  }
  // Canonical form only, so compose(parse(file)) stays byte-exact.
  if (encode({ id, name }) !== raw) {
    throw new FrontmatterError("author is not in canonical form");
  }
  return { id, name };
}

// Inline Markdown a heading would otherwise render: code, emphasis, links,
// HTML, strikethrough, and an `&` that starts an entity reference.
const TITLE_SPECIALS =
  /[\\`*_[\]<~]|&(?=[A-Za-z][A-Za-z0-9]{0,31};|#[0-9]{1,7};|#[xX][0-9a-fA-F]{1,6};)/g;

/** The `# Title` line other Markdown viewers show; the title reads back exactly. */
export function composeTitleHeading(title: string): string {
  const escaped = title.replace(TITLE_SPECIALS, "\\$&");
  // A trailing # would be taken as the heading's closing sequence.
  return `# ${escaped.endsWith("#") ? `${escaped.slice(0, -1)}\\#` : escaped}`;
}

/** The title of an ATX level-1 heading line, or null when `line` is not one. */
export function parseTitleHeading(line: string): string | null {
  const match = /^ {0,3}# +([^\n]*?)(?: +#+)? *$/.exec(line);
  if (!match) return null;
  const title = match[1]!.replace(/\\([!-/:-@[-`{-~])/g, "$1").trim();
  return title.length > 0 ? title : null;
}

/** Version written by composeDocumentFile: hidden comment header, title as the leading `# ` heading. */
export const DOCUMENT_HEADER_VERSION = 3;

type HeaderGroups = {
  shebang?: string;
  id: string;
  title?: string;
  created: string;
  createdBy?: string;
  updated: string;
  updatedBy?: string;
  reviewers?: string;
  reviewEvery?: string;
  reviewSince?: string;
  lastReviewed?: string;
  reviewedBy?: string;
  appearance?: string;
};

/** The header field lines, each prefixed by `prefix` ("" in a comment block, "# " in Python). */
function headerSource(prefix: string, withTitle: boolean): string {
  const p = prefix;
  return (
    `${p}id: (?<id>${UUID})\\n` +
    (withTitle ? `${p}title: (?<title>"[^\\n]*")\\n` : "") +
    `${p}created: (?<created>\\S+)\\n` +
    `(?:${p}createdBy: (?<createdBy>\\{[^\\n]*\\})\\n)?` +
    `${p}updated: (?<updated>\\S+)\\n` +
    `(?:${p}updatedBy: (?<updatedBy>\\{[^\\n]*\\})\\n)?` +
    `(?:${p}reviewers: (?<reviewers>\\[[^\\n]*\\])\\n` +
    `${p}reviewEvery: (?<reviewEvery>\\d{1,3})\\n` +
    `${p}reviewSince: (?<reviewSince>\\S+)\\n` +
    `(?:${p}lastReviewed: (?<lastReviewed>\\S+)\\n` +
    `${p}reviewedBy: (?<reviewedBy>\\{[^\\n]*\\})\\n)?)?` +
    `(?:${p}appearance: (?<appearance>[^\\n]*)\\n)?`
  );
}

const COMMENT_RE = new RegExp(
  `^<!-- weaver\\n${headerSource("", false)}-->\\n\\n?`,
);
const PYTHON_HEADER_RE = new RegExp(
  `^(?<shebang>#![^\\n]*\\n)?# weaver\\n${headerSource("# ", true)}# /weaver\\n\\n?`,
);
const SHEBANG_RE = /^#![^\n]*\n/;

export function composeDocumentFile(
  meta: DocumentMeta,
  body: string,
  kind: DocumentKind,
): string {
  assertCanonicalMeta(meta);
  if (/[\r\n]/.test(meta.title))
    throw new FrontmatterError("title must be a single line");
  const lines = headerLines(meta, normalizeAppearance(meta.appearance));
  if (kind === "python") {
    const shebang = SHEBANG_RE.exec(body)?.[0] ?? "";
    const rest = body.slice(shebang.length);
    const b = rest.length === 0 || rest.endsWith("\n") ? rest : `${rest}\n`;
    const withTitle = [
      lines[0]!,
      `title: ${JSON.stringify(meta.title)}`,
      ...lines.slice(1),
    ];
    return `${shebang}# weaver\n${withTitle.map((line) => `# ${line}`).join("\n")}\n# /weaver\n\n${b}`;
  }
  const b = body.endsWith("\n") ? body : `${body}\n`;
  return `<!-- weaver\n${lines.join("\n")}\n-->\n\n${composeTitleHeading(meta.title)}\n\n${b}`;
}

function metaFromGroups(g: HeaderGroups, title: string): DocumentMeta {
  if (
    g.reviewEvery !== undefined &&
    String(Number(g.reviewEvery)) !== g.reviewEvery
  )
    throw new FrontmatterError("reviewEvery is not canonical");
  let appearance: Appearance | null = null;
  if (g.appearance !== undefined) {
    try {
      appearance = normalizeAppearance(JSON.parse(g.appearance));
    } catch {
      /* Invalid optional metadata is ignored. */
    }
  }
  const meta: DocumentMeta = {
    ...(appearance === null ? {} : { appearance }),
    id: g.id,
    title,
    created: g.created,
    createdBy: parseAuthor(g.createdBy, encodeCommentJson),
    updated: g.updated,
    updatedBy: parseAuthor(g.updatedBy, encodeCommentJson),
    review:
      g.reviewers === undefined
        ? null
        : {
            reviewers: parseReviewers(g.reviewers),
            everyMonths: Number(g.reviewEvery),
            since: g.reviewSince!,
            lastReviewed: g.lastReviewed ?? null,
            reviewedBy: parseAuthor(g.reviewedBy, encodeCommentJson),
          },
  };
  assertCanonicalMeta(meta);
  return meta;
}

function parseJsonTitle(raw: string): string {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new FrontmatterError("title is not a valid JSON string");
  }
  if (typeof value !== "string" || JSON.stringify(value) !== raw)
    throw new FrontmatterError("title is not in canonical form");
  if (value.trim().length === 0) throw new FrontmatterError("title is empty");
  return value;
}

function parsePythonFile(text: string): {
  meta: DocumentMeta;
  body: string;
  legacy: false;
} {
  const match = PYTHON_HEADER_RE.exec(text);
  if (!match?.groups)
    throw new FrontmatterError("missing or malformed document header");
  const g = match.groups as HeaderGroups;
  const meta = metaFromGroups(g, parseJsonTitle(g.title!));
  return {
    meta,
    body: `${g.shebang ?? ""}${text.slice(match[0].length)}`,
    legacy: false,
  };
}

/** Reads the current format of `kind`; for Markdown also, as `legacy`, the YAML frontmatter of files before version 2. */
export function parseDocumentFile(
  text: string,
  kind: DocumentKind,
): {
  meta: DocumentMeta;
  body: string;
  legacy: boolean;
} {
  if (kind === "python") return parsePythonFile(text);
  const comment = COMMENT_RE.exec(text);
  if (comment?.groups) {
    const rest = text.slice(comment[0].length);
    const heading = /^\n*([^\n]*)(?:\n|$)\n?/.exec(rest)!;
    const title = parseTitleHeading(heading[1]!);
    if (title === null)
      throw new FrontmatterError("missing the leading # title heading");
    const meta = metaFromGroups(comment.groups as HeaderGroups, title);
    return { meta, body: rest.slice(heading[0].length), legacy: false };
  }
  const m = FM_RE.exec(text);
  if (!m) throw new FrontmatterError("missing or malformed document header");
  let title: unknown;
  try {
    title = JSON.parse(m[2]!);
  } catch {
    throw new FrontmatterError("title is not a valid JSON string");
  }
  if (typeof title !== "string") {
    throw new FrontmatterError("title is not a string");
  }
  const meta: DocumentMeta = {
    id: m[1]!,
    title,
    created: m[3]!,
    createdBy: parseAuthor(m[4], JSON.stringify),
    updated: m[5]!,
    updatedBy: parseAuthor(m[6], JSON.stringify),
    review: null,
  };
  assertCanonicalMeta(meta);
  return { meta, body: text.slice(m[0].length), legacy: true };
}

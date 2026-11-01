import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { CoreError } from "../errors";

export const CONTENT_CURSOR_KINDS = [
  "document",
  "rows",
  "columns",
  "options",
  "cell",
  "deleted",
  "groups",
] as const;
export type ContentCursorKind = (typeof CONTENT_CURSOR_KINDS)[number];

const cursorSchema = z
  .object({
    v: z.literal(1),
    kind: z.enum(CONTENT_CURSOR_KINDS),
    projectId: z.uuid(),
    resourceId: z.uuid(),
    snapshotCommitSha: z.string().regex(/^[0-9a-f]{40}$/),
    query: z.string().regex(/^[0-9a-f]{64}$/),
    position: z.number().int().min(0),
    /** History commit: position zero resumes after it; positive positions resume inside it. */
    after: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
  })
  .strict();
export type ContentCursor = z.infer<typeof cursorSchema>;
export type ContentCursorBinding = Omit<
  ContentCursor,
  "v" | "position" | "snapshotCommitSha"
> & { snapshotCommitSha?: string };

export function invalidCursorError(): CoreError {
  return new CoreError("BAD_REQUEST", "invalid or mismatched cursor", {
    reason: "INVALID_CURSOR",
  });
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, stable(record[key])]),
    );
  }
  return value;
}

/** SHA-256 hex digest of the canonical JSON of the logical query (page size excluded by the caller), so a cursor binds to what was asked, not how it was spelled, at a fixed size regardless of query width. */
export function cursorQueryIdentity(query: unknown): string {
  const canonical = JSON.stringify(stable(query)) ?? "null";
  return createHash("sha256").update(canonical).digest("hex");
}

/** Shared HMAC primitive for every cursor codec; each codec supplies its own domain prefix so cursors from different codecs never verify against each other. */
export function signCursorPayload(
  domain: string,
  payload: string,
  secret = process.env.AUTH_SECRET,
): Buffer {
  if (!secret)
    throw new CoreError(
      "INTERNAL_SERVER_ERROR",
      "Cursor signing is unavailable",
    );
  return createHmac("sha256", secret).update(domain).update(payload).digest();
}

function signature(payload: string, secret?: string): Buffer {
  return signCursorPayload("weaver-content-cursor-v1:", payload, secret);
}

/** A schema failure here means the server built a malformed cursor: a bug, not caller input, so it must never leak as a raw ZodError. */
function parseCursorForEncoding(cursor: ContentCursor): ContentCursor {
  try {
    return cursorSchema.parse(cursor);
  } catch (error) {
    if (error instanceof z.ZodError)
      throw new CoreError(
        "INTERNAL_SERVER_ERROR",
        "built an invalid content cursor",
      );
    throw error;
  }
}

export function encodeContentCursor(
  cursor: ContentCursor,
  secret?: string,
): string {
  const payload = Buffer.from(
    JSON.stringify(parseCursorForEncoding(cursor)),
  ).toString("base64url");
  return `${payload}.${signature(payload, secret).toString("base64url")}`;
}

export function decodeContentCursor(
  value: string,
  binding: ContentCursorBinding,
  secret?: string,
): ContentCursor {
  try {
    if (value.length > 2_000 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value))
      throw new Error();
    const [payload, supplied] = value.split(".") as [string, string];
    const expected = signature(payload, secret);
    const actual = Buffer.from(supplied, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new Error();
    const cursor = cursorSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    if (
      cursor.kind !== binding.kind ||
      cursor.projectId !== binding.projectId ||
      cursor.resourceId !== binding.resourceId ||
      cursor.query !== binding.query ||
      (binding.snapshotCommitSha !== undefined &&
        cursor.snapshotCommitSha !== binding.snapshotCommitSha)
    )
      throw new Error();
    return cursor;
  } catch (error) {
    if (error instanceof CoreError && error.code === "INTERNAL_SERVER_ERROR")
      throw error;
    throw invalidCursorError();
  }
}

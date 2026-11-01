import { CoreError } from "@weaver/core/errors";

export const ADMIN_LIST_MAX = 200;
const ADMIN_LIST_DEFAULT = 50;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalidCursor(): never {
  throw new CoreError("BAD_REQUEST", "Invalid cursor", { field: "cursor" });
}

export function clampLimit(
  limit: number | undefined,
  max = ADMIN_LIST_MAX,
): number {
  const value =
    limit === undefined || !Number.isFinite(limit) ? ADMIN_LIST_DEFAULT : limit;
  return Math.min(Math.max(Math.trunc(value), 1), max);
}

export function encodePageCursor(parts: readonly string[]): string {
  return Buffer.from(JSON.stringify(parts)).toString("base64url");
}

export function decodePageCursor(cursor: string, arity: number): string[] {
  try {
    if (
      !Number.isInteger(arity) ||
      arity < 0 ||
      !BASE64URL_PATTERN.test(cursor)
    ) {
      return invalidCursor();
    }
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) return invalidCursor();
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (
      !Array.isArray(parsed) ||
      parsed.length !== arity ||
      parsed.some((part) => typeof part !== "string")
    ) {
      return invalidCursor();
    }
    return parsed as string[];
  } catch (error) {
    if (error instanceof CoreError) throw error;
    return invalidCursor();
  }
}

export function decodeTimestampPageCursor(
  cursor: string,
  arity: number,
): [Date, ...string[]] {
  const [timestamp, ...parts] = decodePageCursor(cursor, arity);
  if (timestamp === undefined) return invalidCursor();
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== timestamp) {
    return invalidCursor();
  }
  return [date, ...parts];
}

export function decodeTimestampIdPageCursor(cursor: string): [Date, string] {
  const [date, id] = decodeTimestampPageCursor(cursor, 2);
  if (id === undefined || !UUID_PATTERN.test(id)) return invalidCursor();
  return [date, id];
}

export function decodeTextIdPageCursor(cursor: string): [string, string] {
  const [text, id] = decodePageCursor(cursor, 2);
  if (text === undefined || id === undefined || !UUID_PATTERN.test(id))
    return invalidCursor();
  return [text, id];
}

export function decodeIdPageCursor(cursor: string): string {
  const [id] = decodePageCursor(cursor, 1);
  if (id === undefined || !UUID_PATTERN.test(id)) return invalidCursor();
  return id;
}

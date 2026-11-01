import { redactSecrets } from "../security/redactSecrets";
import type { Prisma } from "@weaver/db/client";

export const MAX_MESSAGE_CHARS = 500;
export const MAX_DETAILS_CHARS = 8_192;
export const MAX_BODY_CHARS = 32_768;
export const MAX_ERROR_TEXT_CHARS = 1_024;

const MAX_LEAF_STRING_CHARS = 2_000;
const MAX_DEPTH = 8;
const SECRET_KEY =
  /authorization|credential|apikey|secret|token|password|cookie/i;
const SECRET_TEXT =
  /(?<![\w-])(?:authorization|credentials?|(?:x[-_\s]*)?api[-_\s]*key|secret|(?:access[-_\s]*|refresh[-_\s]*)?token|password|cookie)[\\"']*\s*[:=]/i;
const CONTENT_NAMES = new Set([
  "prompt",
  "prompts",
  "message",
  "messages",
  "content",
  "contents",
  "text",
  "texts",
  "body",
  "bodies",
  "history",
  "histories",
  "conversation",
  "conversations",
  "transcript",
  "transcripts",
  "messagehistory",
  "conversationhistory",
  "chathistory",
]);
const CONTENT_PREFIXES = [
  "raw",
  "user",
  "assistant",
  "system",
  "developer",
  "model",
  "document",
  "request",
  "response",
  "message",
  "conversation",
  "chat",
];

// `ErrorSummary` (errorSummary.ts) arrives already capped and secret-redacted;
// without this its `message` would be redacted as private content.
const ERROR_SUMMARY_KEYS = new Set([
  "name",
  "message",
  "code",
  "errno",
  "syscall",
  "hostname",
  "cause",
  "stack",
]);

function isErrorSummary(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || typeof record.message !== "string")
    return false;
  return Object.keys(record).every((key) => ERROR_SUMMARY_KEYS.has(key));
}

function hasCredentialScheme(text: string): boolean {
  if (/\bbearer\s+\S+/i.test(text)) return true;
  for (const match of text.matchAll(/\bbasic\s+([A-Za-z0-9._~+/-]+={0,2})/gi)) {
    const token = match[1]!;
    if (
      /^[A-Za-z0-9+/]+={0,2}$/.test(token) &&
      Buffer.from(token, "base64").toString("utf8").includes(":")
    )
      return true;
    if (
      token.length >= 24 ||
      (token.length >= 8 &&
        (/[0-9._~+/-]/.test(token) ||
          (/[a-z]/.test(token) && /[A-Z]/.test(token))))
    )
      return true;
  }
  return false;
}

export function sanitizeText(text: string, max: number): string {
  try {
    if (typeof text !== "string") return truncateText("[unavailable]", max);
    // Redact the whole field so quoted, structured, and multi-value secrets cannot leak.
    return truncateText(
      SECRET_TEXT.test(text) || hasCredentialScheme(text)
        ? "[redacted]"
        : redactSecrets(text),
      max,
    );
  } catch {
    return "[unavailable]";
  }
}

/** Cuts on UTF-16 code units while keeping surrogate pairs intact. */
export function truncateText(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;

  let end = max - 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

export function sanitizeValue(value: unknown, depth = 0): unknown {
  return sanitize(value, depth, false);
}

function sanitize(
  value: unknown,
  depth: number,
  providerBody: boolean,
): unknown {
  try {
    if (value === null || value === undefined) return value ?? null;
    if (typeof value === "string") {
      return sanitizeText(value, MAX_LEAF_STRING_CHARS);
    }
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "boolean") return value;
    if (typeof value === "bigint") return Number(value);
    if (value instanceof Date) {
      return Number.isNaN(value.getTime())
        ? "[invalid date]"
        : value.toISOString();
    }
    if (value instanceof Error) return errorSummary(value);
    if (depth >= MAX_DEPTH) return "[depth]";
    if (Array.isArray(value)) {
      return value
        .slice(0, 200)
        .map((item) => sanitize(item, depth + 1, providerBody));
    }
    if (typeof value === "object") {
      if (!providerBody && isErrorSummary(value)) {
        const summary: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) {
          summary[key] =
            key === "cause"
              ? sanitize(item, depth + 1, providerBody)
              : typeof item === "string"
                ? sanitizeText(item, MAX_LEAF_STRING_CHARS)
                : item;
        }
        return summary;
      }
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(
        value as Record<string, unknown>,
      )) {
        const normalizedKey = key.replace(/[-_\s]+/g, "").toLowerCase();
        const privateContent =
          !providerBody &&
          (CONTENT_NAMES.has(normalizedKey) ||
            CONTENT_PREFIXES.some(
              (prefix) =>
                normalizedKey.startsWith(prefix) &&
                CONTENT_NAMES.has(normalizedKey.slice(prefix.length)),
            ));
        result[key] =
          (SECRET_KEY.test(normalizedKey) &&
            !(
              normalizedKey.endsWith("tokens") &&
              typeof item === "number" &&
              Number.isFinite(item)
            )) ||
          privateContent
            ? "[redacted]"
            : sanitize(item, depth + 1, providerBody);
      }
      return result;
    }
    return sanitizeText(
      Object.prototype.toString.call(value),
      MAX_LEAF_STRING_CHARS,
    );
  } catch {
    return "[unavailable]";
  }
}

export function sanitizeDetails(
  value: unknown,
): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;

  const sanitized = sanitizeValue(value);
  const serialized = JSON.stringify(sanitized) ?? "null";
  let sourceWasTooLarge = false;
  try {
    sourceWasTooLarge =
      (JSON.stringify(value) ?? "null").length > MAX_DETAILS_CHARS;
  } catch {
    sourceWasTooLarge = true;
  }
  if (serialized.length <= MAX_DETAILS_CHARS) {
    if (
      sourceWasTooLarge &&
      sanitized &&
      typeof sanitized === "object" &&
      !Array.isArray(sanitized)
    ) {
      const marked = { ...sanitized, truncated: true };
      if (JSON.stringify(marked).length <= MAX_DETAILS_CHARS) return marked;
    }
    return sanitized as Prisma.InputJsonValue;
  }

  let low = 0;
  let high = serialized.length;
  let preview = "";
  while (low <= high) {
    const candidateLimit = Math.floor((low + high) / 2);
    const candidate = truncateText(serialized, candidateLimit);
    const candidateDetails = JSON.stringify({
      truncated: true,
      preview: candidate,
    });
    if (candidateDetails.length <= MAX_DETAILS_CHARS) {
      preview = candidate;
      low = candidateLimit + 1;
    } else {
      high = candidateLimit - 1;
    }
  }
  return { truncated: true, preview };
}

export function parseProviderBody(text: string): unknown {
  if (!/(^|\r?\n)data:/.test(text)) return JSON.parse(text) as unknown;
  const events = text.split(/\r?\n\r?\n/).flatMap((frame) => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data || data === "[DONE]") return [];
    try {
      return [JSON.parse(data) as unknown];
    } catch {
      return ["[redacted event]"];
    }
  });
  return { events };
}

export function sanitizeBody(text: string | null | undefined): string | null {
  if (!text) return null;

  try {
    const parsed = parseProviderBody(text);
    return truncateText(
      JSON.stringify(sanitize(parsed, 0, true)),
      MAX_BODY_CHARS,
    );
  } catch {
    return "[redacted body]";
  }
}

export function errorSummary(error: unknown): string {
  try {
    if (error instanceof Error) {
      return sanitizeText(
        `${error.name}: ${error.message}`,
        MAX_ERROR_TEXT_CHARS,
      );
    }
    return sanitizeText(String(error), MAX_ERROR_TEXT_CHARS);
  } catch {
    return "[error]";
  }
}

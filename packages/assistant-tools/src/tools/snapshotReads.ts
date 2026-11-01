import {
  cursorQueryIdentity,
  decodeContentCursor,
  encodeContentCursor,
  type ContentCursorKind,
} from "@weaver/core/services/contentCursors";
import { commitShaSchema } from "@weaver/core/services/contentSnapshots";
import { z } from "zod";
import { MAX_TOOL_OUTPUT_CHARS, ToolError, utf8Bytes } from "../contract";

export const atCommitShaInput = commitShaSchema
  .optional()
  .describe(
    "Pins the read to a snapshotCommitSha from an earlier read; omit for current HEAD.",
  );
export const cursorInput = z
  .string()
  .max(2_000)
  .optional()
  .describe("nextCursor from the prior page; continues at its snapshot.");

/** Backs the boundary off by one code unit when it would split a surrogate pair, so a chunk is never a lossy cut (mirrors truncateText in core/diagnostics/sanitize.ts). */
export function sliceTextChunk(
  raw: string,
  start: number,
  maxChars: number,
): { text: string; end: number } {
  let end = Math.min(start + maxChars, raw.length);
  if (end < raw.length) {
    const code = raw.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  return { text: raw.slice(start, end), end };
}

const TEXT_ENVELOPE_SLACK_CHARS = 64;

/** Serialized UTF-8 bytes left for a text field: pass the real result with the text empty and a worst-case nextCursor, since both transports cap the JSON, not the string. */
export function textChunkBudget(envelope: unknown): number {
  return (
    MAX_TOOL_OUTPUT_CHARS -
    utf8Bytes(JSON.stringify(envelope)) -
    TEXT_ENVELOPE_SLACK_CHARS
  );
}

/** sliceTextChunk (a character cap), shrunk until the chunk's JSON escaping fits budgetChars in UTF-8 BYTES; always advances by at least one code point so a cursor can never stall. */
export function fitTextChunk(
  raw: string,
  start: number,
  maxChars: number,
  budgetChars: number,
): { text: string; end: number } {
  const fits = (chunk: { text: string }) =>
    utf8Bytes(JSON.stringify(chunk.text)) - 2 <= budgetChars;
  const whole = sliceTextChunk(raw, start, maxChars);
  if (fits(whole)) return whole;
  let low = 1;
  let high = whole.end - start - 1;
  let fitted: { text: string; end: number } | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const chunk = sliceTextChunk(raw, start, middle);
    if (chunk.end === start || fits(chunk)) {
      if (chunk.end > start) fitted = chunk;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (!fitted)
    throw new ToolError(
      "BAD_REQUEST",
      "the result envelope leaves no room for a text page",
      "PAYLOAD_TOO_LARGE",
    );
  return fitted;
}

export type PinnedRequest = {
  kind: ContentCursorKind;
  projectId: string;
  resourceId: string;
  atCommitSha?: string;
  cursor?: string;
  /** Logical query without page size; becomes the cursor's binding identity. */
  query: unknown;
};

/** Cursor wins over repeated fields, but repeated fields must agree with it (concept §4.2). */
export function resolvePinnedRequest(req: PinnedRequest): {
  atCommitSha: string | undefined;
  position: number;
  query: string;
} {
  const query = cursorQueryIdentity(req.query);
  if (req.cursor === undefined)
    return { atCommitSha: req.atCommitSha, position: 0, query };
  const cursor = decodeContentCursor(req.cursor, {
    kind: req.kind,
    projectId: req.projectId,
    resourceId: req.resourceId,
    query,
    snapshotCommitSha: req.atCommitSha,
  });
  return {
    atCommitSha: cursor.snapshotCommitSha,
    position: cursor.position,
    query,
  };
}

export function continuationCursor(
  binding: {
    kind: ContentCursorKind;
    projectId: string;
    resourceId: string;
    snapshotCommitSha: string;
    query: string;
  },
  position: number | null,
): string | null {
  if (position === null) return null;
  return encodeContentCursor({ v: 1, ...binding, position });
}

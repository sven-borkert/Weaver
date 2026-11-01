import { MAX_MARKDOWN_CHARS } from "@weaver/core/documents/limits";
import { normalizeMimeType } from "@weaver/core/ingestion/mimeTypes";
import { emptyDocument, type ParseOutcome } from "../parser";

export const TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/csv"]);

export function decodeUtf8Text(
  bytes: Buffer,
): string | { failureKind: "validation"; message: string } {
  if (bytes.byteLength > MAX_MARKDOWN_CHARS * 4) {
    return {
      failureKind: "validation",
      message: `parsed content exceeds ${MAX_MARKDOWN_CHARS} characters`,
    };
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return {
      failureKind: "validation",
      message: "file is not valid UTF-8 text",
    };
  }
  if (decoded.includes("\0")) {
    return {
      failureKind: "validation",
      message: "file contains a NUL character",
    };
  }
  return decoded;
}

/** text/plain and text/markdown pass through; CSV is handled by the table path. */
export function parseText(input: {
  mimeType: string;
  bytes: Buffer;
}): ParseOutcome {
  const type = normalizeMimeType(input.mimeType);
  if (type !== "text/plain" && type !== "text/markdown") {
    return { failureKind: "parser", message: `no text parser for ${type}` };
  }
  const decoded = decodeUtf8Text(input.bytes);
  if (typeof decoded !== "string") return decoded;
  if (decoded.length > MAX_MARKDOWN_CHARS) {
    return {
      failureKind: "validation",
      message: `parsed content exceeds ${MAX_MARKDOWN_CHARS} characters`,
    };
  }
  return emptyDocument(decoded);
}

import { CoreError } from "../errors";
import { MAX_MARKDOWN_CHARS } from "./limits";

export const MAX_DOCUMENT_TEXT_CHARS = MAX_MARKDOWN_CHARS;

// Everything in C0/C1 except tab, LF and CR.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

/** LF line endings; a nonempty text ends with exactly the newline it had or one added. */
export function normalizeDocumentText(text: string): string {
  const lf = text.replace(/\r\n?/g, "\n");
  return lf.length === 0 || lf.endsWith("\n") ? lf : `${lf}\n`;
}

export function isPlainText(text: string): boolean {
  return !CONTROL_RE.test(text);
}

export function assertPlainText(text: string, field = "text"): void {
  if (!isPlainText(text))
    throw new CoreError(
      "BAD_REQUEST",
      "The file is not a text file (it contains binary or control characters)",
      { field, reason: "UNSUPPORTED_FILE" },
    );
  if (text.length > MAX_DOCUMENT_TEXT_CHARS)
    throw new CoreError("BAD_REQUEST", "Text exceeds the size limit", {
      field,
    });
}

/** The text of valid UTF-8 bytes, or null when they are not UTF-8. */
export function decodeUtf8Strict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

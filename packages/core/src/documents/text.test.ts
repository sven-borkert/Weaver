import { describe, expect, it } from "vitest";
import { CoreError } from "../errors";
import {
  MAX_DOCUMENT_TEXT_CHARS,
  assertPlainText,
  decodeUtf8Strict,
  isPlainText,
  normalizeDocumentText,
} from "./text";

describe("normalizeDocumentText", () => {
  it("converts CRLF and CR to LF and ends with one newline", () => {
    expect(normalizeDocumentText("a\r\nb\rc")).toBe("a\nb\nc\n");
    expect(normalizeDocumentText("a\n")).toBe("a\n");
    expect(normalizeDocumentText("")).toBe("");
    expect(normalizeDocumentText("a\n\n")).toBe("a\n\n");
  });
});

describe("assertPlainText", () => {
  it("accepts tabs, newlines and unicode", () => {
    expect(() => assertPlainText("def f():\n\treturn 'ü'\r\n")).not.toThrow();
    expect(isPlainText("x")).toBe(true);
  });
  it("rejects NUL and other control characters", () => {
    for (const bad of ["a\0b", "\x01", "a\x7fb", "\x85", "\x0c"]) {
      expect(() => assertPlainText(bad, "text")).toThrow(CoreError);
      expect(isPlainText(bad)).toBe(false);
    }
    expect(() => assertPlainText("\0", "text")).toThrow(
      expect.objectContaining({
        code: "BAD_REQUEST",
        details: { field: "text", reason: "UNSUPPORTED_FILE" },
      }),
    );
  });
  it("rejects text over the size limit", () => {
    expect(() =>
      assertPlainText("x".repeat(MAX_DOCUMENT_TEXT_CHARS + 1)),
    ).toThrow(CoreError);
  });
});

describe("decodeUtf8Strict", () => {
  it("decodes valid UTF-8 and refuses invalid bytes", () => {
    expect(decodeUtf8Strict(new TextEncoder().encode("héllo"))).toBe("héllo");
    expect(decodeUtf8Strict(new Uint8Array([0xff, 0xfe, 0x00]))).toBeNull();
  });
});

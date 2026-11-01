import { describe, expect, it } from "vitest";
import {
  contentTypeMatches,
  INGESTION_MIME_TYPES,
  isAllowedMimeType,
  sniffContentType,
} from "./mimeTypes";

const PDF = new TextEncoder().encode("%PDF-1.7\n...");
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0,
]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
const OLE = new Uint8Array([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0,
]);
const TIFF = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0, 0]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
]);
const TEXT = new TextEncoder().encode("# Title\n\nBody text.\n");

describe("mimeTypes", () => {
  it("allows the documented families and nothing else", () => {
    expect(isAllowedMimeType("application/pdf")).toBe(true);
    expect(isAllowedMimeType("text/markdown")).toBe(true);
    expect(isAllowedMimeType("application/x-msdownload")).toBe(false);
    expect(INGESTION_MIME_TYPES).toContain("image/png");
  });

  it("ignores parameters and case in the declared type", () => {
    expect(isAllowedMimeType("TEXT/Markdown; charset=utf-8")).toBe(true);
  });

  it("sniffs each supported binary container or image signature", () => {
    expect(sniffContentType(PDF)).toBe("application/pdf");
    expect(sniffContentType(PNG)).toBe("image/png");
    expect(sniffContentType(JPEG)).toBe("image/jpeg");
    expect(sniffContentType(ZIP)).toBe("application/zip");
    expect(sniffContentType(OLE)).toBe("application/x-ole-storage");
    expect(sniffContentType(TIFF)).toBe("image/tiff");
    expect(sniffContentType(WEBP)).toBe("image/webp");
  });

  it("returns null for content it cannot identify", () => {
    expect(sniffContentType(TEXT)).toBeNull();
  });

  it("accepts a declared type the bytes confirm", () => {
    expect(contentTypeMatches("application/pdf", PDF)).toBe(true);
    expect(contentTypeMatches("image/png", PNG)).toBe(true);
  });

  it("accepts modern Office types whose container is a zip", () => {
    expect(
      contentTypeMatches(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ZIP,
      ),
    ).toBe(true);
    expect(
      contentTypeMatches(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ZIP,
      ),
    ).toBe(true);
  });

  it("accepts legacy Office types only for an OLE container", () => {
    expect(contentTypeMatches("application/msword", OLE)).toBe(true);
    expect(contentTypeMatches("application/vnd.ms-excel", OLE)).toBe(true);
    expect(contentTypeMatches("application/msword", ZIP)).toBe(false);
  });

  it("rejects a declared binary type the bytes contradict", () => {
    expect(contentTypeMatches("application/pdf", PNG)).toBe(false);
    expect(contentTypeMatches("image/webp", JPEG)).toBe(false);
  });

  it.each([PDF, PNG, JPEG, ZIP, OLE, TIFF, WEBP])(
    "rejects recognizable binary content declared as text",
    (binary) => {
      expect(contentTypeMatches("text/plain", binary)).toBe(false);
      expect(contentTypeMatches("text/markdown", binary)).toBe(false);
      expect(contentTypeMatches("text/csv", binary)).toBe(false);
    },
  );

  it("accepts text content that has no contradictory signature", () => {
    expect(contentTypeMatches("text/markdown", TEXT)).toBe(true);
  });

  it("rejects a declared type outside the allow-list", () => {
    expect(contentTypeMatches("application/octet-stream", TEXT)).toBe(false);
  });
});

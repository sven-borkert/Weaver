import { describe, expect, it } from "vitest";
import { artifactContentMatches, contentTypeForFilename } from "./contentTypes";

const PDF = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d]);
const ZIP = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0]);
const TEXT = new TextEncoder().encode('{"a":1}');

describe("contentTypeForFilename", () => {
  it("maps known extensions case-insensitively", () => {
    expect(contentTypeForFilename("Spec.DOCX")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(contentTypeForFilename("data.json")).toBe("application/json");
    expect(contentTypeForFilename("scan.pdf")).toBe("application/pdf");
    expect(contentTypeForFilename("notes.YAML")).toBe("application/yaml");
    expect(contentTypeForFilename("notes.yml")).toBe("application/yaml");
    expect(contentTypeForFilename("Operations.ONEPKG")).toBe(
      "application/onenote",
    );
    expect(contentTypeForFilename("Section.one")).toBe("application/onenote");
  });

  it("falls back to octet-stream for unknown or missing extensions", () => {
    expect(contentTypeForFilename("archive.7z")).toBe(
      "application/octet-stream",
    );
    expect(contentTypeForFilename("README")).toBe("application/octet-stream");
  });

  it("ignores inherited Object properties as extensions", () => {
    for (const filename of [
      "a.constructor",
      "a.__proto__",
      "a.toString",
      "a.hasOwnProperty",
    ])
      expect(contentTypeForFilename(filename)).toBe("application/octet-stream");
  });
});

describe("artifactContentMatches", () => {
  it("accepts bytes that agree with the extension's type", () => {
    expect(artifactContentMatches("application/pdf", PDF)).toBe(true);
    expect(artifactContentMatches(contentTypeForFilename("a.xlsx"), ZIP)).toBe(
      true,
    );
  });

  it("rejects a recognised contradiction", () => {
    expect(artifactContentMatches("application/pdf", ZIP)).toBe(false);
    expect(artifactContentMatches(contentTypeForFilename("a.docx"), PDF)).toBe(
      false,
    );
    expect(artifactContentMatches(contentTypeForFilename("a.docx"), TEXT)).toBe(
      false,
    );
  });

  it("does not sniff text and unknown types", () => {
    expect(artifactContentMatches("application/json", TEXT)).toBe(true);
    expect(artifactContentMatches("application/octet-stream", ZIP)).toBe(true);
    expect(artifactContentMatches("text/plain", PDF)).toBe(true);
  });
});

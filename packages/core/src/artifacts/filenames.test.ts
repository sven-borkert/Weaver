import { describe, expect, it } from "vitest";
import { CoreError } from "../errors";
import { artifactFilenameKey, validateArtifactFilename } from "./filenames";

describe("validateArtifactFilename", () => {
  it("accepts an ordinary name", () => {
    expect(() =>
      validateArtifactFilename("Q3 Report (final).docx"),
    ).not.toThrow();
  });

  it.each([
    "",
    " a.txt",
    "a.txt ",
    ".env",
    "a/b.txt",
    "a\\b.txt",
    "a\u0000.txt",
    "x".repeat(256),
    // Fullwidth forms NFKC-fold onto the ASCII the raw checks reject.
    "\uff0ehidden",
    "a\uff3cb.pdf",
    "a\uff0fb.pdf",
  ])("rejects %j", (name) => {
    expect(() => validateArtifactFilename(name)).toThrow(CoreError);
  });

  it("rejects a name whose NFKC-normalised key exceeds 255 characters", () => {
    // "㍿" (U+337F) is 1 character but NFKC-expands to 4 ("株式会社").
    const name = "㍿".repeat(64);
    expect(name.length).toBe(64);
    expect(() => validateArtifactFilename(name)).toThrow(CoreError);
  });
});

describe("artifactFilenameKey", () => {
  it("is case-insensitive and NFKC-normalised", () => {
    expect(artifactFilenameKey("Report.DOCX")).toBe("report.docx");
    expect(artifactFilenameKey("ｆｕｌｌ.txt")).toBe("full.txt");
    expect(artifactFilenameKey("é.txt")).toBe(artifactFilenameKey("é.txt"));
  });
});

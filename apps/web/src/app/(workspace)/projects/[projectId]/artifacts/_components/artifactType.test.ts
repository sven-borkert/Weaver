import { describe, expect, it } from "vitest";

import { artifactTypeLabel } from "./artifactType";

describe("artifactTypeLabel", () => {
  it("names the Office container types", () => {
    expect(
      artifactTypeLabel(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Plan.docx",
      ),
    ).toBe("Word");
    expect(
      artifactTypeLabel(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Budget.xlsx",
      ),
    ).toBe("Excel");
  });

  it("names the exact and prefixed media types", () => {
    expect(artifactTypeLabel("application/pdf", "Report.pdf")).toBe("PDF");
    expect(artifactTypeLabel("application/json", "data.json")).toBe("JSON");
    expect(artifactTypeLabel("text/markdown", "notes.md")).toBe("Text");
    expect(artifactTypeLabel("image/png", "logo.png")).toBe("Image");
  });

  it("falls back to the uppercased extension", () => {
    expect(artifactTypeLabel("application/zip", "bundle.zip")).toBe("ZIP");
    expect(artifactTypeLabel("application/octet-stream", "notes.bak")).toBe(
      "BAK",
    );
  });

  it("falls back to File without a usable extension", () => {
    expect(artifactTypeLabel("application/octet-stream", "LICENSE")).toBe(
      "File",
    );
    expect(artifactTypeLabel("application/octet-stream", "archive.")).toBe(
      "File",
    );
    expect(
      artifactTypeLabel("application/octet-stream", "weird.abcdefghij"),
    ).toBe("File");
  });
});

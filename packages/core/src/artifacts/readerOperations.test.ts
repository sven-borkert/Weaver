import { expect, it } from "vitest";
import { artifactFormatOf, READER_OPERATIONS } from "./readerOperations";

it("recognizes text family filename fallbacks without weakening native gates", () => {
  for (const [filename, format] of [
    ["a.txt", "text"],
    ["a.md", "markdown"],
    ["a.csv", "csv"],
    ["a.yaml", "yaml"],
    ["a.YML", "yaml"],
  ]) {
    expect(artifactFormatOf("application/octet-stream", filename)).toBe(format);
    expect(artifactFormatOf("text/plain", filename)).toBe(format);
    expect(artifactFormatOf("image/png", filename)).toBeNull();
    expect(artifactFormatOf("application/pdf", filename)).toBe("pdf");
  }
  expect(artifactFormatOf("application/octet-stream", "a.docx")).toBeNull();
  expect(READER_OPERATIONS["text.read"]).toEqual([
    "text",
    "markdown",
    "yaml",
    "csv",
  ]);
  expect(READER_OPERATIONS["word.chapter"]).toEqual(["word"]);
});

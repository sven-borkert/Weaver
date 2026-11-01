import { describe, expect, it } from "vitest";
import { MAX_MARKDOWN_CHARS } from "@weaver/core/documents/limits";
import { parseText } from "./text";

describe("parseText", () => {
  it("passes UTF-8 text and Markdown through unchanged", () => {
    expect(
      parseText({ mimeType: "text/markdown", bytes: Buffer.from("# Hi\n") }),
    ).toMatchObject({ markdown: "# Hi\n", tables: [], warnings: [] });
    expect(
      parseText({
        mimeType: "text/plain; charset=utf-8",
        bytes: Buffer.from("plain"),
      }),
    ).toMatchObject({ markdown: "plain" });
  });

  it("fails invalid UTF-8, NUL characters, and oversized text as validation", () => {
    expect(
      parseText({ mimeType: "text/plain", bytes: Buffer.from([0xff, 0xfe]) }),
    ).toMatchObject({
      failureKind: "validation",
      message: "file is not valid UTF-8 text",
    });
    expect(
      parseText({ mimeType: "text/plain", bytes: Buffer.from("a\0b") }),
    ).toMatchObject({
      failureKind: "validation",
      message: "file contains a NUL character",
    });
    expect(
      parseText({
        mimeType: "text/plain",
        bytes: Buffer.alloc(MAX_MARKDOWN_CHARS + 1, 0x61),
      }),
    ).toMatchObject({ failureKind: "validation" });
  });
});

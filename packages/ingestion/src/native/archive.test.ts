import { describe, expect, it } from "vitest";
import { buildZip, docxFixture, xlsxFixture } from "../fixtures";
import { archiveIssue } from "./archive";
import { parseDocx } from "./docx";
import { parseXlsx } from "./xlsx";

describe("native archive bounds", () => {
  it("returns null for a valid archive", () => {
    const bytes = buildZip({ "a.txt": "hello" });
    expect(archiveIssue(bytes)).toBeNull();
  });

  it("reports an expanded-size bomb as a validation ParseFailure", () => {
    const bytes = buildZip({ "a.txt": "hello" });
    const entry = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(entry).toBeGreaterThan(0);
    bytes.writeUInt32LE(512 * 1024 * 1024, entry + 24);
    expect(archiveIssue(bytes)).toEqual({
      failureKind: "validation",
      message: "archive exceeds parser limits or has invalid metadata",
    });
  });

  it("reports non-ZIP bytes as the original parser ParseFailure", () => {
    expect(archiveIssue(Buffer.from("not a zip"))).toEqual({
      failureKind: "parser",
      message: "the archive could not be read",
    });
  });

  // Through the real parsers, so dropping a parser's archiveIssue call fails
  // here rather than silently reopening the bomb to the decompressor.
  it.each(["docx", "xlsx"] as const)(
    "rejects %s expanded-size bombs before decompression",
    async (kind) => {
      const bytes =
        kind === "docx"
          ? docxFixture({ paragraphs: ["Hello"] })
          : await xlsxFixture([{ name: "Data", rows: [["Name"], ["Ada"]] }]);
      const entry = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      expect(entry).toBeGreaterThan(0);
      bytes.writeUInt32LE(512 * 1024 * 1024, entry + 24);
      const result = await (kind === "docx"
        ? parseDocx(bytes)
        : parseXlsx(bytes));
      expect(result).toMatchObject({
        failureKind: "validation",
        message: /archive.*limit/i,
      });
    },
  );
});

import { describe, expect, it } from "vitest";
import { docxFixture } from "../fixtures";
import { parseDocx } from "./docx";

describe("parseDocx", () => {
  it("converts headings, paragraphs, and tables to Markdown", async () => {
    const outcome = await parseDocx(
      docxFixture({
        heading: "Quarterly report",
        paragraphs: ["First paragraph.", "Second paragraph."],
        table: [
          ["Region", "Revenue"],
          ["North", "12"],
        ],
      }),
    );
    expect(outcome).toMatchObject({
      markdown:
        "# Quarterly report\n\nFirst paragraph.\n\nSecond paragraph.\n\n| Region | Revenue |\n| --- | --- |\n| North | 12 |\n",
      tables: [],
      warnings: [],
    });
  });

  it("warns about dropped embedded images", async () => {
    const outcome = await parseDocx(
      docxFixture({ paragraphs: ["Text"], images: 2 }),
    );
    expect(outcome).toMatchObject({
      markdown: "Text\n",
      warnings: ["2 embedded images were not imported"],
    });
  });

  it("fails an unreadable or empty document", async () => {
    expect(await parseDocx(Buffer.from("not a zip"))).toMatchObject({
      failureKind: "parser",
    });
    expect(await parseDocx(docxFixture({}))).toMatchObject({
      failureKind: "validation",
      message: "the document contains no text",
    });
  });
});

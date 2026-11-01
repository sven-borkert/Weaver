import { describe, expect, it } from "vitest";
import { escapeMarkdownCell, markdownTable } from "./markdown";

describe("markdownTable", () => {
  it("renders a GFM table with escaped pipes and line breaks", () => {
    expect(
      markdownTable(
        ["Name", "Note"],
        [
          ["a|b", "line1\nline2"],
          ["c\\d", ""],
        ],
      ),
    ).toBe(
      "| Name | Note |\n| --- | --- |\n| a\\|b | line1<br>line2 |\n| c\\\\d |  |\n",
    );
  });

  it("escapes cells consistently", () => {
    expect(escapeMarkdownCell("x\r\ny|z")).toBe("x<br>y\\|z");
  });
});

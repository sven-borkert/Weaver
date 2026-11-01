import { describe, expect, it } from "vitest";
import { titleFromFileName } from "./title";

describe("titleFromFileName", () => {
  it("drops the extension and tidies separators", () => {
    expect(titleFromFileName("quarterly_report-2026.final.md")).toBe(
      "Quarterly report 2026.final",
    );
  });

  it("drops path components from uploaded names", () => {
    expect(titleFromFileName("folder\\nested/report_name.txt")).toBe(
      "Report name",
    );
  });

  it("falls back when the name is only an extension", () => {
    expect(titleFromFileName(".gitignore")).toBe("Untitled import");
  });

  it("truncates to the title column bound", () => {
    expect(titleFromFileName(`${"a".repeat(300)}.md`)).toHaveLength(200);
  });

  it("removes separator whitespace exposed at the truncation boundary", () => {
    expect(titleFromFileName(`${"a".repeat(199)}_b.md`)).toBe(
      `A${"a".repeat(198)}`,
    );
  });
});

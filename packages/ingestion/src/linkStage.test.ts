import { describe, expect, it } from "vitest";
import { linkQueriesFor } from "./linkStage";

describe("linkQueriesFor", () => {
  it("combines title, analysis phrases, headings, and column names without duplicates", () => {
    expect(
      linkQueriesFor({
        proposedTitle: "Quarterly revenue report",
        linkQueries: ["revenue forecast", "quarterly revenue report"],
        markdown: "# Quarterly revenue report\n\n## Regional totals\n\ntext\n",
        columns: null,
      }),
    ).toEqual([
      "quarterly or revenue or report",
      "revenue or forecast",
      "regional or totals",
    ]);
  });

  it("uses column names for tables and caps the list", () => {
    const queries = linkQueriesFor({
      proposedTitle: "Budget",
      linkQueries: Array.from(
        { length: 5 },
        (_, i) => `phrase number${i} extra`,
      ),
      markdown: null,
      columns: [
        { name: "Cost centre" },
        { name: "Amount owed" },
        { name: "Paid" },
      ],
    });
    expect(queries).toHaveLength(8);
    expect(queries[0]).toBe("budget");
    expect(queries).toContain("cost or centre or amount or owed or paid");
  });
});

import { describe, expect, it } from "vitest";
import { tableItemFromLeaf, tableHref } from "./explorer";

describe("tables explorer helpers", () => {
  it("strips the tables root from leaf paths", () => {
    const item = tableItemFromLeaf({
      id: "t1",
      title: "Budget",
      path: "tables/finance/budget.table",
      rowCount: 3,
      lastEditedAt: new Date("2026-09-01T00:00:00Z"),
      lastEditedBy: null,
    });
    expect(item.path).toBe("finance/budget.table");
  });
  it("builds table hrefs", () => {
    expect(tableHref("p1", "t1")).toBe("/projects/p1/tables/t1");
  });
});

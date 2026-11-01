import { describe, expect, it } from "vitest";
import { PathError } from "@weaver/core/documents/paths";
import {
  TABLE_DIR_RE,
  assertOutsideTablesRoot,
  folderPathOfTableDir,
  isTableDirName,
  slugFromTableDir,
  tableDirName,
  tableDirPath,
} from "./paths";

describe("table paths", () => {
  it("joins and splits table directories", () => {
    expect(tableDirPath([], "budget")).toBe("tables/budget.table");
    expect(tableDirPath(["finance", "2026"], "budget")).toBe(
      "tables/finance/2026/budget.table",
    );
    expect(folderPathOfTableDir("tables/finance/2026/budget.table")).toEqual([
      "finance",
      "2026",
    ]);
    expect(folderPathOfTableDir("tables/budget.table")).toEqual([]);
  });

  it("round-trips slugs through directory names", () => {
    expect(tableDirName("q1-forecast")).toBe("q1-forecast.table");
    expect(slugFromTableDir("q1-forecast.table")).toBe("q1-forecast");
    expect(isTableDirName("q1-forecast.table")).toBe(true);
  });

  it("rejects invalid table directory names", () => {
    for (const bad of [
      "budget",
      ".table",
      "BUDGET.table",
      "bud get.table",
      "budget.table/table",
    ]) {
      expect(isTableDirName(bad)).toBe(false);
      expect(TABLE_DIR_RE.test(bad)).toBe(false);
    }
    expect(() => slugFromTableDir("budget")).toThrow(PathError);
    expect(() => tableDirPath([".."], "budget")).toThrow(PathError);
  });

  it("rejects documents-scope paths inside the reserved tables root", () => {
    expect(() => assertOutsideTablesRoot(["tables"])).toThrow(PathError);
    expect(() => assertOutsideTablesRoot(["tables", "finance"])).toThrow(
      PathError,
    );
    expect(() => assertOutsideTablesRoot(["guides"])).not.toThrow();
    expect(() => assertOutsideTablesRoot([])).not.toThrow();
  });
});

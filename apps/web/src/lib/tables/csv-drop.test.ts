import { describe, expect, it } from "vitest";
import { isCsvFileName, partitionDroppedCsvFiles } from "./csv-drop";

describe("csv drop", () => {
  it("accepts .csv and .tsv only", () => {
    expect(isCsvFileName("a.CSV")).toBe(true);
    expect(isCsvFileName("a.tsv")).toBe(true);
    expect(isCsvFileName(".csv")).toBe(false);
    expect(isCsvFileName("a.txt")).toBe(false);
  });
  it("partitions files", () => {
    const csv = new File(["a"], "x.csv");
    const txt = new File(["a"], "x.txt");
    expect(partitionDroppedCsvFiles([csv, txt])).toEqual({
      csv: [csv],
      ignored: [txt],
    });
  });
});

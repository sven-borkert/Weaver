import { expect, it } from "vitest";
import {
  parseCsvPosition,
  csvPositionString,
  readCsvArtifactTool,
} from "./artifactsCsv";

it("preserves large cell offsets and rejects malformed CSV continuations", () => {
  const position = { row: 100, column: 400, charOffset: 80001 };
  expect(parseCsvPosition(csvPositionString(position))).toEqual(position);
  for (const value of ["0:1:0", "1:-1:0", "1:0:NaN", "1:0", "1:0:0:0"])
    expect(() => parseCsvPosition(value)).toThrow();
});

it("accepts indexed projection independently of duplicate header names", () => {
  const input = readCsvArtifactTool.inputSchema.parse({
    projectId: "11111111-1111-4111-8111-111111111111",
    filename: "data.csv",
    columns: [1000, 0],
    delimiter: "\t",
    hasHeader: false,
  });
  expect(input.columns).toEqual([1000, 0]);
  expect(input.limit).toBe(50);
});

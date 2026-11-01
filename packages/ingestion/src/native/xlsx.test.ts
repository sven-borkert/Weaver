import {
  MAX_DRAFT_TABLE_COLUMNS,
  MAX_DRAFT_TABLE_ROWS,
} from "@weaver/core/ingestion/limits";
import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";
import { xlsxFixture } from "../fixtures";
import * as tableModule from "./table";
import type * as TableModule from "./table";
import { cellText, parseCsvTable, parseXlsx } from "./xlsx";

// spies on the real implementation so every existing assertion below still
// exercises genuine tableFromRows behaviour; only the call args are observed
vi.mock("./table", async (importOriginal) => {
  const actual = await importOriginal<typeof TableModule>();
  return { ...actual, tableFromRows: vi.fn(actual.tableFromRows) };
});

describe("parseXlsx", () => {
  it("imports the first non-empty worksheet and names the skipped ones", async () => {
    const bytes = await xlsxFixture([
      { name: "Empty", rows: [] },
      {
        name: "Data",
        rows: [
          ["Name", "When", "Count", "Ok"],
          ["Ada", new Date(Date.UTC(2026, 0, 2)), 3.5, true],
          ["Bob", { formula: "1+1", result: 2 }, null, false],
        ],
      },
      { name: "Notes", rows: [["ignored"]] },
    ]);
    expect(await parseXlsx(bytes)).toEqual({
      tables: [
        {
          name: "Data",
          columns: ["Name", "When", "Count", "Ok"],
          rows: [
            ["Ada", "2026-01-02", "3.5", "true"],
            ["Bob", "2", "", "false"],
          ],
        },
      ],
      warnings: ['1 additional worksheet was skipped: "Notes"'],
    });
  });

  it("keeps every column when the sheet has a leading blank column", async () => {
    // built directly: a leading untouched column makes actualColumnCount
    // (distinct populated columns) diverge from columnCount (max column index)
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sparse");
    sheet.getRow(1).getCell(2).value = "Name";
    sheet.getRow(1).getCell(3).value = "Age";
    sheet.getRow(1).getCell(4).value = "City";
    sheet.getRow(2).getCell(2).value = "Ada";
    sheet.getRow(2).getCell(3).value = 36;
    sheet.getRow(2).getCell(4).value = "NYC";
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    expect(await parseXlsx(bytes)).toEqual({
      tables: [
        {
          name: "Sparse",
          columns: ["Column 1", "Name", "Age", "City"],
          rows: [["", "Ada", "36", "NYC"]],
        },
      ],
      warnings: [],
    });
  });

  it("caps rows and columns read before validating bounds, on a sheet far exceeding both", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Huge");
    const rowCount = MAX_DRAFT_TABLE_ROWS + 50;
    const colCount = MAX_DRAFT_TABLE_COLUMNS + 50;
    for (let row = 1; row <= rowCount; row += 1) {
      sheet.getRow(row).getCell(1).value = `r${row}`;
      sheet.getRow(row).getCell(colCount).value = `c${row}`;
    }
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    expect(await parseXlsx(bytes)).toMatchObject({
      failureKind: "validation",
      message: `a table draft may have at most ${MAX_DRAFT_TABLE_COLUMNS} columns`,
    });
    const tableFromRowsMock = vi.mocked(tableModule.tableFromRows);
    const [rowsPassed] = tableFromRowsMock.mock.calls.at(-1)!;
    expect(rowsPassed.length).toBeLessThanOrEqual(MAX_DRAFT_TABLE_ROWS + 2);
    expect(rowsPassed.length).toBeLessThan(rowCount);
    expect(rowsPassed[0]!.length).toBeLessThanOrEqual(
      MAX_DRAFT_TABLE_COLUMNS + 1,
    );
    expect(rowsPassed[0]!.length).toBeLessThan(colCount);
  });

  it("fails unreadable or empty workbooks", async () => {
    expect(await parseXlsx(Buffer.from("nope"))).toMatchObject({
      failureKind: "parser",
    });
    expect(
      await parseXlsx(await xlsxFixture([{ name: "Empty", rows: [] }])),
    ).toMatchObject({
      failureKind: "validation",
      message: "the spreadsheet contains no data",
    });
  });
});

describe("cellText", () => {
  it("normalizes rich text, hyperlinks, errors, and timestamps", () => {
    expect(cellText({ richText: [{ text: "a" }, { text: "b" }] })).toBe("ab");
    expect(cellText({ text: "Site", hyperlink: "https://x" })).toBe("Site");
    expect(cellText({ error: "#DIV/0!" })).toBe("#DIV/0!");
    expect(cellText(new Date(Date.UTC(2026, 0, 2, 13, 30)))).toBe(
      "2026-01-02T13:30:00.000Z",
    );
    expect(cellText(null)).toBe("");
  });
});

describe("parseCsvTable", () => {
  it("turns CSV rows into one table", () => {
    expect(parseCsvTable('h1,h2\n"a,1",2\n')).toEqual({
      tables: [{ name: null, columns: ["h1", "h2"], rows: [["a,1", "2"]] }],
      warnings: [],
    });
    expect(parseCsvTable('a,"b')).toMatchObject({ failureKind: "validation" });
  });

  it("keeps cells beyond the header and reports them in one warning", () => {
    expect(parseCsvTable("Name\nAda,42\nBob\nCy,7,x\nDi,,\n")).toEqual({
      tables: [
        {
          name: null,
          columns: ["Name", "Column 2", "Column 3"],
          rows: [
            ["Ada", "42", ""],
            ["Bob", "", ""],
            ["Cy", "7", "x"],
            ["Di", "", ""],
          ],
        },
      ],
      warnings: [
        "2 rows had more cells than the header; the extra values were kept in generated columns (first: row 2)",
      ],
    });
  });
});

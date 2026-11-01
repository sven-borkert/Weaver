import { archiveIssue } from "./archive";
import {
  MAX_DRAFT_TABLE_COLUMNS,
  MAX_DRAFT_TABLE_ROWS,
} from "@weaver/core/ingestion/limits";
import ExcelJS from "exceljs";
import type { ParsedTable, ParseFailure } from "../parser";
import { parseCsvRows } from "./csv";
import { headerOverflowWarning, tableFromRows } from "./table";

type Tables = { tables: ParsedTable[]; warnings: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    const iso = value.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
  }
  if (isRecord(value)) {
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText
        .map((run) =>
          isRecord(run) ? String((run.text as string | undefined) ?? "") : "",
        )
        .join("");
    }
    if ("formula" in value || "sharedFormula" in value) {
      return cellText((value as ExcelJS.CellFormulaValue).result ?? null);
    }
    if ("hyperlink" in value) {
      const text = (value as ExcelJS.CellHyperlinkValue).text;
      return typeof text === "string" ? text : cellText(text);
    }
    if ("error" in value) return String(value.error);
  }
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- record variants are all handled above
  return String(value);
}

function sheetRows(sheet: ExcelJS.Worksheet): string[][] {
  const rows: string[][] = [];
  const width = Math.min(sheet.columnCount, MAX_DRAFT_TABLE_COLUMNS + 1);
  // +2: the first captured row becomes the header in tableFromRows, so this
  // still leaves one-past-the-limit data rows for draftTableIssue to reject
  const maxRows = MAX_DRAFT_TABLE_ROWS + 2;
  sheet.eachRow({ includeEmpty: false }, (row) => {
    if (rows.length >= maxRows) return;
    rows.push(
      Array.from({ length: width }, (_, index) =>
        cellText(row.getCell(index + 1).value),
      ),
    );
  });
  return rows;
}

export async function parseXlsx(bytes: Buffer): Promise<Tables | ParseFailure> {
  const issue = archiveIssue(bytes);
  if (issue) return issue;
  const workbook = new ExcelJS.Workbook();
  try {
    // exceljs's own @types/node (via fast-csv) shadows the workspace Buffer type
    await workbook.xlsx.load(
      bytes as unknown as Parameters<typeof workbook.xlsx.load>[0],
    );
  } catch {
    return { failureKind: "parser", message: "the workbook could not be read" };
  }
  const sheets = workbook.worksheets.filter(
    (sheet) => sheet.actualRowCount > 0,
  );
  const [first, ...rest] = sheets;
  if (!first) {
    return {
      failureKind: "validation",
      message: "the spreadsheet contains no data",
    };
  }
  const table = tableFromRows(sheetRows(first), first.name);
  if ("failureKind" in table) return table;
  const warnings =
    rest.length === 0
      ? []
      : [
          `${rest.length} additional worksheet${rest.length === 1 ? " was" : "s were"} skipped: ${rest
            .map((sheet) => `"${sheet.name}"`)
            .join(", ")}`,
        ];
  return { tables: [table], warnings };
}

export function parseCsvTable(source: string): Tables | ParseFailure {
  let rows: string[][];
  try {
    rows = parseCsvRows(source);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { failureKind: "validation", message: error.message };
  }
  const table = tableFromRows(rows, null);
  if ("failureKind" in table) return table;
  const overflow = headerOverflowWarning(rows);
  return { tables: [table], warnings: overflow ? [overflow] : [] };
}

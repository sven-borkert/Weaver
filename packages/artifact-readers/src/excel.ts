/** Pure reader for .xlsx artifacts. Beyond the port, officePackage.ts's
 *  container checks catch the legacy/encrypted/macro-enabled cases ExcelJS
 *  reports as one generic failure. */
import ExcelJS from "exceljs";
import { assertReadableArchive } from "./archive";
import { ArtifactReadError } from "./errors";
import { normalizeLimit } from "./limits";
import {
  classifyOleContainer,
  declaresMacroEnabledContentType,
} from "./officePackage";

/** The workbook's main part, whose declared content type decides whether the
 *  package is macro-enabled. */
const EXCEL_MAIN_PART = "/xl/workbook.xml";

const LEGACY_MESSAGE =
  "Legacy (.xls) workbooks are not supported; save as .xlsx.";
const MACRO_MESSAGE =
  "Macro-enabled workbooks (.xlsm/.xlsb) are not supported; save as .xlsx.";
const ENCRYPTED_MESSAGE = "Workbook is password-protected and cannot be read.";
const UNREADABLE_MESSAGE =
  "Unable to read the workbook. Corrupt or invalid files are not supported.";

const DEFAULT_MAX_CELLS = 1_000;
const HARD_MAX_CELLS = 10_000;
const DEFAULT_OVERVIEW_MAX_SHEETS = 50;
const HARD_OVERVIEW_MAX_SHEETS = 100;
const DEFAULT_OVERVIEW_SAMPLE_ROWS_PER_SHEET = 5;
const HARD_OVERVIEW_SAMPLE_ROWS_PER_SHEET = 20;
const DEFAULT_OVERVIEW_MAX_SAMPLE_CELLS = 750;
const HARD_OVERVIEW_MAX_SAMPLE_CELLS = 2_000;
const DEFAULT_OVERVIEW_MAX_COLUMNS_PER_SHEET = 25;
const HARD_OVERVIEW_MAX_COLUMNS_PER_SHEET = 100;

type ExcelLoadBuffer = Parameters<ExcelJS.Workbook["xlsx"]["load"]>[0];

export type ExcelCellOutput =
  | string
  | number
  | boolean
  | null
  | { value: number; text: string }
  | { formula: string; result: ExcelCellOutput };

export interface ExcelOverviewInput {
  maxSheets?: number;
  sampleRowsPerSheet?: number;
  maxSampleCells?: number;
  maxColumnsPerSheet?: number;
}

export interface ExcelOverview {
  sheets: ExcelSheetOverview[];
  omittedSheets: Array<{
    index: number;
    name: string;
    reason: string;
  }>;
  truncated: boolean;
  warnings: string[];
  limits: Required<ExcelOverviewInput>;
}

export interface ExcelSheetOverview {
  index: number;
  name: string;
  rowCount: number;
  actualRowCount: number;
  columnCount: number;
  actualColumnCount: number;
  usedRange: ExcelUsedRange | null;
  empty: boolean;
  nonEmptyCellCount: number;
  formulaCellCount: number;
  likelyHeaders: ExcelRowRead | null;
  sampleRows: ExcelRowRead[];
  truncated: boolean;
  warnings: string[];
}

export interface ExcelUsedRange {
  startCell: string;
  endCell: string;
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
}

export interface ExcelRowsResult {
  name: string;
  sheetName: string;
  startRow: number;
  endRow: number;
  rows: ExcelRowRead[];
  nextCursor: string | null;
  truncated: boolean;
}

export interface ExcelWorkbookDataResult {
  sheets: ExcelRowsResult[];
  nextCursor: string | null;
  truncated: boolean;
}

export interface ExcelRowRead {
  rowNumber: number;
  values: ExcelCellOutput[];
}

export async function readExcelOverview(
  data: Uint8Array,
  input: ExcelOverviewInput = {},
): Promise<ExcelOverview> {
  const workbook = await loadWorkbook(data);
  const limits = normalizeOverviewLimits(input);
  const sheets: ExcelSheetOverview[] = [];
  const omittedSheets: ExcelOverview["omittedSheets"] = [];
  const warnings: string[] = [];
  let remainingSampleCells = limits.maxSampleCells;

  workbook.worksheets.forEach((sheet, index) => {
    const sheetIndex = index + 1;
    if (sheetIndex > limits.maxSheets) {
      omittedSheets.push({
        index: sheetIndex,
        name: sheet.name,
        reason: `maxSheets limit ${limits.maxSheets} reached`,
      });
      return;
    }

    const result = overviewSheet(sheet, sheetIndex, {
      limits,
      remainingSampleCells,
    });
    sheets.push(result.sheet);
    remainingSampleCells = result.remainingSampleCells;
  });

  if (omittedSheets.length > 0) {
    warnings.push(
      `${omittedSheets.length} worksheet${omittedSheets.length === 1 ? "" : "s"} omitted because maxSheets was reached.`,
    );
  }

  return {
    sheets,
    omittedSheets,
    truncated:
      omittedSheets.length > 0 || sheets.some((sheet) => sheet.truncated),
    warnings,
    limits,
  };
}

export async function readExcelSheet(
  data: Uint8Array,
  input: {
    sheetName: string;
    range?: string;
    cursor?: string | null;
    maxCells?: number;
  },
): Promise<ExcelRowsResult> {
  const workbook = await loadWorkbook(data);
  const sheet = requireWorksheet(workbook, input.sheetName);
  const range = input.range
    ? parseRange(input.range)
    : {
        startRow: 1,
        endRow: sheet.rowCount,
        startColumn: 1,
        endColumn: Math.max(sheet.columnCount, 1),
      };
  const cursorRow = input.cursor
    ? parsePositiveInt(input.cursor, "cursor")
    : null;
  const maxCells = normalizeMaxCells(input.maxCells);
  assertRowFits(rangeColumnCount(range), maxCells, null);
  return readRowsFromSheet(sheet, {
    ...range,
    startRow: cursorRow ?? range.startRow,
    maxCells,
  });
}

export async function readExcelWorkbook(
  data: Uint8Array,
  input: { cursor?: string | null; maxCells?: number } = {},
): Promise<ExcelWorkbookDataResult> {
  const workbook = await loadWorkbook(data);
  const maxCells = normalizeMaxCells(input.maxCells);
  const { sheetIndex, rowNumber } = parseWorkbookCursor(input.cursor);
  let remaining = maxCells;
  let nextCursor: string | null = null;
  const sheets: ExcelRowsResult[] = [];

  for (let index = sheetIndex; index < workbook.worksheets.length; index += 1) {
    const sheet = workbook.worksheets[index];
    if (!sheet) continue;
    assertRowFits(Math.max(sheet.columnCount, 1), maxCells, index + 1);
    const startRow = index === sheetIndex ? rowNumber : 1;
    const result = readRowsFromSheet(sheet, {
      startRow,
      endRow: sheet.rowCount,
      startColumn: 1,
      endColumn: Math.max(sheet.columnCount, 1),
      maxCells: remaining,
    });
    if (result.rows.length > 0) sheets.push(result);
    remaining -= result.rows.length * Math.max(sheet.columnCount, 1);
    if (result.nextCursor) {
      nextCursor = `${index + 1}:${result.nextCursor}`;
      break;
    }
  }

  return {
    sheets,
    nextCursor,
    truncated: nextCursor !== null,
  };
}

async function loadWorkbook(data: Uint8Array): Promise<ExcelJS.Workbook> {
  const ole = classifyOleContainer(data);
  if (ole !== null) {
    throw ole === "encrypted"
      ? new ArtifactReadError("encrypted", ENCRYPTED_MESSAGE)
      : new ArtifactReadError("legacy_format", LEGACY_MESSAGE);
  }
  assertReadableArchive(data);
  if (declaresMacroEnabledContentType(data, EXCEL_MAIN_PART)) {
    throw new ArtifactReadError("legacy_format", MACRO_MESSAGE);
  }
  let workbook: ExcelJS.Workbook;
  try {
    workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(data) as unknown as ExcelLoadBuffer);
  } catch {
    throw new ArtifactReadError("malformed", UNREADABLE_MESSAGE);
  }
  // A ZIP without an xl/workbook.xml part loads with zero worksheets instead
  // of throwing (ExcelJS does not require the part to be present).
  if (workbook.worksheets.length === 0) {
    throw new ArtifactReadError("malformed", UNREADABLE_MESSAGE);
  }
  return workbook;
}

function rangeColumnCount(range: {
  startColumn: number;
  endColumn: number;
}): number {
  return Math.max(1, range.endColumn - range.startColumn + 1);
}

/** A row that cannot fit in maxCells would page forever: no row is returned
 *  and the cursor stays where the caller already was. */
function assertRowFits(
  columnCount: number,
  maxCells: number,
  sheetIndex: number | null,
): void {
  if (columnCount <= maxCells) return;
  const subject =
    sheetIndex === null
      ? "The requested range is"
      : `Worksheet ${sheetIndex} is`;
  throw new ArtifactReadError(
    "resource_limit",
    `${subject} ${columnCount} columns wide, so no whole row fits in maxCells ${maxCells}; pass a narrower range or a larger maxCells.`,
  );
}

function readRowsFromSheet(
  sheet: ExcelJS.Worksheet,
  args: {
    startRow: number;
    endRow: number;
    startColumn: number;
    endColumn: number;
    maxCells: number;
  },
): ExcelRowsResult {
  const columnCount = Math.max(1, args.endColumn - args.startColumn + 1);
  const rows: ExcelRowRead[] = [];
  let nextCursor: string | null = null;

  for (
    let rowNumber = args.startRow;
    rowNumber <= args.endRow;
    rowNumber += 1
  ) {
    if ((rows.length + 1) * columnCount > args.maxCells) {
      nextCursor = String(rowNumber);
      break;
    }
    const values: ExcelCellOutput[] = [];
    for (
      let columnNumber = args.startColumn;
      columnNumber <= args.endColumn;
      columnNumber += 1
    ) {
      const cell = sheet.getCell(rowNumber, columnNumber);
      values.push(cellToJson(cell.value, cell));
    }
    rows.push({ rowNumber, values });
  }

  return {
    name: sheet.name,
    sheetName: sheet.name,
    startRow: rows[0]?.rowNumber ?? args.startRow,
    endRow: rows.at(-1)?.rowNumber ?? args.startRow - 1,
    rows,
    nextCursor,
    truncated: nextCursor !== null,
  };
}

function overviewSheet(
  sheet: ExcelJS.Worksheet,
  index: number,
  args: {
    limits: Required<ExcelOverviewInput>;
    remainingSampleCells: number;
  },
): { sheet: ExcelSheetOverview; remainingSampleCells: number } {
  const analysis = analyseWorksheet(sheet);
  const warnings: string[] = [];
  let remainingSampleCells = args.remainingSampleCells;
  let truncated = false;

  if (!analysis.usedRange) {
    return {
      sheet: {
        index,
        name: sheet.name,
        rowCount: sheet.rowCount,
        actualRowCount: sheet.actualRowCount,
        columnCount: sheet.columnCount,
        actualColumnCount: sheet.actualColumnCount,
        usedRange: null,
        empty: true,
        nonEmptyCellCount: 0,
        formulaCellCount: 0,
        likelyHeaders: null,
        sampleRows: [],
        truncated: false,
        warnings: [],
      },
      remainingSampleCells,
    };
  }

  const sampleStartColumn = analysis.usedRange.startColumn;
  const sampleEndColumn = Math.min(
    analysis.usedRange.endColumn,
    sampleStartColumn + args.limits.maxColumnsPerSheet - 1,
  );
  const sampleColumnCount = sampleEndColumn - sampleStartColumn + 1;
  if (sampleEndColumn < analysis.usedRange.endColumn) {
    truncated = true;
    warnings.push(
      `Only columns ${numberToColumnLetters(sampleStartColumn)}:${numberToColumnLetters(sampleEndColumn)} are included in samples; later used columns are omitted.`,
    );
  }

  const readSampleRow = (rowNumber: number): ExcelRowRead | null => {
    if (remainingSampleCells < sampleColumnCount) {
      truncated = true;
      return null;
    }
    remainingSampleCells -= sampleColumnCount;
    return readRowFromSheet(sheet, {
      rowNumber,
      startColumn: sampleStartColumn,
      endColumn: sampleEndColumn,
    });
  };

  const headerRowNumber = analysis.nonEmptyRows[0] ?? null;
  const likelyHeaders =
    headerRowNumber === null ? null : readSampleRow(headerRowNumber);
  if (headerRowNumber !== null && likelyHeaders === null) {
    warnings.push("No sample budget remained for the likely header row.");
  }

  const sampleRows: ExcelRowRead[] = [];
  const dataRows = analysis.nonEmptyRows
    .filter((rowNumber) => rowNumber !== headerRowNumber)
    .slice(0, args.limits.sampleRowsPerSheet);
  for (const rowNumber of dataRows) {
    const row = readSampleRow(rowNumber);
    if (!row) {
      warnings.push("No sample budget remained for additional sample rows.");
      break;
    }
    sampleRows.push(row);
  }

  return {
    sheet: {
      index,
      name: sheet.name,
      rowCount: sheet.rowCount,
      actualRowCount: sheet.actualRowCount,
      columnCount: sheet.columnCount,
      actualColumnCount: sheet.actualColumnCount,
      usedRange: analysis.usedRange,
      empty: false,
      nonEmptyCellCount: analysis.nonEmptyCellCount,
      formulaCellCount: analysis.formulaCellCount,
      likelyHeaders,
      sampleRows,
      truncated,
      warnings,
    },
    remainingSampleCells,
  };
}

function analyseWorksheet(sheet: ExcelJS.Worksheet): {
  usedRange: ExcelUsedRange | null;
  nonEmptyRows: number[];
  nonEmptyCellCount: number;
  formulaCellCount: number;
} {
  let startRow = Number.POSITIVE_INFINITY;
  let endRow = 0;
  let startColumn = Number.POSITIVE_INFINITY;
  let endColumn = 0;
  let nonEmptyCellCount = 0;
  let formulaCellCount = 0;
  const nonEmptyRows = new Set<number>();

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
      if (!hasCellContent(cell.value)) return;
      nonEmptyCellCount += 1;
      if (isFormulaValue(cell.value)) formulaCellCount += 1;
      nonEmptyRows.add(rowNumber);
      startRow = Math.min(startRow, rowNumber);
      endRow = Math.max(endRow, rowNumber);
      startColumn = Math.min(startColumn, columnNumber);
      endColumn = Math.max(endColumn, columnNumber);
    });
  });

  if (nonEmptyCellCount === 0) {
    return {
      usedRange: null,
      nonEmptyRows: [],
      nonEmptyCellCount: 0,
      formulaCellCount: 0,
    };
  }

  return {
    usedRange: {
      startCell: cellAddress(startRow, startColumn),
      endCell: cellAddress(endRow, endColumn),
      startRow,
      endRow,
      startColumn,
      endColumn,
    },
    nonEmptyRows: [...nonEmptyRows].sort((a, b) => a - b),
    nonEmptyCellCount,
    formulaCellCount,
  };
}

function requireWorksheet(
  workbook: ExcelJS.Workbook,
  sheetName: string,
): ExcelJS.Worksheet {
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) {
    throw new ArtifactReadError(
      "not_found",
      `Worksheet ${sheetName} was not found`,
    );
  }
  return sheet;
}

function readRowFromSheet(
  sheet: ExcelJS.Worksheet,
  args: { rowNumber: number; startColumn: number; endColumn: number },
): ExcelRowRead {
  const values: ExcelCellOutput[] = [];
  for (
    let columnNumber = args.startColumn;
    columnNumber <= args.endColumn;
    columnNumber += 1
  ) {
    const cell = sheet.getCell(args.rowNumber, columnNumber);
    values.push(cellToJson(cell.value, cell));
  }
  return { rowNumber: args.rowNumber, values };
}

function cellToJson(
  value: ExcelJS.CellValue,
  cell?: ExcelJS.Cell,
): ExcelCellOutput {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") {
    const text = cell?.text;
    if (text !== undefined && text.trim() !== "" && text !== String(value)) {
      // Numeric cell whose formatted display differs (number formats, locale
      // artefacts like "2222, 8443" stored as 2222.8443) — expose both so
      // consumers can detect the mismatch.
      return { value, text };
    }
    return value;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (isFormulaValue(value)) {
    return {
      formula: value.formula,
      result: cellToJson(value.result),
    };
  }
  if (isRichTextValue(value)) {
    return value.richText.map((part) => part.text).join("");
  }
  if (isHyperlinkValue(value)) {
    return value.text;
  }
  return jsonFallback(value);
}

function hasCellContent(value: ExcelJS.CellValue): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.length > 0;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value instanceof Date
  ) {
    return true;
  }
  if (isFormulaValue(value)) return value.formula.trim().length > 0;
  if (isRichTextValue(value)) {
    return value.richText.some((part) => part.text.length > 0);
  }
  if (isHyperlinkValue(value)) {
    return value.text.length > 0 || value.hyperlink.length > 0;
  }
  return true;
}

function isFormulaValue(
  value: ExcelJS.CellValue,
): value is ExcelJS.CellFormulaValue {
  return typeof value === "object" && value !== null && "formula" in value;
}

function isRichTextValue(
  value: ExcelJS.CellValue,
): value is ExcelJS.CellRichTextValue {
  return typeof value === "object" && value !== null && "richText" in value;
}

function isHyperlinkValue(
  value: ExcelJS.CellValue,
): value is ExcelJS.CellHyperlinkValue {
  return typeof value === "object" && value !== null && "hyperlink" in value;
}

function jsonFallback(value: object): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unsupported cell value]";
  }
}

function parseWorkbookCursor(cursor?: string | null): {
  sheetIndex: number;
  rowNumber: number;
} {
  if (!cursor) return { sheetIndex: 0, rowNumber: 1 };
  const parts = cursor.split(":");
  if (parts.length !== 2) {
    throw new ArtifactReadError(
      "invalid_input",
      `Invalid cursor "${cursor}"; expected "sheet:row"`,
    );
  }
  const [sheet, row] = parts;
  return {
    sheetIndex: parsePositiveInt(sheet, "cursor sheet") - 1,
    rowNumber: parsePositiveInt(row, "cursor row"),
  };
}

function parseRange(range: string): {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
} {
  const [startRaw, endRaw] = range.split(":");
  const start = parseCellAddress(startRaw);
  const end = parseCellAddress(endRaw ?? startRaw);
  return {
    startRow: Math.min(start.row, end.row),
    endRow: Math.max(start.row, end.row),
    startColumn: Math.min(start.column, end.column),
    endColumn: Math.max(start.column, end.column),
  };
}

function parseCellAddress(value: string | undefined): {
  row: number;
  column: number;
} {
  const match = /^([A-Za-z]+)([1-9][0-9]*)$/.exec(value ?? "");
  if (!match) {
    throw new ArtifactReadError(
      "invalid_input",
      `Invalid cell address ${value ?? ""}`,
    );
  }
  return {
    column: columnLettersToNumber(match[1]!),
    row: Number(match[2]),
  };
}

function columnLettersToNumber(letters: string): number {
  return [...letters.toUpperCase()].reduce(
    (value, char) => value * 26 + char.charCodeAt(0) - 64,
    0,
  );
}

function numberToColumnLetters(column: number): string {
  let value = column;
  let out = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    out = String.fromCharCode(65 + remainder) + out;
    value = Math.floor((value - 1) / 26);
  }
  return out;
}

function cellAddress(row: number, column: number): string {
  return `${numberToColumnLetters(column)}${row}`;
}

function parsePositiveInt(value: string | undefined, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new ArtifactReadError("invalid_input", `Invalid ${label}`);
  }
  return number;
}

function normalizeMaxCells(value: number | undefined): number {
  return normalizeLimit({
    value,
    defaultValue: DEFAULT_MAX_CELLS,
    hardMax: HARD_MAX_CELLS,
    label: "maxCells",
  });
}

function normalizeOverviewLimits(
  input: ExcelOverviewInput,
): Required<ExcelOverviewInput> {
  return {
    maxSheets: normalizeLimit({
      value: input.maxSheets,
      defaultValue: DEFAULT_OVERVIEW_MAX_SHEETS,
      hardMax: HARD_OVERVIEW_MAX_SHEETS,
      label: "maxSheets",
    }),
    sampleRowsPerSheet: normalizeLimit({
      value: input.sampleRowsPerSheet,
      defaultValue: DEFAULT_OVERVIEW_SAMPLE_ROWS_PER_SHEET,
      hardMax: HARD_OVERVIEW_SAMPLE_ROWS_PER_SHEET,
      label: "sampleRowsPerSheet",
    }),
    maxSampleCells: normalizeLimit({
      value: input.maxSampleCells,
      defaultValue: DEFAULT_OVERVIEW_MAX_SAMPLE_CELLS,
      hardMax: HARD_OVERVIEW_MAX_SAMPLE_CELLS,
      label: "maxSampleCells",
    }),
    maxColumnsPerSheet: normalizeLimit({
      value: input.maxColumnsPerSheet,
      defaultValue: DEFAULT_OVERVIEW_MAX_COLUMNS_PER_SHEET,
      hardMax: HARD_OVERVIEW_MAX_COLUMNS_PER_SHEET,
      label: "maxColumnsPerSheet",
    }),
  };
}

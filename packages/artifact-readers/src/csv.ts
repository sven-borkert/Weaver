import { ArtifactReadError } from "./errors";
import { normalizeLimit, utf8Prefix } from "./limits";
import { decodeUtf8, literalSearchPattern } from "./text";

const MAX_RESULT_BYTES = 128 * 1024;
const MAX_METADATA_BYTES = 32 * 1024;
const MAX_CELL_BYTES = 20_000;
const MAX_LABEL_BYTES = 500;

export type CsvDelimiter = "," | ";" | "\t";
export type CsvReadInput = {
  delimiter?: CsvDelimiter;
  hasHeader?: boolean;
  startRow?: number;
  columns?: number[];
  limit?: number;
};
export type CsvColumn = { index: number; name: string; nameTruncated: boolean };
export type CsvOverview = {
  delimiter: CsvDelimiter;
  hasHeader: boolean;
  rowCount: number;
  columnCount: number;
  columns: CsvColumn[];
  irregularRowCount: number;
  nextOffset: number | null;
};
export type CsvReadResult = {
  delimiter: CsvDelimiter;
  hasHeader: boolean;
  rowCount: number;
  columnCount: number;
  columns: CsvColumn[];
  omittedColumnCount: number;
  rows: Array<{
    row: number;
    startLine: number;
    endLine: number;
    width: number;
    cells: Array<{ index: number; value: string; truncated: boolean }>;
    omittedCellCount: number;
  }>;
  nextRow: number | null;
};
export type CsvPosition = { row: number; column: number; charOffset: number };
export type CsvSearchResult = {
  matches: Array<
    CsvPosition & { snippet: string; startLine: number; endLine: number }
  >;
  nextPosition: CsvPosition | null;
};
type CsvRecord = { cells: string[]; startLine: number; endLine: number };
type Source = {
  text: string;
  delimiter: CsvDelimiter;
  hasHeader: boolean;
  header: string[];
  rowCount: number;
  columnCount: number;
  irregularRowCount: number;
};

function invalid(message: string): never {
  throw new ArtifactReadError("invalid_input", message);
}

function malformed(): never {
  throw new ArtifactReadError("malformed", "CSV contains malformed quoting");
}

function integer(
  value: number | undefined,
  fallback: number,
  minimum: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum)
    invalid(`${label} must be a safe integer at least ${minimum}`);
  return value;
}

function detectDelimiter(text: string): CsvDelimiter {
  const delimiters: CsvDelimiter[] = [",", ";", "\t"];
  const counts = [0, 0, 0];
  let quoted = false;
  let fieldStart = true;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') index++;
        else quoted = false;
      }
      continue;
    }
    if (char === '"' && fieldStart) {
      quoted = true;
      fieldStart = false;
      continue;
    }
    if (char === "\r" || char === "\n") break;
    const delimiterIndex = delimiters.indexOf(char as CsvDelimiter);
    if (delimiterIndex >= 0) {
      counts[delimiterIndex]!++;
      fieldStart = true;
    } else fieldStart = false;
  }
  let best = 0;
  for (let index = 1; index < counts.length; index++)
    if (counts[index]! > counts[best]!) best = index;
  return delimiters[best]!;
}

function* records(text: string, delimiter: CsvDelimiter): Generator<CsvRecord> {
  let cells: string[] = [];
  let fieldStart = 0;
  let recordStart = 0;
  let startLine = 1;
  let line = 1;
  let quoted = false;
  let closed = false;
  let valueStart = 0;
  let valueEnd = 0;
  let escaped = false;
  function finishField(end: number) {
    const value = closed
      ? text.slice(valueStart, valueEnd)
      : text.slice(fieldStart, end);
    cells.push(escaped ? value.replace(/""/g, '"') : value);
    quoted = false;
    closed = false;
    escaped = false;
  }
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          escaped = true;
          index++;
        } else {
          quoted = false;
          closed = true;
          valueEnd = index;
        }
      } else if (char === "\r" || char === "\n") {
        if (char === "\r" && text[index + 1] === "\n") index++;
        line++;
      }
      continue;
    }
    if (char === '"' && index === fieldStart && !closed) {
      quoted = true;
      valueStart = index + 1;
      continue;
    }
    if (char === delimiter) {
      finishField(index);
      fieldStart = index + 1;
    } else if (char === "\r" || char === "\n") {
      finishField(index);
      yield { cells, startLine, endLine: line };
      cells = [];
      if (char === "\r" && text[index + 1] === "\n") index++;
      line++;
      startLine = line;
      fieldStart = recordStart = index + 1;
    } else if (closed || char === '"') malformed();
  }
  if (quoted) malformed();
  if (recordStart < text.length) {
    finishField(text.length);
    yield { cells, startLine, endLine: line };
  }
}

function source(
  data: Uint8Array,
  input: { delimiter?: CsvDelimiter; hasHeader?: boolean },
): Source {
  if (
    input.delimiter !== undefined &&
    ![",", ";", "\t"].includes(input.delimiter)
  )
    invalid("delimiter must be comma, semicolon or tab");
  if (input.hasHeader !== undefined && typeof input.hasHeader !== "boolean")
    invalid("hasHeader must be a boolean");
  const text = decodeUtf8(data);
  const delimiter = input.delimiter ?? detectDelimiter(text);
  const hasHeader = input.hasHeader ?? true;
  let header: string[] = [];
  let recordCount = 0;
  let columnCount = 0;
  let baselineWidth = 0;
  let irregularRowCount = 0;
  for (const record of records(text, delimiter)) {
    if (recordCount === 0) {
      baselineWidth = record.cells.length;
      if (hasHeader) header = record.cells;
    }
    columnCount = Math.max(columnCount, record.cells.length);
    if (
      (!hasHeader || recordCount > 0) &&
      record.cells.length !== baselineWidth
    )
      irregularRowCount++;
    recordCount++;
  }
  return {
    text,
    delimiter,
    hasHeader,
    header,
    rowCount: Math.max(0, recordCount - (hasHeader ? 1 : 0)),
    columnCount,
    irregularRowCount,
  };
}

function columnAt(parsed: Source, index: number): CsvColumn {
  const original = parsed.hasHeader
    ? (parsed.header[index] ?? "")
    : `Column ${index + 1}`;
  const name = utf8Prefix(original, MAX_LABEL_BYTES);
  return { index, name, nameTruncated: name.length < original.length };
}

function jsonSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

export function readCsvOverview(
  data: Uint8Array,
  input: {
    delimiter?: CsvDelimiter;
    hasHeader?: boolean;
    offset?: number;
    limit?: number;
  },
): CsvOverview {
  const offset = integer(input.offset, 0, 0, "offset");
  const limit = normalizeLimit({
    value: input.limit,
    defaultValue: 50,
    hardMax: 200,
    label: "limit",
  });
  const parsed = source(data, input);
  const columns: CsvColumn[] = [];
  let size = 512;
  for (
    let index = offset;
    index < Math.min(parsed.columnCount, offset + limit);
    index++
  ) {
    const column = columnAt(parsed, index);
    const cost = jsonSize(column) + 1;
    if (size + cost > MAX_RESULT_BYTES) break;
    columns.push(column);
    size += cost;
  }
  return {
    delimiter: parsed.delimiter,
    hasHeader: parsed.hasHeader,
    rowCount: parsed.rowCount,
    columnCount: parsed.columnCount,
    columns,
    irregularRowCount: parsed.irregularRowCount,
    nextOffset:
      offset + columns.length < parsed.columnCount
        ? offset + columns.length
        : null,
  };
}

function projection(
  parsed: Source,
  columns: number[] | undefined,
): number[] | undefined {
  if (columns === undefined) return undefined;
  if (
    !Array.isArray(columns) ||
    !columns.length ||
    new Set(columns).size !== columns.length ||
    columns.some(
      (index) =>
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= parsed.columnCount,
    )
  )
    invalid("columns must contain distinct existing zero-based column indices");
  return columns;
}

export function readCsv(data: Uint8Array, input: CsvReadInput): CsvReadResult {
  const limit = normalizeLimit({
    value: input.limit,
    defaultValue: 50,
    hardMax: 200,
    label: "limit",
  });
  const startRow = integer(input.startRow, 1, 1, "startRow");
  const parsed = source(data, input);
  if (startRow > parsed.rowCount + 1) invalid("startRow is outside the source");
  const selected = projection(parsed, input.columns);
  const columns: CsvColumn[] = [];
  let metadataSize = 0;
  const metadataCount = selected?.length ?? parsed.columnCount;
  for (let offset = 0; offset < metadataCount; offset++) {
    const column = columnAt(parsed, selected?.[offset] ?? offset);
    const cost = jsonSize(column) + 1;
    if (metadataSize + cost > MAX_METADATA_BYTES) break;
    columns.push(column);
    metadataSize += cost;
  }
  const rows: CsvReadResult["rows"] = [];
  let size = 512 + metadataSize;
  let rowNumber = parsed.hasHeader ? 0 : 1;
  for (const record of records(parsed.text, parsed.delimiter)) {
    const row = rowNumber++;
    if (row < startRow) continue;
    if (rows.length === limit) break;
    const result: CsvReadResult["rows"][number] = {
      row,
      startLine: record.startLine,
      endLine: record.endLine,
      width: record.cells.length,
      cells: [],
      omittedCellCount: record.cells.length,
    };
    let rowSize = jsonSize(result) + 1;
    const requestedCount = selected?.length ?? record.cells.length;
    let budgetOmission = false;
    for (let offset = 0; offset < requestedCount; offset++) {
      const index = selected?.[offset] ?? offset;
      const original = record.cells[index];
      if (original === undefined) continue;
      const value = utf8Prefix(original, MAX_CELL_BYTES);
      const cell = { index, value, truncated: value.length < original.length };
      const cost = jsonSize(cell) + 1;
      if (size + rowSize + cost > MAX_RESULT_BYTES) {
        budgetOmission = true;
        break;
      }
      result.cells.push(cell);
      result.omittedCellCount--;
      rowSize += cost;
    }
    if (size + rowSize > MAX_RESULT_BYTES || (budgetOmission && rows.length))
      break;
    rows.push(result);
    size += rowSize;
    if (budgetOmission) break;
  }
  const next = startRow + rows.length;
  return {
    delimiter: parsed.delimiter,
    hasHeader: parsed.hasHeader,
    rowCount: parsed.rowCount,
    columnCount: parsed.columnCount,
    columns,
    omittedColumnCount: metadataCount - columns.length,
    rows,
    nextRow: next <= parsed.rowCount ? next : null,
  };
}

function splitsSurrogate(text: string, offset: number): boolean {
  return (
    offset > 0 &&
    offset < text.length &&
    text.charCodeAt(offset - 1) >= 0xd800 &&
    text.charCodeAt(offset - 1) <= 0xdbff &&
    text.charCodeAt(offset) >= 0xdc00 &&
    text.charCodeAt(offset) <= 0xdfff
  );
}

function snippet(value: string, offset: number, length: number): string {
  let start = Math.max(0, offset - 80);
  if (splitsSurrogate(value, start)) start--;
  let end = Math.min(value.length, offset + length + 80);
  if (splitsSurrogate(value, end)) end--;
  return utf8Prefix(value.slice(start, end), MAX_LABEL_BYTES);
}

export function searchCsv(
  data: Uint8Array,
  input: {
    query: string;
    delimiter?: CsvDelimiter;
    hasHeader?: boolean;
    position?: CsvPosition;
    limit?: number;
  },
): CsvSearchResult {
  const pattern = literalSearchPattern(input.query);
  const limit = normalizeLimit({
    value: input.limit,
    defaultValue: 25,
    hardMax: 100,
    label: "limit",
  });
  const parsed = source(data, input);
  const position = input.position ?? { row: 1, column: 0, charOffset: 0 };
  integer(position.row, 1, 1, "position.row");
  integer(position.column, 0, 0, "position.column");
  integer(position.charOffset, 0, 0, "position.charOffset");
  if (
    position.row > parsed.rowCount + 1 ||
    (position.row === parsed.rowCount + 1 &&
      (position.column !== 0 || position.charOffset !== 0))
  )
    invalid("position is outside the source");
  const matches: CsvSearchResult["matches"] = [];
  let nextPosition: CsvPosition | null = null;
  let rowNumber = parsed.hasHeader ? 0 : 1;
  for (const record of records(parsed.text, parsed.delimiter)) {
    const row = rowNumber++;
    if (row < position.row) continue;
    const startColumn = row === position.row ? position.column : 0;
    if (startColumn >= record.cells.length)
      invalid("position is outside the source");
    for (let column = startColumn; column < record.cells.length; column++) {
      const value = record.cells[column]!;
      const from =
        row === position.row && column === position.column
          ? position.charOffset
          : 0;
      if (from > value.length || splitsSurrogate(value, from))
        invalid("position is outside a cell or splits a Unicode character");
      pattern.lastIndex = from;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(value))) {
        if (matches.length === limit) return { matches, nextPosition };
        matches.push({
          row,
          column,
          charOffset: match.index,
          snippet: snippet(value, match.index, match[0].length),
          startLine: record.startLine,
          endLine: record.endLine,
        });
        nextPosition = { row, column, charOffset: pattern.lastIndex };
      }
    }
  }
  return { matches, nextPosition: null };
}

import {
  hasRealCalendarDate,
  isRoundTrippingNumber,
  isValidDateTimeCell,
  isValidUrlCell,
  normalizeDateTimeCell,
} from "./validation";

export class CsvError extends Error {}

export type CsvParseResult = { header: string[]; rows: string[][] };
export type InferredColumnType =
  "text" | "number" | "date" | "datetime" | "boolean" | "url" | "longtext";
export type CsvDelimiter = "," | ";" | "\t";
export type ParseCsvOptions = { preferredDelimiter?: CsvDelimiter };

const DELIMITERS = [",", ";", "\t"] as const;

export function detectDelimiter(
  headerLine: string,
  preferred?: CsvDelimiter,
): CsvDelimiter {
  const counts = new Map<CsvDelimiter, number>();
  for (const delimiter of DELIMITERS) {
    let count = 0;
    let quoted = false;
    for (const ch of headerLine) {
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch === delimiter) count += 1;
    }
    counts.set(delimiter, count);
  }
  if (preferred !== undefined) {
    const preferredCount = counts.get(preferred) ?? 0;
    const anyCounted = [...counts.values()].some((count) => count > 0);
    if (preferredCount >= 1 || !anyCounted) return preferred;
  }
  let best: CsvDelimiter = ",";
  let bestCount = -1;
  for (const delimiter of DELIMITERS) {
    const count = counts.get(delimiter) ?? 0;
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

/** Index of the first unquoted line break, quote-aware (doubled quotes stay inside the field). */
function firstLineEnd(text: string): number {
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) return i;
  }
  return text.length;
}

export function parseCsv(
  input: string,
  options: ParseCsvOptions = {},
): CsvParseResult {
  const text = input.startsWith("﻿") ? input.slice(1) : input;
  const delimiter = detectDelimiter(
    text.slice(0, firstLineEnd(text)),
    options.preferredDelimiter,
  );
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  let quoteJustClosed = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
          quoteJustClosed = true;
        }
      } else field += ch;
      continue;
    }
    if (quoteJustClosed && ch !== delimiter && ch !== "\n" && ch !== "\r") {
      throw new CsvError("Unexpected character after a closing quote");
    }
    if (ch === '"' && field.length === 0) quoted = true;
    else if (ch === delimiter) {
      record.push(field);
      field = "";
      quoteJustClosed = false;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      record.push(field);
      records.push(record);
      field = "";
      record = [];
      quoteJustClosed = false;
    } else field += ch;
  }
  if (quoted) throw new CsvError("Unterminated quoted field");
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  const header = records.shift() ?? [];
  const width = header.length;
  const rows = records
    .filter((row) => !(row.length === 1 && row[0] === ""))
    .map((row, index) => {
      if (row.length === width) return row;
      if (row.length < width) {
        return [
          ...row,
          ...Array.from({ length: width - row.length }, () => ""),
        ];
      }
      const extra = row.slice(width);
      if (extra.every((value) => value === "")) return row.slice(0, width);
      throw new CsvError(
        `Row ${index + 1} has ${row.length} fields but the header has ${width}`,
      );
    });
  return { header, rows };
}

/** Strips a trailing " (n)" dedupe suffix so a literal "X (2)" shares X's counter. */
function dedupeRoot(name: string): string {
  return name.replace(/ \(\d+\)$/, "");
}

export function columnNamesFromHeader(header: string[]): string[] {
  const seen = new Set<string>();
  return header.map((raw, index) => {
    const trimmed = raw.trim() || `Column ${index + 1}`;
    const root = dedupeRoot(trimmed);
    let candidate = trimmed;
    let suffix = 2;
    while (seen.has(candidate)) {
      candidate = `${root} (${suffix})`;
      suffix += 1;
    }
    seen.add(candidate);
    return candidate;
  });
}

function isCsvNumber(value: string): boolean {
  return !/^(?:\+|-?0\d)/.test(value) && isRoundTrippingNumber(value);
}

const BOOLEAN_RE = /^(true|false|yes|no)$/i;
const STRICT_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LONGTEXT_THRESHOLD = 200;

/** Strict calendar dates remain separate from datetime inference. */
function isStrictCalendarDate(value: string): boolean {
  const match = STRICT_DATE_RE.exec(value);
  if (!match) return false;
  const [, year, month, day] = match;
  return hasRealCalendarDate(year!, month!, day!);
}

function isLongtext(value: string): boolean {
  return value.includes("\n") || value.length > LONGTEXT_THRESHOLD;
}

export function inferColumnType(values: string[]): InferredColumnType {
  const present = values
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (present.length === 0) return "text";
  if (present.every((value) => isCsvNumber(value))) return "number";
  if (present.every((value) => isValidDateTimeCell(value))) return "datetime";
  if (present.every((value) => isStrictCalendarDate(value))) return "date";
  if (present.every((value) => BOOLEAN_RE.test(value))) return "boolean";
  if (present.every((value) => isValidUrlCell(value))) return "url";
  if (present.some((value) => isLongtext(value))) return "longtext";
  return "text";
}

export function coerceCsvCell(
  raw: string,
  type: InferredColumnType,
): string | number | boolean | undefined {
  if (type === "text" || type === "longtext")
    return raw.length ? raw : undefined;
  const value = raw.trim();
  if (!value) return undefined;
  if (type === "number") return isCsvNumber(value) ? Number(value) : undefined;
  if (type === "datetime")
    return isValidDateTimeCell(value)
      ? normalizeDateTimeCell(value)
      : undefined;
  if (type === "date") return isStrictCalendarDate(value) ? value : undefined;
  if (type === "url") return isValidUrlCell(value) ? value : undefined;
  if (type === "boolean")
    return /^(true|yes)$/i.test(value)
      ? true
      : /^(false|no)$/i.test(value)
        ? false
        : undefined;
  return undefined;
}

export function decodeCsvBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder("utf-16le", { fatal: true }).decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder("utf-16be", { fatal: true }).decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

import { hasOptions, type TableColumn } from "./types";

export const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const MAX_TABLE_COLUMNS = 100;
export const MAX_SELECT_OPTIONS = 200;
export const MAX_DATA_FILE_BYTES = 5_000_000;
export const MAX_TEXT_CHARS = 10_000;
export const MAX_URL_CHARS = 2_048;
export const MAX_MULTISELECT_VALUES = 200;

/**
 * The column-shape rules the Git table writer enforces. Shared so a preview
 * cannot approve a shape that acceptance would then reject.
 */
export function columnShapeIssue(column: TableColumn): string | null {
  if (hasOptions(column.type)) {
    return !column.options ||
      column.options.length === 0 ||
      column.options.length > MAX_SELECT_OPTIONS
      ? `invalid select/multiselect options ${column.id}`
      : null;
  }
  return column.options !== undefined
    ? `options are only valid on select/multiselect columns ${column.id}`
    : null;
}

export function columnsShapeIssue(
  columns: readonly TableColumn[],
): string | null {
  if (columns.length > MAX_TABLE_COLUMNS) return "too many columns";
  for (const column of columns) {
    const issue = columnShapeIssue(column);
    if (issue) return issue;
  }
  return null;
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function hasRealCalendarDate(
  year: string,
  month: string,
  day: string,
): boolean {
  const date = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() + 1 === Number(month) &&
    date.getUTCDate() === Number(day)
  );
}

function validParts(match: RegExpExecArray): boolean {
  const [, year, month, day, hour, minute, second] = match;
  return (
    hasRealCalendarDate(year!, month!, day!) &&
    (hour === undefined || Number(hour) <= 23) &&
    (minute === undefined || Number(minute) <= 59) &&
    (second === undefined || Number(second) <= 59)
  );
}

export function isValidIsoDate(value: string): boolean {
  const match = ISO_DATE_RE.exec(value);
  return !!match && validParts(match) && !Number.isNaN(Date.parse(value));
}

export function isValidIsoTimestamp(value: string): boolean {
  const match = ISO_TIMESTAMP_RE.exec(value);
  return !!match && validParts(match) && !Number.isNaN(Date.parse(value));
}

const DATETIME_CELL_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** A datetime cell requires a mandatory zone designator; seconds are optional. */
export function isValidDateTimeCell(value: string): boolean {
  const match = DATETIME_CELL_RE.exec(value);
  return !!match && validParts(match) && !Number.isNaN(Date.parse(value));
}

/** Adds ":00" seconds when absent; keeps the zone exactly as given. */
export function normalizeDateTimeCell(value: string): string {
  const match = DATETIME_CELL_RE.exec(value);
  if (!match || match[6] !== undefined) return value;
  const zone = match[7]!;
  return `${value.slice(0, value.length - zone.length)}:00${zone}`;
}

export function dateTimeInstant(value: string): number {
  return Date.parse(value);
}

const URL_RE = /^https?:\/\/\S+$/i;

export function isValidUrlCell(value: string): boolean {
  return value.length <= MAX_URL_CHARS && URL_RE.test(value);
}

const DECIMAL_RE = /^[-+]?((\d+\.?\d*)|(\.\d+))([eE][-+]?\d+)?$/;

function canonicalDecimal(text: string): string {
  const [mantissa = "", exponent = "0"] = text
    .replace(/^[-+]/, "")
    .split(/[eE]/);
  const [whole = "", fraction = ""] = mantissa.split(".");
  const digits = `${whole}${fraction}`.replace(/^0+/, "");
  const significant = digits.replace(/0+$/, "");
  if (significant.length === 0) return "0";
  const power =
    Number(exponent) - fraction.length + digits.length - significant.length;
  return `${text.startsWith("-") ? "-" : ""}${significant}e${power}`;
}

/**
 * A decimal-literal string is numeric only if it round-trips through
 * `Number` without precision loss — otherwise large integers like
 * `12345678901234567890` would silently become a different, imprecise
 * number instead of staying text.
 */
export function isRoundTrippingNumber(text: string): boolean {
  if (!DECIMAL_RE.test(text)) return false;
  const value = Number(text);
  if (!Number.isFinite(value)) return false;
  const source = canonicalDecimal(text);
  if (source !== canonicalDecimal(String(value))) return false;
  // A double's shortest decimal can hide rounding of an unsafe integer.
  if (
    Number.isInteger(value) &&
    !Number.isSafeInteger(value) &&
    source !== canonicalDecimal(BigInt(value).toString())
  )
    return false;
  return true;
}

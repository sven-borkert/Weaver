import type { CellValue, TableColumn, TableRow } from "./types";
import {
  CANONICAL_UUID_RE,
  isValidDateTimeCell,
  isValidIsoDate,
  isValidUrlCell,
  MAX_MULTISELECT_VALUES,
  MAX_TEXT_CHARS,
  normalizeDateTimeCell,
} from "./validation";

export type CellError = { rowId: string; columnId: string; reason: string };

export function isValidCellValue(
  value: CellValue,
  column: TableColumn,
): boolean {
  switch (column.type) {
    case "text":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "date":
      return typeof value === "string" && isValidIsoDate(value);
    case "datetime":
      return typeof value === "string" && isValidDateTimeCell(value);
    case "select":
      return (
        typeof value === "string" &&
        (column.options ?? []).some((option) => option.id === value)
      );
    case "multiselect": {
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        value.length > MAX_MULTISELECT_VALUES
      )
        return false;
      const ids = new Set((column.options ?? []).map((option) => option.id));
      return (
        value.every((entry) => typeof entry === "string" && ids.has(entry)) &&
        new Set(value).size === value.length
      );
    }
    case "url":
      return typeof value === "string" && isValidUrlCell(value);
    case "longtext":
      return typeof value === "string" && value.length <= MAX_TEXT_CHARS;
    case "document":
      return typeof value === "string" && CANONICAL_UUID_RE.test(value);
  }
}

/** Arrays compare by content, order-sensitive; everything else by identity. */
export function cellValuesEqual(
  a: CellValue | undefined,
  b: CellValue | undefined,
): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((entry, index) => entry === b[index]);
  }
  return a === b;
}

export function validateRows(
  columns: TableColumn[],
  rows: TableRow[],
): { ok: true } | { ok: false; errors: CellError[] } {
  const errors: CellError[] = [];
  const byId = new Map<string, TableColumn>();
  for (const column of columns) {
    if (byId.has(column.id))
      errors.push({
        rowId: "",
        columnId: column.id,
        reason: "duplicate column id",
      });
    byId.set(column.id, column);
  }
  const seenRows = new Set<string>();
  for (const row of rows) {
    if (seenRows.has(row.id))
      errors.push({ rowId: row.id, columnId: "", reason: "duplicate row id" });
    seenRows.add(row.id);
    for (const [columnId, value] of Object.entries(row.cells)) {
      const column = byId.get(columnId);
      if (!column)
        errors.push({ rowId: row.id, columnId, reason: "unknown column" });
      else if (!isValidCellValue(value, column))
        errors.push({
          rowId: row.id,
          columnId,
          reason: `invalid value for type ${column.type}`,
        });
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function convertCellValue(
  value: CellValue,
  from: TableColumn,
  to: TableColumn,
): { ok: true; value: CellValue } | { ok: false } {
  if (from.type === to.type)
    return isValidCellValue(value, to) ? { ok: true, value } : { ok: false };
  if (from.type === "multiselect" && Array.isArray(value)) {
    const labels = value.map(
      (id) =>
        (from.options ?? []).find((option) => option.id === id)?.label ?? id,
    );
    if (to.type === "text" || to.type === "longtext")
      return { ok: true, value: labels.join(", ") };
    if (to.type === "select")
      return value.length &&
        (to.options ?? []).some((option) => option.id === value[0])
        ? { ok: true, value: value[0]! }
        : { ok: false };
    return { ok: false };
  }
  if (
    from.type === "select" &&
    to.type === "multiselect" &&
    typeof value === "string"
  )
    return (to.options ?? []).some((option) => option.id === value)
      ? { ok: true, value: [value] }
      : { ok: false };
  if (
    from.type === "date" &&
    to.type === "datetime" &&
    typeof value === "string"
  ) {
    const withTime = value.includes("T") ? value : `${value}T00:00:00`;
    const zoned = /(Z|[+-]\d{2}:\d{2})$/.test(withTime)
      ? withTime
      : `${withTime}Z`;
    const normalized = normalizeDateTimeCell(zoned);
    return isValidDateTimeCell(normalized)
      ? { ok: true, value: normalized }
      : { ok: false };
  }
  if (
    from.type === "datetime" &&
    to.type === "date" &&
    typeof value === "string"
  )
    return { ok: true, value: value.slice(0, 10) };
  if (
    (from.type === "url" || from.type === "longtext") &&
    to.type === "text" &&
    typeof value === "string"
  )
    return { ok: true, value };
  if (
    from.type === "text" &&
    to.type === "longtext" &&
    typeof value === "string"
  )
    return { ok: true, value };
  if (
    from.type === "url" &&
    to.type === "longtext" &&
    typeof value === "string"
  )
    return { ok: true, value };
  if (to.type === "text") {
    if (Array.isArray(value)) return { ok: false };
    if (from.type === "select") {
      const label = (from.options ?? []).find(
        (option) => option.id === value,
      )?.label;
      return { ok: true, value: label ?? String(value) };
    }
    return { ok: true, value: String(value) };
  }
  if (from.type === "boolean" && to.type === "number")
    return { ok: true, value: value === true ? 1 : 0 };
  if (
    (from.type !== "text" && from.type !== "longtext") ||
    typeof value !== "string"
  )
    return { ok: false };
  const text = value.trim();
  switch (to.type) {
    case "number": {
      if (text.length === 0) return { ok: false };
      const parsed = Number(text);
      return Number.isFinite(parsed)
        ? { ok: true, value: parsed }
        : { ok: false };
    }
    case "boolean":
      if (text === "true") return { ok: true, value: true };
      if (text === "false") return { ok: true, value: false };
      return { ok: false };
    case "date":
      return isValidIsoDate(text) ? { ok: true, value: text } : { ok: false };
    case "datetime":
      return isValidDateTimeCell(text)
        ? { ok: true, value: normalizeDateTimeCell(text) }
        : { ok: false };
    case "url":
      return isValidUrlCell(text) ? { ok: true, value: text } : { ok: false };
    case "select": {
      const option = (to.options ?? []).find((entry) => entry.label === text);
      return option ? { ok: true, value: option.id } : { ok: false };
    }
    case "multiselect": {
      const labels = text
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      if (labels.length === 0) return { ok: false };
      const ids: string[] = [];
      for (const label of labels) {
        const option = (to.options ?? []).find(
          (entry) => entry.label === label,
        );
        if (!option) return { ok: false };
        ids.push(option.id);
      }
      return new Set(ids).size === ids.length
        ? { ok: true, value: ids }
        : { ok: false };
    }
    case "document":
      return CANONICAL_UUID_RE.test(text)
        ? { ok: true, value: text }
        : { ok: false };
    default:
      return { ok: false };
  }
}

export function retypeColumn(
  rows: TableRow[],
  from: TableColumn,
  to: TableColumn,
): { ok: true; rows: TableRow[] } | { ok: false; failures: string[] } {
  const failures: string[] = [];
  const next = rows.map((row) => {
    const value = row.cells[from.id];
    if (value === undefined) return row;
    const converted = convertCellValue(value, from, to);
    if (!converted.ok) {
      failures.push(row.id);
      return row;
    }
    return { id: row.id, cells: { ...row.cells, [from.id]: converted.value } };
  });
  return failures.length === 0
    ? { ok: true, rows: next }
    : { ok: false, failures };
}

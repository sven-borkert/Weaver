import { normalizeAppearance } from "../appearance/metadata";
import {
  COLUMN_TYPES,
  hasOptions,
  type CellValue,
  type SchemaFile,
  type TableColumn,
  type TableRow,
} from "./types";
import { CANONICAL_UUID_RE, isValidIsoTimestamp } from "./validation";

export class TableFileError extends Error {}

function isCellValue(value: unknown): value is CellValue {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
  );
}

export function serializeRows(
  columns: TableColumn[],
  rows: TableRow[],
): string {
  if (rows.length === 0) return "";
  return (
    rows
      .map((row) => {
        const cells: Record<string, CellValue> = {};
        for (const column of columns) {
          const value = row.cells[column.id];
          if (value !== undefined) cells[column.id] = value;
        }
        return JSON.stringify({ id: row.id, cells });
      })
      .join("\n") + "\n"
  );
}

const ROW_FRAME_BYTES = '{"id":"","cells":{}}\n'.length + 36;
const CELL_KEY_BYTES = '"":'.length + 36;

/** Bytes `serializeRows` writes for one row holding these present cell values. */
export function serializedRowBytes(values: CellValue[]): number {
  let bytes = ROW_FRAME_BYTES + Math.max(0, values.length - 1);
  for (const value of values) {
    bytes += CELL_KEY_BYTES + Buffer.byteLength(JSON.stringify(value), "utf8");
  }
  return bytes;
}

export function parseRows(text: string): TableRow[] {
  const rows: TableRow[] = [];
  const seen = new Set<string>();
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.trim().length === 0) continue;
    const at = `data.jsonl line ${index + 1}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new TableFileError(`${at}: invalid JSON`);
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new TableFileError(`${at}: not an object`);
    }
    const { id, cells, ...rest } = parsed as Record<string, unknown>;
    if (typeof id !== "string" || !CANONICAL_UUID_RE.test(id)) {
      throw new TableFileError(`${at}: invalid row id`);
    }
    if (seen.has(id)) throw new TableFileError(`${at}: duplicate row id`);
    seen.add(id);
    if (typeof cells !== "object" || cells === null || Array.isArray(cells)) {
      throw new TableFileError(`${at}: cells must be an object`);
    }
    if (Object.keys(rest).length > 0) {
      throw new TableFileError(`${at}: unknown keys`);
    }
    const out: Record<string, CellValue> = {};
    for (const [key, value] of Object.entries(cells)) {
      if (!CANONICAL_UUID_RE.test(key)) {
        throw new TableFileError(`${at}: invalid column id`);
      }
      if (!isCellValue(value)) {
        throw new TableFileError(
          `${at}: cell must be a string, finite number, boolean, or array of strings`,
        );
      }
      out[key] = value;
    }
    rows.push({ id, cells: out });
  }
  return rows;
}

export function serializeSchemaFile(schema: SchemaFile): string {
  const { appearance: raw, ...metadata } = schema;
  const appearance = normalizeAppearance(raw);
  return `${JSON.stringify({ ...metadata, ...(appearance === null ? {} : { appearance }) }, null, 2)}\n`;
}

function parseColumn(raw: unknown, at: string): TableColumn {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TableFileError(`${at}: column must be an object`);
  }
  const { id, name, type, options, ...rest } = raw as Record<string, unknown>;
  if (typeof id !== "string" || !CANONICAL_UUID_RE.test(id)) {
    throw new TableFileError(`${at}: invalid column id`);
  }
  if (typeof name !== "string" || name.length === 0) {
    throw new TableFileError(`${at}: column name must be a non-empty string`);
  }
  if (
    typeof type !== "string" ||
    !(COLUMN_TYPES as readonly string[]).includes(type)
  ) {
    throw new TableFileError(`${at}: unknown column type`);
  }
  if (Object.keys(rest).length > 0) {
    throw new TableFileError(`${at}: unknown column keys`);
  }
  if (hasOptions(type as TableColumn["type"])) {
    if (!Array.isArray(options) || options.length === 0) {
      throw new TableFileError(
        `${at}: select/multiselect columns require options`,
      );
    }
    const seen = new Set<string>();
    const parsed = options.map((option) => {
      if (typeof option !== "object" || option === null) {
        throw new TableFileError(`${at}: option must be an object`);
      }
      const {
        id: optionId,
        label,
        ...optionRest
      } = option as Record<string, unknown>;
      if (
        typeof optionId !== "string" ||
        !CANONICAL_UUID_RE.test(optionId) ||
        seen.has(optionId)
      ) {
        throw new TableFileError(`${at}: invalid or duplicate option id`);
      }
      seen.add(optionId);
      if (
        typeof label !== "string" ||
        label.length === 0 ||
        Object.keys(optionRest).length > 0
      ) {
        throw new TableFileError(`${at}: invalid option`);
      }
      return { id: optionId, label };
    });
    return { id, name, type: type as TableColumn["type"], options: parsed };
  }
  if (options !== undefined) {
    throw new TableFileError(
      `${at}: options are only valid on select/multiselect columns`,
    );
  }
  return { id, name, type: type as TableColumn["type"] };
}

export function parseSchemaFile(text: string): SchemaFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TableFileError("schema.json: invalid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TableFileError("schema.json: not an object");
  }
  const {
    id,
    title,
    sourceOfTruth,
    columns,
    created,
    updated,
    appearance: rawAppearance,
    ...rest
  } = parsed as Record<string, unknown>;
  if (typeof id !== "string" || !CANONICAL_UUID_RE.test(id)) {
    throw new TableFileError("schema.json: invalid table id");
  }
  if (typeof title !== "string" || title.length === 0) {
    throw new TableFileError("schema.json: title must be a non-empty string");
  }
  if (sourceOfTruth !== "git") {
    throw new TableFileError("schema.json: unsupported sourceOfTruth");
  }
  if (
    typeof created !== "string" ||
    typeof updated !== "string" ||
    !isValidIsoTimestamp(created) ||
    !isValidIsoTimestamp(updated)
  ) {
    throw new TableFileError("schema.json: created/updated must be strings");
  }
  if (!Array.isArray(columns)) {
    throw new TableFileError("schema.json: columns must be an array");
  }
  if (Object.keys(rest).length > 0) {
    throw new TableFileError("schema.json: unknown keys");
  }
  const seen = new Set<string>();
  const parsedColumns = columns.map((raw, index) => {
    const column = parseColumn(raw, `schema.json column ${index + 1}`);
    if (seen.has(column.id)) {
      throw new TableFileError(
        `schema.json column ${index + 1}: duplicate column id`,
      );
    }
    seen.add(column.id);
    return column;
  });
  const appearance = normalizeAppearance(rawAppearance);
  return {
    id,
    title,
    sourceOfTruth,
    columns: parsedColumns,
    created,
    updated,
    ...(appearance === null ? {} : { appearance }),
  };
}

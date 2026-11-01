import type { Appearance } from "../appearance/metadata";

export const COLUMN_TYPES = [
  "text",
  "number",
  "date",
  "datetime",
  "select",
  "multiselect",
  "boolean",
  "url",
  "longtext",
  "document",
] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

export const OPTION_COLUMN_TYPES = ["select", "multiselect"] as const;

export function hasOptions(
  type: ColumnType,
): type is (typeof OPTION_COLUMN_TYPES)[number] {
  return type === "select" || type === "multiselect";
}

export type SelectOption = { id: string; label: string };

export type TableColumn = {
  id: string;
  name: string;
  type: ColumnType;
  options?: SelectOption[];
};

export type CellValue = string | number | boolean | string[];

export type TableRow = {
  id: string;
  cells: Record<string, CellValue>;
};

export type TableData = {
  title: string;
  columns: TableColumn[];
  rows: TableRow[];
};

export type SchemaFile = {
  id: string;
  title: string;
  sourceOfTruth: "git";
  appearance?: Appearance;
  columns: TableColumn[];
  created: string;
  updated: string;
};

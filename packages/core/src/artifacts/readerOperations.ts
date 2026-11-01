/** The operation catalogue both sides of the reader child share. It must stay
 *  free of runtime reader imports: the parent loads it, and
 *  exceljs/unpdf/pdfjs-dist belong to the child alone. */
import type { ArtifactReadErrorCode } from "@weaver/artifact-readers/errors";

export type ArtifactFormat =
  | "word"
  | "excel"
  | "pdf"
  | "json"
  | "onenote"
  | "text"
  | "markdown"
  | "csv"
  | "yaml";

export const READER_OPERATIONS = {
  "word.outline": ["word"],
  "word.tableInventory": ["word"],
  "word.chapter": ["word"],
  "word.blocks": ["word"],
  "word.instructions": ["word"],
  "word.findTables": ["word"],
  "word.table": ["word"],
  "word.dropdowns": ["word"],
  "word.search": ["word"],
  "excel.overview": ["excel"],
  "excel.sheet": ["excel"],
  "excel.workbook": ["excel"],
  "pdf.summary": ["pdf"],
  "pdf.pages": ["pdf"],
  "pdf.search": ["pdf"],
  "json.overview": ["json"],
  "json.query": ["json"],
  "text.overview": ["text", "markdown"],
  "text.read": ["text", "markdown", "yaml", "csv"],
  "text.search": ["text", "markdown", "yaml", "csv"],
  "csv.overview": ["csv"],
  "csv.rows": ["csv"],
  "csv.search": ["csv"],
  "yaml.overview": ["yaml"],
  "yaml.query": ["yaml"],
  "yaml.structure": ["yaml"],
  "json.structure": ["json"],
} as const satisfies Record<string, readonly ArtifactFormat[]>;

export type ReaderOperation = keyof typeof READER_OPERATIONS;

/** A serialized reader result above this never reaches the parent. */
export const MAX_READER_RESULT_BYTES = 2 * 1024 * 1024;

const FORMAT_BY_CONTENT_TYPE: Readonly<Record<string, ArtifactFormat>> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "word",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template":
    "word",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "excel",
  "application/pdf": "pdf",
  "application/json": "json",
  "application/onenote": "onenote",
  "text/plain": "text",
  "text/markdown": "markdown",
  "text/csv": "csv",
  "application/yaml": "yaml",
  "application/x-yaml": "yaml",
  "text/yaml": "yaml",
  "text/x-yaml": "yaml",
};

const TEXT_EXTENSION_FORMATS: Readonly<Record<string, ArtifactFormat>> = {
  txt: "text",
  md: "markdown",
  csv: "csv",
  yaml: "yaml",
  yml: "yaml",
};

export function artifactFormatOf(
  contentType: string,
  filename?: string,
): ArtifactFormat | null {
  if (
    contentType.startsWith("text/") ||
    contentType === "application/octet-stream"
  ) {
    const extension = filename?.split(".").at(-1)?.toLowerCase();
    if (
      filename?.includes(".") &&
      extension &&
      Object.hasOwn(TEXT_EXTENSION_FORMATS, extension)
    )
      return TEXT_EXTENSION_FORMATS[extension]!;
  }
  return Object.hasOwn(FORMAT_BY_CONTENT_TYPE, contentType)
    ? FORMAT_BY_CONTENT_TYPE[contentType]!
    : null;
}

export function isReaderOperation(value: string): value is ReaderOperation {
  return Object.hasOwn(READER_OPERATIONS, value);
}

/** Mirrors ARTIFACT_READ_ERROR_CODES without importing it at runtime; the
 *  satisfies check fails if the readers add or drop a code. */
const READ_ERROR_CODES = {
  unsupported_format: true,
  legacy_format: true,
  encrypted: true,
  malformed: true,
  resource_limit: true,
  invalid_path: true,
  invalid_input: true,
  not_found: true,
} as const satisfies Record<ArtifactReadErrorCode, true>;

export function isArtifactReadErrorCode(
  value: string,
): value is ArtifactReadErrorCode {
  return Object.hasOwn(READ_ERROR_CODES, value);
}

import { sniffContentType } from "../ingestion/mimeTypes";

const OCTET_STREAM = "application/octet-stream";
const ZIP = "application/zip";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  dotx: "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
  json: "application/json",
  one: "application/onenote",
  onepkg: "application/onenote",
  md: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  yaml: "application/yaml",
  yml: "application/yaml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
  zip: ZIP,
};

const ZIP_CONTAINERS = new Set([
  CONTENT_TYPES.docx,
  CONTENT_TYPES.dotx,
  CONTENT_TYPES.xlsx,
  ZIP,
]);
const SNIFFED = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export function contentTypeForFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return OCTET_STREAM;
  const ext = filename.slice(dot + 1).toLowerCase();
  return Object.hasOwn(CONTENT_TYPES, ext) ? CONTENT_TYPES[ext]! : OCTET_STREAM;
}

/** False only when the bytes contradict a type whose magic bytes Weaver knows. */
export function artifactContentMatches(
  contentType: string,
  head: Uint8Array,
): boolean {
  if (ZIP_CONTAINERS.has(contentType)) return sniffContentType(head) === ZIP;
  if (SNIFFED.has(contentType)) return sniffContentType(head) === contentType;
  return true;
}

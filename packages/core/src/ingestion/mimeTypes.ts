const DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOC = "application/msword";
const XLS = "application/vnd.ms-excel";
const ZIP = "application/zip";
const OLE = "application/x-ole-storage";

export const INGESTION_MIME_TYPES = [
  "application/pdf",
  DOCX,
  XLSX,
  DOC,
  XLS,
  "text/csv",
  "text/plain",
  "text/markdown",
  "image/png",
  "image/jpeg",
  "image/tiff",
  "image/webp",
] as const satisfies readonly string[];

const ZIP_CONTAINER_TYPES = new Set<string>([DOCX, XLSX]);
const OLE_CONTAINER_TYPES = new Set<string>([DOC, XLS]);
const TEXT_TYPES = new Set<string>(["text/csv", "text/plain", "text/markdown"]);
const allowed = new Set<string>(INGESTION_MIME_TYPES);

export function normalizeMimeType(value: string): string {
  return value.split(";", 1)[0]!.trim().toLowerCase();
}

export function isAllowedMimeType(value: string): boolean {
  return allowed.has(normalizeMimeType(value));
}

function startsWith(head: Uint8Array, bytes: readonly number[]): boolean {
  if (head.length < bytes.length) return false;
  return bytes.every((byte, index) => head[index] === byte);
}

function isZip(head: Uint8Array): boolean {
  return (
    startsWith(head, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(head, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(head, [0x50, 0x4b, 0x07, 0x08])
  );
}

export function sniffContentType(head: Uint8Array): string | null {
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46])) return "application/pdf";
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (isZip(head)) return ZIP;
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return OLE;
  }
  if (
    startsWith(head, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(head.subarray(8), [0x57, 0x45, 0x42, 0x50])
  ) {
    return "image/webp";
  }
  if (
    startsWith(head, [0x49, 0x49, 0x2a, 0x00]) ||
    startsWith(head, [0x4d, 0x4d, 0x00, 0x2a])
  ) {
    return "image/tiff";
  }
  return null;
}

export function contentTypeMatches(
  declared: string,
  head: Uint8Array,
): boolean {
  const type = normalizeMimeType(declared);
  if (!allowed.has(type)) return false;
  const sniffed = sniffContentType(head);
  if (TEXT_TYPES.has(type)) return sniffed === null;
  if (ZIP_CONTAINER_TYPES.has(type)) return sniffed === ZIP;
  if (OLE_CONTAINER_TYPES.has(type)) return sniffed === OLE;
  return sniffed === type;
}

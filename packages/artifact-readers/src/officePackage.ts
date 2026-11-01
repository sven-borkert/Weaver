/** Container checks shared by every ZIP-based OOXML reader; this module only
 *  classifies, so the per-format messages stay with each reader. */
import { readArchiveEntry } from "./archive";

const OLE_HEADER = Buffer.from([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
]);

/** Bytes scanned for CFB stream-name markers: a best-effort window, not a
 *  guarantee that the directory entries are inside it. */
const OLE_SCAN_BYTES = 64 * 1024;
const ENCRYPTED_CFB_MARKERS = ["EncryptedPackage", "EncryptionInfo"];

const CONTENT_TYPES_ENTRY_NAME = "[Content_Types].xml";
/** Generous for a real package's tiny content-types part; also bounds the
 *  inflate this triggers via archive.ts's readArchiveEntry. */
const CONTENT_TYPES_MAX_BYTES = 1 << 20;

export type OleContainerKind = "encrypted" | "legacy";

function startsWithOleHeader(data: Uint8Array): boolean {
  if (data.length < OLE_HEADER.length) return false;
  for (let i = 0; i < OLE_HEADER.length; i++) {
    if (data[i] !== OLE_HEADER[i]) return false;
  }
  return true;
}

/** Legacy binary Office file or Office-encrypted OOXML wrapper: the two share
 *  the same header, so only the CFB stream names tell them apart. */
export function classifyOleContainer(
  data: Uint8Array,
): OleContainerKind | null {
  if (!startsWithOleHeader(data)) return null;
  const buffer = Buffer.from(
    data.buffer,
    data.byteOffset,
    Math.min(data.length, OLE_SCAN_BYTES),
  );
  const encrypted = ENCRYPTED_CFB_MARKERS.some((marker) =>
    buffer.includes(Buffer.from(marker, "utf16le")),
  );
  return encrypted ? "encrypted" : "legacy";
}

/** True when [Content_Types].xml declares a macro-enabled type for the MAIN
 *  part (`mainPartName`, absolute, e.g. "/word/document.xml") — an ordinary
 *  package may embed macro-enabled parts of its own. */
export function declaresMacroEnabledContentType(
  data: Uint8Array,
  mainPartName: string,
): boolean {
  const contentTypes = readArchiveEntry(
    data,
    CONTENT_TYPES_ENTRY_NAME,
    CONTENT_TYPES_MAX_BYTES,
  );
  if (contentTypes === null) return false;
  const declared = mainPartContentType(
    Buffer.from(contentTypes).toString("utf8"),
    mainPartName,
  );
  return declared !== null && /macroEnabled/i.test(declared);
}

/** The part's Override, else the Default for its extension; scanned rather
 *  than parsed, since nothing has vouched for the package yet. */
function mainPartContentType(xml: string, partName: string): string | null {
  const target = partName.toLowerCase();
  for (const element of xml.matchAll(/<Override\b([^>]*)>/gi)) {
    const attributes = element[1] ?? "";
    if (attributeValue(attributes, "PartName")?.toLowerCase() === target) {
      return attributeValue(attributes, "ContentType");
    }
  }
  const extension = target.slice(target.lastIndexOf(".") + 1);
  for (const element of xml.matchAll(/<Default\b([^>]*)>/gi)) {
    const attributes = element[1] ?? "";
    if (attributeValue(attributes, "Extension")?.toLowerCase() === extension) {
      return attributeValue(attributes, "ContentType");
    }
  }
  return null;
}

function attributeValue(attributes: string, name: string): string | null {
  const match = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    "i",
  ).exec(attributes);
  if (!match) return null;
  return match[1] ?? match[2] ?? null;
}

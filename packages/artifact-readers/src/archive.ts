import { inflateRawSync } from "node:zlib";
import { ArtifactReadError } from "./errors";

export type ArchiveProblem =
  | "encrypted"
  | "zip64"
  | "too_large"
  | "too_many_entries"
  | "invalid"
  | "not_archive";

const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10000;

/** Parts the Word reader reports pictures from; the copy path looks them up by the same rule. */
export const WORD_MEDIA_PART = /^word\/media\/[^/]{1,255}$/;

const ENTRY_UNREADABLE_MESSAGE = "archive entry could not be read";
const ENTRY_TOO_LARGE_MESSAGE = "archive entry exceeds the configured limit";

/** Fixed-position fields read off one central-directory record; `null` when
 *  the record at `offset` doesn't fit before `end` or lacks the signature. */
interface CentralDirectoryHeader {
  nextOffset: number;
  flags: number;
  method: number;
  compressed: number;
  uncompressed: number;
  nameLength: number;
  localOffset: number;
}

function readCentralDirectoryHeader(
  buffer: Buffer,
  offset: number,
  end: number,
): CentralDirectoryHeader | null {
  if (offset + 46 > end || buffer.readUInt32LE(offset) !== 0x02014b50) {
    return null;
  }
  const nameLength = buffer.readUInt16LE(offset + 28);
  const extraLength = buffer.readUInt16LE(offset + 30);
  const commentLength = buffer.readUInt16LE(offset + 32);
  return {
    nextOffset: offset + 46 + nameLength + extraLength + commentLength,
    flags: buffer.readUInt16LE(offset + 8),
    method: buffer.readUInt16LE(offset + 10),
    compressed: buffer.readUInt32LE(offset + 20),
    uncompressed: buffer.readUInt32LE(offset + 24),
    nameLength,
    localOffset: buffer.readUInt32LE(offset + 42),
  };
}

/** Locates the end-of-central-directory record, scanning back from the end
 *  of the file (it may be followed by a variable-length comment). */
function locateEndOfCentralDirectory(buffer: Buffer): number | null {
  let end = buffer.length - 22;
  for (; end >= Math.max(0, buffer.length - 65557); end--) {
    if (
      buffer.readUInt32LE(end) === 0x06054b50 &&
      end + 22 + buffer.readUInt16LE(end + 20) === buffer.length
    ) {
      return end;
    }
  }
  return null;
}

/** Verifies actual expansion before handing an archive to unbounded parsers. */
export function archiveProblem(
  bytes: Uint8Array,
  verifyExpansion = true,
): ArchiveProblem | null {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = locateEndOfCentralDirectory(buffer);
  if (end === null) return "not_archive";
  const count = buffer.readUInt16LE(end + 10);
  const size = buffer.readUInt32LE(end + 12);
  let offset = buffer.readUInt32LE(end + 16);
  if (buffer.readUInt32LE(end + 4) !== 0) return "invalid";
  if (count !== buffer.readUInt16LE(end + 8)) return "invalid";
  if (count > MAX_ARCHIVE_ENTRIES) return "too_many_entries";
  if (offset + size !== end) return "invalid";
  let expanded = 0;
  for (let index = 0; index < count; index++) {
    const header = readCentralDirectoryHeader(buffer, offset, end);
    if (!header) return "invalid";
    if ((header.flags & 1) !== 0) return "encrypted";
    expanded += header.uncompressed;
    if (header.compressed === 0xffffffff) return "zip64";
    if (header.uncompressed === 0xffffffff) return "zip64";
    if (header.localOffset + 30 > end) return "invalid";
    if (buffer.readUInt32LE(header.localOffset) !== 0x04034b50)
      return "invalid";
    if (expanded > MAX_EXPANDED_BYTES) return "too_large";
    const dataOffset =
      header.localOffset +
      30 +
      buffer.readUInt16LE(header.localOffset + 26) +
      buffer.readUInt16LE(header.localOffset + 28);
    if (dataOffset + header.compressed > end) return "invalid";
    if (verifyExpansion)
      try {
        const actual = extractEntry(
          buffer,
          header,
          Math.max(1, header.uncompressed),
        );
        if (actual.byteLength !== header.uncompressed) return "invalid";
      } catch (error) {
        return error instanceof ArtifactReadError &&
          error.code === "resource_limit"
          ? "too_large"
          : "invalid";
      }
    offset = header.nextOffset;
  }
  return offset === end ? null : "invalid";
}

/**
 * Throws ArtifactReadError: encrypted -> "encrypted"; zip64/too_large/
 * too_many_entries -> "resource_limit"; invalid/not_archive -> "malformed".
 */
export function assertReadableArchive(
  bytes: Uint8Array,
  verifyExpansion = true,
): void {
  const problem = archiveProblem(bytes, verifyExpansion);
  if (problem === null) return;
  if (problem === "encrypted")
    throw new ArtifactReadError("encrypted", "archive is password-protected");
  if (problem === "invalid" || problem === "not_archive")
    throw new ArtifactReadError("malformed", "archive could not be read");
  throw new ArtifactReadError(
    "resource_limit",
    "archive exceeds parser limits",
  );
}

function extractEntry(
  buffer: Buffer,
  header: CentralDirectoryHeader,
  maxBytes: number,
): Uint8Array {
  if (header.method !== 0 && header.method !== 8) {
    throw new ArtifactReadError("malformed", ENTRY_UNREADABLE_MESSAGE);
  }
  if ((header.flags & 1) !== 0) {
    throw new ArtifactReadError("malformed", ENTRY_UNREADABLE_MESSAGE);
  }
  if (
    header.localOffset + 30 > buffer.length ||
    buffer.readUInt32LE(header.localOffset) !== 0x04034b50
  ) {
    throw new ArtifactReadError("malformed", ENTRY_UNREADABLE_MESSAGE);
  }
  const localNameLength = buffer.readUInt16LE(header.localOffset + 26);
  const localExtraLength = buffer.readUInt16LE(header.localOffset + 28);
  const dataStart =
    header.localOffset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataStart + header.compressed;
  if (dataEnd > buffer.length) {
    throw new ArtifactReadError("malformed", ENTRY_UNREADABLE_MESSAGE);
  }
  const raw = buffer.subarray(dataStart, dataEnd);
  if (header.method === 0) {
    if (raw.length > maxBytes) {
      throw new ArtifactReadError("resource_limit", ENTRY_TOO_LARGE_MESSAGE);
    }
    return raw;
  }
  try {
    return inflateRawSync(raw, { maxOutputLength: maxBytes });
  } catch (cause) {
    // zlib sets code ERR_BUFFER_TOO_LARGE when maxOutputLength is exceeded;
    // any other cause is a corrupt/truncated deflate stream. Neither error's
    // native message is ever surfaced — it can quote the entry's own bytes.
    if ((cause as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
      throw new ArtifactReadError("resource_limit", ENTRY_TOO_LARGE_MESSAGE);
    }
    throw new ArtifactReadError("malformed", ENTRY_UNREADABLE_MESSAGE);
  }
}

/** One named entry, bounded on its actual inflated length because a
 *  central-directory size field can lie; null when there is no such entry. */
export function readArchiveEntry(
  bytes: Uint8Array,
  name: string,
  maxBytes: number,
): Uint8Array | null {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = locateEndOfCentralDirectory(buffer);
  if (end === null) return null;
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  for (let index = 0; index < count; index++) {
    const header = readCentralDirectoryHeader(buffer, offset, end);
    if (!header) return null;
    const entryName = buffer.toString(
      "utf8",
      offset + 46,
      offset + 46 + header.nameLength,
    );
    if (entryName === name) {
      return extractEntry(buffer, header, maxBytes);
    }
    offset = header.nextOffset;
  }
  return null;
}

export interface ArchiveEntryRead {
  name: string;
  /** null when the entry is over maxBytes or cannot be read. */
  bytes: Uint8Array | null;
  tooLarge: boolean;
  /** Inflate output this entry cost: at most maxBytes, 0 when nothing was inflated. */
  inflatedBytes: number;
}

function readBoundedEntry(
  buffer: Buffer,
  header: CentralDirectoryHeader,
  maxBytes: number,
): Omit<ArchiveEntryRead, "name"> {
  if (header.uncompressed > maxBytes)
    return { bytes: null, tooLarge: true, inflatedBytes: 0 };
  const deflated = header.method === 8;
  try {
    const bytes = extractEntry(buffer, header, maxBytes);
    return {
      bytes,
      tooLarge: false,
      inflatedBytes: deflated ? bytes.byteLength : 0,
    };
  } catch (cause) {
    return {
      bytes: null,
      tooLarge:
        cause instanceof ArtifactReadError && cause.code === "resource_limit",
      inflatedBytes: deflated ? maxBytes : 0,
    };
  }
}

/** Reads every entry `accept` names in one walk; false when stopped early or unreadable. Never throws. */
export function readArchiveEntries(
  bytes: Uint8Array,
  accept: (name: string) => boolean,
  maxBytes: number,
  limits: { maxEntries: number; maxNameBytes: number },
  visit: (entry: ArchiveEntryRead) => boolean,
): boolean {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = locateEndOfCentralDirectory(buffer);
  if (end === null) return false;
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  let read = 0;
  for (let index = 0; index < count; index++) {
    const header = readCentralDirectoryHeader(buffer, offset, end);
    if (!header) return false;
    const nameStart = offset + 46;
    offset = header.nextOffset;
    if (header.nameLength > limits.maxNameBytes) continue;
    const name = buffer.toString(
      "utf8",
      nameStart,
      nameStart + header.nameLength,
    );
    if (!accept(name)) continue;
    if (read >= limits.maxEntries) return false;
    read += 1;
    if (!visit({ name, ...readBoundedEntry(buffer, header, maxBytes) }))
      return false;
  }
  return true;
}

/**
 * Entry names in central-directory order, for callers that must discover
 * parts whose names are not fixed (a package's word/headerN.xml set, say).
 * Reads no entry data; an unreadable directory yields the names found so far.
 */
export function listArchiveEntryNames(bytes: Uint8Array): string[] {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = locateEndOfCentralDirectory(buffer);
  if (end === null) return [];
  const count = buffer.readUInt16LE(end + 10);
  const names: string[] = [];
  let offset = buffer.readUInt32LE(end + 16);
  for (let index = 0; index < count; index++) {
    const header = readCentralDirectoryHeader(buffer, offset, end);
    if (!header) break;
    names.push(
      buffer.toString("utf8", offset + 46, offset + 46 + header.nameLength),
    );
    offset = header.nextOffset;
  }
  return names;
}

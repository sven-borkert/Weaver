import { crc32, deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  archiveProblem,
  assertReadableArchive,
  listArchiveEntryNames,
  readArchiveEntries,
  readArchiveEntry,
  WORD_MEDIA_PART,
  type ArchiveEntryRead,
  type ArchiveProblem,
} from "./archive";
import { ArtifactReadError } from "./errors";

const CENTRAL_SIGNATURE = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
const END_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

/** Minimal STORED zip, hand-assembled like packages/ingestion's fixtures builder. */
function buildZip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const data = Buffer.from(value, "utf8");
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([header, nameBytes]));
    const entry = Buffer.concat([local, nameBytes, data]);
    locals.push(entry);
    offset += entry.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/**
 * Zip with full control over each entry's method/flags/declared sizes, for
 * readArchiveEntry tests that need a DEFLATE entry or a central-directory
 * field that lies about the entry's size. `content` is the entry's on-disk
 * bytes (already compressed for method 8); `uncompressedSize` defaults to
 * `content.length` but can be overridden to simulate a lying declaration.
 */
function buildArchive(
  entries: Array<{
    name: string;
    content: Buffer;
    method?: number;
    flags?: number;
    uncompressedSize?: number;
  }>,
): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const method = entry.method ?? 0;
    const flags = entry.flags ?? 0;
    const data = entry.content;
    const nameBytes = Buffer.from(entry.name, "utf8");
    const crc = crc32(data);
    const uncompressedSize = entry.uncompressedSize ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(uncompressedSize, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([header, nameBytes]));
    const entryBytes = Buffer.concat([local, nameBytes, data]);
    locals.push(entryBytes);
    offset += entryBytes.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function findCentralEntry(bytes: Buffer): number {
  const entry = bytes.indexOf(CENTRAL_SIGNATURE);
  expect(entry).toBeGreaterThan(0);
  return entry;
}

function findEndRecord(bytes: Buffer): number {
  const end = bytes.indexOf(END_SIGNATURE);
  expect(end).toBeGreaterThan(0);
  return end;
}

function readErrorCode(bytes: Buffer): string {
  try {
    assertReadableArchive(bytes);
  } catch (error) {
    expect(error).toBeInstanceOf(ArtifactReadError);
    return (error as ArtifactReadError).code;
  }
  throw new Error("expected assertReadableArchive to throw");
}

describe("archiveProblem", () => {
  it("rejects a false size before handing compressed bytes to a parser", () => {
    const bytes = buildArchive([
      {
        name: "word/document.xml",
        content: deflateRawSync(Buffer.alloc(1_000_000)),
        method: 8,
        uncompressedSize: 10,
      },
    ]);
    expect(archiveProblem(bytes)).toBe("too_large");
  });

  it("returns null for a valid small archive", () => {
    const bytes = buildZip({ "a.txt": "hello" });
    expect(archiveProblem(bytes)).toBeNull();
  });

  it("returns not_archive when no end-of-central-directory record is found", () => {
    const bytes = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(archiveProblem(bytes)).toBe<ArchiveProblem>("not_archive");
  });

  it("returns invalid when the central directory offset is inconsistent", () => {
    const bytes = buildZip({ "a.txt": "hello" });
    const end = findEndRecord(bytes);
    bytes.writeUInt32LE(bytes.readUInt32LE(end + 16) + 1, end + 16);
    expect(archiveProblem(bytes)).toBe<ArchiveProblem>("invalid");
  });

  it("returns too_many_entries when the entry count exceeds the limit", () => {
    const bytes = buildZip({ "a.txt": "hello" });
    const end = findEndRecord(bytes);
    bytes.writeUInt16LE(10001, end + 8);
    bytes.writeUInt16LE(10001, end + 10);
    expect(archiveProblem(bytes)).toBe<ArchiveProblem>("too_many_entries");
  });

  it("returns encrypted when an entry's general-purpose bit 0 is set", () => {
    const bytes = buildZip({ "a.txt": "hello" });
    const entry = findCentralEntry(bytes);
    bytes.writeUInt16LE(1, entry + 8);
    expect(archiveProblem(bytes)).toBe<ArchiveProblem>("encrypted");
  });

  it("returns zip64 when the compressed-size sentinel is set", () => {
    const bytes = buildZip({ "a.txt": "hello" });
    const entry = findCentralEntry(bytes);
    bytes.writeUInt32LE(0xffffffff, entry + 20);
    expect(archiveProblem(bytes)).toBe<ArchiveProblem>("zip64");
  });

  it("returns zip64 when the uncompressed-size sentinel is set", () => {
    const bytes = buildZip({ "a.txt": "hello" });
    const entry = findCentralEntry(bytes);
    bytes.writeUInt32LE(0xffffffff, entry + 24);
    expect(archiveProblem(bytes)).toBe<ArchiveProblem>("zip64");
  });

  it("returns too_large when the summed uncompressed size exceeds the limit", () => {
    const bytes = buildZip({ "a.txt": "hello" });
    const entry = findCentralEntry(bytes);
    bytes.writeUInt32LE(512 * 1024 * 1024, entry + 24);
    expect(archiveProblem(bytes)).toBe<ArchiveProblem>("too_large");
  });
});

describe("assertReadableArchive", () => {
  it("does not throw for a valid archive", () => {
    const bytes = buildZip({ "a.txt": "hello" });
    expect(() => assertReadableArchive(bytes)).not.toThrow();
  });

  it("throws encrypted for a password-protected entry", () => {
    const bytes = buildZip({ "a.txt": "hello" });
    const entry = findCentralEntry(bytes);
    bytes.writeUInt16LE(1, entry + 8);
    expect(readErrorCode(bytes)).toBe("encrypted");
  });

  it("throws resource_limit for an oversized archive", () => {
    const bytes = buildZip({ "a.txt": "hello" });
    const entry = findCentralEntry(bytes);
    bytes.writeUInt32LE(512 * 1024 * 1024, entry + 24);
    expect(readErrorCode(bytes)).toBe("resource_limit");
  });

  it("throws resource_limit for a zip64 archive", () => {
    const bytes = buildZip({ "a.txt": "hello" });
    const entry = findCentralEntry(bytes);
    bytes.writeUInt32LE(0xffffffff, entry + 20);
    expect(readErrorCode(bytes)).toBe("resource_limit");
  });

  it("throws resource_limit for too many entries", () => {
    const bytes = buildZip({ "a.txt": "hello" });
    const end = findEndRecord(bytes);
    bytes.writeUInt16LE(10001, end + 8);
    bytes.writeUInt16LE(10001, end + 10);
    expect(readErrorCode(bytes)).toBe("resource_limit");
  });

  it("throws malformed when no end-of-central-directory record is found", () => {
    const bytes = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(readErrorCode(bytes)).toBe("malformed");
  });

  it("throws malformed for a structurally inconsistent archive", () => {
    const bytes = buildZip({ "a.txt": "hello" });
    const end = findEndRecord(bytes);
    bytes.writeUInt32LE(bytes.readUInt32LE(end + 16) + 1, end + 16);
    expect(readErrorCode(bytes)).toBe("malformed");
  });
});

describe("readArchiveEntry", () => {
  it("reads a stored entry's bytes", () => {
    const bytes = buildArchive([
      { name: "[Content_Types].xml", content: Buffer.from("hello world") },
    ]);
    const entry = readArchiveEntry(bytes, "[Content_Types].xml", 1_000);
    expect(entry).not.toBeNull();
    expect(Buffer.from(entry!).toString("utf8")).toBe("hello world");
  });

  it("reads and inflates a DEFLATE entry's bytes", () => {
    const original = Buffer.from("a".repeat(500));
    const compressed = deflateRawSync(original);
    const bytes = buildArchive([
      {
        name: "[Content_Types].xml",
        content: compressed,
        method: 8,
        uncompressedSize: original.length,
      },
    ]);
    const entry = readArchiveEntry(bytes, "[Content_Types].xml", 1_000);
    expect(entry).not.toBeNull();
    expect(Buffer.from(entry!).toString("utf8")).toBe(
      original.toString("utf8"),
    );
  });

  it("returns null for a missing entry, exact and case-sensitive", () => {
    const bytes = buildArchive([
      { name: "a.txt", content: Buffer.from("hello") },
    ]);
    expect(readArchiveEntry(bytes, "b.txt", 1_000)).toBeNull();
    expect(readArchiveEntry(bytes, "A.TXT", 1_000)).toBeNull();
  });

  it("throws resource_limit when a DEFLATE entry inflates past maxBytes despite a lying declared size", () => {
    const huge = Buffer.alloc(1_000_000, 0);
    const compressed = deflateRawSync(huge);
    const bytes = buildArchive([
      {
        name: "[Content_Types].xml",
        content: compressed,
        method: 8,
        uncompressedSize: 10, // lies: the real inflated size is 1,000,000
      },
    ]);
    expect(() => readArchiveEntry(bytes, "[Content_Types].xml", 1_024)).toThrow(
      ArtifactReadError,
    );
    try {
      readArchiveEntry(bytes, "[Content_Types].xml", 1_024);
      expect.unreachable();
    } catch (e) {
      expect((e as ArtifactReadError).code).toBe("resource_limit");
    }
  });

  it("throws malformed for an unsupported compression method, without leaking zlib's native message", () => {
    const bytes = buildArchive([
      {
        name: "[Content_Types].xml",
        content: Buffer.from("irrelevant MARKER_SECRET_XYZ"),
        method: 99,
      },
    ]);
    try {
      readArchiveEntry(bytes, "[Content_Types].xml", 1_000);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ArtifactReadError);
      expect((e as ArtifactReadError).code).toBe("malformed");
      expect((e as ArtifactReadError).message).not.toContain(
        "MARKER_SECRET_XYZ",
      );
    }
  });

  it("throws malformed for a corrupt DEFLATE stream, without leaking zlib's native message", () => {
    const bytes = buildArchive([
      {
        name: "[Content_Types].xml",
        content: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
        method: 8,
        uncompressedSize: 1_000,
      },
    ]);
    try {
      readArchiveEntry(bytes, "[Content_Types].xml", 1_000);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ArtifactReadError);
      expect((e as ArtifactReadError).code).toBe("malformed");
    }
  });
});

describe("listArchiveEntryNames", () => {
  it("lists entry names in central-directory order", () => {
    const bytes = buildArchive([
      { name: "word/document.xml", content: Buffer.from("a") },
      { name: "word/header1.xml", content: Buffer.from("b") },
      { name: "word/footer1.xml", content: Buffer.from("c") },
    ]);
    expect(listArchiveEntryNames(bytes)).toEqual([
      "word/document.xml",
      "word/header1.xml",
      "word/footer1.xml",
    ]);
  });

  it("returns an empty list when no end-of-central-directory record exists", () => {
    expect(listArchiveEntryNames(Buffer.from("not a zip"))).toEqual([]);
  });
});

describe("readArchiveEntries", () => {
  const LIMITS = { maxEntries: 10, maxNameBytes: 64 };
  const media = (name: string) => name.startsWith("word/media/");
  const collect = (
    bytes: Buffer,
    maxBytes = 1_000,
    limits = LIMITS,
    keepGoing: (entry: ArchiveEntryRead) => boolean = () => true,
  ) => {
    const entries: ArchiveEntryRead[] = [];
    const complete = readArchiveEntries(
      bytes,
      media,
      maxBytes,
      limits,
      (entry) => {
        entries.push(entry);
        return keepGoing(entry);
      },
    );
    return { entries, complete };
  };
  const deflated = (name: string, original: Buffer, declared?: number) => ({
    name,
    content: deflateRawSync(original),
    method: 8,
    uncompressedSize: declared ?? original.length,
  });

  it("reads the accepted entries in directory order and passes over the rest", () => {
    const { entries, complete } = collect(
      buildArchive([
        { name: "word/document.xml", content: Buffer.from("<xml />") },
        { name: "word/media/a.png", content: Buffer.from("stored") },
        deflated("word/media/b.png", Buffer.from("b".repeat(300))),
        { name: "docProps/app.xml", content: Buffer.from("<app />") },
      ]),
    );
    expect(complete).toBe(true);
    expect(
      entries.map((entry) => [
        entry.name,
        Buffer.from(entry.bytes!).toString("utf8"),
        entry.tooLarge,
        entry.inflatedBytes,
      ]),
    ).toEqual([
      ["word/media/a.png", "stored", false, 0],
      ["word/media/b.png", "b".repeat(300), false, 300],
    ]);
  });

  it("flags an entry over the limit and goes on to the next one", () => {
    const { entries, complete } = collect(
      buildArchive([
        deflated("word/media/lying.png", Buffer.alloc(100_000), 10),
        deflated("word/media/declared.png", Buffer.alloc(2_000)),
        { name: "word/media/stored.png", content: Buffer.alloc(2_000) },
        { name: "word/media/ok.png", content: Buffer.from("ok") },
      ]),
    );
    expect(complete).toBe(true);
    expect(
      entries.map((entry) => [
        entry.name,
        entry.bytes === null,
        entry.tooLarge,
        entry.inflatedBytes,
      ]),
    ).toEqual([
      ["word/media/lying.png", true, true, 1_000],
      ["word/media/declared.png", true, true, 0],
      ["word/media/stored.png", true, true, 0],
      ["word/media/ok.png", false, false, 0],
    ]);
  });

  it("reports a corrupt or unsupported entry as unreadable without throwing", () => {
    const { entries, complete } = collect(
      buildArchive([
        {
          name: "word/media/corrupt.png",
          content: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
          method: 8,
          uncompressedSize: 500,
        },
        {
          name: "word/media/method.png",
          content: Buffer.from("x"),
          method: 99,
        },
        { name: "word/media/ok.png", content: Buffer.from("ok") },
      ]),
    );
    expect(complete).toBe(true);
    expect(
      entries.map((entry) => [
        entry.bytes === null,
        entry.tooLarge,
        entry.inflatedBytes,
      ]),
    ).toEqual([
      [true, false, 1_000],
      [true, false, 0],
      [false, false, 0],
    ]);
  });

  it("skips an entry whose name is longer than maxNameBytes without asking about it", () => {
    const long = `word/media/${"n".repeat(80)}.png`;
    const asked: string[] = [];
    const entries: string[] = [];
    const complete = readArchiveEntries(
      buildArchive([
        { name: long, content: Buffer.from("long") },
        { name: "word/media/short.png", content: Buffer.from("short") },
      ]),
      (name) => {
        asked.push(name);
        return true;
      },
      1_000,
      LIMITS,
      (entry) => {
        entries.push(entry.name);
        return true;
      },
    );
    expect(complete).toBe(true);
    expect(asked).toEqual(["word/media/short.png"]);
    expect(entries).toEqual(["word/media/short.png"]);
  });

  it("stops at maxEntries and says the walk was cut short", () => {
    const three = buildArchive(
      ["a", "b", "c"].map((name) => ({
        name: `word/media/${name}.png`,
        content: Buffer.from(name),
      })),
    );
    const cut = collect(three, 1_000, { ...LIMITS, maxEntries: 2 });
    expect(cut.complete).toBe(false);
    expect(cut.entries.map((entry) => entry.name)).toEqual([
      "word/media/a.png",
      "word/media/b.png",
    ]);
    const exact = collect(three, 1_000, { ...LIMITS, maxEntries: 3 });
    expect(exact.complete).toBe(true);
    expect(exact.entries).toHaveLength(3);
  });

  it("stops when the visitor asks it to", () => {
    const { entries, complete } = collect(
      buildArchive([
        { name: "word/media/a.png", content: Buffer.from("a") },
        { name: "word/media/b.png", content: Buffer.from("b") },
      ]),
      1_000,
      LIMITS,
      () => false,
    );
    expect(complete).toBe(false);
    expect(entries).toHaveLength(1);
  });

  it("never throws for a hostile archive", () => {
    const valid = buildArchive([
      { name: "word/media/a.png", content: Buffer.from("a") },
      { name: "word/media/b.png", content: Buffer.from("b") },
    ]);
    expect(collect(Buffer.from("not a zip"))).toEqual({
      entries: [],
      complete: false,
    });
    expect(collect(Buffer.alloc(0)).complete).toBe(false);

    // Second central record loses its signature: the walk ends after the first.
    const broken = Buffer.from(valid);
    broken.writeUInt32LE(0, broken.lastIndexOf(CENTRAL_SIGNATURE));
    const walked = collect(broken);
    expect(walked.complete).toBe(false);
    expect(walked.entries.map((entry) => entry.name)).toEqual([
      "word/media/a.png",
    ]);

    // Local header offset points past the end of the file.
    const dangling = Buffer.from(valid);
    dangling.writeUInt32LE(0xfffffff0, findCentralEntry(dangling) + 42);
    expect(collect(dangling).entries[0]).toMatchObject({
      bytes: null,
      tooLarge: false,
    });
  });
});

describe("WORD_MEDIA_PART", () => {
  it("matches one path segment below word/media only", () => {
    expect(WORD_MEDIA_PART.test("word/media/image1.png")).toBe(true);
    expect(WORD_MEDIA_PART.test("word/media/sub/image1.png")).toBe(false);
    expect(WORD_MEDIA_PART.test("word/embeddings/image1.png")).toBe(false);
    expect(WORD_MEDIA_PART.test("word/media/")).toBe(false);
    expect(WORD_MEDIA_PART.test(`word/media/${"n".repeat(256)}`)).toBe(false);
  });
});

import { crc32, deflateRawSync } from "node:zlib";
import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";
import { ArtifactReadError } from "./errors";
import { readExcelOverview, readExcelSheet, readExcelWorkbook } from "./excel";

const CENTRAL_SIGNATURE = Buffer.from([0x50, 0x4b, 0x01, 0x02]);

function readCode(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => {
      throw new Error("expected the promise to reject");
    },
    (e: unknown) => {
      expect(e).toBeInstanceOf(ArtifactReadError);
      return (e as ArtifactReadError).code;
    },
  );
}

async function buildWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const servers = workbook.addWorksheet("Servers");
  servers.addRows([
    ["Name", "Role"],
    ["db01", "database"],
    ["web01", "web"],
  ]);
  const ports = workbook.addWorksheet("Ports");
  ports.addRows([
    ["Port", "Protocol"],
    ["80", "HTTP"],
  ]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** One cell far to the right, so the sheet is wider than the default
 *  maxCells budget and not a single whole row fits. */
async function buildWideWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const narrow = workbook.addWorksheet("Narrow");
  narrow.addRows([["Name"], ["Ada"]]);
  const wide = workbook.addWorksheet("Wide");
  wide.getCell(1, 1).value = "left";
  wide.getCell(1, 1_500).value = "right";
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function buildOverviewWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const servers = workbook.addWorksheet("Servers");
  servers.addRows([
    ["Name", "Role", "Cost"],
    ["db01", "database", null],
    ["web01", "web", 3],
  ]);
  servers.getCell("C2").value = { formula: "1+1", result: 2 };
  workbook.addWorksheet("Empty");

  const wide = workbook.addWorksheet("Wide");
  wide.addRow(Array.from({ length: 30 }, (_value, index) => `C${index + 1}`));
  wide.addRow(Array.from({ length: 30 }, (_value, index) => `v${index + 1}`));

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/**
 * Hand-assembled zip with full control over each entry's method and declared
 * uncompressed size, matching archive.test.ts's fixture builder (duplicated
 * here rather than shared — these are test-only fixtures, not the production
 * ZIP-reading code the review flagged, which now lives once in archive.ts).
 * `content` is on-disk bytes (already DEFLATEd for method 8); a plain
 * STORED entry is the default.
 */
function buildZip(
  entries: Array<{
    name: string;
    content: Buffer;
    method?: number;
    uncompressedSize?: number;
  }>,
): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const method = entry.method ?? 0;
    const data = entry.content;
    const nameBytes = Buffer.from(entry.name, "utf8");
    const crc = crc32(data);
    const uncompressedSize = entry.uncompressedSize ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
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

function contentTypesXml(contentType: string): Buffer {
  return Buffer.from(
    '<?xml version="1.0"?><Types><Override PartName="/xl/workbook.xml" ' +
      `ContentType="${contentType}"/></Types>`,
    "utf8",
  );
}

const MACRO_CONTENT_TYPE =
  "application/vnd.ms-excel.sheet.macroEnabled.main+xml";

describe("readExcelOverview", () => {
  it("builds a bounded workbook overview with headers, samples, counts, and warnings", async () => {
    const xlsx = await buildOverviewWorkbook();

    const overview = await readExcelOverview(xlsx, {
      sampleRowsPerSheet: 1,
      maxColumnsPerSheet: 3,
      maxSampleCells: 50,
    });

    expect(overview.sheets.map((sheet) => sheet.name)).toEqual([
      "Servers",
      "Empty",
      "Wide",
    ]);
    expect(overview.truncated).toBe(true);

    expect(overview.sheets[0]).toMatchObject({
      index: 1,
      name: "Servers",
      empty: false,
      usedRange: {
        startCell: "A1",
        endCell: "C3",
        startRow: 1,
        endRow: 3,
        startColumn: 1,
        endColumn: 3,
      },
      nonEmptyCellCount: 9,
      formulaCellCount: 1,
      likelyHeaders: { rowNumber: 1, values: ["Name", "Role", "Cost"] },
      sampleRows: [
        {
          rowNumber: 2,
          values: ["db01", "database", { formula: "1+1", result: 2 }],
        },
      ],
      truncated: false,
    });

    expect(overview.sheets[1]).toMatchObject({
      name: "Empty",
      empty: true,
      usedRange: null,
      likelyHeaders: null,
      sampleRows: [],
      truncated: false,
    });

    expect(overview.sheets[2]).toMatchObject({
      name: "Wide",
      empty: false,
      likelyHeaders: { rowNumber: 1, values: ["C1", "C2", "C3"] },
      sampleRows: [{ rowNumber: 2, values: ["v1", "v2", "v3"] }],
      truncated: true,
    });
    expect(overview.sheets[2]!.warnings.join("\n")).toContain(
      "later used columns are omitted",
    );
  });

  it("reports omitted sheets and sample-budget truncation", async () => {
    const xlsx = await buildOverviewWorkbook();

    const overview = await readExcelOverview(xlsx, {
      maxSheets: 1,
      maxSampleCells: 1,
    });

    expect(overview.truncated).toBe(true);
    expect(overview.sheets).toHaveLength(1);
    expect(overview.sheets[0]).toMatchObject({
      name: "Servers",
      likelyHeaders: null,
      sampleRows: [],
      truncated: true,
    });
    expect(overview.sheets[0]!.warnings.join("\n")).toContain(
      "No sample budget remained",
    );
    expect(overview.omittedSheets.map((sheet) => sheet.name)).toEqual([
      "Empty",
      "Wide",
    ]);
  });

  it("rejects an out-of-range limit with invalid_input", async () => {
    const xlsx = await buildOverviewWorkbook();
    const code = await readCode(readExcelOverview(xlsx, { maxSheets: 0 }));
    expect(code).toBe("invalid_input");
  });
});

describe("readExcelSheet", () => {
  it("reads a selected sheet range", async () => {
    const xlsx = await buildWorkbook();

    await expect(
      readExcelSheet(xlsx, {
        sheetName: "Servers",
        range: "A2:B3",
        maxCells: 20,
      }),
    ).resolves.toMatchObject({
      sheetName: "Servers",
      rows: [
        { rowNumber: 2, values: ["db01", "database"] },
        { rowNumber: 3, values: ["web01", "web"] },
      ],
      truncated: false,
    });
  });

  it("throws not_found for an unknown sheet name, without listing real sheet names", async () => {
    const xlsx = await buildWorkbook();
    const code = await readCode(readExcelSheet(xlsx, { sheetName: "Nope" }));
    expect(code).toBe("not_found");
    try {
      await readExcelSheet(xlsx, { sheetName: "Nope" });
      expect.unreachable();
    } catch (e) {
      const message = (e as ArtifactReadError).message;
      expect(message).toContain("Nope");
      expect(message).not.toContain("Servers");
      expect(message).not.toContain("Ports");
    }
  });

  it("throws invalid_input for a malformed range", async () => {
    const xlsx = await buildWorkbook();
    const code = await readCode(
      readExcelSheet(xlsx, { sheetName: "Servers", range: "not-a-range" }),
    );
    expect(code).toBe("invalid_input");
  });

  it("throws invalid_input for a malformed cursor", async () => {
    const xlsx = await buildWorkbook();
    const code = await readCode(
      readExcelSheet(xlsx, { sheetName: "Servers", cursor: "not-a-number" }),
    );
    expect(code).toBe("invalid_input");
  });

  it("throws resource_limit when the sheet is wider than maxCells, instead of returning the cursor it was given", async () => {
    const xlsx = await buildWideWorkbook();
    const code = await readCode(readExcelSheet(xlsx, { sheetName: "Wide" }));
    expect(code).toBe("resource_limit");
    try {
      await readExcelSheet(xlsx, { sheetName: "Wide" });
      expect.unreachable();
    } catch (e) {
      const message = (e as ArtifactReadError).message;
      expect(message).toContain("1500");
      expect(message).toMatch(/range/);
      expect(message).toMatch(/maxCells/);
      expect(message).not.toContain("right");
      expect(message).not.toContain("Wide");
    }
  });

  it("reads the same wide sheet when an explicit range narrows it", async () => {
    const xlsx = await buildWideWorkbook();
    await expect(
      readExcelSheet(xlsx, { sheetName: "Wide", range: "A1:A1" }),
    ).resolves.toMatchObject({
      sheetName: "Wide",
      rows: [{ rowNumber: 1, values: ["left"] }],
      truncated: false,
      nextCursor: null,
    });
  });

  it("pages through a sheet with a cursor that continues exactly where the previous page stopped", async () => {
    const xlsx = await buildWorkbook();

    const first = await readExcelSheet(xlsx, {
      sheetName: "Servers",
      maxCells: 2,
    });
    expect(first.rows).toEqual([{ rowNumber: 1, values: ["Name", "Role"] }]);
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).toBe("2");

    const second = await readExcelSheet(xlsx, {
      sheetName: "Servers",
      cursor: first.nextCursor,
      maxCells: 2,
    });
    expect(second.rows).toEqual([
      { rowNumber: 2, values: ["db01", "database"] },
    ]);
    expect(second.truncated).toBe(true);
    expect(second.nextCursor).toBe("3");

    const third = await readExcelSheet(xlsx, {
      sheetName: "Servers",
      cursor: second.nextCursor,
      maxCells: 2,
    });
    expect(third.rows).toEqual([{ rowNumber: 3, values: ["web01", "web"] }]);
    expect(third.truncated).toBe(false);
    expect(third.nextCursor).toBeNull();
  });

  it("surfaces formulas as { formula, result }", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("S");
    sheet.getCell("A1").value = { formula: "1+1", result: 2 };
    const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());

    await expect(
      readExcelSheet(xlsx, { sheetName: "S" }),
    ).resolves.toMatchObject({
      rows: [{ rowNumber: 1, values: [{ formula: "1+1", result: 2 }] }],
    });
  });

  it("surfaces dates as ISO strings", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("S");
    const date = new Date("2026-01-15T00:00:00.000Z");
    sheet.getCell("A1").value = date;
    const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());

    await expect(
      readExcelSheet(xlsx, { sheetName: "S" }),
    ).resolves.toMatchObject({
      rows: [{ rowNumber: 1, values: [date.toISOString()] }],
    });
  });

  it("returns value plus text for numeric cells whose display text differs", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("S");
    sheet.getCell("A1").value = 2222.8443;
    sheet.getCell("A2").value = 42;
    const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());

    const cellProto = Object.getPrototypeOf(sheet.getCell("A1")) as object;
    const descriptor = Object.getOwnPropertyDescriptor(cellProto, "text")!;
    Object.defineProperty(cellProto, "text", {
      ...descriptor,
      get(this: ExcelJS.Cell): string {
        if (this.value === 2222.8443) return "2222, 8443";
        return descriptor.get!.call(this) as string;
      },
    });
    try {
      await expect(
        readExcelSheet(xlsx, { sheetName: "S" }),
      ).resolves.toMatchObject({
        rows: [
          { rowNumber: 1, values: [{ value: 2222.8443, text: "2222, 8443" }] },
          { rowNumber: 2, values: [42] },
        ],
      });
    } finally {
      Object.defineProperty(cellProto, "text", descriptor);
    }
  });
});

describe("readExcelWorkbook", () => {
  it("reads all worksheet data through cursors", async () => {
    const xlsx = await buildWorkbook();

    const first = await readExcelWorkbook(xlsx, { maxCells: 4 });
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).toBe("1:3");
    expect(first.sheets[0]).toMatchObject({
      name: "Servers",
      rows: [
        { rowNumber: 1, values: ["Name", "Role"] },
        { rowNumber: 2, values: ["db01", "database"] },
      ],
    });

    const second = await readExcelWorkbook(xlsx, {
      cursor: first.nextCursor,
      maxCells: 20,
    });
    expect(second.truncated).toBe(false);
    expect(second.nextCursor).toBeNull();
    expect(second.sheets.map((sheet) => sheet.name)).toEqual([
      "Servers",
      "Ports",
    ]);
  });

  it("throws invalid_input for a malformed cursor", async () => {
    const xlsx = await buildWorkbook();
    const code = await readCode(readExcelWorkbook(xlsx, { cursor: "garbage" }));
    expect(code).toBe("invalid_input");
  });

  it("throws resource_limit naming the too-wide worksheet instead of making every later sheet unreachable", async () => {
    const xlsx = await buildWideWorkbook();
    const code = await readCode(readExcelWorkbook(xlsx));
    expect(code).toBe("resource_limit");
    try {
      await readExcelWorkbook(xlsx);
      expect.unreachable();
    } catch (e) {
      const message = (e as ArtifactReadError).message;
      expect(message).toContain("2");
      expect(message).toContain("1500");
      expect(message).not.toContain("right");
      expect(message).not.toContain("Wide");
    }
  });
});

describe("file-shape failures", () => {
  it("throws legacy_format for a synthetic OLE header with no CFB encryption marker", async () => {
    // Synthetic: a real .xls has a full CFB directory; this is just the
    // 8-byte magic number plus filler, enough to exercise the "not
    // encrypted" branch of classifyOleContainer.
    const ole = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(64),
    ]);
    const code = await readCode(readExcelOverview(ole));
    expect(code).toBe("legacy_format");
  });

  it("throws encrypted for a synthetic OLE header containing the CFB EncryptedPackage stream-name marker", async () => {
    // Synthetic: real Excel password protection produces a full CFB
    // directory sector; this only plants the UTF-16LE stream-name bytes
    // classifyOleContainer looks for, not a real CFB file.
    const ole = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(32),
      Buffer.from("EncryptedPackage", "utf16le"),
      Buffer.alloc(32),
    ]);
    const code = await readCode(readExcelOverview(ole));
    expect(code).toBe("encrypted");
  });

  it("throws legacy_format for a package declaring a macro-enabled content type (STORED), without opening it in ExcelJS", async () => {
    const bytes = buildZip([
      {
        name: "[Content_Types].xml",
        content: contentTypesXml(MACRO_CONTENT_TYPE),
      },
    ]);
    const probe = new ExcelJS.Workbook();
    const xlsxProto = Object.getPrototypeOf(probe.xlsx) as {
      load: (...args: unknown[]) => unknown;
    };
    const loadSpy = vi.spyOn(xlsxProto, "load");
    try {
      const code = await readCode(readExcelOverview(bytes));
      expect(code).toBe("legacy_format");
      expect(loadSpy).not.toHaveBeenCalled();
    } finally {
      loadSpy.mockRestore();
    }
  });

  it("throws legacy_format for a package declaring a macro-enabled content type (DEFLATE), without opening it in ExcelJS", async () => {
    const original = contentTypesXml(MACRO_CONTENT_TYPE);
    const bytes = buildZip([
      {
        name: "[Content_Types].xml",
        content: deflateRawSync(original),
        method: 8,
        uncompressedSize: original.length,
      },
    ]);
    const probe = new ExcelJS.Workbook();
    const xlsxProto = Object.getPrototypeOf(probe.xlsx) as {
      load: (...args: unknown[]) => unknown;
    };
    const loadSpy = vi.spyOn(xlsxProto, "load");
    try {
      const code = await readCode(readExcelOverview(bytes));
      expect(code).toBe("legacy_format");
      expect(loadSpy).not.toHaveBeenCalled();
    } finally {
      loadSpy.mockRestore();
    }
  });

  it("throws malformed for a ZIP that is not a workbook, without leaking a marker from its content", async () => {
    const bytes = buildZip([
      {
        name: "notes.txt",
        content: Buffer.from("hello world MARKER_SECRET_XYZ", "utf8"),
      },
    ]);
    const code = await readCode(readExcelOverview(bytes));
    expect(code).toBe("malformed");
    try {
      await readExcelOverview(bytes);
      expect.unreachable();
    } catch (e) {
      expect((e as ArtifactReadError).message).not.toContain(
        "MARKER_SECRET_XYZ",
      );
    }
  });

  it("rejects a zip bomb via assertReadableArchive before ExcelJS opens it", async () => {
    const xlsx = await buildWorkbook();
    const entry = xlsx.indexOf(CENTRAL_SIGNATURE);
    expect(entry).toBeGreaterThan(0);
    const bomb = Buffer.from(xlsx);
    bomb.writeUInt32LE(512 * 1024 * 1024, entry + 24);

    const probe = new ExcelJS.Workbook();
    const xlsxProto = Object.getPrototypeOf(probe.xlsx) as {
      load: (...args: unknown[]) => unknown;
    };
    const loadSpy = vi.spyOn(xlsxProto, "load");
    try {
      const code = await readCode(readExcelOverview(bomb));
      expect(code).toBe("resource_limit");
      expect(loadSpy).not.toHaveBeenCalled();
    } finally {
      loadSpy.mockRestore();
    }
  });

  it("throws encrypted for a password-protected archive entry", async () => {
    const bytes = buildZip([
      { name: "a.txt", content: Buffer.from("hello", "utf8") },
    ]);
    const entry = bytes.indexOf(CENTRAL_SIGNATURE);
    expect(entry).toBeGreaterThan(0);
    bytes.writeUInt16LE(1, entry + 8);
    const code = await readCode(readExcelOverview(bytes));
    expect(code).toBe("encrypted");
  });

  it("propagates resource_limit when the content-types part itself exceeds the sniff bound", async () => {
    const huge = Buffer.alloc(5_000_000, 0x20);
    const bytes = buildZip([
      {
        name: "[Content_Types].xml",
        content: deflateRawSync(huge),
        method: 8,
        uncompressedSize: 10, // lies: the real inflated size is 5,000,000
      },
    ]);
    const code = await readCode(readExcelOverview(bytes));
    expect(code).toBe("resource_limit");
  });
});

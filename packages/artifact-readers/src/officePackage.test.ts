import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  classifyOleContainer,
  declaresMacroEnabledContentType,
} from "./officePackage";

const WORD_MAIN_PART = "/word/document.xml";
const EXCEL_MAIN_PART = "/xl/workbook.xml";

/** Minimal STORED zip holding one [Content_Types].xml, like archive.test.ts's
 *  fixture builder. */
function buildPackage(contentTypes: string): Buffer {
  const name = Buffer.from("[Content_Types].xml", "utf8");
  const data = Buffer.from(contentTypes, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc32(data), 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt32LE(crc32(data), 16);
  header.writeUInt32LE(data.length, 20);
  header.writeUInt32LE(data.length, 24);
  header.writeUInt16LE(name.length, 28);
  const entry = Buffer.concat([local, name, data]);
  const directory = Buffer.concat([header, name]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(entry.length, 16);
  return Buffer.concat([entry, directory, end]);
}

function types(body: string): Buffer {
  return buildPackage(
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${body}</Types>`,
  );
}

const WORD_MACRO = "application/vnd.ms-word.document.macroEnabled.main+xml";
const WORD_PLAIN =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const EXCEL_MACRO = "application/vnd.ms-excel.sheet.macroEnabled.main+xml";
const EXCEL_PLAIN =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
const EMBEDDED_MACRO_WORKBOOK =
  "application/vnd.ms-excel.sheet.macroEnabled.12";

describe("declaresMacroEnabledContentType", () => {
  it("detects a macro-enabled main part via its Override", () => {
    const word = types(
      `<Override PartName="/word/document.xml" ContentType="${WORD_MACRO}"/>`,
    );
    const excel = types(
      `<Override PartName="/xl/workbook.xml" ContentType="${EXCEL_MACRO}"/>`,
    );

    expect(declaresMacroEnabledContentType(word, WORD_MAIN_PART)).toBe(true);
    expect(declaresMacroEnabledContentType(excel, EXCEL_MAIN_PART)).toBe(true);
  });

  it("ignores a macro-enabled content type declared for an EMBEDDED part", () => {
    const bytes = types(
      `<Override PartName="/word/document.xml" ContentType="${WORD_PLAIN}"/>` +
        `<Override PartName="/word/embeddings/Book1.xlsm" ContentType="${EMBEDDED_MACRO_WORKBOOK}"/>`,
    );

    expect(declaresMacroEnabledContentType(bytes, WORD_MAIN_PART)).toBe(false);
  });

  it("falls back to the Default mapping for the main part's extension", () => {
    const macro = types(
      `<Default Extension="xml" ContentType="${EXCEL_MACRO}"/>`,
    );
    const plain = types(
      `<Default Extension="xml" ContentType="${EXCEL_PLAIN}"/>`,
    );

    expect(declaresMacroEnabledContentType(macro, EXCEL_MAIN_PART)).toBe(true);
    expect(declaresMacroEnabledContentType(plain, EXCEL_MAIN_PART)).toBe(false);
  });

  it("prefers the main part's Override over the Default mapping", () => {
    const bytes = types(
      `<Default Extension="xml" ContentType="${EXCEL_MACRO}"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="${EXCEL_PLAIN}"/>`,
    );

    expect(declaresMacroEnabledContentType(bytes, EXCEL_MAIN_PART)).toBe(false);
  });

  it("matches part names case-insensitively and single-quoted attributes", () => {
    const bytes = types(
      `<Override PartName='/WORD/Document.xml' ContentType='${WORD_MACRO}'/>`,
    );

    expect(declaresMacroEnabledContentType(bytes, WORD_MAIN_PART)).toBe(true);
  });

  it("returns false when the package declares nothing for the main part", () => {
    expect(
      declaresMacroEnabledContentType(
        types('<Default Extension="rels" ContentType="x"/>'),
        WORD_MAIN_PART,
      ),
    ).toBe(false);
    expect(
      declaresMacroEnabledContentType(Buffer.from("not a zip"), WORD_MAIN_PART),
    ).toBe(false);
  });
});

describe("classifyOleContainer", () => {
  it("returns null for bytes that are not an OLE container", () => {
    expect(classifyOleContainer(Buffer.from("PK\u0003\u0004rest"))).toBeNull();
  });
});

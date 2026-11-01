import { crc32 } from "node:zlib";
import { createCanvas } from "@napi-rs/canvas";
import ExcelJS from "exceljs";

/** Minimal STORED zip so DOCX fixtures need no third-party binaries. */
export function buildZip(entries: Record<string, string | Uint8Array>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const data =
      typeof value === "string"
        ? Buffer.from(value, "utf8")
        : Buffer.from(value);
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

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const xmlEscape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const run = (text: string) =>
  `<w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;

export function docxFixture(content: {
  heading?: string;
  paragraphs?: string[];
  table?: string[][];
  images?: number;
}): Buffer {
  const body = [
    content.heading
      ? `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${run(content.heading)}</w:p>`
      : "",
    ...(content.paragraphs ?? []).map((text) => `<w:p>${run(text)}</w:p>`),
    content.table
      ? `<w:tbl>${content.table
          .map(
            (row) =>
              `<w:tr>${row.map((cell) => `<w:tc><w:p>${run(cell)}</w:p></w:tc>`).join("")}</w:tr>`,
          )
          .join("")}</w:tbl>`
      : "",
    ...Array.from(
      { length: content.images ?? 0 },
      (_, index) =>
        `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="rIdImg${index}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`,
    ),
  ].join("");
  const imageRels = Array.from(
    { length: content.images ?? 0 },
    (_, index) =>
      `<Relationship Id="rIdImg${index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${index}.png"/>`,
  ).join("");
  const png = pngFixture(2, 2);
  const media = Object.fromEntries(
    Array.from({ length: content.images ?? 0 }, (_, index) => [
      `word/media/image${index}.png`,
      png,
    ]),
  );
  return buildZip({
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/_rels/document.xml.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${imageRels}</Relationships>`,
    "word/styles.xml": `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`,
    ...media,
  });
}

function escapePdfText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

/** One page per entry; `null` is an empty page (stands in for a scanned page). */
export function pdfFixture(
  pages: Array<string | null>,
  size: { width: number; height: number } = { width: 612, height: 792 },
): Buffer {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body);
  add(""); // 1: catalog (filled below)
  add(""); // 2: pages
  add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ); // 3
  const pageIds: number[] = [];
  for (const text of pages) {
    const content =
      text === null
        ? ""
        : `BT /F1 12 Tf 72 720 Td (${escapePdfText(text)}) Tj ET`;
    const stream = add(
      `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    );
    pageIds.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${size.width} ${size.height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${stream} 0 R >>`,
      ),
    );
  }
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets)
    out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

export function pngFixture(width = 8, height = 8): Buffer {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#000000";
  context.fillRect(1, 1, Math.max(1, width - 2), Math.max(1, height - 2));
  return canvas.toBuffer("image/png");
}

export async function xlsxFixture(
  sheets: Array<{ name: string; rows: unknown[][] }>,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    const worksheet = workbook.addWorksheet(sheet.name);
    for (const row of sheet.rows) worksheet.addRow(row);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

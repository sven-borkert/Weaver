/**
 * Builds minimal but structurally valid Word packages for the Word reader's
 * tests: [Content_Types].xml, _rels/.rels, word/document.xml and (by default)
 * word/styles.xml, plus optional comments, headers and footers. The XML
 * shapes use heading
 * styles "HeadingN", the "guidance"/"Caption" paragraph styles and the
 * italic + 7C9DBE run formatting the instruction profile recognises, and the
 * w:sdt dropdown/combo-box layouts the control reader expects. Test support only: not exported from package.json.
 */
import JSZip from "jszip";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const IMAGE_REL_TYPE = `${R_NS}/image`;

export const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export type DocxContentType = "document" | "template" | "macro";

const MAIN_CONTENT_TYPES: Record<DocxContentType, string> = {
  document:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  template:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml",
  macro: "application/vnd.ms-word.document.macroEnabled.main+xml",
};

export interface DocxRunSpec {
  text: string;
  bold?: boolean;
  italic?: boolean;
  /** Hex run colour, e.g. "7C9DBE". */
  color?: string;
  /** Run size in half-points (w:sz), e.g. 40 for 20 pt. */
  size?: number;
  /** Character style id (w:rStyle). */
  style?: string;
}

export interface DocxParagraphSpec {
  text?: string;
  runs?: DocxRunSpec[];
  /** Paragraph style id (w:pStyle), e.g. "guidance" or "Caption". */
  style?: string;
  /** Paragraph outline level (w:outlineLvl), 0 = top level. */
  outlineLevel?: number;
  /** An inline picture appended after the paragraph's runs. */
  image?: { relId: string; alt?: string; vml?: boolean };
}

export interface DocxDropdownOptionSpec {
  value: string;
  displayText?: string;
}

export interface DocxDropdownSpec {
  id: string;
  type: "dropDownList" | "comboBox";
  selectedText: string;
  /** Emits w:showingPlcHdr, marking the control as unfilled. */
  placeholder?: boolean;
  alias?: string;
  tag?: string;
  options: DocxDropdownOptionSpec[];
}

export type DocxCellSpec =
  | string
  | {
      paragraphs?: Array<string | DocxParagraphSpec>;
      /** A content control inside a paragraph of this cell. */
      dropdown?: DocxDropdownSpec;
      /** A content control wrapping the whole w:tc. */
      wrapDropdown?: DocxDropdownSpec;
    };

export type DocxBlockSpec =
  | { type: "heading"; level: number; text: string }
  | ({ type: "paragraph" } & DocxParagraphSpec)
  | { type: "table"; rows: DocxCellSpec[][] }
  /** A body-level table-of-contents content control. */
  | { type: "toc"; id?: string; paragraphs: string[] }
  /** A body-level content control wrapping real blocks. */
  | { type: "contentControl"; id?: string; blocks: DocxBlockSpec[] };

export interface DocxCommentSpec {
  id: string;
  author?: string;
  date?: string;
  text: string;
}

export interface DocxSpec {
  body?: DocxBlockSpec[];
  /** Replaces the generated word/document.xml verbatim. */
  documentXml?: string;
  /** Leaves word/document.xml out of the package entirely. */
  omitDocument?: boolean;
  /** true (default) writes the default styles part, false omits it, a string
   *  is used as the part's content. */
  styles?: boolean | string;
  comments?: DocxCommentSpec[];
  /** Part base name ("header1.xml") to the text of its single paragraph. */
  headers?: Record<string, string>;
  footers?: Record<string, string>;
  contentType?: DocxContentType;
  /** Extra content-type Overrides, e.g. an embedded macro-enabled workbook. */
  contentTypeOverrides?: Array<{ partName: string; contentType: string }>;
  /** Relationship id → media part. `target` is relative to word/. */
  images?: Record<
    string,
    { target: string; bytes?: Uint8Array; external?: boolean }
  >;
  /** Raw parts written as given; bytes allow deliberately invalid UTF-8. */
  extraParts?: Record<string, string | Uint8Array>;
}

export async function buildDocx(spec: DocxSpec = {}): Promise<Buffer> {
  const zip = new JSZip();
  const withStyles = spec.styles !== false;
  zip.file(
    "[Content_Types].xml",
    contentTypesXml(
      spec.contentType ?? "document",
      withStyles,
      spec.contentTypeOverrides ?? [],
    ),
  );
  zip.file("_rels/.rels", packageRelsXml());
  zip.file("word/_rels/document.xml.rels", documentRelsXml(spec.images));
  for (const image of Object.values(spec.images ?? {})) {
    if (image.bytes && !image.external)
      zip.file(`word/${image.target}`, image.bytes);
  }
  if (!spec.omitDocument) {
    zip.file(
      "word/document.xml",
      spec.documentXml ?? documentXml(renderBlocks(spec.body ?? [])),
    );
  }
  if (withStyles) {
    zip.file(
      "word/styles.xml",
      typeof spec.styles === "string" ? spec.styles : defaultStylesXml(),
    );
  }
  if (spec.comments) {
    zip.file("word/comments.xml", commentsXml(spec.comments));
  }
  for (const [name, text] of Object.entries(spec.headers ?? {})) {
    zip.file(`word/${name}`, headerFooterXml("hdr", text));
  }
  for (const [name, text] of Object.entries(spec.footers ?? {})) {
    zip.file(`word/${name}`, headerFooterXml("ftr", text));
  }
  for (const [name, content] of Object.entries(spec.extraParts ?? {})) {
    zip.file(name, content);
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

buildDocx.withContentType = (
  contentType: DocxContentType,
  spec: DocxSpec = {},
): Promise<Buffer> => buildDocx({ ...spec, contentType });

export function documentXml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}">
  <w:body>${body}<w:sectPr /></w:body>
</w:document>`;
}

export function renderBlocks(blocks: DocxBlockSpec[]): string {
  return blocks.map(renderBlock).join("");
}

function renderBlock(block: DocxBlockSpec): string {
  switch (block.type) {
    case "heading":
      return renderParagraph({
        text: block.text,
        style: `Heading${block.level}`,
      });
    case "paragraph":
      return renderParagraph(block);
    case "table":
      return `<w:tbl>${block.rows.map(renderRow).join("")}</w:tbl>`;
    case "toc":
      return `<w:sdt><w:sdtPr><w:id w:val="${escapeXml(block.id ?? "1")}" /><w:docPartObj><w:docPartGallery w:val="Table of Contents" /></w:docPartObj></w:sdtPr><w:sdtContent>${block.paragraphs
        .map((text) => renderParagraph({ text }))
        .join("")}</w:sdtContent></w:sdt>`;
    case "contentControl":
      return `<w:sdt><w:sdtPr><w:id w:val="${escapeXml(block.id ?? "2")}" /></w:sdtPr><w:sdtContent>${renderBlocks(block.blocks)}</w:sdtContent></w:sdt>`;
  }
}

function renderParagraph(paragraph: DocxParagraphSpec): string {
  const props = [
    paragraph.style ? `<w:pStyle w:val="${escapeXml(paragraph.style)}" />` : "",
    paragraph.outlineLevel === undefined
      ? ""
      : `<w:outlineLvl w:val="${paragraph.outlineLevel}" />`,
  ].join("");
  const pPr = props ? `<w:pPr>${props}</w:pPr>` : "";
  const runs =
    paragraph.runs ??
    (paragraph.text === undefined && paragraph.image
      ? []
      : [{ text: paragraph.text ?? "" }]);
  return `<w:p>${pPr}${runs.map(renderRun).join("")}${
    paragraph.image ? renderImageRun(paragraph.image) : ""
  }</w:p>`;
}

function renderImageRun(
  image: NonNullable<DocxParagraphSpec["image"]>,
): string {
  const alt = escapeXml(image.alt ?? "");
  const relId = escapeXml(image.relId);
  if (image.vml)
    return `<w:r><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml" alt="${alt}"><v:imagedata xmlns:r="${R_NS}" r:id="${relId}" /></v:shape></w:pict></w:r>`;
  return `<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:docPr id="1" name="Picture" descr="${alt}" /><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip xmlns:r="${R_NS}" r:embed="${relId}" /></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

function renderRun(run: DocxRunSpec): string {
  const props = [
    run.style ? `<w:rStyle w:val="${escapeXml(run.style)}" />` : "",
    run.bold ? "<w:b />" : "",
    run.italic ? "<w:i />" : "",
    run.color ? `<w:color w:val="${escapeXml(run.color)}" />` : "",
    run.size ? `<w:sz w:val="${run.size}" />` : "",
  ].join("");
  const rPr = props ? `<w:rPr>${props}</w:rPr>` : "";
  return `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(run.text)}</w:t></w:r>`;
}

function renderRow(cells: DocxCellSpec[]): string {
  return `<w:tr>${cells.map(renderCell).join("")}</w:tr>`;
}

function renderCell(cell: DocxCellSpec): string {
  if (typeof cell === "string") {
    return `<w:tc>${renderParagraph({ text: cell })}</w:tc>`;
  }
  if (cell.wrapDropdown) {
    const paragraphs = cell.paragraphs ?? [cell.wrapDropdown.selectedText];
    return `<w:sdt>${dropdownProperties(cell.wrapDropdown)}<w:sdtContent><w:tc>${paragraphs
      .map(renderCellParagraph)
      .join("")}</w:tc></w:sdtContent></w:sdt>`;
  }
  const paragraphs = (cell.paragraphs ?? []).map(renderCellParagraph).join("");
  const dropdown = cell.dropdown
    ? `<w:p>${dropdownSdt(cell.dropdown)}</w:p>`
    : "";
  const body = `${paragraphs}${dropdown}` || renderParagraph({ text: "" });
  return `<w:tc>${body}</w:tc>`;
}

function renderCellParagraph(paragraph: string | DocxParagraphSpec): string {
  return renderParagraph(
    typeof paragraph === "string" ? { text: paragraph } : paragraph,
  );
}

function dropdownSdt(dropdown: DocxDropdownSpec): string {
  return `<w:sdt>${dropdownProperties(dropdown)}<w:sdtContent><w:r><w:t>${escapeXml(
    dropdown.selectedText,
  )}</w:t></w:r></w:sdtContent></w:sdt>`;
}

function dropdownProperties(dropdown: DocxDropdownSpec): string {
  const items = dropdown.options
    .map(
      (option) =>
        `<w:listItem w:value="${escapeXml(option.value)}"${
          option.displayText
            ? ` w:displayText="${escapeXml(option.displayText)}"`
            : ""
        } />`,
    )
    .join("");
  return `<w:sdtPr><w:id w:val="${escapeXml(dropdown.id)}" />${
    dropdown.alias ? `<w:alias w:val="${escapeXml(dropdown.alias)}" />` : ""
  }${dropdown.tag ? `<w:tag w:val="${escapeXml(dropdown.tag)}" />` : ""}${
    dropdown.placeholder ? "<w:showingPlcHdr />" : ""
  }<w:${dropdown.type}>${items}</w:${dropdown.type}></w:sdtPr>`;
}

function contentTypesXml(
  contentType: DocxContentType,
  withStyles: boolean,
  overrides: Array<{ partName: string; contentType: string }>,
): string {
  const extra = [
    ...(withStyles
      ? [
          {
            partName: "/word/styles.xml",
            contentType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",
          },
        ]
      : []),
    ...overrides,
  ]
    .map(
      (override) =>
        `\n  <Override PartName="${escapeXml(override.partName)}" ContentType="${escapeXml(override.contentType)}"/>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="${MAIN_CONTENT_TYPES[contentType]}"/>${extra}
</Types>`;
}

function packageRelsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
}

function documentRelsXml(images: NonNullable<DocxSpec["images"]> = {}): string {
  const relationships = Object.entries(images)
    .map(
      ([id, image]) =>
        `<Relationship Id="${escapeXml(id)}" Type="${IMAGE_REL_TYPE}" Target="${escapeXml(image.target)}"${image.external ? ' TargetMode="External"' : ""} />`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`;
}

/** Heading, caption and guidance styles: the instruction profile matches the
 *  "guidance" name, and its italic + 7C9DBE formatting. */
function defaultStylesXml(): string {
  const headings = Array.from(
    { length: 9 },
    (_value, index) =>
      `  <w:style w:type="paragraph" w:styleId="Heading${index + 1}"><w:name w:val="heading ${index + 1}" /><w:basedOn w:val="Normal" /></w:style>`,
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W_NS}">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal" /></w:style>
${headings}
  <w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="Caption" /></w:style>
  <w:style w:type="paragraph" w:styleId="guidance">
    <w:name w:val="guidance" /><w:basedOn w:val="Normal" />
    <w:rPr><w:i /><w:color w:val="7C9DBE" w:themeColor="accent2" /></w:rPr>
  </w:style>
  <w:style w:type="character" w:styleId="guidanceChar">
    <w:name w:val="guidance Char" /><w:link w:val="guidance" />
    <w:rPr><w:i /><w:color w:val="7C9DBE" /></w:rPr>
  </w:style>
</w:styles>`;
}

function commentsXml(comments: DocxCommentSpec[]): string {
  const body = comments
    .map(
      (comment) =>
        `<w:comment w:id="${escapeXml(comment.id)}"${
          comment.author ? ` w:author="${escapeXml(comment.author)}"` : ""
        }${comment.date ? ` w:date="${escapeXml(comment.date)}"` : ""}>${comment.text
          .split("\n")
          .map((line) => renderParagraph({ text: line }))
          .join("")}</w:comment>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="${W_NS}">${body}</w:comments>`;
}

function headerFooterXml(root: "hdr" | "ftr", text: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:${root} xmlns:w="${W_NS}">${renderParagraph({ text })}</w:${root}>`;
}

/** Escapes both text and attribute values, so quotes are escaped too. */
export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

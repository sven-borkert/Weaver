/** Loading and XML access for .docx/.dotx packages. The loader is not a port:
 *  parts are read through archive.ts's bounded entry reader, not JSZip. */
import { DOMParser } from "@xmldom/xmldom";
import {
  assertReadableArchive,
  listArchiveEntryNames,
  readArchiveEntry,
} from "../archive";
import { ArtifactReadError } from "../errors";
import {
  classifyOleContainer,
  declaresMacroEnabledContentType,
} from "../officePackage";

export type XmlDocument = ReturnType<DOMParser["parseFromString"]>;
export type XmlElement = NonNullable<XmlDocument["documentElement"]>;

const XML_MIME = "text/xml";
const DOCUMENT_PART = "word/document.xml";
/** Absolute part name as [Content_Types].xml spells it. */
const DOCUMENT_MAIN_PART = "/word/document.xml";

/** A bound on a part's bytes, not on the DOM memory it becomes. */
export const WORD_PART_MAX_BYTES = 16 * 1024 * 1024;

const LEGACY_MESSAGE =
  "Legacy (.doc) documents are not supported; save as .docx.";
const MACRO_MESSAGE =
  "Macro-enabled documents (.docm/.dotm) are not supported; save as .docx.";
const ENCRYPTED_MESSAGE = "Document is password-protected and cannot be read.";
const UNREADABLE_MESSAGE =
  "Unable to read the document. Corrupt or invalid files are not supported.";

/** OOXML parts never legitimately carry a document type definition, so any
 *  part declaring one is rejected before parsing rather than trusting the
 *  parser to bound entity expansion. */
const DOCTYPE_PATTERN = /<!DOCTYPE|<!ENTITY/i;

export interface WordPackage {
  /** Kept so further parts can be read on demand through archive.ts. */
  data: Uint8Array;
  doc: XmlDocument;
  /** Entry names, listed once per load: header/footer discovery needs them
   *  and would otherwise re-walk the central directory for every part. */
  partNames: string[];
}

export interface WordCommentRead {
  commentId: string;
  author: string | null;
  date: string | null;
  text: string;
}

export function loadDocx(data: Uint8Array): WordPackage {
  const ole = classifyOleContainer(data);
  if (ole !== null) {
    throw ole === "encrypted"
      ? new ArtifactReadError("encrypted", ENCRYPTED_MESSAGE)
      : new ArtifactReadError("legacy_format", LEGACY_MESSAGE);
  }
  // Word reads each XML/media entry through its own bounded inflater.
  assertReadableArchive(data, false);
  if (declaresMacroEnabledContentType(data, DOCUMENT_MAIN_PART)) {
    throw new ArtifactReadError("legacy_format", MACRO_MESSAGE);
  }
  const doc = readPartDocument(data, DOCUMENT_PART);
  if (!doc) throw new ArtifactReadError("malformed", UNREADABLE_MESSAGE);
  return { data, doc, partNames: listArchiveEntryNames(data) };
}

/** Strict: anything but an absent part fails the read. Only
 *  word/document.xml is read this way. */
export function readPartDocument(
  data: Uint8Array,
  name: string,
): XmlDocument | null {
  const bytes = readArchiveEntry(data, name, WORD_PART_MAX_BYTES);
  if (bytes === null) return null;
  const xml = decodePart(bytes);
  assertNoDoctype(xml);
  return parseXmlPart(xml);
}

/** A secondary part that cannot be read counts as absent (as in the source),
 *  but a DTD or a blown size bound still fails the whole read. */
export function readOptionalPartDocument(
  data: Uint8Array,
  name: string,
): XmlDocument | null {
  let bytes: Uint8Array | null;
  try {
    bytes = readArchiveEntry(data, name, WORD_PART_MAX_BYTES);
  } catch (cause) {
    if (cause instanceof ArtifactReadError && cause.code === "resource_limit") {
      throw cause;
    }
    return null;
  }
  if (bytes === null) return null;
  let xml: string;
  try {
    xml = decodePart(bytes);
  } catch {
    return null;
  }
  assertNoDoctype(xml);
  try {
    return parseXmlPart(xml);
  } catch {
    return null;
  }
}

function decodePart(bytes: Uint8Array): string {
  try {
    return normalizeXmlText(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    throw new ArtifactReadError("malformed", UNREADABLE_MESSAGE);
  }
}

function normalizeXmlText(xml: string): string {
  return xml.startsWith("﻿") ? xml.slice(1) : xml;
}

function assertNoDoctype(xml: string): void {
  if (DOCTYPE_PATTERN.test(xml)) {
    throw new ArtifactReadError("malformed", UNREADABLE_MESSAGE);
  }
}

/** xmldom's parse messages quote the offending XML, so they are kept as a
 *  flag only; warnings are tolerated, real documents produce them. */
function parseXmlPart(xml: string): XmlDocument {
  let failed = false;
  const parser = new DOMParser({
    onError: (level) => {
      if (level !== "warning") failed = true;
    },
  });
  let doc: XmlDocument;
  try {
    doc = parser.parseFromString(xml, XML_MIME);
  } catch {
    throw new ArtifactReadError("malformed", UNREADABLE_MESSAGE);
  }
  if (failed || !doc.documentElement) {
    throw new ArtifactReadError("malformed", UNREADABLE_MESSAGE);
  }
  return doc;
}

/** Review comments from word/comments.xml; [] when the part is absent. */
export function readWordComments(pkg: WordPackage): WordCommentRead[] {
  const doc = readOptionalPartDocument(pkg.data, "word/comments.xml");
  const root = doc?.documentElement;
  if (!root) return [];
  const comments: WordCommentRead[] = [];
  visitElements(root, (element) => {
    if (!isWordElement(element, "comment")) return;
    const paragraphs: string[] = [];
    visitElements(element, (child) => {
      if (isWordElement(child, "p")) paragraphs.push(textOf(child));
    });
    comments.push({
      commentId: attr(element, "id") ?? String(comments.length + 1),
      author: attr(element, "author"),
      date: attr(element, "date"),
      text: paragraphs.join("\n").trim(),
    });
  });
  return comments;
}

export function textOf(element: XmlElement): string {
  const parts: string[] = [];
  visitElements(element, (child) => {
    if (isWordElement(child, "t")) parts.push(child.textContent ?? "");
    if (isWordElement(child, "tab")) parts.push("\t");
    if (isWordElement(child, "br")) parts.push("\n");
  });
  return parts.join("");
}

export function directElementChildren(element: XmlElement): XmlElement[] {
  return Array.from(element.childNodes).filter(isElement);
}

export function directWordChild(
  element: XmlElement,
  localName: string,
): XmlElement | null {
  return (
    directElementChildren(element).find((child) =>
      isWordElement(child, localName),
    ) ?? null
  );
}

export function directWordChildren(
  element: XmlElement,
  localName: string,
): XmlElement[] {
  return directElementChildren(element).filter((child) =>
    isWordElement(child, localName),
  );
}

export function firstDescendant(
  element: XmlElement,
  localName: string,
): XmlElement | null {
  let found: XmlElement | null = null;
  visitElements(element, (child) => {
    if (!found && isWordElement(child, localName)) found = child;
  });
  return found;
}

export function visitElements(
  element: XmlElement,
  visitor: (element: XmlElement) => void,
): void {
  for (const child of directElementChildren(element)) {
    visitor(child);
    visitElements(child, visitor);
  }
}

function isElement(node: unknown): node is XmlElement {
  return (
    typeof node === "object" &&
    node !== null &&
    "nodeType" in node &&
    (node as { nodeType: number }).nodeType === 1
  );
}

export function isWordElement(element: XmlElement, localName: string): boolean {
  return (
    (element.localName ?? element.nodeName.split(":").at(-1)) === localName
  );
}

export function attr(element: XmlElement, name: string): string | null {
  return element.getAttribute(`w:${name}`) ?? element.getAttribute(name);
}

export function idFor(prefix: string, ordinal: number): string {
  return `${prefix}-${String(ordinal).padStart(3, "0")}`;
}

export function maxColumns(rows: string[][]): number {
  return rows.reduce((max, row) => Math.max(max, row.length), 0);
}

export function countDescendants(
  element: XmlElement,
  localName: string,
): number {
  let count = 0;
  visitElements(element, (child) => {
    if (isWordElement(child, localName)) count += 1;
  });
  return count;
}

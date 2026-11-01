import { isIconAssetPath } from "@weaver/core/appearance/icons";
import { isAssetsSegment } from "@weaver/core/documents/images";
import { importTitle } from "@weaver/core/documents/importMarkdown";
import { splitPythonImport } from "@weaver/core/documents/importPython";
import {
  documentKindFromFileName,
  type DocumentKind,
} from "@weaver/core/documents/kinds";
import {
  MAX_IMPORTED_IMAGES,
  MAX_IMPORT_IMAGE_BYTES,
  MAX_MARKDOWN_CHARS,
} from "@weaver/core/documents/limits";
import { MAX_FOLDER_DEPTH } from "@weaver/core/documents/paths";
import { slugify } from "@weaver/core/documents/slug";
import { imageTagSources } from "@weaver/core/editor/imageTag";

export const MAX_ZIP_ENTRIES = 10_000;
export const MAX_ZIP_BYTES = 1024 ** 3;

export type ZipEntryInfo = { path: string; size: number; dir: boolean };
export type ZipImage = { entryPath: string; name: string; size: number };
export type ZipDocument = {
  entryPath: string;
  fileName: string;
  kind: DocumentKind;
  /** Directory names as written in the ZIP. */
  directories: string[];
  images: ZipImage[];
};
export type ZipSkipped = { path: string; reason: string };
export type ZipAnalysis =
  | {
      ok: true;
      documents: ZipDocument[];
      skipped: ZipSkipped[];
      folderEntries: string[];
      iconEntries: string[];
    }
  | { ok: false; error: string };

const ASSETS_SUFFIX_LENGTH = ".assets".length;
const IMAGE_NAME_RE = /\.(png|jpe?g|webp|gif)$/i;
const WEAVER_ID_RES = [
  /^<!-- weaver\r?\nid: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\r?\n/,
  /^(?:#![^\n]*\n)?# weaver\r?\n# id: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\r?\n/,
];
// Heuristic for the "missing images" preview only; code spans and fences are not skipped.
const IMAGE_LINK_RE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)/g;

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function unsafe(path: string): boolean {
  return (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

function systemFile(segments: string[]): boolean {
  const name = segments.at(-1)!;
  return (
    segments[0] === "__MACOSX" || name === ".DS_Store" || name.startsWith("._")
  );
}

function stem(fileName: string): string {
  return fileName.replace(/\.(md|markdown|py)$/i, "");
}

/** Sorts a ZIP's entries into documents, their images, and everything left out. */
export function analyzeZipEntries(entries: ZipEntryInfo[]): ZipAnalysis {
  if (entries.length > MAX_ZIP_ENTRIES)
    return { ok: false, error: "The ZIP holds more than 10,000 entries." };
  const files = entries
    .filter((entry) => !entry.dir)
    .sort((a, b) => compare(a.path, b.path));
  if (files.reduce((sum, entry) => sum + entry.size, 0) > MAX_ZIP_BYTES)
    return { ok: false, error: "The ZIP unpacks to more than 1 GiB." };
  const documents = new Map<string, ZipDocument>();
  const images: Array<{ entry: ZipEntryInfo; key: string; name: string }> = [];
  const skipped: ZipSkipped[] = [];
  const folderEntries: string[] = [];
  const iconEntries: string[] = [];
  for (const entry of files) {
    const skip = (reason: string) => skipped.push({ path: entry.path, reason });
    if (unsafe(entry.path)) {
      skip("unsafe path");
      continue;
    }
    const segments = entry.path.split("/");
    const name = segments.at(-1)!;
    const directories = segments.slice(0, -1);
    if (segments.includes(".weaver-icons")) {
      if (!isIconAssetPath(entry.path) || entry.size > 2 * 1024 * 1024)
        return { ok: false, error: "Invalid reserved icon asset." };
      iconEntries.push(entry.path);
    } else if (
      name === ".folder.json" &&
      directories.length &&
      !directories.some(isAssetsSegment)
    ) {
      if (entry.size > 65536)
        return { ok: false, error: "Folder metadata is too large." };
      folderEntries.push(entry.path);
    } else if (systemFile(segments)) skip("system file");
    else if (directories.some(isAssetsSegment)) {
      const parent = directories.at(-1)!;
      const above = directories.slice(0, -1);
      if (!isAssetsSegment(parent) || above.some(isAssetsSegment))
        skip("nested inside an assets directory");
      else
        images.push({
          entry,
          name,
          key: [...above, parent.slice(0, -ASSETS_SUFFIX_LENGTH)].join("/"),
        });
    } else {
      const kind = documentKindFromFileName(name);
      if (kind) {
        const key = `${[...directories, stem(name)].join("/")}\u0000${kind}`;
        if (documents.has(key)) skip("duplicate document name");
        else
          documents.set(key, {
            entryPath: entry.path,
            fileName: name,
            kind,
            directories,
            images: [],
          });
      } else skip("not a document file or document image");
    }
  }
  for (const { entry, key, name } of images) {
    // Only Markdown documents carry images.
    const document = documents.get(`${key}\u0000markdown`);
    if (!document)
      skipped.push({ path: entry.path, reason: "no document for this image" });
    else if (!IMAGE_NAME_RE.test(name))
      skipped.push({ path: entry.path, reason: "unsupported image type" });
    else
      document.images.push({ entryPath: entry.path, name, size: entry.size });
  }
  return {
    ok: true,
    folderEntries,
    iconEntries,
    documents: [...documents.values()].sort((a, b) =>
      compare(a.entryPath, b.entryPath),
    ),
    skipped: skipped.sort((a, b) => compare(a.path, b.path)),
  };
}

export type ZipDocumentDetails = {
  title: string;
  weaverId: string | null;
  /** Images the Markdown links in its own assets directory that the ZIP lacks. */
  missingImages: string[];
  /** Set when the document cannot be imported. */
  problem: string | null;
};

function decoded(src: string): string {
  try {
    return decodeURI(src).replace(/^\.\//, "");
  } catch {
    return src;
  }
}

/** What the preview shows for one document, from its file text. */
export function describeZipDocument(
  doc: ZipDocument,
  text: string,
): ZipDocumentDetails {
  const missingImages =
    doc.kind === "markdown" ? missingImageNames(doc, text) : [];
  const imageBytes = doc.images.reduce((sum, image) => sum + image.size, 0);
  return {
    title:
      doc.kind === "python"
        ? splitPythonImport(text, doc.fileName).title
        : importTitle(text, doc.fileName),
    weaverId:
      WEAVER_ID_RES.map((re) => re.exec(text)?.[1]).find(Boolean) ?? null,
    missingImages,
    problem:
      text.length > MAX_MARKDOWN_CHARS
        ? "file exceeds the import size limit"
        : doc.kind === "python" && doc.images.length
          ? "a Python file carries no images"
          : doc.images.length > MAX_IMPORTED_IMAGES
            ? "more than 100 images"
            : imageBytes > MAX_IMPORT_IMAGE_BYTES
              ? "images exceed 64 MiB in total"
              : null,
  };
}

function missingImageNames(doc: ZipDocument, markdown: string): string[] {
  const prefix = `${stem(doc.fileName)}.assets/`;
  const present = new Set(doc.images.map((image) => image.name));
  const missing = new Set<string>();
  const sources = [
    ...[...markdown.matchAll(IMAGE_LINK_RE)].map((match) => match[1]!),
    ...imageTagSources(markdown),
  ];
  for (const source of sources) {
    const src = decoded(source);
    if (src.startsWith(prefix) && !present.has(src.slice(prefix.length)))
      missing.add(src.slice(prefix.length));
  }
  return [...missing].sort();
}

export type ImportTarget =
  | { ok: true; folderPath: string[]; folderNames: Record<string, string> }
  | { ok: false; reason: string };

/** The folder a document lands in, and the display names of folders it may create. */
export function planImportTarget(
  directories: string[],
  currentFolder: string[],
  keepStructure: boolean,
): ImportTarget {
  const folderPath = [...currentFolder];
  const folderNames: Record<string, string> = {};
  if (keepStructure)
    for (const name of directories) {
      folderPath.push(slugify(name));
      folderNames[folderPath.join("/")] = name;
    }
  if (folderPath.length > MAX_FOLDER_DEPTH)
    return { ok: false, reason: "folder depth exceeds 10" };
  return { ok: true, folderPath, folderNames };
}

export type ExistingDocument = {
  headCommitSha?: string;
  id: string;
  title: string;
  path: string;
  documentKind: DocumentKind;
};
export type ImportCollision = {
  kind: "id" | "title";
  existing: ExistingDocument;
  /** False when the existing document is a different kind of file. */
  replaceable: boolean;
};

/** The existing document an import would duplicate: same Weaver id, else same title in the target folder. */
export function findCollision(
  doc: {
    weaverId: string | null;
    title: string;
    folderPath: string[];
    documentKind: DocumentKind;
  },
  existing: ExistingDocument[],
): ImportCollision | null {
  const collision = (
    kind: ImportCollision["kind"],
    found: ExistingDocument,
  ): ImportCollision => ({
    kind,
    existing: found,
    replaceable: found.documentKind === doc.documentKind,
  });
  const byId = doc.weaverId
    ? existing.find((candidate) => candidate.id === doc.weaverId)
    : undefined;
  if (byId) return collision("id", byId);
  const folder = doc.folderPath.join("/");
  const title = doc.title.trim().toLowerCase();
  const byTitle = existing.find(
    (candidate) =>
      candidate.path.split("/").slice(0, -1).join("/") === folder &&
      candidate.title.trim().toLowerCase() === title,
  );
  return byTitle ? collision("title", byTitle) : null;
}

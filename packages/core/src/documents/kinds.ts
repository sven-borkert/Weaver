export type DocumentKind = "markdown" | "python";

export type DocumentKindSpec = {
  /** Extension of the stored Git file. */
  extension: string;
  /** Extensions accepted on upload, lowercase. */
  importExtensions: readonly string[];
  mimeType: string;
  label: string;
  supportsImages: boolean;
  supportsPdf: boolean;
  supportsRemoteSend: boolean;
};

export class DocumentKindError extends Error {}

export const DOCUMENT_KINDS: Record<DocumentKind, DocumentKindSpec> = {
  markdown: {
    extension: ".md",
    importExtensions: [".md", ".markdown"],
    mimeType: "text/markdown",
    label: "Markdown document",
    supportsImages: true,
    supportsPdf: true,
    supportsRemoteSend: true,
  },
  python: {
    extension: ".py",
    importExtensions: [".py"],
    mimeType: "text/x-python",
    label: "Python file",
    supportsImages: false,
    supportsPdf: false,
    supportsRemoteSend: false,
  },
};

export const DOCUMENT_KIND_NAMES = Object.keys(
  DOCUMENT_KINDS,
) as DocumentKind[];

export function documentFileExtension(kind: DocumentKind): string {
  return DOCUMENT_KINDS[kind].extension;
}

function basename(path: string): string {
  return path.slice(
    Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1,
  );
}

/** The kind of a stored document path, by its exact lowercase extension. */
export function documentKindFromPath(path: string): DocumentKind | null {
  const name = basename(path);
  for (const kind of DOCUMENT_KIND_NAMES) {
    const extension = DOCUMENT_KINDS[kind].extension;
    if (name.length > extension.length && name.endsWith(extension)) return kind;
  }
  return null;
}

export function documentKindOfPath(path: string): DocumentKind {
  const kind = documentKindFromPath(path);
  if (kind === null)
    throw new DocumentKindError(`not a document path: ${JSON.stringify(path)}`);
  return kind;
}

/** The kind an uploaded file name maps to, by its import extensions. */
export function documentKindFromFileName(name: string): DocumentKind | null {
  const lower = basename(name).toLowerCase();
  for (const kind of DOCUMENT_KIND_NAMES)
    for (const extension of DOCUMENT_KINDS[kind].importExtensions)
      if (lower.length > extension.length && lower.endsWith(extension))
        return kind;
  return null;
}

/** The basename without its registered stored extension (unchanged when none). */
export function documentFileStem(path: string): string {
  const name = basename(path);
  const kind = documentKindFromPath(name);
  return kind ? name.slice(0, -DOCUMENT_KINDS[kind].extension.length) : name;
}

export function documentImportExtensions(): string[] {
  return DOCUMENT_KIND_NAMES.flatMap((kind) => [
    ...DOCUMENT_KINDS[kind].importExtensions,
  ]);
}

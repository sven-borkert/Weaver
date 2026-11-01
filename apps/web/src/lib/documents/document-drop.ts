import { documentKindFromFileName } from "@weaver/core/documents/kinds";

export function isDocumentFileName(name: string): boolean {
  return documentKindFromFileName(name) !== null;
}

export function isArchiveFileName(name: string): boolean {
  return name.length > 4 && name.toLowerCase().endsWith(".zip");
}

export function partitionDroppedFiles(files: File[]): {
  documents: File[];
  archives: File[];
  ignored: File[];
} {
  const documents: File[] = [];
  const archives: File[] = [];
  const ignored: File[] = [];
  for (const file of files) {
    if (isDocumentFileName(file.name)) documents.push(file);
    else if (isArchiveFileName(file.name)) archives.push(file);
    else ignored.push(file);
  }
  return { documents, archives, ignored };
}

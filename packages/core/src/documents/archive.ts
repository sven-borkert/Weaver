import {
  assetsDirForDocPath,
  hasAssetsSegment,
} from "@weaver/core/documents/images";
import { documentKindFromPath } from "@weaver/core/documents/kinds";
import { TABLES_ROOT } from "@weaver/core/tables/paths";

export const MAX_ARCHIVE_FILES = 10_000;
export const MAX_ARCHIVE_BYTES = 1024 ** 3;

export type ArchiveLimits = { maxFiles: number; maxBytes: number };

export type ArchiveBlob = {
  path: string;
  sha: string;
  size: number;
  archiveRoot?: boolean;
  bytes?: Uint8Array;
};

export type ArchivePlan = {
  /** Documents and their images, paths relative to the archived folder. */
  files: ArchiveBlob[];
  /** Folders without any archived file, so they survive as empty directories. */
  directories: string[];
  totalBytes: number;
};

const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Selects what a folder download holds; null when no committed file lies in the folder. */
export function planFolderArchive(
  blobs: ArchiveBlob[],
  folderPath: string[],
): ArchivePlan | null {
  if (folderPath.some((segment) => hasAssetsSegment(segment))) return null;
  const prefix = folderPath.length ? `${folderPath.join("/")}/` : "";
  const files: ArchiveBlob[] = [];
  const directories = new Set<string>();
  let found = folderPath.length === 0;
  let totalBytes = 0;
  for (const blob of blobs) {
    if (!blob.path.startsWith(prefix)) continue;
    if (
      blob.path.startsWith(`${TABLES_ROOT}/`) ||
      blob.path.startsWith(".weaver-icons/")
    )
      continue;
    found = true;
    const path = blob.path.slice(prefix.length);
    const segments = path.split("/").slice(0, -1);
    for (let length = 1; length <= segments.length; length++) {
      const directory = segments.slice(0, length).join("/");
      if (!hasAssetsSegment(directory)) directories.add(directory);
    }
    if (
      !hasAssetsSegment(path) &&
      documentKindFromPath(path) === null &&
      path.split("/").at(-1) !== ".folder.json"
    )
      continue;
    files.push({ path, sha: blob.sha, size: blob.size });
    totalBytes += blob.size;
  }
  if (!found) return null;
  for (const file of files) {
    const segments = file.path.split("/").slice(0, -1);
    for (let length = 1; length <= segments.length; length++)
      directories.delete(segments.slice(0, length).join("/"));
  }
  return {
    files: files.sort((a, b) => byPath(a.path, b.path)),
    directories: [...directories].sort(byPath),
    totalBytes,
  };
}

/** Selects one document's file and its images; null when the file is not committed. */
export function planDocumentArchive(
  blobs: ArchiveBlob[],
  docPath: string,
): ArchivePlan | null {
  const folderLength = docPath.lastIndexOf("/") + 1;
  const assetsPrefix = `${assetsDirForDocPath(docPath)}/`;
  const files: ArchiveBlob[] = [];
  let found = false;
  let totalBytes = 0;
  for (const blob of blobs) {
    const isDocument = blob.path === docPath;
    if (!isDocument && !blob.path.startsWith(assetsPrefix)) continue;
    found ||= isDocument;
    files.push({
      path: blob.path.slice(folderLength),
      sha: blob.sha,
      size: blob.size,
    });
    totalBytes += blob.size;
  }
  if (!found) return null;
  return {
    files: files.sort((a, b) => byPath(a.path, b.path)),
    directories: [],
    totalBytes,
  };
}

import {
  artifactFilenameKey,
  validateArtifactFilename,
} from "@weaver/core/artifacts/filenames";
import { MAX_INGESTION_UPLOAD_FILES } from "@weaver/core/ingestion/limits";

import { formatBytes } from "../../imports/_components/upload";

export type BatchRow = {
  file: File;
  tooLarge: boolean;
  duplicateInBatch: boolean;
  replacesExisting: boolean;
  invalidName: boolean;
};

/** What the upload flow does next with a classified selection. */
export type ArtifactUploadPlan =
  | { kind: "blocked"; message: string }
  | { kind: "confirm"; files: File[]; names: string[] }
  | { kind: "upload"; files: File[] };

function nameIsValid(name: string): boolean {
  try {
    validateArtifactFilename(name);
    return true;
  } catch {
    return false;
  }
}

export function classifyArtifactBatch(
  files: File[],
  existingFilenames: readonly string[],
  maxBytes: number,
): BatchRow[] {
  const existing = new Set(existingFilenames.map(artifactFilenameKey));
  const counts = new Map<string, number>();
  for (const file of files) {
    const key = artifactFilenameKey(file.name);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return files.map((file) => {
    const key = artifactFilenameKey(file.name);
    return {
      file,
      tooLarge: file.size > maxBytes,
      duplicateInBatch: (counts.get(key) ?? 0) > 1,
      replacesExisting: existing.has(key),
      invalidName: !nameIsValid(file.name),
    };
  });
}

export function batchBlocked(
  rows: BatchRow[],
  maxBytes?: number,
): string | null {
  if (rows.length === 0) return "Choose at least one file.";
  if (rows.length > MAX_INGESTION_UPLOAD_FILES)
    return `Choose up to ${MAX_INGESTION_UPLOAD_FILES} files at a time.`;
  const invalid = rows.find((row) => row.invalidName);
  if (invalid) return `${invalid.file.name}: this name cannot be used.`;
  if (rows.some((row) => row.duplicateInBatch))
    return "Two selected files have the same name. Remove one of them.";
  const large = rows.find((row) => row.tooLarge);
  if (large)
    return `${large.file.name} is larger than ${maxBytes ? formatBytes(maxBytes) : "the upload limit"}.`;
  return null;
}

export function planArtifactUpload(
  rows: BatchRow[],
  maxBytes: number,
): ArtifactUploadPlan {
  const message = batchBlocked(rows, maxBytes);
  if (message) return { kind: "blocked", message };
  const files = rows.map((row) => row.file);
  const names = rows
    .filter((row) => row.replacesExisting)
    .map((row) => row.file.name);
  return names.length
    ? { kind: "confirm", files, names }
    : { kind: "upload", files };
}

/** The list page holds one page of names only, so the server's 409 adds more. */
export function mergeReplacements(
  replace: readonly string[],
  conflicts: readonly string[],
): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const name of [...replace, ...conflicts]) {
    const key = artifactFilenameKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(name);
  }
  return merged;
}

export function replaceConfirmTitle(count: number): string {
  return `Replace ${count} existing file${count === 1 ? "" : "s"}?`;
}

export function uploadedMessage(count: number): string {
  return `${count} file${count === 1 ? "" : "s"} uploaded`;
}

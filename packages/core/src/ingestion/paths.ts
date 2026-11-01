import path from "node:path";

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const DIGEST_RE = /^[0-9a-f]{64}$/;

function assertUuid(label: string, value: string): void {
  if (!UUID_RE.test(value)) throw new Error(`invalid ${label}`);
}

export function projectFilesDir(dataDir: string, projectId: string): string {
  assertUuid("projectId", projectId);
  return path.join(dataDir, "files", projectId);
}

export function blobPath(
  dataDir: string,
  projectId: string,
  digest: string,
): string {
  if (!DIGEST_RE.test(digest)) throw new Error("invalid digest");
  return path.join(
    projectFilesDir(dataDir, projectId),
    digest.slice(0, 2),
    digest,
  );
}

export function tmpDir(dataDir: string, projectId: string): string {
  return path.join(projectFilesDir(dataDir, projectId), "tmp");
}

export function tmpPath(
  dataDir: string,
  projectId: string,
  uploadId: string,
): string {
  assertUuid("uploadId", uploadId);
  return path.join(tmpDir(dataDir, projectId), uploadId);
}

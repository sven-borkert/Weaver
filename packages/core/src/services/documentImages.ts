import { FOLDER_METADATA_FILE } from "@weaver/core/documents/folderMetadata";
import type { PrismaClient } from "@weaver/db/client";
import { CoreError } from "@weaver/core/errors";
import {
  allocateImageFileName,
  assetsDirForDocPath,
  assetsPrefixForSlug,
  imageBasename,
  imageExtension,
  sniffImageType,
  type DocumentImageType,
} from "@weaver/core/documents/images";
import {
  DOCUMENT_KINDS,
  documentKindFromPath,
} from "@weaver/core/documents/kinds";
import { openProjectRepo } from "@weaver/git-store";
import type { EnrichedActor } from "./documents";
import { assertProjectRole, type ProjectActor } from "./projectAccess";
import { notifyProjectContentChanged } from "./projectGitRemoteJobs";
import { withProjectRepo } from "./projectRepo";

export const MAX_SERVED_BLOB_BYTES = 52_428_800;
const MAX_SEGMENTS = 12;
const SNIFF_BYTES = 16;
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;
const FORBIDDEN_SEGMENT_RE = /[\x00-\x1f\x7f\\/]/;

export type StoredDocumentImage = {
  src: string;
  path: string;
  contentType: DocumentImageType;
  byteSize: number;
  commitSha: string;
};

export type ServedProjectImage = {
  bytes: Buffer;
  blobSha: string;
  contentType: DocumentImageType;
  fileName: string;
};

export async function storeDocumentImage(
  db: PrismaClient,
  input: {
    projectId: string;
    documentId: string;
    fileName: string | null;
    bytes: Uint8Array;
  },
  actor: EnrichedActor,
): Promise<StoredDocumentImage> {
  await assertProjectRole(db, input.projectId, actor, "Editor");
  const contentType = sniffImageType(input.bytes.subarray(0, SNIFF_BYTES));
  if (!contentType)
    throw new CoreError("BAD_REQUEST", "unsupported image type");
  const basename = imageBasename(input.fileName);
  const extension = imageExtension(contentType);
  const result = await withProjectRepo(input.projectId, async (repo) => {
    const row = await db.document.findFirst({
      where: { id: input.documentId, projectId: input.projectId },
      select: { path: true, slug: true, kind: true },
    });
    if (!row || !(await repo.fileExistsInWorktree(row.path))) {
      throw new CoreError("NOT_FOUND");
    }
    if (!DOCUMENT_KINDS[row.kind].supportsImages)
      throw new CoreError("BAD_REQUEST", "This file kind does not hold images");
    const assetsDir = assetsDirForDocPath(row.path);
    const taken = new Set(
      (await repo.listTrackedFiles())
        .filter((file) => file.startsWith(`${assetsDir}/`))
        .map((file) => file.slice(assetsDir.length + 1)),
    );
    let fileName = allocateImageFileName(basename, extension, taken);
    while (await repo.fileExistsInWorktree(`${assetsDir}/${fileName}`)) {
      taken.add(fileName);
      fileName = allocateImageFileName(basename, extension, taken);
    }
    const relPath = `${assetsDir}/${fileName}`;
    await repo.writeBinaryFileAtomic(relPath, input.bytes);
    const commitSha = await repo.commitAll(
      `asset: ${relPath} (for ${row.path})`,
      { name: actor.name, email: actor.email, userId: actor.userId },
    );
    return {
      src: `${assetsPrefixForSlug(row.slug)}${fileName}`,
      path: relPath,
      contentType,
      byteSize: input.bytes.byteLength,
      commitSha,
    };
  });
  void notifyProjectContentChanged(db, input.projectId);
  return result;
}

/** Returns the repository-relative path or null when the segments are not servable. */
export function validateFileSegments(segments: string[]): string | null {
  if (segments.length === 0 || segments.length > MAX_SEGMENTS) return null;
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      FORBIDDEN_SEGMENT_RE.test(segment) ||
      Buffer.byteLength(segment, "utf8") > 255
    )
      return null;
  }
  const relPath = segments.join("/");
  if (
    segments[0] === ".git" ||
    segments[0] === ".weaver-icons" ||
    segments[0] === "tables" ||
    relPath === "project.json" ||
    segments.at(-1) === FOLDER_METADATA_FILE ||
    documentKindFromPath(relPath) !== null
  )
    return null;
  return relPath;
}

export function readProjectImage(
  db: PrismaClient,
  input: { projectId: string; segments: string[]; at?: string },
  actor: ProjectActor,
): Promise<ServedProjectImage | null>;
export function readProjectImage(
  db: PrismaClient,
  input: {
    projectId: string;
    segments: string[];
    at?: string;
    ifNoneMatch: string | null;
  },
  actor: ProjectActor,
): Promise<ServedProjectImage | { notModified: true; blobSha: string } | null>;
export async function readProjectImage(
  db: PrismaClient,
  input: {
    projectId: string;
    segments: string[];
    at?: string;
    ifNoneMatch?: string | null;
  },
  actor: ProjectActor,
): Promise<ServedProjectImage | { notModified: true; blobSha: string } | null> {
  await assertProjectRole(db, input.projectId, actor, "Viewer");
  const relPath = validateFileSegments(input.segments);
  if (!relPath) return null;
  if (input.at !== undefined && !COMMIT_SHA_RE.test(input.at)) return null;
  const repo = await openProjectRepo(input.projectId);
  if (!repo) return null;
  const head = await repo.resolveHead();
  const commitish = input.at ?? head;
  if (input.at && !(await repo.isAncestor(input.at, head))) return null;
  const blobSha = await repo.blobShaAt(commitish, relPath);
  if (blobSha && input.ifNoneMatch === `"${blobSha}"`)
    return { notModified: true, blobSha };
  const blob = await repo.readCommittedBlobAt(
    commitish,
    relPath,
    MAX_SERVED_BLOB_BYTES,
  );
  if (!blob) return null;
  const contentType = sniffImageType(blob.bytes.subarray(0, SNIFF_BYTES));
  if (!contentType) return null;
  return {
    bytes: blob.bytes,
    blobSha: blob.blobSha,
    contentType,
    fileName: input.segments[input.segments.length - 1]!,
  };
}

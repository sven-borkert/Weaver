import { iconAssetPath } from "../appearance/icons";
import type { Appearance } from "../appearance/metadata";
import { parseDocumentFile } from "../documents/frontmatter";
import {
  DOCUMENT_KINDS,
  documentFileExtension,
  documentKindFromPath,
  type DocumentKind,
} from "../documents/kinds";
import {
  parseFolderMetadata,
  composeFolderMetadata,
} from "../documents/folderMetadata";
import { collectAppearanceAssetsAt } from "./appearanceAssets";
import type { Readable } from "node:stream";
import { CoreError } from "@weaver/core/errors";
import {
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_FILES,
  planDocumentArchive,
  planFolderArchive,
  type ArchiveBlob,
  type ArchiveLimits,
  type ArchivePlan,
} from "@weaver/core/documents/archive";
import { createArchiveStream } from "@weaver/core/documents/archiveZip";
import {
  assertSafeSegments,
  folderNotFound,
} from "@weaver/core/documents/paths";
import { slugify } from "@weaver/core/documents/slug";
import { assertOutsideTablesRoot } from "@weaver/core/tables/paths";
import type { PrismaClient } from "@weaver/db/client";
import { openProjectRepo, type ProjectRepoReader } from "@weaver/git-store";
import { getDocument } from "./documents";
import { assertProjectRole, type ProjectActor } from "./projectAccess";

const MAX_DOCUMENT_FILE_BYTES = 2_000_000;

/** The committed document file exactly as Git stores it. */
export async function readDocumentFile(
  db: PrismaClient,
  input: { projectId: string; documentId: string },
  actor: ProjectActor,
): Promise<{ bytes: Buffer; fileName: string; mimeType: string }> {
  // Resolves access, the current path, and the last commit that wrote the file.
  const document = await getDocument(db, input, actor);
  const repo = await openProjectRepo(input.projectId);
  const blob = await repo?.readCommittedBlobAt(
    document.baseCommitSha,
    document.path,
    MAX_DOCUMENT_FILE_BYTES,
  );
  if (!blob) throw new CoreError("NOT_FOUND");
  return {
    bytes: blob.bytes,
    fileName: downloadFileName(document),
    mimeType: DOCUMENT_KINDS[document.kind].mimeType,
  };
}

/** Markdown keeps its slug; a Python file comes back under its title so it keeps its real name. */
export function downloadFileName(document: {
  kind: DocumentKind;
  slug: string;
  title: string;
}): string {
  if (document.kind === "markdown") return `${document.slug}.md`;
  return `${document.title.replace(/[\\/]/g, "-")}${documentFileExtension(document.kind)}`;
}

function assertWithinLimits(plan: ArchivePlan, limits?: ArchiveLimits): void {
  const { maxFiles, maxBytes } = limits ?? {
    maxFiles: MAX_ARCHIVE_FILES,
    maxBytes: MAX_ARCHIVE_BYTES,
  };
  if (plan.files.length > maxFiles || plan.totalBytes > maxBytes)
    throw new CoreError("BAD_REQUEST", "archive is too large to download", {
      reason: "PAYLOAD_TOO_LARGE",
    });
}

/** A ZIP of the document file and its images at the current revision. */
export async function createDocumentArchive(
  db: PrismaClient,
  input: { projectId: string; documentId: string },
  actor: ProjectActor,
): Promise<{ stream: Readable; fileName: string }> {
  const document = await getDocument(db, input, actor);
  const repo = await openProjectRepo(input.projectId);
  if (!repo) throw new CoreError("NOT_FOUND");
  const snapshotSha = await repo.resolveHead();
  const blobs = await repo.listTrackedBlobs(snapshotSha);
  const plan = planDocumentArchive(blobs, document.path);
  if (!plan) throw new CoreError("NOT_FOUND");
  assertWithinLimits(plan);
  await addAppearanceToArchive(repo, snapshotSha, plan, blobs);
  assertWithinLimits(plan);
  const stream = createArchiveStream({
    plan,
    date: await repo.commitDate(snapshotSha),
    readBlob: (file) => repo.readBlob(file.sha),
  });
  return { stream, fileName: `${document.slug}.zip` };
}

/** Carries no access check; callers assert Viewer first. */
export async function archiveFolderInRepo(
  repo: ProjectRepoReader,
  input: { folderPath: string[]; rootName: string; limits?: ArchiveLimits },
): Promise<Readable> {
  try {
    assertSafeSegments(input.folderPath);
    assertOutsideTablesRoot(input.folderPath);
  } catch {
    throw folderNotFound("path");
  }
  const snapshotSha = await repo.resolveHead();
  const blobs = await repo.listTrackedBlobs(snapshotSha);
  const plan = planFolderArchive(blobs, input.folderPath);
  if (!plan) throw folderNotFound("path");
  assertWithinLimits(plan, input.limits);
  await addAppearanceToArchive(repo, snapshotSha, plan, blobs, input.limits);
  assertWithinLimits(plan, input.limits);
  return createArchiveStream({
    rootName: input.rootName,
    plan,
    date: await repo.commitDate(snapshotSha),
    readBlob: (file) => repo.readBlob(file.sha),
  });
}

/** A ZIP of the folder's documents and images at the current revision; the empty path is the project root. */
export async function createFolderArchive(
  db: PrismaClient,
  input: { projectId: string; folderPath: string[] },
  actor: ProjectActor,
): Promise<{ stream: Readable; fileName: string }> {
  const { project } = await assertProjectRole(
    db,
    input.projectId,
    actor,
    "Viewer",
  );
  const repo = await openProjectRepo(input.projectId);
  if (!repo) throw new CoreError("NOT_FOUND");
  const rootName = input.folderPath.at(-1) ?? slugify(project.name);
  const stream = await archiveFolderInRepo(repo, {
    folderPath: input.folderPath,
    rootName,
  });
  return { stream, fileName: `${rootName}.zip` };
}

async function addAppearanceToArchive(
  repo: ProjectRepoReader,
  revision: string,
  plan: ArchivePlan,
  blobs: ArchiveBlob[],
  limits?: ArchiveLimits,
): Promise<void> {
  const appearances: Appearance[] = [];
  const files = [];
  for (const file of plan.files) {
    if (file.path.split("/").at(-1) === ".folder.json") {
      const metadata = parseFolderMetadata(
        (await repo.readBlob(file.sha)).toString("utf8"),
      );
      if (!metadata) {
        plan.totalBytes -= file.size;
        continue;
      }
      const bytes = Buffer.from(composeFolderMetadata(metadata));
      plan.totalBytes += bytes.byteLength - file.size;
      files.push({ ...file, bytes, size: bytes.byteLength });
      if (metadata.appearance) appearances.push(metadata.appearance);
    } else {
      files.push(file);
      const kind = documentKindFromPath(file.path);
      if (kind !== null) {
        try {
          const appearance = parseDocumentFile(
            (await repo.readBlob(file.sha)).toString("utf8"),
            kind,
          ).meta.appearance;
          if (appearance) appearances.push(appearance);
        } catch {
          /* Unmanaged Markdown remains downloadable. */
        }
      }
    }
  }
  const references = new Set(
    appearances.flatMap(({ icon }) =>
      icon?.type === "image" ? [iconAssetPath(icon)] : [],
    ),
  );
  const iconBlobs = blobs.filter((blob) => references.has(blob.path));
  assertWithinLimits(
    {
      ...plan,
      files: [...files, ...iconBlobs],
      totalBytes:
        plan.totalBytes + iconBlobs.reduce((sum, blob) => sum + blob.size, 0),
    },
    limits,
  );
  for (const { icon, bytes } of await collectAppearanceAssetsAt(
    repo,
    revision,
    appearances,
  )) {
    files.push({
      path: iconAssetPath(icon),
      sha: "",
      size: bytes.byteLength,
      bytes,
      archiveRoot: true,
    });
    plan.totalBytes += bytes.byteLength;
  }
  plan.files = files;
}

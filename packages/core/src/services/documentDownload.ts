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
import { getDocumentWithSnapshot } from "./documents";
import {
  listUntrackedUnder,
  readUntrackedAssets,
  readUntrackedDocumentFile,
  readUntrackedFile,
} from "./untrackedDocuments";

/** Untracked documents, folder metadata and images below `rel`, as in-memory archive blobs. */
async function untrackedArchiveBlobs(
  db: PrismaClient,
  projectId: string,
  rel: string,
): Promise<ArchiveBlob[]> {
  const { documents, folders } = await listUntrackedUnder(db, projectId, rel);
  const blobs: ArchiveBlob[] = [];
  const add = (path: string, bytes: Uint8Array) =>
    blobs.push({ path, sha: "", size: bytes.byteLength, bytes });
  for (const folder of folders)
    add(`${folder.path}/.folder.json`, Buffer.from(folder.metadata));
  for (const document of documents) {
    add(document.path, Buffer.from(document.content));
    for (const asset of await readUntrackedAssets(db, projectId, document.path))
      add(asset.path, asset.bytes);
  }
  return blobs;
}
import { assertProjectRole, type ProjectActor } from "./projectAccess";

const MAX_DOCUMENT_FILE_BYTES = 2_000_000;

/** The committed document file exactly as Git stores it. */
export async function readDocumentFile(
  db: PrismaClient,
  input: { projectId: string; documentId: string },
  actor: ProjectActor,
): Promise<{ bytes: Buffer; fileName: string; mimeType: string }> {
  await assertProjectRole(db, input.projectId, actor, "Viewer");
  const untracked = await readUntrackedDocumentFile(
    db,
    input.projectId,
    input.documentId,
  );
  if (untracked)
    return {
      bytes: Buffer.from(untracked.content),
      fileName: downloadFileName(untracked),
      mimeType: DOCUMENT_KINDS[untracked.kind].mimeType,
    };
  const document = await getDocumentWithSnapshot(db, input, actor);
  const repo = await openProjectRepo(input.projectId);
  const blob = await repo?.readCommittedBlobAt(
    document.snapshotCommitSha,
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
  await assertProjectRole(db, input.projectId, actor, "Viewer");
  const untracked = await readUntrackedDocumentFile(
    db,
    input.projectId,
    input.documentId,
  );
  if (untracked) {
    const content = Buffer.from(untracked.content);
    const blobs: ArchiveBlob[] = [
      {
        path: untracked.path,
        sha: "",
        size: content.byteLength,
        bytes: content,
      },
      ...(await readUntrackedAssets(db, input.projectId, untracked.path)).map(
        (asset) => ({
          path: asset.path,
          sha: "",
          size: asset.bytes.byteLength,
          bytes: asset.bytes,
        }),
      ),
    ];
    const plan = planDocumentArchive(blobs, untracked.path)!;
    assertWithinLimits(plan);
    const repo = await openProjectRepo(input.projectId);
    await addAppearanceToArchive(db, input.projectId, repo, null, plan, []);
    assertWithinLimits(plan);
    const stream = createArchiveStream({
      plan,
      date: new Date(),
      readBlob: () => Promise.reject(new Error("untracked blob without bytes")),
    });
    return { stream, fileName: `${untracked.slug}.zip` };
  }
  const document = await getDocumentWithSnapshot(db, input, actor);
  const repo = await openProjectRepo(input.projectId);
  if (!repo) throw new CoreError("NOT_FOUND");
  const snapshotSha = document.snapshotCommitSha;
  const blobs = await repo.listTrackedBlobs(snapshotSha);
  const plan = planDocumentArchive(blobs, document.path);
  if (!plan) throw new CoreError("NOT_FOUND");
  assertWithinLimits(plan);
  await addAppearanceToArchive(
    db,
    input.projectId,
    repo,
    snapshotSha,
    plan,
    blobs,
  );
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
  input: {
    folderPath: string[];
    rootName: string;
    limits?: ArchiveLimits;
    /** Includes Git-ignored content of this project. */
    untracked?: { db: PrismaClient; projectId: string };
  },
): Promise<Readable> {
  try {
    assertSafeSegments(input.folderPath);
    assertOutsideTablesRoot(input.folderPath);
  } catch {
    throw folderNotFound("path");
  }
  const snapshotSha = await repo.resolveHead();
  const blobs = [
    ...(await repo.listTrackedBlobs(snapshotSha)),
    ...(input.untracked
      ? await untrackedArchiveBlobs(
          input.untracked.db,
          input.untracked.projectId,
          input.folderPath.join("/"),
        )
      : []),
  ];
  const plan = planFolderArchive(blobs, input.folderPath);
  if (!plan) throw folderNotFound("path");
  assertWithinLimits(plan, input.limits);
  await addAppearanceToArchive(
    input.untracked?.db ?? null,
    input.untracked?.projectId ?? "",
    repo,
    snapshotSha,
    plan,
    blobs,
    input.limits,
  );
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
    untracked: { db, projectId: input.projectId },
  });
  return { stream, fileName: `${rootName}.zip` };
}

async function addAppearanceToArchive(
  db: PrismaClient | null,
  projectId: string,
  repo: ProjectRepoReader | null,
  revision: string | null,
  plan: ArchivePlan,
  blobs: ArchiveBlob[],
  limits?: ArchiveLimits,
): Promise<void> {
  const appearances: Appearance[] = [];
  const files = [];
  for (const file of plan.files) {
    if (file.path.split("/").at(-1) === ".folder.json") {
      const metadata = parseFolderMetadata(
        (await readArchiveBlob(repo, file)).toString("utf8"),
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
            (await readArchiveBlob(repo, file)).toString("utf8"),
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
  const collected =
    repo && revision
      ? await collectAppearanceAssetsAt(repo, revision, appearances)
      : [];
  if (db) {
    const found = new Set(collected.map(({ icon }) => iconAssetPath(icon)));
    for (const { icon } of appearances) {
      if (icon?.type !== "image" || found.has(iconAssetPath(icon))) continue;
      found.add(iconAssetPath(icon));
      const stored = await readUntrackedFile(
        db,
        projectId,
        iconAssetPath(icon),
      );
      if (stored) collected.push({ icon, bytes: stored.bytes });
    }
  }
  for (const { icon, bytes } of collected) {
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

function readArchiveBlob(
  repo: ProjectRepoReader | null,
  file: ArchiveBlob,
): Promise<Buffer> {
  if (file.bytes) return Promise.resolve(Buffer.from(file.bytes));
  if (!repo) return Promise.reject(new Error("missing repository"));
  return repo.readBlob(file.sha);
}

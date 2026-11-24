import { stageFolderInRepo } from "./folders";
import { iconAssetPath } from "../appearance/icons";
import { normalizeAppearance, type Appearance } from "../appearance/metadata";
import {
  parseFolderMetadata,
  type FolderMetadata,
} from "../documents/folderMetadata";
import {
  readAppearanceAsset,
  validateAppearanceAssets,
  withAppearanceAssetsInRepo,
  type AppearanceAsset,
} from "./appearanceAssets";
import { randomUUID } from "node:crypto";
import type { JSONContent } from "@tiptap/core";
import { parseServerEnv } from "@weaver/config/server";
import type { PrismaClient } from "@weaver/db/client";
import type { ProjectRepoWriter } from "@weaver/git-store";
import { parseDocumentBody } from "../editor/markdown";
import {
  allocateImageFileName,
  ASSETS_SUFFIX,
  assetsDirForDocPath,
  assetsPrefixForSlug,
  collectImageSources,
  imageBasename,
  imageExtension,
  mapImageSources,
  sniffImageType,
} from "../documents/images";
import {
  importedReview,
  importedAppearance,
  importTitle,
  splitImportHeader,
} from "../documents/importMarkdown";
import { importedProperties } from "../documents/importProperties";
import { splitPythonImport } from "../documents/importPython";
import {
  documentKindFromFileName,
  type DocumentKind,
} from "../documents/kinds";
import { MAX_IMPORTED_IMAGES } from "../documents/limits";
import { assertSafeSegments } from "../documents/paths";
import { slugify } from "../documents/slug";
import { assertPlainText } from "../documents/text";
import { CoreError } from "../errors";
import { assertOutsideTablesRoot } from "../tables/paths";
import { resolveImageReferences } from "./documentImageImports";
import {
  createDocument,
  writeDocumentInRepo,
  type DocumentAssetFile,
  type DocumentResult,
  type EnrichedActor,
} from "./documents";
import { assertProjectRole } from "./projectAccess";
import { notifyProjectContentChanged } from "./projectGitRemoteJobs";
import { withProjectRepo } from "./projectRepo";
import {
  createUntrackedDocument,
  ensureUntrackedFolders,
  findUntrackedDocument,
  isUntrackedFolderPath,
  saveUntrackedDocument,
} from "./untrackedDocuments";

export async function importDocumentFile(
  db: PrismaClient,
  input: {
    projectId: string;
    folderPath: string[];
    fileName: string;
    text: string;
  },
  actor: EnrichedActor,
): Promise<DocumentResult & { warnings?: string[] }> {
  const kind = documentKindFromFileName(input.fileName);
  if (kind === null)
    throw new CoreError(
      "BAD_REQUEST",
      "Only Markdown and Python files can be imported",
      { field: "fileName", reason: "UNSUPPORTED_FILE" },
    );
  assertPlainText(input.text, "text");
  await assertProjectRole(db, input.projectId, actor, "Editor");
  return kind === "python"
    ? importPythonDocument(db, input, actor)
    : importMarkdownDocument(db, input, actor);
}

type FileImportInput = Parameters<typeof importDocumentFile>[1];

async function iconWarnings(
  db: PrismaClient,
  projectId: string,
  appearance: Appearance | undefined,
  actor: EnrichedActor,
): Promise<string[]> {
  const icon = appearance?.icon;
  return icon?.type === "image" &&
    !(await readAppearanceAsset(db, { projectId, icon }, actor))
    ? ["The imported icon image is missing; the default icon will be shown."]
    : [];
}

async function importPythonDocument(
  db: PrismaClient,
  input: FileImportInput,
  actor: EnrichedActor,
): Promise<DocumentResult & { warnings?: string[] }> {
  const { title, body, review, appearance, properties } = splitPythonImport(
    input.text,
    input.fileName,
  );
  const warnings = await iconWarnings(db, input.projectId, appearance, actor);
  const result = await createDocument(
    db,
    {
      projectId: input.projectId,
      folderPath: input.folderPath,
      title,
      reviewSource: { kind: "import", imported: review },
      appearance,
      ...(properties && { properties }),
      allowMissingIcon: true,
      content: { kind: "python", text: body },
    },
    actor,
  );
  return { ...result, ...(warnings.length ? { warnings } : {}) };
}

async function importMarkdownDocument(
  db: PrismaClient,
  input: FileImportInput,
  actor: EnrichedActor,
): Promise<DocumentResult & { warnings?: string[] }> {
  const { body } = splitImportHeader(input.text);
  const title = importTitle(input.text, input.fileName);
  const assetsFromSlug = slugify(title);
  const images = await resolveImageReferences(db, actor, {
    projectId: input.projectId,
    contentJson: parseDocumentBody(body),
    assetsSlug: assetsFromSlug,
    takenNames: new Set(),
  });
  const appearance = importedAppearance(input.text);
  const properties = importedProperties(input.text);
  const warnings = await iconWarnings(db, input.projectId, appearance, actor);
  const result = await createDocument(
    db,
    {
      projectId: input.projectId,
      folderPath: input.folderPath,
      title,
      reviewSource: {
        kind: "import",
        imported: importedReview(input.text),
      },
      appearance,
      ...(properties && { properties }),
      allowMissingIcon: true,
      content: { kind: "markdown", contentJson: images.contentJson },
      assets: images.assets,
      assetsFromSlug,
    },
    actor,
  );
  return { ...result, ...(warnings.length ? { warnings } : {}) };
}

export type ArchiveImportImage = { name: string; bytes: Uint8Array };
export type ArchiveImportTarget =
  | { mode: "create" }
  | { mode: "replace"; documentId: string; expectedHeadCommitSha: string };

export type ArchiveFolderMetadata = Record<string, FolderMetadata>;

type ArchiveImportInput = {
  projectId: string;
  folderPath: string[];
  /** Display names of folders that may need creating, keyed by slug path. */
  folderNames: Record<string, string>;
  folderMetadata?: ArchiveFolderMetadata;
  iconAssets?: AppearanceAsset[];
  kind: DocumentKind;
  fileName: string;
  text: string;
  images: ArchiveImportImage[];
  target: ArchiveImportTarget;
};

const badImage = (name: string, reason: string) =>
  new CoreError("BAD_REQUEST", `image ${name.slice(0, 120)} ${reason}`, {
    field: "image",
  });

function sourceStem(fileName: string): string {
  return fileName.replace(/^.*[\\/]/, "").replace(/\.(md|markdown|py)$/i, "");
}

function decodedSrc(src: string): string {
  try {
    return decodeURI(src).replace(/^\.\//, "");
  } catch {
    return src;
  }
}

/** Stores the supplied images the body references and points their links at `assetsSlug`. */
function adoptSuppliedImages(
  contentJson: JSONContent,
  input: Pick<ArchiveImportInput, "fileName" | "images">,
  assetsSlug: string,
  maxBytes: number,
): { contentJson: JSONContent; assets: DocumentAssetFile[] } {
  const sourcePrefix = `${sourceStem(input.fileName)}${ASSETS_SUFFIX}/`;
  const supplied = new Map(input.images.map((image) => [image.name, image]));
  const stored = new Map<string, string>();
  const taken = new Set<string>();
  const assets: DocumentAssetFile[] = [];
  const next = mapImageSources(contentJson, (src) => {
    const key = decodedSrc(src);
    if (!key.startsWith(sourcePrefix)) return src;
    const image = supplied.get(key.slice(sourcePrefix.length));
    if (!image) return src;
    let name = stored.get(image.name);
    if (!name) {
      const type = sniffImageType(image.bytes.subarray(0, 16));
      if (!type)
        throw badImage(image.name, "is not a PNG, JPEG, WebP or GIF image");
      if (image.bytes.byteLength > maxBytes)
        throw badImage(image.name, "exceeds the document image size limit");
      name = allocateImageFileName(
        imageBasename(image.name),
        imageExtension(type),
        taken,
      );
      taken.add(name);
      stored.set(image.name, name);
      assets.push({ name, bytes: image.bytes });
    }
    return `${assetsPrefixForSlug(assetsSlug)}${name}`;
  });
  return { contentJson: next, assets };
}

function normalizedFolders(
  raw: ArchiveFolderMetadata = {},
): ArchiveFolderMetadata {
  if (Object.keys(raw).length > 1000)
    throw new CoreError("BAD_REQUEST", "Too many folders");
  const result: ArchiveFolderMetadata = {};
  for (const [path, value] of Object.entries(raw)) {
    try {
      assertSafeSegments(path.split("/"));
      assertOutsideTablesRoot(path.split("/"));
    } catch {
      throw new CoreError("BAD_REQUEST", "Invalid folder metadata path");
    }
    const metadata = parseFolderMetadata(JSON.stringify(value));
    if (!metadata)
      throw new CoreError("BAD_REQUEST", "Invalid folder metadata");
    result[path] = metadata;
  }
  return result;
}

type ArchiveFolder = {
  segments: string[];
  name: string;
  appearance?: Appearance;
};

/** The folders an archive entry may create, shallowest first, named and styled as in the archive. */
function requestedFolders(
  input: Pick<
    ArchiveImportInput,
    "folderPath" | "folderNames" | "folderMetadata"
  >,
): ArchiveFolder[] {
  const requested = new Set([
    input.folderPath.join("/"),
    ...Object.keys(input.folderMetadata ?? {}),
  ]);
  const folders = new Map<string, ArchiveFolder>();
  for (const requestedPath of requested) {
    const segments = requestedPath ? requestedPath.split("/") : [];
    for (let depth = 1; depth <= segments.length; depth++) {
      const rel = segments.slice(0, depth).join("/");
      if (folders.has(rel)) continue;
      const segment = segments[depth - 1]!;
      const source = input.folderMetadata?.[rel];
      const wanted = input.folderNames[rel]?.trim();
      const name =
        source?.name ??
        (wanted && slugify(wanted) === segment ? wanted : segment);
      const appearance = normalizeAppearance(source?.appearance);
      folders.set(rel, {
        segments: segments.slice(0, depth),
        name,
        ...(appearance ? { appearance } : {}),
      });
    }
  }
  return [...folders.values()].sort(
    (a, b) => a.segments.length - b.segments.length,
  );
}

async function ensureFolders(
  db: PrismaClient,
  repo: ProjectRepoWriter,
  projectId: string,
  folders: ArchiveFolder[],
  actor: EnrichedActor,
): Promise<void> {
  for (const folder of folders) {
    if (await repo.fileExistsInWorktree(folder.segments.join("/"))) continue;
    await stageFolderInRepo(db, repo, projectId, folder, actor, "documents");
  }
}

/** The supplied icons the appearances use, as files of the untracked store. */
function untrackedIcons(
  appearances: Appearance[],
  assets: AppearanceAsset[],
): Array<{ path: string; bytes: Uint8Array }> {
  const used = new Set(
    appearances.flatMap(({ icon }) =>
      icon?.type === "image" ? [iconAssetPath(icon)] : [],
    ),
  );
  return assets.flatMap((asset) => {
    const path = iconAssetPath({
      type: "image",
      digest: asset.digest,
      extension: asset.extension,
    });
    return used.has(path) ? [{ path, bytes: asset.bytes }] : [];
  });
}

/** Below a folder kept out of Git, imported folders stay out of Git too. */
async function ensureUntrackedArchiveFolders(
  db: PrismaClient,
  projectId: string,
  folders: ArchiveFolder[],
  appearances: Appearance[],
  assets: AppearanceAsset[],
  actor: EnrichedActor,
): Promise<void> {
  await ensureUntrackedFolders(
    db,
    {
      projectId,
      folders,
      icons: untrackedIcons(
        [
          ...appearances,
          ...folders.flatMap((folder) =>
            folder.appearance ? [folder.appearance] : [],
          ),
        ],
        assets,
      ),
    },
    actor,
  );
}

export async function importArchiveFolders(
  db: PrismaClient,
  input: Pick<
    ArchiveImportInput,
    "projectId" | "folderPath" | "folderNames" | "folderMetadata" | "iconAssets"
  >,
  actor: EnrichedActor,
) {
  await assertProjectRole(db, input.projectId, actor, "Editor");
  const folderMetadata = normalizedFolders(input.folderMetadata);
  const appearances = Object.values(folderMetadata).flatMap((meta) =>
    meta.appearance ? [meta.appearance] : [],
  );
  const assets = input.iconAssets ?? [];
  validateAppearanceAssets(assets);
  if (
    assets.some(
      (asset) =>
        !appearances.some(
          ({ icon }) =>
            icon?.type === "image" &&
            icon.digest === asset.digest &&
            icon.extension === asset.extension,
        ),
    )
  )
    throw new CoreError("BAD_REQUEST", "Unreferenced icon asset");
  assertSafeSegments(input.folderPath);
  assertOutsideTablesRoot(input.folderPath);
  const folders = requestedFolders({ ...input, folderMetadata });
  if (await isUntrackedFolderPath(db, input.projectId, input.folderPath)) {
    await ensureUntrackedArchiveFolders(
      db,
      input.projectId,
      folders,
      [],
      assets,
      actor,
    );
    return { folders: Object.keys(folderMetadata), headCommitSha: null };
  }
  const result = await withProjectRepo(
    input.projectId,
    async (repo) => {
      const fresh = Object.entries(folderMetadata);
      const wanted: Appearance[] = [];
      for (const [path, meta] of fresh)
        if (!(await repo.fileExistsInWorktree(path)) && meta.appearance)
          wanted.push(meta.appearance);
      return withAppearanceAssetsInRepo(
        repo,
        wanted,
        assets,
        async (writer) => {
          await ensureFolders(db, writer, input.projectId, folders, actor);
          const headCommitSha = await writer.commitAll(
            "create: imported folders",
            {
              name: actor.name ?? null,
              email: actor.email,
              userId: actor.userId,
            },
          );
          return { folders: Object.keys(folderMetadata), headCommitSha };
        },
      );
    },
    { db, actor, min: "Editor" },
  );
  void notifyProjectContentChanged(db, input.projectId);
  return result;
}

/** Removes the images of the document's current assets directory that the new body drops. */
async function removeStaleAssets(
  repo: ProjectRepoWriter,
  current: { path: string; slug: string },
  next: { contentJson: JSONContent; assets: DocumentAssetFile[] },
): Promise<void> {
  const assetsDir = assetsDirForDocPath(current.path);
  const ownPrefix = assetsPrefixForSlug(current.slug);
  const kept = new Set(next.assets.map((asset) => asset.name));
  for (const src of collectImageSources(next.contentJson))
    if (src.startsWith(ownPrefix)) kept.add(src.slice(ownPrefix.length));
  for (const file of await repo.listTrackedFiles())
    if (
      file.startsWith(`${assetsDir}/`) &&
      !kept.has(file.slice(assetsDir.length + 1))
    )
      await repo.rm(file);
}

/** Imports one document of a dropped archive, with its images, as a new document or onto an existing one. */
export async function importDocumentArchiveEntry(
  db: PrismaClient,
  input: ArchiveImportInput,
  actor: EnrichedActor,
): Promise<DocumentResult> {
  if (documentKindFromFileName(input.fileName) !== input.kind)
    throw new CoreError(
      "BAD_REQUEST",
      "the file name does not match the document kind",
      { field: "fileName", reason: "UNSUPPORTED_FILE" },
    );
  assertPlainText(input.text, "text");
  if (input.kind === "python" && input.images.length)
    throw new CoreError("BAD_REQUEST", "a Python file carries no images", {
      field: "image",
    });
  if (input.images.length > MAX_IMPORTED_IMAGES)
    throw new CoreError(
      "BAD_REQUEST",
      `a document may carry at most ${MAX_IMPORTED_IMAGES} images`,
      { field: "image" },
    );
  await assertProjectRole(db, input.projectId, actor, "Editor");
  try {
    assertSafeSegments(input.folderPath);
    assertOutsideTablesRoot(input.folderPath);
  } catch {
    throw new CoreError("BAD_REQUEST", "invalid folder path", {
      field: "folderPath",
    });
  }
  const source =
    input.kind === "python"
      ? splitPythonImport(input.text, input.fileName)
      : null;
  const title = source ? source.title : importTitle(input.text, input.fileName);
  const build = async (assetsSlug: string) => {
    const parsed = parseDocumentBody(splitImportHeader(input.text).body);
    const maxBytes = parseServerEnv(
      process.env,
    ).WEAVER_DOCUMENT_IMAGE_MAX_BYTES;
    const own = adoptSuppliedImages(parsed, input, assetsSlug, maxBytes);
    const referenced = await resolveImageReferences(db, actor, {
      projectId: input.projectId,
      contentJson: own.contentJson,
      assetsSlug,
      takenNames: new Set(own.assets.map((asset) => asset.name)),
    });
    return {
      contentJson: referenced.contentJson,
      assets: [...own.assets, ...referenced.assets],
    };
  };
  const target = input.target;
  const folderMetadata = normalizedFolders(input.folderMetadata);
  const appearance = source
    ? source.appearance
    : importedAppearance(input.text);
  const properties = source
    ? source.properties
    : importedProperties(input.text);
  validateAppearanceAssets(input.iconAssets ?? []);
  const folders = requestedFolders({ ...input, folderMetadata });
  const untracked =
    target.mode === "replace"
      ? await findUntrackedDocument(db, input.projectId, target.documentId)
      : null;
  if (untracked && target.mode === "replace") {
    // A document kept out of Git is replaced in its own store; nothing is committed.
    if (untracked.kind !== input.kind)
      throw new CoreError(
        "BAD_REQUEST",
        "the existing document is a different kind of file",
        { field: "targetDocumentId" },
      );
    const update = {
      projectId: input.projectId,
      documentId: untracked.id,
      baseCommitSha: target.expectedHeadCommitSha,
      title,
      ...(properties && { properties }),
    };
    if (source)
      return saveUntrackedDocument(
        db,
        { ...update, content: { kind: "python", text: source.body } },
        actor,
      );
    const built = await build(untracked.slug);
    return saveUntrackedDocument(
      db,
      {
        ...update,
        content: { kind: "markdown", contentJson: built.contentJson },
        assets: built.assets,
      },
      actor,
    );
  }
  if (
    target.mode === "create" &&
    (await isUntrackedFolderPath(db, input.projectId, input.folderPath))
  ) {
    // Like a single file dropped there, the entry stays out of Git.
    const create = {
      projectId: input.projectId,
      folderPath: input.folderPath,
      title,
      ...(appearance && { appearance }),
      ...(properties && { properties }),
    };
    const ensure = () =>
      ensureUntrackedArchiveFolders(
        db,
        input.projectId,
        folders,
        appearance ? [appearance] : [],
        input.iconAssets ?? [],
        actor,
      );
    if (source) {
      await ensure();
      return createUntrackedDocument(
        db,
        {
          ...create,
          content: { kind: "python", text: source.body },
          reviewSource: { kind: "import", imported: source.review },
        },
        actor,
      );
    }
    const assetsFromSlug = slugify(title);
    const built = await build(assetsFromSlug);
    await ensure();
    return createUntrackedDocument(
      db,
      {
        ...create,
        content: { kind: "markdown", contentJson: built.contentJson },
        reviewSource: { kind: "import", imported: importedReview(input.text) },
        assets: built.assets,
        assetsFromSlug,
      },
      actor,
    );
  }
  const result = await withProjectRepo(
    input.projectId,
    async (repo) => {
      const appearances: Appearance[] =
        target.mode === "create" && appearance ? [appearance] : [];
      if (target.mode === "create")
        for (const [path, meta] of Object.entries(folderMetadata))
          if (!(await repo.fileExistsInWorktree(path)) && meta.appearance)
            appearances.push(meta.appearance);
      return withAppearanceAssetsInRepo(
        repo,
        appearances,
        input.iconAssets ?? [],
        async (repo) => {
          if (target.mode === "replace") {
            const row = await db.document.findFirst({
              where: { id: target.documentId, projectId: input.projectId },
            });
            const baseCommitSha =
              row && (await repo.lastCommitForPath(row.path));
            if (!row || !baseCommitSha) throw new CoreError("NOT_FOUND");
            if (target.expectedHeadCommitSha !== baseCommitSha)
              throw new CoreError(
                "CONFLICT",
                "The document changed after preview. Preview the import again.",
              );
            if (row.kind !== input.kind)
              throw new CoreError(
                "BAD_REQUEST",
                "the existing document is a different kind of file",
                { field: "targetDocumentId" },
              );
            const update = {
              kind: "update" as const,
              documentId: row.id,
              baseCommitSha,
              title,
              changeSummary: `replaced by import of ${input.fileName}`,
              ...(properties && { propertiesInput: properties }),
            };
            if (source)
              return writeDocumentInRepo(
                db,
                repo,
                input.projectId,
                { ...update, content: { kind: "python", text: source.body } },
                actor,
                { operation: "update" },
              );
            const built = await build(row.slug);
            await removeStaleAssets(repo, row, built);
            return writeDocumentInRepo(
              db,
              repo,
              input.projectId,
              {
                ...update,
                content: { kind: "markdown", contentJson: built.contentJson },
                assets: built.assets,
              },
              actor,
              { operation: "update" },
            );
          }
          const create = {
            kind: "create" as const,
            id: randomUUID(),
            folderPath: input.folderPath,
            title,
            createdAt: new Date().toISOString(),
            appearance,
            ...(properties && { propertiesInput: properties }),
          };
          if (source) {
            await ensureFolders(db, repo, input.projectId, folders, actor);
            return writeDocumentInRepo(
              db,
              repo,
              input.projectId,
              {
                ...create,
                content: { kind: "python", text: source.body },
                reviewSource: { kind: "import", imported: source.review },
              },
              actor,
              { operation: "create" },
            );
          }
          const assetsFromSlug = slugify(title);
          const built = await build(assetsFromSlug);
          await ensureFolders(db, repo, input.projectId, folders, actor);
          return writeDocumentInRepo(
            db,
            repo,
            input.projectId,
            {
              ...create,
              content: { kind: "markdown", contentJson: built.contentJson },
              reviewSource: {
                kind: "import",
                imported: importedReview(input.text),
              },
              assets: built.assets,
              assetsFromSlug,
            },
            actor,
            { operation: "create" },
          );
        },
      );
    },
    { db, actor, min: "Editor" },
  );
  void notifyProjectContentChanged(db, input.projectId);
  return result;
}

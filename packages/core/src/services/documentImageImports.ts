import { createHash } from "node:crypto";
import type { JSONContent } from "@tiptap/core";
import { parseServerEnv } from "@weaver/config/server";
import type { PrismaClient } from "@weaver/db/client";
import { artifactFormatOf } from "../artifacts/readerOperations";
import {
  findWordImages,
  WORD_IMAGE_SOURCE_MAX_BYTES,
  type WordImageLookup,
} from "../artifacts/wordImages";
import {
  collectImageReferences,
  parseImageReference,
  replaceImageReferences,
  type ImageReference,
} from "../documents/imageReferences";
import {
  allocateImageFileName,
  assetsPrefixForSlug,
  DOCUMENT_IMAGE_TYPES,
  imageExtension,
  sniffImageType,
} from "../documents/images";
import { MAX_IMPORTED_IMAGES } from "../documents/limits";
import { CoreError, isCoreError } from "../errors";
import { readBlob } from "../ingestion/blobStore";
import {
  findArtifactNotebookAsset,
  readArtifactNotebookAsset,
} from "./artifactNotebooks";
import { getArtifact } from "./artifacts";
import type { DocumentAssetFile } from "./documents";
import type { ProjectActor } from "./projectAccess";

const invalid = (src: string, reason: string) =>
  new CoreError("BAD_REQUEST", `image ${src.slice(0, 120)} ${reason}`, {
    field: "markdown",
  });

type Source = { src: string; reference: ImageReference };
type Limits = {
  dataDir: string;
  maxBytes: number;
  /** Image ids the write references, per artifact id. */
  wanted: Map<string, Set<string>>;
  /** One lookup per Word file, by artifact id and content digest. */
  wordLookups: Map<string, Promise<WordImageLookup>>;
};

type Located =
  | { kind: "notebook"; artifactId: string; contentDigest: string }
  | { kind: "word"; bytes: Uint8Array }
  | { kind: "file"; contentDigest: string };

function notebookAssetError(src: string, error: unknown): never {
  if (!isCoreError(error)) throw error;
  if (error.code === "NOT_FOUND")
    throw invalid(src, "is not an image of this notebook");
  if (error.code === "PRECONDITION_FAILED" || error.code === "CONFLICT")
    throw invalid(
      src,
      "cannot be read until the notebook is prepared; read it with read_onenote first",
    );
  throw invalid(src, error.message);
}

/** Reads and scans one Word file; the file's bytes are released when this returns. */
async function lookUpWordImages(
  projectId: string,
  contentDigest: string,
  wanted: ReadonlySet<string>,
  limits: Limits,
): Promise<WordImageLookup> {
  const docx = await readBlob(
    limits.dataDir,
    projectId,
    contentDigest,
    WORD_IMAGE_SOURCE_MAX_BYTES,
  );
  if (createHash("sha256").update(docx).digest("hex") !== contentDigest)
    throw new Error("digest mismatch");
  return findWordImages(docx, wanted, limits.maxBytes);
}

async function locateWordImage(
  projectId: string,
  src: string,
  artifact: { contentDigest: string; byteSize: number },
  reference: { artifactId: string; assetId: string },
  limits: Limits,
): Promise<Located> {
  if (artifact.byteSize > WORD_IMAGE_SOURCE_MAX_BYTES)
    throw invalid(src, "is in a Word file too large to copy images from");
  const key = `${reference.artifactId}/${artifact.contentDigest}`;
  let lookup = limits.wordLookups.get(key);
  if (!lookup) {
    lookup = lookUpWordImages(
      projectId,
      artifact.contentDigest,
      limits.wanted.get(reference.artifactId)!,
      limits,
    );
    limits.wordLookups.set(key, lookup);
  }
  const found = await lookup.catch(() => {
    throw invalid(src, "is no longer stored");
  });
  const bytes = found.images.get(reference.assetId);
  if (bytes) return { kind: "word", bytes };
  if (!found.complete)
    throw invalid(
      src,
      "could not be located: this Word file has too many or too large pictures",
    );
  throw invalid(
    src,
    found.oversized > 0
      ? "is not an image of this Word file, or exceeds the document image size limit"
      : "is not an image of this Word file",
  );
}

/** Checks that a reference names an image of this project that fits; a Word file is read and scanned once per call. */
async function locateImage(
  db: PrismaClient,
  actor: ProjectActor,
  projectId: string,
  src: string,
  reference: ImageReference,
  limits: Limits,
): Promise<Located> {
  const artifact = await getArtifact(db, actor, {
    projectId,
    artifactId: reference.artifactId,
  }).catch((error: unknown) => {
    if (isCoreError(error) && error.code === "NOT_FOUND")
      throw invalid(src, "names a file that is not in this project");
    throw error;
  });
  if (reference.assetId) {
    if (artifactFormatOf(artifact.contentType, artifact.filename) === "word")
      return locateWordImage(
        projectId,
        src,
        artifact,
        { artifactId: reference.artifactId, assetId: reference.assetId },
        limits,
      );
    const asset = await findArtifactNotebookAsset(db, actor, {
      projectId,
      artifactId: artifact.id,
      contentDigest: artifact.contentDigest,
      assetId: reference.assetId,
    }).catch((error: unknown) => notebookAssetError(src, error));
    if (asset.byteSize > limits.maxBytes)
      throw invalid(src, "exceeds the document image size limit");
    return {
      kind: "notebook",
      artifactId: artifact.id,
      contentDigest: artifact.contentDigest,
    };
  }
  if (
    !(DOCUMENT_IMAGE_TYPES as readonly string[]).includes(artifact.contentType)
  )
    throw invalid(src, "is not a PNG, JPEG, WebP or GIF image file");
  if (artifact.byteSize > limits.maxBytes)
    throw invalid(src, "exceeds the document image size limit");
  return { kind: "file", contentDigest: artifact.contentDigest };
}

async function loadImage(
  db: PrismaClient,
  actor: ProjectActor,
  projectId: string,
  src: string,
  reference: ImageReference,
  limits: Limits,
): Promise<Uint8Array> {
  const located = await locateImage(
    db,
    actor,
    projectId,
    src,
    reference,
    limits,
  );
  if (located.kind === "word") return located.bytes;
  if (located.kind === "notebook") {
    return (
      await readArtifactNotebookAsset(db, actor, {
        projectId,
        artifactId: located.artifactId,
        contentDigest: located.contentDigest,
        assetId: reference.assetId!,
      }).catch((error: unknown) => notebookAssetError(src, error))
    ).bytes;
  }
  const bytes = await readBlob(
    limits.dataDir,
    projectId,
    located.contentDigest,
    limits.maxBytes,
  ).catch(() => {
    throw invalid(src, "is no longer stored");
  });
  if (
    createHash("sha256").update(bytes).digest("hex") !== located.contentDigest
  )
    throw invalid(src, "is no longer stored");
  return bytes;
}

function imageLimits(sources: readonly Source[]): Limits {
  const env = parseServerEnv(process.env);
  const wanted = new Map<string, Set<string>>();
  for (const { reference } of sources) {
    if (!reference.assetId) continue;
    const ids = wanted.get(reference.artifactId) ?? new Set();
    wanted.set(reference.artifactId, ids.add(reference.assetId));
  }
  return {
    dataDir: env.WEAVER_DATA_DIR,
    maxBytes: env.WEAVER_DOCUMENT_IMAGE_MAX_BYTES,
    wanted,
    wordLookups: new Map(),
  };
}

/** The references of a body, each parsed, within the per-write cap. */
function imageSources(contentJson: JSONContent): Source[] {
  const sources = collectImageReferences(contentJson);
  if (sources.length > MAX_IMPORTED_IMAGES)
    throw new CoreError(
      "BAD_REQUEST",
      `a write may copy at most ${MAX_IMPORTED_IMAGES} images`,
      { field: "markdown" },
    );
  return sources.map((src) => {
    try {
      return { src, reference: parseImageReference(src)! };
    } catch {
      throw invalid(
        src,
        "is not a valid reference; use weaver-image:<file id> or weaver-image:<file id>/<image id>",
      );
    }
  });
}

/** Validates every reference as `resolveImageReferences` would; only Word files are read, to find their pictures. */
export async function checkImageReferences(
  db: PrismaClient,
  actor: ProjectActor,
  input: { projectId: string; contentJson: JSONContent },
): Promise<{ images: number }> {
  const sources = imageSources(input.contentJson);
  if (!sources.length) return { images: 0 };
  const limits = imageLimits(sources);
  for (const { src, reference } of sources)
    await locateImage(db, actor, input.projectId, src, reference, limits);
  return { images: sources.length };
}

/** Copies every `weaver-image:` reference into the document's assets, read with the actor's own access. */
export async function resolveImageReferences(
  db: PrismaClient,
  actor: ProjectActor,
  input: {
    projectId: string;
    contentJson: JSONContent;
    assetsSlug: string;
    takenNames: ReadonlySet<string>;
  },
): Promise<{ contentJson: JSONContent; assets: DocumentAssetFile[] }> {
  const sources = imageSources(input.contentJson);
  if (!sources.length) return { contentJson: input.contentJson, assets: [] };
  const limits = imageLimits(sources);
  const taken = new Set(input.takenNames);
  const targets = new Map<string, string>();
  const assets: DocumentAssetFile[] = [];
  for (const { src, reference } of sources) {
    const bytes = await loadImage(
      db,
      actor,
      input.projectId,
      src,
      reference,
      limits,
    );
    const type = sniffImageType(bytes.subarray(0, 16));
    if (!type) throw invalid(src, "is not a PNG, JPEG, WebP or GIF image");
    if (bytes.byteLength > limits.maxBytes)
      throw invalid(src, "exceeds the document image size limit");
    const name = allocateImageFileName("image", imageExtension(type), taken);
    taken.add(name);
    assets.push({ name, bytes });
    targets.set(src, `${assetsPrefixForSlug(input.assetsSlug)}${name}`);
  }
  return {
    contentJson: replaceImageReferences(input.contentJson, targets),
    assets,
  };
}

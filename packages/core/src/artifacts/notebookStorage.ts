import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { UUID_RE } from "../ingestion/paths";
import {
  NOTEBOOK_ASSET_MAX_BYTES,
  NOTEBOOK_MANIFEST_MAX_BYTES,
  NOTEBOOK_PAGE_MAX_BYTES,
  NOTEBOOK_SNAPSHOT_MAX_BYTES,
  notebookDigestSchema,
  notebookManifestSchema,
  notebookPageSchema,
  type NotebookManifest,
} from "./notebookSchema";

export function notebookClaimDir(
  dataDir: string,
  projectId: string,
  artifactId: string,
  digest: string,
  parserVersion: number,
  claimToken: string,
): string {
  if (
    ![projectId, artifactId, claimToken].every((value) =>
      UUID_RE.test(value),
    ) ||
    !notebookDigestSchema.safeParse(digest).success ||
    !Number.isSafeInteger(parserVersion) ||
    parserVersion < 1
  )
    throw new Error("invalid_notebook_path");
  return path.join(
    dataDir,
    "notebooks",
    projectId,
    artifactId,
    digest,
    String(parserVersion),
    claimToken,
  );
}

export async function assertNotebookPath(
  dataDir: string,
  target: string,
): Promise<void> {
  const root = await realpath(dataDir);
  const relative = path.relative(path.resolve(dataDir), path.resolve(target));
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("invalid_notebook_path");
  let current = root;
  for (const part of relative.split(path.sep)) {
    if (!part || part === ".") continue;
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error("invalid_notebook_path");
  }
}

export async function createNotebookDirectory(
  dataDir: string,
  target: string,
): Promise<void> {
  const relative = path.relative(path.resolve(dataDir), path.resolve(target));
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("invalid_notebook_path");
  let current = await realpath(dataDir);
  for (const part of relative.split(path.sep)) {
    if (!part || part === ".") continue;
    current = path.join(current, part);
    try {
      await mkdir(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("invalid_notebook_path");
  }
}

export async function readNotebookFile(
  dataDir: string,
  target: string,
  maxBytes: number,
): Promise<Buffer> {
  await assertNotebookPath(dataDir, target);
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes)
      throw new Error("invalid_notebook_file");
    const buffer = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== info.size) throw new Error("invalid_notebook_file");
    return buffer.subarray(0, offset);
  } finally {
    await file.close();
  }
}

export async function readNotebookManifest(
  dataDir: string,
  dir: string,
): Promise<NotebookManifest> {
  return notebookManifestSchema.parse(
    JSON.parse(
      (
        await readNotebookFile(
          dataDir,
          path.join(dir, "manifest.json"),
          NOTEBOOK_MANIFEST_MAX_BYTES,
        )
      ).toString("utf8"),
    ),
  );
}

/** Validates a parser's output tree and returns its manifest with the bytes
 *  it occupies on disk (every file under `dir`), which the runner records
 *  against the project quota. */
export async function validateNotebookSnapshot(
  dataDir: string,
  dir: string,
  signal?: AbortSignal,
): Promise<{ manifest: NotebookManifest; byteSize: number }> {
  let total = 0;
  let count = 0;
  const files = new Set<string>();
  async function visit(current: string, depth: number): Promise<void> {
    if (depth > 2) throw new Error("invalid_notebook_snapshot");
    for await (const entry of await opendir(current)) {
      signal?.throwIfAborted();
      if (++count > 45_000 || entry.isSymbolicLink())
        throw new Error("invalid_notebook_snapshot");
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target, depth + 1);
      else if (entry.isFile()) {
        total += (await lstat(target)).size;
        if (total > NOTEBOOK_SNAPSHOT_MAX_BYTES)
          throw new Error("notebook_snapshot_limit");
        files.add(path.relative(dir, target));
      } else throw new Error("invalid_notebook_snapshot");
    }
  }
  await assertNotebookPath(dataDir, dir);
  await visit(dir, 0);
  const manifest = await readNotebookManifest(dataDir, dir);
  if (!manifest.sections.length) throw new Error("empty_notebook_snapshot");
  const assetIds = new Set(manifest.assets.map((asset) => asset.id));
  if (assetIds.size !== manifest.assets.length)
    throw new Error("invalid_notebook_snapshot");
  const sections = new Set<string>();
  const pages = new Set<string>();
  const expected = new Set(["manifest.json"]);
  for (const section of manifest.sections) {
    signal?.throwIfAborted();
    if (sections.has(section.id)) throw new Error("invalid_notebook_snapshot");
    sections.add(section.id);
    for (const summary of section.pages) {
      signal?.throwIfAborted();
      if (pages.has(summary.id)) throw new Error("invalid_notebook_snapshot");
      pages.add(summary.id);
      const relative = path.join("pages", `${summary.id}.json`);
      expected.add(relative);
      const page = notebookPageSchema.parse(
        JSON.parse(
          (
            await readNotebookFile(
              dataDir,
              path.join(dir, relative),
              NOTEBOOK_PAGE_MAX_BYTES,
            )
          ).toString("utf8"),
        ),
      );
      if (
        page.id !== summary.id ||
        page.sectionId !== section.id ||
        page.title !== summary.title ||
        page.level !== summary.level ||
        page.blocks.some(
          (block) => block.kind === "image" && !assetIds.has(block.assetId),
        )
      )
        throw new Error("invalid_notebook_snapshot");
    }
  }
  for (const asset of manifest.assets) {
    signal?.throwIfAborted();
    const relative = path.join("assets", asset.id);
    expected.add(relative);
    const bytes = await readNotebookFile(
      dataDir,
      path.join(dir, relative),
      NOTEBOOK_ASSET_MAX_BYTES,
    );
    if (
      bytes.length !== asset.byteSize ||
      createHash("sha256").update(bytes).digest("hex") !== asset.id ||
      !validImageSignature(bytes, asset.contentType)
    )
      throw new Error("invalid_notebook_asset");
  }
  if (
    files.size !== expected.size ||
    [...files].some((file) => !expected.has(file))
  )
    throw new Error("invalid_notebook_snapshot");
  return { manifest, byteSize: total };
}

export function validImageSignature(
  bytes: Buffer,
  contentType: string,
): boolean {
  if (contentType === "image/png")
    return bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (contentType === "image/jpeg")
    return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (contentType === "image/gif")
    return ["GIF87a", "GIF89a"].includes(
      bytes.subarray(0, 6).toString("ascii"),
    );
  return (
    contentType === "image/webp" &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  );
}

import { createHash } from "node:crypto";
import type { PrismaClient } from "@weaver/db/client";
import type { ProjectRepoReader, ProjectRepoWriter } from "@weaver/git-store";
import { iconAssetPath } from "../appearance/icons";
import {
  assertAppearancePatch,
  type Appearance,
  type ImageIcon,
} from "../appearance/metadata";
import { imageExtension, sniffImageType } from "../documents/images";
import { CoreError } from "../errors";
import { assertProjectRole, type ProjectActor } from "./projectAccess";
import { withExistingProjectRepoReader } from "./projectRepo";

export const MAX_ICON_BYTES = 2 * 1024 * 1024;

export function imageIconFromBytes(bytes: Uint8Array): ImageIcon {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ICON_BYTES)
    throw new CoreError("BAD_REQUEST", "Icon images must be at most 2 MiB", {
      field: "icon",
    });
  const type = sniffImageType(bytes.subarray(0, 16));
  if (!type || type === "image/gif")
    throw new CoreError("BAD_REQUEST", "Use a PNG, JPEG, or WebP icon", {
      field: "icon",
    });
  return {
    type: "image",
    digest: createHash("sha256").update(bytes).digest("hex"),
    extension: imageExtension(type) as ImageIcon["extension"],
  };
}

/** Caller holds the repository lock and has authorized the project. */
export async function readAppearanceAssetInRepo(
  repo: ProjectRepoReader,
  icon: ImageIcon,
  revision: string,
) {
  assertAppearancePatch({ icon });
  const fileName = `${icon.digest}.${icon.extension}`;
  const blob = await repo.readCommittedBlobAt(
    revision,
    iconAssetPath(icon),
    MAX_ICON_BYTES,
  );
  if (!blob) return null;
  let actual: ImageIcon;
  try {
    actual = imageIconFromBytes(blob.bytes);
  } catch {
    return null;
  }
  if (actual.digest !== icon.digest || actual.extension !== icon.extension)
    return null;
  return {
    bytes: blob.bytes,
    blobSha: blob.blobSha,
    contentType: sniffImageType(blob.bytes)!,
    fileName,
  };
}

export async function readAppearanceAsset(
  db: PrismaClient,
  input: {
    projectId: string;
    icon: ImageIcon;
    at?: string;
    ifNoneMatch?: string;
  },
  actor: ProjectActor,
) {
  await assertProjectRole(db, input.projectId, actor, "Viewer");
  return withExistingProjectRepoReader(input.projectId, async (repo) => {
    await assertProjectRole(db, input.projectId, actor, "Viewer");
    const head = await repo.resolveHead();
    if (
      input.at !== undefined &&
      (!/^[a-f0-9]{40}$/.test(input.at) ||
        !(await repo.isAncestor(input.at, head)))
    )
      return null;
    const asset = await readAppearanceAssetInRepo(
      repo,
      input.icon,
      input.at ?? head,
    );
    if (asset && input.ifNoneMatch === `"${asset.blobSha}"`)
      return { notModified: true as const, blobSha: asset.blobSha };
    return asset;
  });
}

export type AppearanceAsset = {
  digest: string;
  extension: ImageIcon["extension"];
  bytes: Uint8Array;
};

/** Caller authorizes the project; all references resolve at the same revision. */
export async function collectAppearanceAssetsAt(
  repo: ProjectRepoReader,
  revision: string,
  appearances: Appearance[],
): Promise<Array<{ icon: ImageIcon; bytes: Uint8Array }>> {
  const assets = new Map<string, { icon: ImageIcon; bytes: Uint8Array }>();
  for (const { icon } of appearances) {
    if (icon?.type !== "image" || assets.has(iconAssetPath(icon))) continue;
    const asset = await readAppearanceAssetInRepo(repo, icon, revision);
    if (asset) assets.set(iconAssetPath(icon), { icon, bytes: asset.bytes });
  }
  return [...assets.values()];
}

export function validateAppearanceAssets(assets: AppearanceAsset[]): void {
  const seen = new Set<string>();
  if (assets.length > 100)
    throw new CoreError("BAD_REQUEST", "Too many icon assets");
  for (const asset of assets) {
    const actual = imageIconFromBytes(asset.bytes);
    const key = `${asset.digest}.${asset.extension}`;
    if (
      actual.digest !== asset.digest ||
      actual.extension !== asset.extension ||
      seen.has(key)
    )
      throw new CoreError("BAD_REQUEST", "Invalid or repeated icon asset", {
        field: "icon",
      });
    seen.add(key);
  }
}

/** Adds only referenced icons to the caller's existing locked content commit. */
export async function withAppearanceAssetsInRepo<T>(
  repo: ProjectRepoWriter,
  appearances: Appearance[],
  assets: AppearanceAsset[],
  write: (repo: ProjectRepoWriter) => Promise<T>,
  allowMissing = false,
): Promise<T> {
  validateAppearanceAssets(assets);
  for (const appearance of appearances) assertAppearancePatch(appearance);
  const head = await repo.resolveHead();
  const supplied = new Map(
    assets.map((asset) => [`${asset.digest}.${asset.extension}`, asset]),
  );
  const pending = new Map<string, Uint8Array>();
  for (const { icon } of appearances) {
    if (icon?.type !== "image") continue;
    const path = iconAssetPath(icon);
    if (await readAppearanceAssetInRepo(repo, icon, head)) continue;
    const asset = supplied.get(`${icon.digest}.${icon.extension}`);
    if (!asset) {
      if (allowMissing) continue;
      throw new CoreError("BAD_REQUEST", "Referenced icon asset is missing", {
        field: "icon",
      });
    }
    if (await repo.blobShaAt(head, path))
      throw new CoreError("BAD_REQUEST", "Existing icon asset is invalid", {
        field: "icon",
      });
    pending.set(path, asset.bytes);
  }
  const originals = new Map<string, Buffer | null>();
  const remember = async (path: string) => {
    if (originals.has(path)) return;
    const sha = await repo.blobShaAt(head, path);
    originals.set(path, sha ? await repo.readBlob(sha) : null);
  };
  const writer = {
    ...repo,
    ensureFolder: async (path: string) => {
      await remember(`${path}/.gitkeep`);
      await repo.ensureFolder(path);
    },
    writeFileAtomic: async (path: string, text: string) => {
      await remember(path);
      await repo.writeFileAtomic(path, text);
    },
    writeBinaryFileAtomic: async (path: string, bytes: Uint8Array) => {
      await remember(path);
      await repo.writeBinaryFileAtomic(path, bytes);
    },
  };
  try {
    for (const [path, bytes] of pending)
      await writer.writeBinaryFileAtomic(path, bytes);
    return await write(writer);
  } catch (error) {
    if ((await repo.resolveHead()) !== head) throw error;
    for (const [path, bytes] of originals)
      if (bytes !== null) await repo.writeBinaryFileAtomic(path, bytes);
    await repo.resetWorktreeTo(head);
    for (const [path, bytes] of originals)
      if (bytes === null) await repo.removeUntrackedFile(path);
    throw error;
  }
}

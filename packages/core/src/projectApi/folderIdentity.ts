import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { ProjectRepoReader, ProjectRepoWriter } from "@weaver/git-store";
import {
  composeFolderMetadata,
  parseFolderMetadata,
} from "../documents/folderMetadata";
import { assertSafeSegments } from "../documents/paths";
import { assertOutsideTablesRoot } from "../tables/paths";
import { CoreError } from "../errors";
import { listScopeDirsAt, type FolderScope } from "../services/folders";
import type { EnrichedActor } from "../services/documents";
import { MACHINE_UUID_RE } from "./constants";

export type FolderIdentityEntry = { id: string; path: string[]; name: string };
export type FolderIdentityIndex = {
  entries: readonly FolderIdentityEntry[];
  byId: ReadonlyMap<string, FolderIdentityEntry>;
  invalidIds: ReadonlySet<string>;
};
const cache = new Map<string, FolderIdentityIndex>();
const MAX_FOLDERS = 10_000;
const METADATA_MAX_BYTES = 64 * 1024;
const metadataPath = (scope: FolderScope, path: string) =>
  `${scope === "tables" ? "tables/" : ""}${path}/.folder.json`;

export async function loadFolderIdentityIndex(
  repo: ProjectRepoReader,
  projectId: string,
  scope: FolderScope,
  commitSha: string,
): Promise<FolderIdentityIndex> {
  const key = `${projectId}:${scope}:${commitSha}`;
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const dirs = await listScopeDirsAt(repo, scope, commitSha);
  if (dirs.length > MAX_FOLDERS)
    throw new CoreError(
      "PRECONDITION_FAILED",
      "Too many folders to resolve project API grants",
    );
  const byId = new Map<string, FolderIdentityEntry>();
  const invalidIds = new Set<string>();
  for (let offset = 0; offset < dirs.length; offset += 256) {
    const chunk = dirs.slice(offset, offset + 256);
    const blobs = await repo.readBlobsAt(
      commitSha,
      chunk.map((path) => metadataPath(scope, path)),
      METADATA_MAX_BYTES,
    );
    for (const path of chunk) {
      const text = blobs.get(metadataPath(scope, path));
      if (text === undefined) continue;
      const meta = parseFolderMetadata(text);
      let rawId: unknown;
      try {
        rawId = (JSON.parse(text) as { id?: unknown })?.id;
      } catch {
        continue;
      }
      if (typeof rawId !== "string" || !MACHINE_UUID_RE.test(rawId)) continue;
      if (!meta?.id || byId.has(rawId)) {
        invalidIds.add(rawId);
        continue;
      }
      const segments = path.split("/");
      try {
        assertSafeSegments(segments);
      } catch {
        invalidIds.add(rawId);
        continue;
      }
      byId.set(rawId, { id: rawId, path: segments, name: meta.name });
    }
  }
  for (const id of invalidIds) byId.delete(id);
  const index: FolderIdentityIndex = {
    entries: [...byId.values()],
    byId,
    invalidIds,
  };
  cache.set(key, index);
  if (cache.size > 16) cache.delete(cache.keys().next().value!);
  return index;
}

export async function ensureFolderIdentityInRepo(
  repo: ProjectRepoWriter,
  scope: FolderScope,
  path: string[],
  actor: EnrichedActor,
): Promise<{ id: string; path: string[]; commitSha: string }> {
  try {
    assertSafeSegments(path);
    if (scope === "documents") assertOutsideTablesRoot(path);
  } catch {
    throw new CoreError("BAD_REQUEST", "Invalid folder path", {
      field: "grants",
    });
  }
  if (path.length === 0)
    throw new CoreError("BAD_REQUEST", "Use the explicit scope root");
  const commitSha = await repo.resolveHead();
  const rel = path.join("/");
  if (!(await listScopeDirsAt(repo, scope, commitSha)).includes(rel))
    throw new CoreError("NOT_FOUND");
  const file = metadataPath(scope, rel);
  const text = (
    await repo.readBlobsAt(commitSha, [file], METADATA_MAX_BYTES)
  ).get(file);
  if (text === undefined && (await repo.blobShaAt(commitSha, file)))
    throw new CoreError(
      "PRECONDITION_FAILED",
      "Folder metadata is unavailable",
    );
  const meta = text === undefined ? null : parseFolderMetadata(text);
  if (text !== undefined && !meta)
    throw new CoreError("PRECONDITION_FAILED", "Folder metadata is malformed");
  if (meta?.id) {
    const index = await loadFolderIdentityIndex(
      repo,
      basename(repo.dir),
      scope,
      commitSha,
    );
    if (!index.byId.has(meta.id))
      throw new CoreError(
        "PRECONDITION_FAILED",
        "Folder identity is ambiguous",
      );
    return { id: meta.id, path, commitSha };
  }
  const id = randomUUID();
  await repo.writeFileAtomic(
    file,
    composeFolderMetadata({
      ...(meta ?? {
        name: path.at(-1)!,
        created: null,
        createdBy: null,
        updated: null,
        updatedBy: null,
      }),
      id,
    }),
  );
  const sha = await repo.commitAll(
    `chore: assign folder identity ${scope}/${rel}`,
    { name: actor.name, email: actor.email, userId: actor.userId },
  );
  return { id, path, commitSha: sha };
}

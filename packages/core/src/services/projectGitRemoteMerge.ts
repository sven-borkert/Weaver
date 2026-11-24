import { captureError } from "../diagnostics/writer";
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@weaver/db/client";
import type { CommitAuthor, ProjectRepoWriter } from "@weaver/git-store";
import { GitRemoteError } from "@weaver/git-store/remote";
import {
  composeDocumentFile,
  parseDocumentFile,
} from "@weaver/core/documents/frontmatter";
import { composeFolderMetadata } from "@weaver/core/documents/folderMetadata";
import {
  assertSafeSegments,
  docPath,
  folderPathOfDocPath,
} from "@weaver/core/documents/paths";
import {
  assetsDirForDocPath,
  hasAssetsSegment,
  rewriteOwnAssetsPrefix,
} from "@weaver/core/documents/images";
import {
  documentFileStem,
  documentKindFromPath,
  documentKindOfPath,
  type DocumentKind,
} from "@weaver/core/documents/kinds";
import { slugify } from "@weaver/core/documents/slug";
import {
  parseDocumentBody,
  serializeDocumentBody,
} from "@weaver/core/editor/markdown";
import {
  parseSchemaFile,
  serializeSchemaFile,
} from "@weaver/core/tables/jsonl";
import {
  TABLE_DIR_SUFFIX,
  TABLES_ROOT,
  folderPathOfTableDir,
  isTableDirName,
  tableDirPath,
  slugFromTableDir,
  tableSlugWithSuffix,
} from "@weaver/core/tables/paths";
import { documentSlugFromPath } from "./documents";
import { listScopeDirsAt, readFolderMetadataAt } from "./folders";
import {
  composeProjectMetadataFor,
  PROJECT_METADATA_PATH,
} from "./projectMetadata";
import {
  lockUntracked,
  moveUntrackedPrefix,
  reslugUntrackedDocument,
  untrackedSlugTaken,
} from "./untrackedDocuments";

export function hasCaseCollidingPaths(paths: Iterable<string>): boolean {
  const seen = new Map<string, string>();
  for (const file of paths) {
    const segments = file.split("/");
    for (let end = 1; end <= segments.length; end++) {
      const prefix = segments.slice(0, end).join("/");
      const folded = prefix.normalize("NFC").toLowerCase();
      const previous = seen.get(folded);
      if (previous !== undefined && previous !== prefix) return true;
      seen.set(folded, prefix);
    }
  }
  return false;
}

/** Temporary ref the fetched remote branch is fetched into for the merge. */
const PULL_REF = "refs/weaver/pull";

export type MergeOutcome = {
  mergedSha: string;
  remoteHead: string;
  fastForward: boolean;
  /** One entry per local document/table moved to a free path because the
   * remote had different content (a different id) at its original path, or
   * because the remote carries the same id at another path (I3). */
  reslugged: Array<{
    kind: "document" | "table";
    from: string;
    to: string;
    /** The local copy also received a fresh id: the remote owns that id at a
     * different path, and two rows with one id are unreachable after
     * rebuild. */
    reassignedId?: boolean;
  }>;
};

function documentIdentity(path: string, text: string): string | null {
  try {
    return parseDocumentFile(text, documentKindOfPath(path)).meta.id;
  } catch {
    return null;
  }
}

function tableIdentity(text: string): string | null {
  try {
    return parseSchemaFile(text).id;
  } catch {
    return null;
  }
}

function tableDirFor(p: string): string | null {
  if (!p.startsWith(`${TABLES_ROOT}/`)) return null;
  if (p.endsWith("/schema.json")) return p.slice(0, -"/schema.json".length);
  if (p.endsWith("/data.jsonl")) return p.slice(0, -"/data.jsonl".length);
  return null;
}

/** Every proper ancestor directory of every path, e.g. "a/b/c" contributes
 * "a" and "a/b". `listTrackedFiles` (ls-tree) never lists a bare directory
 * entry, so a taken-set built only from file paths can never notice that a
 * candidate `<slug>.assets`/`<slug>.table` directory already has content in
 * one of the trees (C6). */
function collectDirPrefixes(paths: Iterable<string>): Set<string> {
  const dirs = new Set<string>();
  for (const p of paths) {
    const segments = p.split("/");
    for (let i = 1; i < segments.length; i++) {
      dirs.add(segments.slice(0, i).join("/"));
    }
  }
  return dirs;
}

/** A candidate path is taken when it — or anything under it — already
 * exists in either tree, or was already claimed earlier in this run. */
function isTaken(
  candidate: string,
  taken: ReadonlySet<string>,
  takenDirs: ReadonlySet<string>,
): boolean {
  return taken.has(candidate) || takenDirs.has(candidate);
}

/** Slugs are unique project-wide, so a slug held in any folder of either tree
 * blocks a re-slug target. Plain string handling: non-canonical remote paths
 * must not throw here (I6). */
function collectDocumentSlugs(paths: Iterable<string>): Set<string> {
  const slugs = new Set<string>();
  for (const p of paths) {
    const kind = documentKindFromPath(p);
    if (kind === null || p.startsWith(`${TABLES_ROOT}/`)) continue;
    if (hasAssetsSegment(p)) continue;
    slugs.add(documentFileStem(p));
  }
  return slugs;
}

/** Plain-string slug of a document path; never throws on non-canonical paths. */
function plainDocumentSlug(p: string): string {
  return documentFileStem(p);
}

function plainTableSlug(dir: string): string {
  return dir.slice(dir.lastIndexOf("/") + 1, -TABLE_DIR_SUFFIX.length);
}

function collectTableSlugs(dirs: Iterable<string>): Set<string> {
  const slugs = new Set<string>();
  for (const dir of dirs) {
    if (!dir.startsWith(`${TABLES_ROOT}/`) || !dir.endsWith(TABLE_DIR_SUFFIX))
      continue;
    slugs.add(dir.slice(dir.lastIndexOf("/") + 1, -TABLE_DIR_SUFFIX.length));
  }
  return slugs;
}

/** Every file phase A actually moved to a re-slug target, read back from
 * `baseFiles` (the fresh tracked-file listing at `baseHead`). Restoring
 * these unconditionally — not only when the remote happens to lack the
 * path — is the defense-in-depth half of the C6 fix: even a residual
 * taken-set collision this function's caller failed to anticipate can
 * never silently drop moved local content in phase B. */
function reslugTargetPaths(
  reslugged: MergeOutcome["reslugged"],
  baseFiles: readonly string[],
): string[] {
  const result: string[] = [];
  for (const r of reslugged) {
    if (r.kind === "table") {
      const prefix = `${r.to}/`;
      result.push(...baseFiles.filter((p) => p.startsWith(prefix)));
    } else {
      const assetsPrefix = `${assetsDirForDocPath(r.to)}/`;
      result.push(
        ...baseFiles.filter((p) => p === r.to || p.startsWith(assetsPrefix)),
      );
    }
  }
  return result;
}

async function writeMetadata(
  db: PrismaClient | Prisma.TransactionClient,
  repo: ProjectRepoWriter,
  projectId: string,
): Promise<void> {
  const content = await composeProjectMetadataFor(db, projectId);
  if (content) await repo.writeFileAtomic(PROJECT_METADATA_PATH, content);
}

/** Next free document path for a re-slug, checked against an explicit
 * taken-set (remote paths + local paths + paths already claimed earlier in
 * this run) rather than worktree state, which does not reflect both trees
 * at once during phase A (see mergeFetchedBranch). A candidate is rejected
 * both as a file (`<slug>.md`) and as a directory prefix (`<slug>.assets/…`
 * already has content in either tree, even without a matching `.md`) — C6.
 * The slug must also be free in every folder: rebuild drops a duplicate. */
async function nextFreeDocumentPath(
  db: PrismaClient | Prisma.TransactionClient,
  projectId: string,
  title: string,
  folder: string[],
  kind: DocumentKind,
  taken: ReadonlySet<string>,
  takenDirs: ReadonlySet<string>,
  takenSlugs: ReadonlySet<string>,
): Promise<{ slug: string; path: string }> {
  const base = slugify(title);
  for (let i = 1; i < 1000; i++) {
    const suffix = i === 1 ? "" : `-${i}`;
    const slug = `${base.slice(0, 80 - suffix.length).replace(/-+$/g, "")}${suffix}`;
    if (takenSlugs.has(slug)) continue;
    const path = docPath(folder, slug, kind);
    if (isTaken(path, taken, takenDirs)) continue;
    if (isTaken(assetsDirForDocPath(path), taken, takenDirs)) continue;
    const row = await db.document.findFirst({
      where: { projectId, slug },
      select: { id: true },
    });
    if (row) continue;
    if (await untrackedSlugTaken(db, projectId, slug)) continue;
    return { slug, path };
  }
  throw new Error("no available document slug");
}

/** Next free table directory for a re-slug; same taken-set contract as
 * nextFreeDocumentPath (including the directory-prefix check — C6) and the
 * same project-wide slug uniqueness. */
async function nextFreeTableDir(
  db: PrismaClient | Prisma.TransactionClient,
  projectId: string,
  baseSlug: string,
  folder: string[],
  taken: ReadonlySet<string>,
  takenDirs: ReadonlySet<string>,
  takenSlugs: ReadonlySet<string>,
): Promise<{ slug: string; dir: string }> {
  for (let i = 2; i < 1000; i++) {
    const slug = tableSlugWithSuffix(baseSlug, i);
    if (takenSlugs.has(slug)) continue;
    const dir = tableDirPath(folder, slug);
    if (isTaken(dir, taken, takenDirs)) continue;
    const row = await db.dataTable.findFirst({
      where: { projectId, slug },
      select: { id: true },
    });
    if (row) continue;
    return { slug, dir };
  }
  throw new Error("no available table slug");
}

type PreparedContent = {
  /** Sha of the single-parent "prepare" commit re-slugging local content on
   * top of localHead, or null when nothing needed re-slugging. */
  preparedHead: string | null;
  /** preparedHead when it exists, else localHead unchanged. */
  baseHead: string;
  reslugged: MergeOutcome["reslugged"];
  /** Paths where the remote has the same path but local content must win
   * (same Weaver id): restored explicitly in phase B since "remote lacks
   * the path" does not apply to them. */
  keepLocal: string[];
};

/**
 * Phase A (R1): with the worktree still at localHead, compares every local
 * document/table against the fetched remote tree by content id (not by
 * path) and re-slugs the local copy onto a free path when the ids differ.
 * Files without a parseable Weaver id are never re-slugged (R2) — the
 * remote simply wins that path in phase B, and the local copy stays
 * reachable through localHead's own history. Re-slugged content (including
 * its `<slug>.assets/` directory or full `.table` directory, moved with
 * `repo.mv`) is committed as a single-parent "prepare" commit so phase B's
 * restore-from-baseHead reads (and any later read of the merge result) are
 * ordinary, discoverable git history rather than paths introduced only by a
 * multi-parent commit.
 */
async function prepareLocalContent(
  db: PrismaClient | Prisma.TransactionClient,
  repo: ProjectRepoWriter,
  projectId: string,
  localHead: string,
  branch: string,
  author: CommitAuthor,
  /** True when localHead is an ancestor of the remote head: every local blob
   * is already contained in remote history, so an id the remote carries at
   * another path is the remote's own rename of that same content, not a
   * divergent second copy. The remote copy then wins outright — neither a
   * re-slug nor a new id, which would duplicate that id in the merged tree. */
  remoteContainsLocal: boolean,
  ancestor: string | null,
): Promise<PreparedContent> {
  const remoteFiles = new Set(await repo.listTrackedFiles(PULL_REF));
  const localFiles = (await repo.listTrackedFiles(localHead)).filter(
    (p) => p !== PROJECT_METADATA_PATH,
  );
  const localFileSet = new Set(localFiles);
  const baseBlobs = new Map(
    (ancestor ? await repo.listTrackedBlobs(ancestor) : []).map((blob) => [
      blob.path,
      blob.sha,
    ]),
  );
  const localBlobs = new Map(
    (await repo.listTrackedBlobs(localHead)).map((blob) => [
      blob.path,
      blob.sha,
    ]),
  );
  const remoteBlobs = new Map(
    (await repo.listTrackedBlobs(PULL_REF)).map((blob) => [
      blob.path,
      blob.sha,
    ]),
  );
  const unchanged = (paths: string[], blobs: Map<string, string>) =>
    paths.every((p) => blobs.get(p) === baseBlobs.get(p));

  // Documents: decide per document file outside tables/ and outside *.assets/.
  const documentPaths = localFiles.filter(
    (p) =>
      documentKindFromPath(p) !== null &&
      !p.startsWith(`${TABLES_ROOT}/`) &&
      !hasAssetsSegment(p),
  );
  // Tables: decide per tables/**/<slug>.table directory.
  const tableDirs = new Set<string>();
  for (const p of localFiles) {
    const dir = tableDirFor(p);
    if (dir && isTableDirName(dir.split("/").at(-1)!)) tableDirs.add(dir);
  }
  const remoteContentPaths = [...remoteFiles].filter((p) => {
    if (p === PROJECT_METADATA_PATH) return false;
    if (documentKindFromPath(p) !== null)
      return !p.startsWith(`${TABLES_ROOT}/`) && !hasAssetsSegment(p);
    const dir = tableDirFor(p);
    return (
      !!dir &&
      p.endsWith("/schema.json") &&
      isTableDirName(dir.split("/").at(-1)!)
    );
  });
  // One batched read per tree: a per-file `git show` over a few thousand
  // documents can outlast the caller's lease (I2).
  const remoteText = await repo.readBlobsAt(PULL_REF, remoteContentPaths);
  const localText = await repo.readBlobsAt(localHead, [
    ...documentPaths,
    ...[...tableDirs].map((dir) => `${dir}/schema.json`),
  ]);

  // I3: the remote may hold a local id at another path (a rename pushed from
  // elsewhere). Keeping both copies with one id makes rebuild drop one as a
  // duplicate, so the whole remote tree is indexed by id, not only the
  // colliding paths.
  const baseText = ancestor
    ? await repo.readBlobsAt(
        ancestor,
        [...baseBlobs.keys()].filter(
          (p) => documentKindFromPath(p) !== null || p.endsWith("/schema.json"),
        ),
      )
    : new Map<string, string>();
  const baseDocumentIds = new Map<string, string>();
  const baseTableIds = new Map<string, string>();
  for (const [file, text] of baseText) {
    const isDocument = documentKindFromPath(file) !== null;
    const id = isDocument ? documentIdentity(file, text) : tableIdentity(text);
    if (id)
      (isDocument ? baseDocumentIds : baseTableIds).set(
        id,
        isDocument ? file : tableDirFor(file)!,
      );
  }
  const remoteDocumentIds = new Map<string, string>();
  const remoteTableIds = new Map<string, string>();
  // Slug → id of the remote item holding it: a local-only path whose slug an
  // unrelated remote item already holds must be re-slugged, or rebuild drops
  // one of the two projections (FIX-DOC-04).
  const remoteDocumentSlugHolder = new Map<string, string>();
  const remoteTableSlugHolder = new Map<string, string>();
  for (const p of remoteContentPaths) {
    const text = remoteText.get(p);
    if (text === undefined) continue;
    if (documentKindFromPath(p) !== null) {
      const id = documentIdentity(p, text);
      if (id !== null && !remoteDocumentIds.has(id))
        remoteDocumentIds.set(id, p);
      if (id !== null) {
        const slug = plainDocumentSlug(p);
        if (!remoteDocumentSlugHolder.has(slug))
          remoteDocumentSlugHolder.set(slug, id);
      }
      continue;
    }
    const id = tableIdentity(text);
    const dir = tableDirFor(p)!;
    if (id !== null && !remoteTableIds.has(id)) remoteTableIds.set(id, dir);
    if (id !== null) {
      const slug = plainTableSlug(dir);
      if (!remoteTableSlugHolder.has(slug)) remoteTableSlugHolder.set(slug, id);
    }
  }
  const slugHeldByOther = (
    holders: ReadonlyMap<string, string>,
    slug: string,
    localId: string,
  ): boolean => {
    const holder = holders.get(slug);
    return holder !== undefined && holder !== localId;
  };

  const taken = new Set<string>([...remoteFiles, ...localFiles]);
  const takenDirs = collectDirPrefixes(taken);
  const takenDocSlugs = collectDocumentSlugs(taken);
  const takenTableSlugs = collectTableSlugs(takenDirs);
  const reslugged: MergeOutcome["reslugged"] = [];
  const keepLocal: string[] = [];

  for (const p of documentPaths) {
    const text = localText.get(p);
    if (text === undefined) continue; // Unreadable: treated as non-Weaver (R2).
    const localId = documentIdentity(p, text);
    if (localId === null) continue; // R2: not Weaver content, never re-slug.
    const remoteIdPath = remoteDocumentIds.get(localId);
    const idMovedRemotely = remoteIdPath !== undefined && remoteIdPath !== p;
    // R3: the local head is already contained in remote history, so a moved
    // id is the remote's own rename of this very content — the remote wins
    // the path and re-slugging would only duplicate that id.
    if (remoteContainsLocal && idMovedRemotely) continue;
    const ownPaths = [
      ...new Set([
        ...baseBlobs.keys(),
        ...localBlobs.keys(),
        ...remoteBlobs.keys(),
      ]),
    ].filter(
      (file) => file === p || file.startsWith(`${assetsDirForDocPath(p)}/`),
    );
    if (ancestor && unchanged(ownPaths, localBlobs)) continue;
    const basePath = baseDocumentIds.get(localId);
    const remotePaths = basePath
      ? [...new Set([...baseBlobs.keys(), ...remoteBlobs.keys()])].filter(
          (file) =>
            file === basePath ||
            file.startsWith(`${assetsDirForDocPath(basePath)}/`),
        )
      : [];
    const remoteUnchanged =
      basePath !== undefined &&
      remoteIdPath === basePath &&
      unchanged(remotePaths, remoteBlobs);
    const sameIdConflict =
      remoteIdPath !== undefined &&
      !remoteUnchanged &&
      !remoteContainsLocal &&
      ownPaths.some((file) => localBlobs.get(file) !== remoteBlobs.get(file));
    const reassignId = (idMovedRemotely && !remoteUnchanged) || sameIdConflict;
    // An uncontested local path still needs a new slug when an unrelated
    // remote item holds that slug elsewhere; under R3 the remote tree is
    // authoritative for local paths, so only a divergent local side moves.
    const slugCollides =
      !remoteContainsLocal &&
      slugHeldByOther(remoteDocumentSlugHolder, plainDocumentSlug(p), localId);
    // Phase B restores an uncontested path untouched.
    if (!remoteFiles.has(p) && !reassignId && !slugCollides) continue;

    const assetsDir = assetsDirForDocPath(p);
    const assetPaths = localFiles.filter((f) => f.startsWith(`${assetsDir}/`));
    if (remoteFiles.has(p) && !reassignId) {
      const remoteId = documentIdentity(p, remoteText.get(p) ?? "");
      if (localId === remoteId) {
        keepLocal.push(p, ...assetPaths);
        continue;
      }
    }

    // Known to parse: documentIdentity(text) !== null above.
    const kind = documentKindOfPath(p);
    const localParsed = parseDocumentFile(text, kind);
    // I6/R2: a parseable Weaver document at a non-canonical path (e.g. a
    // remote-authored `Docs/Notes.md`) must never abort the whole merge —
    // a path-shape failure here falls back to "remote wins, no re-slug"
    // exactly like an unparseable file. I7: only the pure, synchronous
    // path-shape computation is guarded — a transient `nextFreeDocumentPath`
    // DB failure or slug-space exhaustion must propagate, not be silently
    // downgraded to "remote wins" and lose the local document.
    let oldSlug: string;
    try {
      oldSlug = documentSlugFromPath(p);
      assertSafeSegments(folderPathOfDocPath(p));
    } catch {
      continue;
    }
    const { slug, path } = await nextFreeDocumentPath(
      db,
      projectId,
      localParsed.meta.title,
      folderPathOfDocPath(p),
      kind,
      taken,
      takenDirs,
      takenDocSlugs,
    );
    taken.add(path);
    takenDocSlugs.add(slug);
    takenDirs.add(assetsDirForDocPath(path));
    const rewriteAssets =
      kind === "markdown" && localParsed.body.includes(`${oldSlug}.assets/`);
    if (rewriteAssets || reassignId) {
      const composed = composeDocumentFile(
        reassignId
          ? { ...localParsed.meta, id: randomUUID() }
          : localParsed.meta,
        rewriteAssets
          ? serializeDocumentBody(
              rewriteOwnAssetsPrefix(
                parseDocumentBody(localParsed.body),
                oldSlug,
                slug,
              ),
            )
          : localParsed.body,
        kind,
      );
      await repo.writeFileAtomic(path, composed);
      await repo.rm(p);
    } else {
      // No self-referencing asset link: move the file verbatim rather than
      // round-tripping markdown <-> tiptap for content that doesn't need it.
      await repo.mv(p, path);
    }
    if (assetPaths.length > 0) {
      await repo.mv(assetsDir, assetsDirForDocPath(path));
    }
    reslugged.push({
      kind: "document",
      from: p,
      to: path,
      ...(reassignId ? { reassignedId: true } : {}),
    });
  }

  for (const dir of tableDirs) {
    const schemaPath = `${dir}/schema.json`;
    if (!localFileSet.has(schemaPath)) continue; // No local schema to compare.
    const localSchemaText = localText.get(schemaPath);
    if (localSchemaText === undefined) continue;
    const localId = tableIdentity(localSchemaText);
    if (localId === null) continue; // R2: not Weaver content, never re-slug.
    const remoteIdDir = remoteTableIds.get(localId);
    const idMovedRemotely = remoteIdDir !== undefined && remoteIdDir !== dir;
    // R3: same containment reasoning as for documents above.
    if (remoteContainsLocal && idMovedRemotely) continue;
    const ownPaths = [
      ...new Set([
        ...baseBlobs.keys(),
        ...localBlobs.keys(),
        ...remoteBlobs.keys(),
      ]),
    ].filter((file) => file.startsWith(`${dir}/`));
    if (ancestor && unchanged(ownPaths, localBlobs)) continue;
    const baseDir = baseTableIds.get(localId);
    const remotePaths = baseDir
      ? [...new Set([...baseBlobs.keys(), ...remoteBlobs.keys()])].filter(
          (file) => file.startsWith(`${baseDir}/`),
        )
      : [];
    const remoteUnchanged =
      baseDir !== undefined &&
      remoteIdDir === baseDir &&
      unchanged(remotePaths, remoteBlobs);
    const sameIdConflict =
      remoteIdDir !== undefined &&
      !remoteUnchanged &&
      !remoteContainsLocal &&
      ownPaths.some((file) => localBlobs.get(file) !== remoteBlobs.get(file));
    const reassignId = (idMovedRemotely && !remoteUnchanged) || sameIdConflict;
    const slugCollides =
      !remoteContainsLocal &&
      slugHeldByOther(remoteTableSlugHolder, plainTableSlug(dir), localId);
    // Remote lacks the dir entirely: phase B restores it untouched.
    if (!remoteFiles.has(schemaPath) && !reassignId && !slugCollides) continue;

    const filesInDir = localFiles.filter((f) => f.startsWith(`${dir}/`));
    if (remoteFiles.has(schemaPath) && !reassignId) {
      const remoteId = tableIdentity(remoteText.get(schemaPath) ?? "");
      if (localId === remoteId) {
        keepLocal.push(...filesInDir);
        continue;
      }
    }

    // I6/R2: same fallback as documents — a non-canonical remote-authored
    // folder segment must never abort the merge. I7: `slugFromTableDir`
    // only validates the leaf directory name, so the folder segments are
    // checked explicitly here; `nextFreeTableDir` itself runs outside this
    // guard so its DB lookups and slug-space exhaustion still propagate.
    let slug: string;
    try {
      slug = slugFromTableDir(dir.split("/").at(-1)!);
      assertSafeSegments(folderPathOfTableDir(dir));
    } catch {
      continue;
    }
    const { slug: newSlug, dir: newDir } = await nextFreeTableDir(
      db,
      projectId,
      slug,
      folderPathOfTableDir(dir),
      taken,
      takenDirs,
      takenTableSlugs,
    );
    taken.add(newDir);
    takenTableSlugs.add(newSlug);
    takenDirs.add(newDir);
    await repo.mv(dir, newDir); // M3: move the whole directory, not just the two known files.
    if (reassignId) {
      // Known to parse: tableIdentity(localSchemaText) !== null above.
      const schema = parseSchemaFile(localSchemaText);
      await repo.writeFileAtomic(
        `${newDir}/schema.json`,
        serializeSchemaFile({ ...schema, id: randomUUID() }),
      );
    }
    reslugged.push({
      kind: "table",
      from: dir,
      to: newDir,
      ...(reassignId ? { reassignedId: true } : {}),
    });
  }

  if (reslugged.length === 0) {
    return { preparedHead: null, baseHead: localHead, reslugged, keepLocal };
  }
  const preparedHead = await repo.createTreeCommit(
    `pull: prepare local content for ${branch}`,
    author,
    [localHead],
  );
  return { preparedHead, baseHead: preparedHead, reslugged, keepLocal };
}

function parentDir(dir: string): string {
  return dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
}

/** A sibling of `dir` that neither tree nor the untracked store uses yet. */
function freeSiblingDir(dir: string, taken: (candidate: string) => boolean) {
  const parent = parentDir(dir);
  const base = dir.slice(parent ? parent.length + 1 : 0);
  for (let i = 2; i < 1000; i++) {
    const suffix = `-${i}`;
    const name = `${base.slice(0, 80 - suffix.length).replace(/-+$/g, "")}${suffix}`;
    const candidate = parent ? `${parent}/${name}` : name;
    if (!taken(candidate)) return candidate;
  }
  throw new Error("no available folder path");
}

/** Moves every untracked folder that pulled Git content now occupies to a
 * free sibling path, with everything below it. Remote content wins the path
 * as for tracked content (R1), and the folder stays out of Git: dropping its
 * row instead would turn it into a Git folder whose next documents are
 * committed and pushed. Its display name is kept, like a re-slugged
 * document's title. */
async function moveUntrackedFoldersOffPulledContent(
  db: PrismaClient | Prisma.TransactionClient,
  projectId: string,
  mergedFiles: readonly string[],
  mergedDirs: ReadonlySet<string>,
): Promise<void> {
  const folders = (
    await db.untrackedFolder.findMany({
      where: { projectId },
      select: { path: true },
      orderBy: { path: "asc" },
    })
  ).map((folder) => folder.path);
  if (!folders.some((folder) => mergedDirs.has(folder))) return;
  const documents = (
    await db.untrackedDocument.findMany({
      where: { projectId },
      select: { path: true },
    })
  ).map((document) => document.path);
  const folderPaths = new Set(folders);
  const files = [...mergedFiles, ...documents];
  const taken = (candidate: string) =>
    mergedDirs.has(candidate) ||
    folderPaths.has(candidate) ||
    files.some(
      (file) =>
        file === candidate ||
        file.startsWith(`${candidate}/`) ||
        file.startsWith(`${candidate}.`),
    );
  const moved: string[] = [];
  // Ascending order visits a folder before its subfolders, which move with it.
  for (const folder of folders) {
    if (!mergedDirs.has(folder)) continue;
    if (moved.some((parent) => folder.startsWith(`${parent}/`))) continue;
    const target = freeSiblingDir(folder, taken);
    await db.untrackedFolder.update({
      where: { projectId_path: { projectId, path: folder } },
      data: { path: target },
    });
    await moveUntrackedPrefix(db, projectId, folder, target);
    folderPaths.add(target);
    moved.push(folder);
  }
}

/** Untracked rows hang below tracked folders by path alone. For each
 * tracked folder that holds untracked content and is gone from the pulled
 * tree, the content follows the folder's id (kept in `.folder.json`) to its
 * new path. A folder the remote deleted, or one without an id, is kept as a
 * folder outside Git at its resolved path: the untracked content was never
 * shared, so it stays reachable instead of hanging below a folder that no
 * longer exists, and nothing is committed back over the remote's delete. */
async function carryUntrackedContentAlong(
  db: PrismaClient | Prisma.TransactionClient,
  repo: ProjectRepoWriter,
  projectId: string,
  localHead: string,
  mergedSha: string,
  mergedDirs: ReadonlySet<string>,
): Promise<void> {
  const [folders, documents] = await Promise.all([
    db.untrackedFolder.findMany({
      where: { projectId },
      select: { path: true },
    }),
    db.untrackedDocument.findMany({
      where: { projectId },
      select: { path: true },
    }),
  ]);
  const untrackedFolders = new Set(folders.map((folder) => folder.path));
  const anchors = new Set<string>();
  for (const container of [
    ...folders.map((folder) => folder.path),
    ...documents.map((document) => parentDir(document.path)),
  ]) {
    // The deepest tracked folder above the content; untracked folders move with it.
    let anchor = container;
    while (anchor && untrackedFolders.has(anchor)) anchor = parentDir(anchor);
    if (anchor && !mergedDirs.has(anchor)) anchors.add(anchor);
  }
  if (anchors.size === 0) return;

  const chain = new Set<string>();
  for (const anchor of anchors)
    for (let dir = anchor; dir; dir = parentDir(dir)) chain.add(dir);
  const localMetadata = await readFolderMetadataAt(
    repo,
    "documents",
    localHead,
    [...chain],
  );
  const mergedMetadata = await readFolderMetadataAt(
    repo,
    "documents",
    mergedSha,
    await listScopeDirsAt(repo, "documents", mergedSha),
  );
  const pulledById = new Map<string, string>();
  for (const [dir, meta] of Object.entries(mergedMetadata))
    if (meta.id && !pulledById.has(meta.id)) pulledById.set(meta.id, dir);

  const resolved = new Map<string, string>();
  const keptOutside = new Map<string, string>();
  const resolve = (dir: string): string => {
    if (!dir || mergedDirs.has(dir)) return dir;
    const known = resolved.get(dir);
    if (known !== undefined) return known;
    const id = localMetadata[dir]?.id;
    let target = id ? pulledById.get(id) : undefined;
    if (target === undefined) {
      const parent = resolve(parentDir(dir));
      const name = dir.slice(dir.lastIndexOf("/") + 1);
      target = parent ? `${parent}/${name}` : name;
      if (!mergedDirs.has(target)) keptOutside.set(target, dir);
    }
    resolved.set(dir, target);
    return target;
  };
  // Deepest first: a subfolder the remote moved elsewhere must not travel
  // with its parent's prefix.
  const ordered = [...anchors].sort(
    (a, b) => b.split("/").length - a.split("/").length,
  );
  for (const anchor of ordered) {
    const target = resolve(anchor);
    if (target !== anchor)
      await moveUntrackedPrefix(db, projectId, anchor, target);
  }
  const created = [...keptOutside].sort(
    ([a], [b]) => a.split("/").length - b.split("/").length,
  );
  for (const [path, source] of created) {
    const metadata = composeFolderMetadata(
      localMetadata[source] ?? {
        name: path.slice(path.lastIndexOf("/") + 1),
        created: null,
        createdBy: null,
        updated: null,
        updatedBy: null,
      },
    );
    await db.untrackedFolder.upsert({
      where: { projectId_path: { projectId, path } },
      create: { projectId, path, metadata },
      update: {},
    });
  }
}

/** Slugs are unique across both stores, and a pulled document cannot be
 * renamed without diverging from the remote, so an untracked document whose
 * slug pulled content now holds moves to a free slug with its images. */
async function reslugUntrackedDocumentsOffPulledSlugs(
  db: PrismaClient | Prisma.TransactionClient,
  projectId: string,
  mergedFiles: readonly string[],
): Promise<void> {
  const documents = await db.untrackedDocument.findMany({
    where: { projectId },
    select: { id: true, path: true, slug: true, kind: true, title: true },
    orderBy: { path: "asc" },
  });
  const trackedSlugs = collectDocumentSlugs(mergedFiles);
  const colliding = documents.filter((document) =>
    trackedSlugs.has(document.slug),
  );
  if (colliding.length === 0) return;
  const files = await db.untrackedFile.findMany({
    where: { projectId },
    select: { path: true },
  });
  const taken = new Set([
    ...mergedFiles,
    ...documents.map((document) => document.path),
    ...files.map((file) => file.path),
  ]);
  const takenDirs = collectDirPrefixes(taken);
  const takenSlugs = new Set([
    ...trackedSlugs,
    ...documents.map((document) => document.slug),
  ]);
  for (const document of colliding) {
    const { slug, path } = await nextFreeDocumentPath(
      db,
      projectId,
      document.title,
      folderPathOfDocPath(document.path),
      document.kind,
      taken,
      takenDirs,
      takenSlugs,
    );
    await reslugUntrackedDocument(db, projectId, document.id, slug);
    taken.add(path);
    takenSlugs.add(slug);
    takenDirs.add(assetsDirForDocPath(path));
  }
}

/**
 * Brings content kept out of Git in line with the tree a pull is about to
 * publish (`mergedSha`, not yet HEAD), so a failure leaves both unchanged.
 * Runs in the caller's transaction; the untracked write lock held from here
 * to its commit keeps untracked writes from validating against the old tree
 * and writing old paths back.
 */
async function followPulledTree(
  db: PrismaClient | Prisma.TransactionClient,
  repo: ProjectRepoWriter,
  projectId: string,
  localHead: string,
  mergedSha: string,
): Promise<void> {
  await lockUntracked(db, projectId);
  const mergedFiles = await repo.listTrackedFiles(mergedSha);
  const mergedDirs = collectDirPrefixes(mergedFiles);
  // Before the carry-along too: content carried onto a pulled folder path
  // must not be swept aside with an untracked folder that held that path.
  await moveUntrackedFoldersOffPulledContent(
    db,
    projectId,
    mergedFiles,
    mergedDirs,
  );
  await carryUntrackedContentAlong(
    db,
    repo,
    projectId,
    localHead,
    mergedSha,
    mergedDirs,
  );
  await moveUntrackedFoldersOffPulledContent(
    db,
    projectId,
    mergedFiles,
    mergedDirs,
  );
  await reslugUntrackedDocumentsOffPulledSlugs(db, projectId, mergedFiles);
}

/**
 * Merges a fetched remote branch (already fetched into the local repository
 * by `fetchLocalRef`) into the project repository. Remote content wins the
 * path; a local document/table whose id differs from the remote content at
 * its path is re-slugged onto a free path instead of lost (R1: as a
 * separate single-parent "prepare" commit reached through the merge commit).
 * True fast-forward (R3) and no-op-pull (R4) are handled without an
 * unnecessary merge commit. Must run inside `withExistingProjectRepo` — the
 * caller holds the exclusive project lock and this function performs no
 * network I/O.
 */
export async function mergeFetchedBranch(
  db: PrismaClient | Prisma.TransactionClient,
  repo: ProjectRepoWriter,
  input: {
    projectId: string;
    bareDirectory: string;
    branch: string;
    remoteHead: string;
    author: CommitAuthor;
  },
): Promise<MergeOutcome> {
  const localHead = await repo.resolveHead();
  const publish = async (
    message: string,
    parents: string[],
    preparedParent?: string,
  ) => {
    const sha = await repo.createTreeCommit(message, input.author, parents);
    await repo.publishTreeCommit(sha, localHead, preparedParent);
    return sha;
  };
  /** Publishes a tree that took remote content, after untracked content followed it. */
  const publishPulled = async (
    message: string,
    parents: string[],
    preparedParent?: string,
  ) => {
    const sha = await repo.createTreeCommit(message, input.author, parents);
    await followPulledTree(db, repo, input.projectId, localHead, sha);
    await repo.publishTreeCommit(sha, localHead, preparedParent);
    return sha;
  };
  try {
    const fetched = await repo.fetchLocalRef(
      input.bareDirectory,
      `refs/heads/${input.branch}`,
      PULL_REF,
    );
    if (fetched !== input.remoteHead) throw new GitRemoteError("MERGE_FAILED");
    // Symlinks and gitlinks would let later worktree writes leave the repository.
    const unsupported = (await repo.listTreeEntries(PULL_REF)).some(
      (entry) => entry.mode === "120000" || entry.mode === "160000",
    );
    if (unsupported) throw new GitRemoteError("UNSUPPORTED_REMOTE_CONTENT");
    const paths = [
      ...(await repo.listTrackedFiles(PULL_REF)),
      ...(await repo.listTrackedFiles(localHead)),
    ];
    if (hasCaseCollidingPaths(paths))
      throw new GitRemoteError("UNSUPPORTED_REMOTE_CONTENT");

    if (await repo.isAncestor(input.remoteHead, localHead)) {
      // Remote already contained: refresh project.json only. R4: a byte-
      // identical project.json means there is nothing at all to commit.
      const exists = await repo.fileExistsInWorktree(PROJECT_METADATA_PATH);
      const current = exists
        ? await repo.readFileFromWorktree(PROJECT_METADATA_PATH)
        : null;
      const file = await composeProjectMetadataFor(db, input.projectId);
      if (!file || current === file) {
        return {
          mergedSha: localHead,
          remoteHead: input.remoteHead,
          fastForward: false,
          reslugged: [],
        };
      }
      await repo.writeFileAtomic(PROJECT_METADATA_PATH, file);
      const sha = await publish(`pull: ${input.branch} (up to date)`, [
        localHead,
      ]);
      return {
        mergedSha: sha,
        remoteHead: input.remoteHead,
        fastForward: false,
        reslugged: [],
      };
    }

    const isFastForwardCandidate = await repo.isAncestor(
      localHead,
      input.remoteHead,
    );
    const ancestor = await repo.mergeBase(localHead, input.remoteHead);
    const prepared = await prepareLocalContent(
      db,
      repo,
      input.projectId,
      localHead,
      input.branch,
      input.author,
      isFastForwardCandidate,
      ancestor,
    );

    if (isFastForwardCandidate && prepared.reslugged.length === 0) {
      // R3: true fast-forward adopts the remote tree as-is — no restores of
      // any kind, even for local-only content the remote later deleted.
      await repo.resetWorktreeTo(PULL_REF);
      await writeMetadata(db, repo, input.projectId);
      const sha = await publishPulled(`pull: ${input.branch}`, [
        input.remoteHead,
      ]);
      return {
        mergedSha: sha,
        remoteHead: input.remoteHead,
        fastForward: true,
        reslugged: [],
      };
    }

    // General two-parent merge: any restore or re-slug forces this path
    // (R3), so fastForward is always false here.
    const remoteFiles = new Set(await repo.listTrackedFiles(PULL_REF));
    const baseFiles = (await repo.listTrackedFiles(prepared.baseHead)).filter(
      (p) => p !== PROJECT_METADATA_PATH,
    );
    const ancestorBlobs = new Map(
      (ancestor ? await repo.listTrackedBlobs(ancestor) : []).map((blob) => [
        blob.path,
        blob.sha,
      ]),
    );
    const localBlobs = new Map(
      (await repo.listTrackedBlobs(localHead)).map((blob) => [
        blob.path,
        blob.sha,
      ]),
    );
    const remoteBlobs = new Map(
      (await repo.listTrackedBlobs(PULL_REF)).map((blob) => [
        blob.path,
        blob.sha,
      ]),
    );
    await repo.resetWorktreeTo(PULL_REF);
    for (const [file, sha] of ancestorBlobs) {
      if (
        file !== PROJECT_METADATA_PATH &&
        !localBlobs.has(file) &&
        remoteBlobs.get(file) === sha
      )
        await repo.rm(file);
    }
    const forcedReslugPaths = reslugTargetPaths(prepared.reslugged, baseFiles);
    // R3: when the remote already contains the local history, its deletions
    // and renames are deliberate and its copies descend from the local ones,
    // so only phase A's own re-slug targets come back.
    const restorePaths = isFastForwardCandidate
      ? [...new Set(forcedReslugPaths)]
      : [
          ...new Set([
            ...baseFiles.filter(
              (p) =>
                !remoteFiles.has(p) &&
                (!ancestorBlobs.has(p) ||
                  localBlobs.get(p) !== ancestorBlobs.get(p)),
            ),
            ...prepared.keepLocal,
            ...forcedReslugPaths,
          ]),
        ];
    if (restorePaths.length > 0) {
      await repo.checkoutPathsFrom(prepared.baseHead, restorePaths);
    }
    await writeMetadata(db, repo, input.projectId);
    const sha = await publishPulled(
      `pull: merge ${input.branch}`,
      [input.remoteHead, prepared.baseHead],
      prepared.preparedHead ?? undefined,
    );
    return {
      mergedSha: sha,
      remoteHead: input.remoteHead,
      fastForward: false,
      reslugged: prepared.reslugged,
    };
  } catch (error) {
    // HEAD contains the original or published final tree. Restore the index
    // and worktree to that committed state before releasing the repo lock.
    try {
      await repo.resetWorktreeTo(await repo.resolveHead());
    } catch {
      // Best-effort: the caller's own recovery (reset --hard + clean -fd on
      // the next withProjectRepo) is the fallback.
    }
    throw error;
  } finally {
    await repo.deleteRef(PULL_REF).catch((error: unknown) => {
      captureError({
        event: "git.remote.pull_cleanup_failed",
        message: "Could not remove the transient pull ref",
        projectId: input.projectId,
        error,
      });
    });
  }
}

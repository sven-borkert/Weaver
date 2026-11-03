import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm as rmFile,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { parseServerEnv } from "@weaver/config/server";
import {
  canonicalProjectRepoId,
  currentProjectLock,
  createAdvisoryLockPool,
  createProjectTurnQueue,
  withProjectAdvisoryLock,
  type AdvisoryLockPool,
} from "@weaver/git-store/advisory-lock";
import type { Pool } from "pg";
import { simpleGit, type SimpleGit } from "simple-git";

const execFileAsync = promisify(execFile);

let parsedEnv: ReturnType<typeof parseServerEnv> | undefined;

function serverEnv() {
  return (parsedEnv ??= parseServerEnv(process.env));
}

export type MachineAuthorKind = "projectApiKey" | "wikiAgent";
export type CommitAuthor =
  | {
      name: string | null;
      email: string;
      userId: string;
      kind?: "user";
    }
  | {
      kind: "machine";
      machineKind: MachineAuthorKind;
      machineId: string;
      name: string | null;
      email: string;
    };
export type GitLogEntry = {
  sha: string;
  pathAtSha: string;
  authorName: string;
  authorEmail: string;
  trustedAuthor?: boolean;
  projectKeyId?: string | null;
  wikiAgentId?: string | null;
  wikiRequestHash?: string | null;
  apiRequestHash?: string | null;
  apiOperation?: string | null;
  userId: string | null;
  operationId: string | null;
  mcpRequestHash: string | null;
  mcpToolName: string | null;
  runId: string | null;
  date: Date;
  message: string;
};
export type GitChangeEntry = {
  sha: string;
  authorName: string;
  authorEmail: string;
  trustedAuthor?: boolean;
  projectKeyId?: string | null;
  wikiAgentId?: string | null;
  userId: string | null;
  operationId: string | null;
  runId: string | null;
  date: Date;
  message: string;
  changes: Array<{
    status: "A" | "M" | "D" | "R" | "C";
    path: string;
    oldPath: string | null;
  }>;
};

const COMMITTER = {
  GIT_COMMITTER_NAME: "Weaver",
  GIT_COMMITTER_EMAIL: "weaver@local",
};
const OPERATION_ID_RE = /^\S{1,200}$/;
const MCP_REQUEST_HASH_RE = /^[0-9a-f]{64}$/;
const MCP_TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,99}$/;
const MACHINE_ID_RE =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const API_OPERATION_RE = /^[a-z][a-z0-9.]{0,39}$/;
const RUN_ID_RE = /^\S{1,200}$/;
const METADATA_OVERRIDE_FIELDS = new Set([
  "created",
  "createdBy",
  "updated",
  "updatedBy",
]);
const USER_ID_VALUE_RE = /^\S+$/;
const GIT_REF_RE = /^refs\/[A-Za-z0-9._\/-]+$/;
const GIT_SHA_RE = /^[0-9a-f]{40}$/;

const MAX_BATCH_BLOB_BYTES = 2_000_000;
const MAX_BATCH_HEADER_BYTES = 4096;

function assertCommitish(commitish: string): void {
  if (
    !commitish ||
    commitish.length > 200 ||
    commitish.startsWith("-") ||
    /[\x00-\x1f\x7f]/.test(commitish)
  ) {
    throw new Error("invalid commitish");
  }
}

/** Streams `<commitish>:<path>` requests through one `git cat-file --batch`
 * (`-z`: NUL-delimited requests, so no path needs quoting) and consumes the
 * responses in request order. Missing, non-blob and oversize entries are
 * skipped, but their bytes are still drained to stay in sync. */
function batchCatFile(
  dir: string,
  commitish: string,
  paths: string[],
  maxBytes: number,
  result: Map<string, string>,
): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["cat-file", "--batch", "-z"], {
      cwd: dir,
      env: {
        ...COMMITTER,
        NODE_ENV: process.env.NODE_ENV ?? "production",
        GIT_CEILING_DIRECTORIES: serverEnv().WEAVER_DATA_DIR,
      },
      timeout: 60_000,
    });
    let header: Buffer[] = [];
    let headerBytes = 0;
    let next = 0;
    let pending: {
      path: string;
      size: number;
      remaining: number;
      parts: Buffer[] | null;
    } | null = null;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(error);
    };
    const consume = (chunk: Buffer) => {
      let offset = 0;
      while (offset < chunk.length && !settled) {
        if (pending) {
          const take = Math.min(pending.remaining, chunk.length - offset);
          pending.parts?.push(chunk.subarray(offset, offset + take));
          pending.remaining -= take;
          offset += take;
          if (pending.remaining > 0) return;
          if (pending.parts) {
            result.set(
              pending.path,
              Buffer.concat(pending.parts)
                .subarray(0, pending.size)
                .toString("utf8"),
            );
          }
          pending = null;
          continue;
        }
        const end = chunk.indexOf(0x0a, offset);
        const piece = chunk.subarray(offset, end === -1 ? chunk.length : end);
        headerBytes += piece.length;
        if (headerBytes > MAX_BATCH_HEADER_BYTES) {
          fail(new Error("git cat-file returned an oversize header"));
          return;
        }
        header.push(piece);
        if (end === -1) return;
        offset = end + 1;
        const line = Buffer.concat(header).toString("utf8");
        header = [];
        headerBytes = 0;
        const relPath = paths[next++];
        if (relPath === undefined) return;
        const match = /^[0-9a-f]{40} (\S+) (\d+)$/.exec(line);
        // "<request> missing" and malformed objects carry no payload.
        if (!match) continue;
        const size = Number(match[2]);
        pending = {
          path: relPath,
          size,
          remaining: size + 1,
          parts: match[1] === "blob" && size <= maxBytes ? [] : null,
        };
      }
    };
    child.stdout.on("data", consume);
    child.on("error", fail);
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        fail(new Error(`git cat-file exited with ${code}`));
        return;
      }
      settled = true;
      resolve(result);
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(
      paths.map((relPath) => `${commitish}:${relPath}\0`).join(""),
    );
  });
}

function isSafeRepoRelativePath(relPath: string): boolean {
  return (
    relPath.length > 0 &&
    !relPath.includes("\0") &&
    !relPath.startsWith("/") &&
    !relPath.split("/").includes("..")
  );
}

export class WorktreePathError extends Error {
  constructor(relPath: string) {
    super(`path leaves the repository worktree: ${relPath}`);
    this.name = "WorktreePathError";
  }
}

// Walks existing components with lstat: a Git-supplied symlink must never
// redirect a worktree read or write outside the repository.
async function worktreePathState(
  dir: string,
  relPath: string,
): Promise<"exists" | "missing"> {
  const segments = relPath.split("/").filter((part) => part && part !== ".");
  if (
    relPath.includes("\0") ||
    relPath.startsWith("/") ||
    segments.includes("..") ||
    segments[0] === ".git"
  )
    throw new WorktreePathError(relPath);
  let current = await realpath(dir);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) return "missing";
    if (info.isSymbolicLink()) throw new WorktreePathError(relPath);
    if (index < segments.length - 1 && !info.isDirectory())
      throw new WorktreePathError(relPath);
  }
  return "exists";
}

// Git deserializes its own trailer grammar; we only validate the final value.
function trailerValue(field: string | undefined, valueRe: RegExp) {
  const value = (field ?? "").split("\x1f").at(-1) ?? "";
  return valueRe.test(value) ? value : null;
}

const CHANGE_LOG_FORMAT =
  "%x00WEAVER-COMMIT%x00%H%x00%an%x00%ae%x00%aI%x00" +
  "%(trailers:key=Weaver-User-Id,valueonly,separator=%x1f,unfold)%x00" +
  "%(trailers:key=Weaver-Operation-Id,valueonly,separator=%x1f,unfold)%x00" +
  "%(trailers:key=Weaver-Run-Id,valueonly,separator=%x1f,unfold)%x00" +
  "%(trailers:key=Weaver-Project-Key-Id,valueonly,separator=%x1f,unfold)%x00" +
  "%(trailers:key=Weaver-Wiki-Agent-Id,valueonly,separator=%x1f,unfold)%x00" +
  "%B%x00";

function parseChangeLog(raw: string): GitChangeEntry[] {
  return raw
    .split("\0WEAVER-COMMIT\0")
    .map((block) => block.trim())
    .filter(
      (block) =>
        block.split("\0").length === 11 && /^[0-9a-f]{40}\0/.test(block),
    )
    .map((block) => {
      const [
        sha,
        an,
        ae,
        aI,
        userField,
        operationField,
        runField,
        keyField,
        wikiAgentField,
        body,
        tail,
      ] = block.split("\0");
      const changes = (tail ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /^[AMDRC]/.test(line))
        .map((line) => {
          const cols = line.split("\t");
          const status =
            cols[0]![0] as GitChangeEntry["changes"][number]["status"];
          return cols.length === 3
            ? { status, path: cols[2]!, oldPath: cols[1]! }
            : { status, path: cols[1] ?? "", oldPath: null };
        });
      return {
        sha: sha!.trim(),
        authorName: an ?? "",
        authorEmail: ae ?? "",
        userId: trailerValue(userField, USER_ID_VALUE_RE),
        projectKeyId: trailerValue(keyField, MACHINE_ID_RE),
        wikiAgentId: trailerValue(wikiAgentField, MACHINE_ID_RE),
        operationId: trailerValue(operationField, OPERATION_ID_RE),
        runId: trailerValue(runField, RUN_ID_RE),
        date: new Date(aI ?? 0),
        message: (body ?? "").split("\n")[0] ?? "",
        changes,
      };
    });
}

export function repoDir(projectId: string): string {
  if (!projectId || /[\\/\x00]/.test(projectId) || projectId.includes(".."))
    throw new Error("Invalid project repository id");
  return path.join(
    serverEnv().WEAVER_DATA_DIR,
    "git",
    canonicalProjectRepoId(projectId),
  );
}

const globalForGit = globalThis as typeof globalThis & {
  weaverGitLockPool?: Pool;
  weaverGitTurnQueue?: ReturnType<typeof createProjectTurnQueue>;
};

function gitLockPool(): AdvisoryLockPool {
  const env = serverEnv();
  return (globalForGit.weaverGitLockPool ??= createAdvisoryLockPool({
    connectionString: env.DATABASE_URL,
    max: env.WEAVER_GIT_LOCK_POOL_MAX,
    applicationName: "weaver-git-lock",
    onError: (error) => console.error("weaver-git-lock pool error", error),
  }));
}

function gitTurnQueue() {
  return (globalForGit.weaverGitTurnQueue ??= createProjectTurnQueue());
}

function logUnlockError(projectId: string) {
  return (error: unknown) =>
    console.error(`project repository unlock failed: ${projectId}`, error);
}

async function withProjectLock<T>(
  projectId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const env = serverEnv();
  // One in-process waiter per project keeps busy projects from draining the pool.
  const deadline = Date.now() + env.WEAVER_GIT_LOCK_TIMEOUT_MS;
  return gitTurnQueue().withTurn(projectId, deadline, () =>
    withProjectAdvisoryLock(
      gitLockPool(),
      projectId,
      {
        timeoutMs: Math.max(1, deadline - Date.now()),
        onUnlockError: logUnlockError(projectId),
      },
      fn,
    ),
  );
}

// Readers share the lock, but only one per project holds a pool client while waiting.
async function withProjectSharedLock<T>(
  projectId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const env = serverEnv();
  const deadline = Date.now() + env.WEAVER_GIT_LOCK_TIMEOUT_MS;
  return gitTurnQueue().withSharedTurn(projectId, deadline, (onAcquired) =>
    withProjectAdvisoryLock(
      gitLockPool(),
      projectId,
      {
        timeoutMs: Math.max(1, deadline - Date.now()),
        mode: "shared",
        onAcquired,
        onUnlockError: logUnlockError(projectId),
      },
      fn,
    ),
  );
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

function sanitizeCommitText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, "");
}

// Caller text can never carry a Weaver-* line; real trailers are appended after this.
function sanitizeCommitMessage(value: string): string {
  return value
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "")
    .split("\n")
    .filter((line) => !/^\s*Weaver-[A-Za-z0-9_-]+\s*:/i.test(line))
    .join("\n");
}

function authorIdentityTrailer(author: CommitAuthor): string {
  if (author.kind === "machine") {
    if (!MACHINE_ID_RE.test(author.machineId))
      throw new Error("invalid machine author");
    switch (author.machineKind) {
      case "projectApiKey":
        return `Weaver-Project-Key-Id: ${author.machineId}`;
      case "wikiAgent":
        return `Weaver-Wiki-Agent-Id: ${author.machineId}`;
    }
  }
  return `Weaver-User-Id: ${author.userId}`;
}

function isWikiAgentAuthor(author: CommitAuthor): boolean {
  return author.kind === "machine" && author.machineKind === "wikiAgent";
}

function gitFor(dir: string, author?: CommitAuthor): SimpleGit {
  const authorEnv = author
    ? {
        GIT_AUTHOR_NAME:
          sanitizeCommitText(author.name ?? "").trim() ||
          sanitizeCommitText(author.email.split("@")[0]!) ||
          "Weaver user",
        GIT_AUTHOR_EMAIL: sanitizeCommitText(author.email),
      }
    : {};
  // Stops repository discovery escaping the data dir: a repo deleted mid-write would
  // otherwise resolve to the enclosing checkout and `add -A` would stage that tree.
  currentProjectLock()?.signal.throwIfAborted();
  return simpleGit({
    baseDir: dir,
    timeout: { block: 60_000 },
    ...(currentProjectLock() ? { abort: currentProjectLock()!.signal } : {}),
  }).env({
    ...COMMITTER,
    ...authorEnv,
    GIT_CEILING_DIRECTORIES: serverEnv().WEAVER_DATA_DIR,
  });
}

async function resolveCommit(
  dir: string,
  revision: string,
): Promise<string | null> {
  if (!revision || revision.length > 200 || /[\x00-\x1f\x7f]/.test(revision))
    return null;
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        `${revision}^{commit}`,
      ],
      {
        cwd: dir,
        env: {
          ...COMMITTER,
          NODE_ENV: process.env.NODE_ENV ?? "production",
          GIT_CEILING_DIRECTORIES: serverEnv().WEAVER_DATA_DIR,
        },
        timeout: 60_000,
        maxBuffer: 4_096,
        encoding: "utf8",
      },
    );
    const sha = stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(sha))
      throw new Error("Git returned an invalid commit ID");
    return sha;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === 1)
      return null;
    throw error;
  }
}

async function ensureRepo(dir: string): Promise<void> {
  if (await exists(path.join(dir, ".git"))) return;
  await mkdir(dir, { recursive: true });
  const git = gitFor(dir);
  await git.raw(["init", "-b", "main"]);
  // Empty root commit keeps HEAD resolvable for recovery and folder-only repos.
  await git.raw([
    "commit",
    "--allow-empty",
    "-m",
    "init",
    "--author",
    "Weaver <weaver@local>",
  ]);
}

async function recover(dir: string): Promise<void> {
  const acquiredAt = currentProjectLock()?.acquiredAt ?? Date.now();
  await currentProjectLock()?.assertHeld();
  const gitDir = path.join(dir, ".git");
  const gitStat = await lstat(gitDir);
  if (!gitStat.isDirectory() || gitStat.isSymbolicLink()) {
    throw new Error("repository .git must be a real directory");
  }
  const realRepoDir = await realpath(dir);
  const realGitDir = await realpath(gitDir);
  if (realGitDir !== path.join(realRepoDir, ".git")) {
    throw new Error("repository .git must be a real directory");
  }
  const isInsideGitDir = (candidate: string) => {
    const relative = path.relative(realGitDir, candidate);
    return (
      relative === "" ||
      (relative !== ".." &&
        !path.isAbsolute(relative) &&
        !relative.startsWith(`..${path.sep}`))
    );
  };
  const pending = [realGitDir];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const currentStat = await lstat(current);
    if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) continue;
    const resolvedCurrent = await realpath(current);
    if (!isInsideGitDir(resolvedCurrent)) {
      throw new Error("repository .git traversal escaped metadata root");
    }
    const resolvedStat = await lstat(resolvedCurrent);
    if (!resolvedStat.isDirectory() || resolvedStat.isSymbolicLink()) continue;
    for (const entry of await readdir(resolvedCurrent, {
      withFileTypes: true,
    })) {
      if (entry.isSymbolicLink()) continue;
      const target = path.join(resolvedCurrent, entry.name);
      if (entry.isDirectory()) {
        if (
          resolvedCurrent === path.join(realGitDir, "objects") &&
          /^[0-9a-f]{2}$/.test(entry.name)
        )
          continue;
        pending.push(target);
      } else if (entry.name.endsWith(".lock")) {
        const targetStat = await lstat(target);
        if (!targetStat.isFile() || targetStat.isSymbolicLink()) continue;
        const resolvedTarget = await realpath(target);
        if (!isInsideGitDir(resolvedTarget)) {
          throw new Error("repository .git lock escaped metadata root");
        }
        if (targetStat.mtimeMs >= acquiredAt)
          throw new Error("repository has a live Git lock");
        await rmFile(target, { force: true });
      }
    }
  }
  await mkdir(path.join(realGitDir, "info"), { recursive: true });
  await writeFile(
    path.join(realGitDir, "info", "attributes"),
    "* -text -eol -ident -filter -diff\n",
  );
  const git = gitFor(dir);
  if (!(await git.raw(["rev-list", "--all", "--max-count=1"])).trim()) {
    await git.raw(["symbolic-ref", "HEAD"]);
    await git.raw(["read-tree", "--empty"]);
    await git.raw([
      "commit",
      "--allow-empty",
      "-m",
      "init",
      "--author",
      "Weaver <weaver@local>",
    ]);
  }
  await git.raw(["reset", "--hard", "HEAD"]);
  await git.raw(["clean", "-fdx"]);
}

async function readTrustLedger(dir: string, name: string): Promise<string> {
  try {
    return await readFile(path.join(dir, ".git", name), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      console.warn("Unable to read local commit attribution ledger");
    return "";
  }
}
async function trustedCommits(dir: string): Promise<Set<string>> {
  const ledgers = await Promise.all([
    readTrustLedger(dir, "weaver-trusted-commits"),
    readTrustLedger(dir, "weaver-trusted-commits.pending"),
  ]);
  return new Set(
    ledgers
      .join("\n")
      .split("\n")
      .filter((sha) => GIT_SHA_RE.test(sha)),
  );
}
async function rememberTrustedCommit(dir: string, sha: string) {
  const pendingPath = path.join(dir, ".git", "weaver-trusted-commits.pending");
  const pending = await readTrustLedger(dir, "weaver-trusted-commits.pending");
  try {
    await appendFile(
      path.join(dir, ".git", "weaver-trusted-commits"),
      `${pending}${sha}\n`,
      { mode: 0o600 },
    );
    await rmFile(pendingPath, { force: true });
  } catch {
    // HEAD is already published; attribution repair must not reject the write.
    console.warn("Local commit attribution requires reconciliation");
    try {
      await appendFile(pendingPath, `${sha}\n`, { mode: 0o600 });
    } catch {
      console.warn("Unable to persist pending local commit attribution");
    }
  }
}
function makeRepo(dir: string) {
  return {
    dir,
    async writeFileAtomic(relPath: string, content: string) {
      currentProjectLock()?.signal.throwIfAborted();
      await worktreePathState(dir, relPath);
      const abs = path.join(dir, relPath);
      await mkdir(path.dirname(abs), { recursive: true });
      const tmp = `${abs}.tmp-${process.pid}`;
      await writeFile(tmp, content, "utf8");
      await rename(tmp, abs);
    },
    async writeBinaryFileAtomic(relPath: string, bytes: Uint8Array) {
      currentProjectLock()?.signal.throwIfAborted();
      await worktreePathState(dir, relPath);
      const abs = path.join(dir, relPath);
      await mkdir(path.dirname(abs), { recursive: true });
      const tmp = `${abs}.tmp-${process.pid}`;
      await writeFile(tmp, bytes);
      await rename(tmp, abs);
    },
    async removeUntrackedFile(relPath: string) {
      if (!isSafeRepoRelativePath(relPath)) throw new Error("invalid path");
      await worktreePathState(dir, relPath);
      const tracked = await gitFor(dir).raw(["ls-files", "--", relPath]);
      if (tracked.trim()) throw new Error("cannot remove a tracked file");
      await rmFile(path.join(dir, relPath), { force: true });
    },
    async ensureFolder(folderRel: string) {
      await worktreePathState(dir, folderRel);
      const abs = path.join(dir, folderRel);
      await mkdir(abs, { recursive: true });
      await writeFile(path.join(abs, ".gitkeep"), "");
    },
    async mv(from: string, to: string) {
      await worktreePathState(dir, from);
      await worktreePathState(dir, to);
      await mkdir(path.dirname(path.join(dir, to)), { recursive: true });
      await gitFor(dir).raw(["mv", from, to]);
    },
    async rm(relPath: string) {
      await gitFor(dir).raw(["rm", "-q", relPath]);
    },
    async rmDir(folderRel: string) {
      await gitFor(dir).raw(["rm", "-r", "-q", folderRel]);
    },
    async commitAll(
      message: string,
      author: CommitAuthor,
      options?: {
        operationId?: string;
        mcpRequestHash?: string;
        mcpToolName?: string;
        apiRequestHash?: string;
        apiOperation?: string;
        wikiRequestHash?: string;
        /** Weaver-Wiki-Input-Id on a source writer commit. */
        wikiInputId?: string;
        beforeCommit?: () => Promise<void>;
        runId?: string;
        /** Document metadata fields the writer set explicitly instead of defaulting. */
        metadataOverride?: readonly string[];
      },
    ) {
      const operationId = options?.operationId;
      if (operationId !== undefined && !OPERATION_ID_RE.test(operationId)) {
        throw new Error("invalid operation id");
      }
      const mcpRequestHash = options?.mcpRequestHash;
      if (
        mcpRequestHash !== undefined &&
        !MCP_REQUEST_HASH_RE.test(mcpRequestHash)
      ) {
        throw new Error("invalid MCP request hash");
      }
      const mcpToolName = options?.mcpToolName;
      if (mcpToolName !== undefined && !MCP_TOOL_NAME_RE.test(mcpToolName)) {
        throw new Error("invalid MCP tool name");
      }
      if ((mcpRequestHash === undefined) !== (mcpToolName === undefined)) {
        throw new Error("incomplete MCP request identity");
      }
      const runId = options?.runId;
      const apiRequestHash = options?.apiRequestHash;
      const apiOperation = options?.apiOperation;
      if (
        (apiRequestHash === undefined) !== (apiOperation === undefined) ||
        (apiRequestHash !== undefined &&
          !MCP_REQUEST_HASH_RE.test(apiRequestHash)) ||
        (apiOperation !== undefined && !API_OPERATION_RE.test(apiOperation))
      )
        throw new Error("invalid API request identity");
      if (runId !== undefined && !RUN_ID_RE.test(runId)) {
        throw new Error("invalid run id");
      }
      const wikiRequestHash = options?.wikiRequestHash;
      // Recovery matches on these, so an agent commit without them cannot exist.
      // A revert is authored by the Editor who started it, with its hash and no agent trailer.
      const revertOperation = operationId?.startsWith("wiki-revert:") === true;
      if (
        wikiRequestHash !== undefined
          ? (!isWikiAgentAuthor(author) && !revertOperation) ||
            (isWikiAgentAuthor(author) && revertOperation) ||
            !MCP_REQUEST_HASH_RE.test(wikiRequestHash)
          : isWikiAgentAuthor(author)
      )
        throw new Error("invalid wiki request identity");
      // Deterministic bootstrap has no run, so only its own id prefix may omit the run id.
      const bootstrap = operationId?.startsWith("wiki-bootstrap:") === true;
      if (
        isWikiAgentAuthor(author) &&
        (!operationId || (bootstrap ? runId !== undefined : !runId))
      )
        throw new Error("incomplete wiki request identity");
      const wikiInputId = options?.wikiInputId;
      if (
        wikiInputId !== undefined &&
        (!isWikiAgentAuthor(author) || !MACHINE_ID_RE.test(wikiInputId))
      )
        throw new Error("invalid wiki input id");
      const overridden = options?.metadataOverride ?? [];
      if (overridden.some((field) => !METADATA_OVERRIDE_FIELDS.has(field))) {
        throw new Error("invalid metadata override field");
      }
      const git = gitFor(dir, author);
      await git.raw(["add", "-f", "-A"]);
      const args = [
        "commit",
        "-m",
        sanitizeCommitMessage(message),
        "--trailer",
        authorIdentityTrailer(author),
      ];
      if (operationId !== undefined) {
        args.push("--trailer", `Weaver-Operation-Id: ${operationId}`);
      }
      if (mcpRequestHash !== undefined && mcpToolName !== undefined) {
        args.push(
          "--trailer",
          `Weaver-MCP-Request-Hash: ${mcpRequestHash}`,
          "--trailer",
          `Weaver-MCP-Tool: ${mcpToolName}`,
        );
      }
      if (runId !== undefined) {
        args.push("--trailer", `Weaver-Run-Id: ${runId}`);
      }
      if (apiRequestHash !== undefined && apiOperation !== undefined)
        args.push(
          "--trailer",
          `Weaver-API-Request-Hash: ${apiRequestHash}`,
          "--trailer",
          `Weaver-API-Operation: ${apiOperation}`,
        );
      if (wikiRequestHash !== undefined)
        args.push("--trailer", `Weaver-Wiki-Request-Hash: ${wikiRequestHash}`);
      if (wikiInputId !== undefined)
        args.push("--trailer", `Weaver-Wiki-Input-Id: ${wikiInputId}`);
      if (overridden.length > 0) {
        args.push(
          "--trailer",
          `Weaver-Metadata-Override: ${overridden.join(",")}`,
        );
      }
      await currentProjectLock()?.assertHeld();
      await options?.beforeCommit?.();
      await git.raw(args);
      const sha = (await git.revparse(["HEAD"])).trim();
      await rememberTrustedCommit(dir, sha);
      return sha;
    },
    async commitDate(commitish: string) {
      const out = await gitFor(dir).raw([
        "show",
        "-s",
        "--format=%aI",
        commitish,
      ]);
      return new Date(out.trim());
    },
    async resolveHead() {
      return (await gitFor(dir).revparse(["HEAD"])).trim();
    },
    async lastCommitForPath(relPath: string) {
      const out = await gitFor(dir).raw([
        "log",
        "-1",
        "--format=%H",
        "--",
        relPath,
      ]);
      const sha = out.trim();
      return sha.length > 0 ? sha : null;
    },
    async mergeBase(left: string, right: string) {
      assertCommitish(left);
      assertCommitish(right);
      try {
        return (
          (await gitFor(dir).raw(["merge-base", left, right])).trim() || null
        );
      } catch {
        return null;
      }
    },
    async isAncestor(sha: string, snapshot: string) {
      const [commit, snapshotCommit] = await Promise.all([
        resolveCommit(dir, sha),
        resolveCommit(dir, snapshot),
      ]);
      if (!commit || !snapshotCommit) return false;
      const unseen = await gitFor(dir).raw([
        "rev-list",
        "-1",
        commit,
        "--not",
        snapshotCommit,
      ]);
      return unseen.trim().length === 0;
    },
    async listHistoricalPaths(prefix = "") {
      const out = await gitFor(dir).raw([
        "log",
        "--format=",
        "--name-only",
        "--diff-filter=D",
        "-z",
        "--",
        ...(prefix ? [prefix] : []),
      ]);
      return [
        ...new Set(
          out
            .split("\0")
            .map((file) => file.replace(/^\n+/, ""))
            .filter(Boolean),
        ),
      ];
    },
    async blobShaAt(commitish: string, relPath: string) {
      try {
        return (await gitFor(dir).revparse([`${commitish}:${relPath}`])).trim();
      } catch {
        return null;
      }
    },
    async blobSizeAt(commitish: string, relPath: string) {
      const output = await gitFor(dir).raw([
        "ls-tree",
        "-l",
        "-z",
        "--full-name",
        commitish,
        "--",
        `:(literal)${relPath}`,
      ]);
      for (const line of output.split("\0").filter(Boolean)) {
        const match = /^\d+ blob [0-9a-f]{40} +([0-9]+)\t([\s\S]+)$/.exec(line);
        if (match?.[2] !== relPath) continue;
        const size = Number(match[1]);
        if (!Number.isSafeInteger(size) || size < 0)
          throw new Error("Invalid Git blob size");
        return size;
      }
      return null;
    },
    async showFileAt(commitish: string, relPath: string) {
      return gitFor(dir).raw(["show", `${commitish}:${relPath}`]);
    },
    async readFileFromWorktree(relPath: string) {
      return this.showFileAt("HEAD", relPath);
    },
    async readCommittedFile(relPath: string) {
      const snapshotSha = await this.resolveHead();
      return this.readCommittedFileAt(snapshotSha, relPath);
    },
    async readCommittedFileAt(commitish: string, relPath: string) {
      if (!(await this.blobShaAt(commitish, relPath))) return null;
      const [entry] = await this.logForPath(relPath, {
        skip: 0,
        limit: 1,
        commitish,
      });
      if (!entry) return null;
      return {
        content: await this.showFileAt(commitish, relPath),
        baseCommitSha: entry.sha,
      };
    },
    async readCommittedBlobAt(
      commitish: string,
      relPath: string,
      maxBytes: number,
    ) {
      const blobSha = await this.blobShaAt(commitish, relPath);
      if (!blobSha) return null;
      const size = await this.blobSizeAt(commitish, relPath);
      if (size === null || size > maxBytes) return null;
      try {
        const type = (
          await gitFor(dir).raw(["cat-file", "-t", blobSha])
        ).trim();
        if (type !== "blob") return null;
        const raw: unknown = await gitFor(dir).binaryCatFile(["blob", blobSha]);
        const bytes = Buffer.isBuffer(raw)
          ? raw
          : Buffer.from(raw as Uint8Array);
        return { bytes, blobSha, size };
      } catch {
        return null;
      }
    },
    /** Bytes of a blob named by `listTrackedBlobs`; throws for any other object. */
    async readBlob(blobSha: string) {
      if (!GIT_SHA_RE.test(blobSha)) throw new Error("invalid blob id");
      const raw: unknown = await gitFor(dir).binaryCatFile(["blob", blobSha]);
      return Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
    },
    async renamedPathBetween(
      fromCommitish: string,
      toCommitish: string,
      relPath: string,
    ) {
      try {
        const out = await gitFor(dir).raw([
          "diff",
          "--name-status",
          "--find-renames",
          fromCommitish,
          toCommitish,
          "--",
        ]);
        for (const line of out.split("\n")) {
          const [status, from, to] = line.split("\t");
          if (status?.startsWith("R") && from === relPath && to) return to;
        }
        return null;
      } catch {
        return null;
      }
    },
    async fileExistsInWorktree(relPath: string) {
      // A symlinked component counts as absent, so callers answer NOT_FOUND.
      return worktreePathState(dir, relPath).then(
        (state) => state === "exists",
        (error: unknown) => {
          if (error instanceof WorktreePathError) return false;
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        },
      );
    },
    async listTrackedFiles(commitish = "HEAD") {
      // -z keeps non-ASCII paths literal; without it Git C-quotes them.
      const out = await gitFor(dir).raw([
        "ls-tree",
        "-r",
        "-z",
        commitish,
        "--name-only",
      ]);
      return out.split("\0").filter((line) => line.length > 0);
    },
    async readBlobsAt(
      commitish: string,
      paths: string[],
      maxBytes = MAX_BATCH_BLOB_BYTES,
    ) {
      assertCommitish(commitish);
      // One `cat-file --batch` instead of one `git show` per path: a few
      // thousand documents would otherwise outlast the caller's lease.
      const wanted = paths.filter(
        (relPath) => isSafeRepoRelativePath(relPath) && !/[\r\n]/.test(relPath),
      );
      const result = new Map<string, string>();
      if (wanted.length === 0) return result;
      return batchCatFile(dir, commitish, wanted, maxBytes, result);
    },
    async listTrackedBlobs(commitish = "HEAD") {
      const out = await gitFor(dir).raw([
        "ls-tree",
        "-r",
        "-l",
        "-z",
        commitish,
      ]);
      return out.split("\0").flatMap((line) => {
        const match = /^\d+ blob ([0-9a-f]{40}) +([0-9]+)\t([\s\S]+)$/.exec(
          line,
        );
        return match
          ? [{ sha: match[1]!, size: Number(match[2]), path: match[3]! }]
          : [];
      });
    },
    async listTreeEntries(commitish = "HEAD") {
      const out = await gitFor(dir).raw(["ls-tree", "-r", "-z", commitish]);
      return out.split("\0").flatMap((line) => {
        const match = /^(\d+) (\w+) [0-9a-f]+\t([\s\S]+)$/.exec(line);
        return match
          ? [{ mode: match[1]!, type: match[2]!, path: match[3]! }]
          : [];
      });
    },
    async orderCommits(commitish: string, shas: string[]) {
      const wanted = new Set(shas);
      if (wanted.size === 0) return [];
      if (wanted.size === 1) return [...wanted];
      if (wanted.size === 2) {
        const [a, b] = [...wanted] as [string, string];
        if (await this.isAncestor(a, b)) return [b, a];
        if (await this.isAncestor(b, a)) return [a, b];
      }
      const common = (
        await gitFor(dir).raw(["merge-base", "--octopus", ...wanted])
      ).trim();
      const parents = (
        await gitFor(dir).raw(["rev-list", "--parents", "-n", "1", common])
      )
        .trim()
        .split(" ")
        .slice(1);
      const out = await gitFor(dir).raw([
        "rev-list",
        "--topo-order",
        commitish,
        ...(parents.length ? ["--not", ...parents] : []),
      ]);
      const ordered = out.split("\n").filter((sha) => wanted.has(sha));
      if (ordered.length !== wanted.size) {
        throw new Error("commit ordering input is not reachable from snapshot");
      }
      return ordered;
    },
    async listWorktreeDirs() {
      const dirs: string[] = [];
      const walk = async (rel: string): Promise<void> => {
        for (const entry of await readdir(path.join(dir, rel), {
          withFileTypes: true,
        })) {
          if (!entry.isDirectory() || entry.name === ".git") continue;
          const childRel = rel.length > 0 ? `${rel}/${entry.name}` : entry.name;
          dirs.push(childRel);
          await walk(childRel);
        }
      };
      await walk("");
      return dirs;
    },
    async logForPath(
      relPath: string,
      {
        skip,
        limit,
        commitish = "HEAD",
        operationId,
      }: {
        skip: number;
        limit: number;
        commitish?: string;
        operationId?: string;
      },
    ) {
      const raw = await gitFor(dir).raw([
        "log",
        "--follow",
        "--name-status",
        "-n",
        String(skip + limit),
        ...(operationId
          ? ["--fixed-strings", `--grep=Weaver-Operation-Id: ${operationId}`]
          : []),
        "--format=%x00WEAVER-COMMIT%x00%H%x00%an%x00%ae%x00%aI%x00" +
          "%(trailers:key=Weaver-User-Id,valueonly,separator=%x1f,unfold)%x00" +
          "%(trailers:key=Weaver-Operation-Id,valueonly,separator=%x1f,unfold)%x00" +
          "%(trailers:key=Weaver-MCP-Request-Hash,valueonly,separator=%x1f,unfold)%x00" +
          "%(trailers:key=Weaver-MCP-Tool,valueonly,separator=%x1f,unfold)%x00" +
          "%(trailers:key=Weaver-Run-Id,valueonly,separator=%x1f,unfold)%x00" +
          "%(trailers:key=Weaver-Project-Key-Id,valueonly,separator=%x1f,unfold)%x00" +
          "%(trailers:key=Weaver-API-Request-Hash,valueonly,separator=%x1f,unfold)%x00" +
          "%(trailers:key=Weaver-API-Operation,valueonly,separator=%x1f,unfold)%x00" +
          "%(trailers:key=Weaver-Wiki-Agent-Id,valueonly,separator=%x1f,unfold)%x00" +
          "%(trailers:key=Weaver-Wiki-Request-Hash,valueonly,separator=%x1f,unfold)%x00" +
          "%B%x00",
        commitish,
        "--",
        relPath,
      ]);
      const trusted = await trustedCommits(dir);
      return raw
        .split("\0WEAVER-COMMIT\0")
        .map((block) => block.trim())
        .filter(
          (block) =>
            block.split("\0").length === 16 && /^[0-9a-f]{40}\0/.test(block),
        )
        .map((block) => {
          const [
            sha,
            an,
            ae,
            aI,
            userField,
            operationField,
            mcpRequestHashField,
            mcpToolNameField,
            runField,
            keyField,
            apiHashField,
            apiOperationField,
            wikiAgentField,
            wikiRequestHashField,
            body,
            tail,
          ] = block.split("\0");
          const statusLine = (tail ?? "")
            .split("\n")
            .map((line) => line.trim())
            .find((line) => /^[AMDR]/.test(line));
          const cols = statusLine?.split("\t") ?? [];
          const pathAtSha = cols.length === 3 ? cols[2]! : (cols[1] ?? relPath);
          return {
            sha: sha!.trim(),
            authorName: an ?? "",
            authorEmail: ae ?? "",
            trustedAuthor: trusted.has(sha!),
            date: new Date(aI ?? 0),
            message: (body ?? "").split("\n")[0] ?? "",
            userId: trailerValue(userField, USER_ID_VALUE_RE),
            projectKeyId: trailerValue(keyField, MACHINE_ID_RE),
            wikiAgentId: trailerValue(wikiAgentField, MACHINE_ID_RE),
            wikiRequestHash: trailerValue(
              wikiRequestHashField,
              MCP_REQUEST_HASH_RE,
            ),
            apiRequestHash: trailerValue(apiHashField, MCP_REQUEST_HASH_RE),
            apiOperation: trailerValue(apiOperationField, API_OPERATION_RE),
            operationId: trailerValue(operationField, OPERATION_ID_RE),
            mcpRequestHash: trailerValue(
              mcpRequestHashField,
              MCP_REQUEST_HASH_RE,
            ),
            mcpToolName: trailerValue(mcpToolNameField, MCP_TOOL_NAME_RE),
            runId: trailerValue(runField, RUN_ID_RE),
            pathAtSha,
          };
        })
        .slice(skip, skip + limit);
    },
    async logSince(
      fromSha: string | null,
      options: { limit: number; sinceDate?: Date },
    ): Promise<GitChangeEntry[]> {
      const raw = await gitFor(dir).raw([
        "log",
        "--name-status",
        "-n",
        String(options.limit),
        ...(options.sinceDate
          ? [`--since=${options.sinceDate.toISOString()}`]
          : []),
        `--format=${CHANGE_LOG_FORMAT}`,
        fromSha ? `${fromSha}..HEAD` : "HEAD",
        "--",
      ]);
      const trusted = await trustedCommits(dir);
      return parseChangeLog(raw).map((entry) => ({
        ...entry,
        trustedAuthor: trusted.has(entry.sha),
      }));
    },
    async logChangesBefore(
      commitish: string,
      options: { limit: number },
    ): Promise<GitChangeEntry[]> {
      let raw: string;
      try {
        raw = await gitFor(dir).raw([
          "log",
          "--name-status",
          "-n",
          String(options.limit),
          `--format=${CHANGE_LOG_FORMAT}`,
          commitish,
          "--",
        ]);
      } catch {
        // An unresolvable commitish is a caller error, not a repository fault.
        return [];
      }
      const trusted = await trustedCommits(dir);
      return parseChangeLog(raw).map((entry) => ({
        ...entry,
        trustedAuthor: trusted.has(entry.sha),
      }));
    },
    async firstParentTrustedBefore(commitish: string, before: Date) {
      assertCommitish(commitish);
      let raw: string;
      try {
        raw = await gitFor(dir).raw([
          "log",
          "--first-parent",
          "--format=%H %at",
          commitish,
          "--",
        ]);
      } catch {
        return null;
      }
      const trusted = await trustedCommits(dir);
      const cutoff = Math.floor(before.getTime() / 1000);
      for (const line of raw.split("\n")) {
        const [sha, at] = line.split(" ");
        if (sha && trusted.has(sha) && Number(at) < cutoff) return sha;
      }
      return null;
    },
    async listCommitShas(
      commitish: string,
      options: { exclude: string | null; maxCount: number },
    ) {
      assertCommitish(commitish);
      if (options.exclude !== null) assertCommitish(options.exclude);
      try {
        const raw = await gitFor(dir).raw([
          "rev-list",
          "--max-count",
          String(options.maxCount),
          commitish,
          ...(options.exclude === null ? [] : ["--not", options.exclude]),
          "--",
        ]);
        return raw.split("\n").filter((sha) => GIT_SHA_RE.test(sha));
      } catch {
        return [];
      }
    },
    async logChangesForShas(shas: string[]): Promise<GitChangeEntry[]> {
      if (shas.length === 0) return [];
      for (const sha of shas) assertCommitish(sha);
      const raw = await gitFor(dir).raw([
        "log",
        "--no-walk=unsorted",
        "--name-status",
        "--diff-merges=first-parent",
        `--format=${CHANGE_LOG_FORMAT}`,
        ...shas,
        "--",
      ]);
      const trusted = await trustedCommits(dir);
      return parseChangeLog(raw).map((entry) => ({
        ...entry,
        trustedAuthor: trusted.has(entry.sha),
      }));
    },
    async fetchLocalRef(
      sourceGitDirectory: string,
      sourceRef: string,
      targetRef: string,
    ) {
      if (!path.isAbsolute(sourceGitDirectory)) {
        throw new Error("source Git directory must be an absolute path");
      }
      if (!GIT_REF_RE.test(sourceRef) || !GIT_REF_RE.test(targetRef)) {
        throw new Error("invalid ref");
      }
      await gitFor(dir).raw([
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--",
        sourceGitDirectory,
        `+${sourceRef}:${targetRef}`,
      ]);
      return (await gitFor(dir).raw(["rev-parse", targetRef])).trim();
    },
    async resetWorktreeTo(ref: string) {
      // A raw commit SHA is also accepted so a caller can recover the
      // worktree back to a known-good commit (e.g. after a failed merge)
      // without needing a symbolic ref for it.
      if (!GIT_REF_RE.test(ref) && !GIT_SHA_RE.test(ref)) {
        throw new Error("invalid ref");
      }
      await gitFor(dir).raw(["read-tree", "--reset", "-u", ref]);
    },
    async checkoutPathsFrom(commitish: string, paths: string[]) {
      assertCommitish(commitish);
      for (const relPath of paths) {
        if (!isSafeRepoRelativePath(relPath)) {
          throw new Error("invalid path");
        }
      }
      const git = gitFor(dir);
      for (let i = 0; i < paths.length; i += 200) {
        const chunk = paths.slice(i, i + 200);
        // --literal-pathspecs: a path containing *, ? or [ must not glob.
        await git.raw([
          "--literal-pathspecs",
          "checkout",
          commitish,
          "--",
          ...chunk,
        ]);
      }
    },
    async commitTreeWithParents(
      message: string,
      author: CommitAuthor,
      parents: string[],
    ) {
      if (isWikiAgentAuthor(author))
        throw new Error("wiki agent cannot author a merge commit");
      const git = gitFor(dir, author);
      await git.raw(["add", "-f", "-A"]);
      const tree = (await git.raw(["write-tree"])).trim();
      // commit-tree has no --trailer flag; append the trailer block the way
      // `git commit --trailer` would, so log readers parse it identically.
      const message_ = `${sanitizeCommitMessage(message)}\n\n${authorIdentityTrailer(author)}`;
      const args = ["commit-tree", tree];
      for (const parent of parents) args.push("-p", parent);
      args.push("-m", message_);
      const sha = (await git.raw(args)).trim();
      await currentProjectLock()?.assertHeld();
      await git.raw(["update-ref", "HEAD", sha]);
      await git.raw(["reset", "--hard", sha]);
      await rememberTrustedCommit(dir, sha);
      return sha;
    },
    async deleteRef(ref: string) {
      if (!GIT_REF_RE.test(ref)) throw new Error("invalid ref");
      await gitFor(dir).raw(["update-ref", "-d", ref]);
    },
  };
}

const READER_KEYS = [
  "resolveHead",
  "readCommittedFile",
  "readCommittedFileAt",
  "readCommittedBlobAt",
  "showFileAt",
  "blobShaAt",
  "blobSizeAt",
  "lastCommitForPath",
  "listTrackedFiles",
  "listTrackedBlobs",
  "readBlob",
  "readBlobsAt",
  "logForPath",
  "logChangesBefore",
  "logChangesForShas",
  "logSince",
  "orderCommits",
  "isAncestor",
  "firstParentTrustedBefore",
  "listCommitShas",
  "listHistoricalPaths",
  "renamedPathBetween",
  "commitDate",
] as const;

export type ProjectRepoWriter = ReturnType<typeof makeRepo>;
export type ProjectRepoReader = Pick<
  ProjectRepoWriter,
  (typeof READER_KEYS)[number]
>;

function makeRepoReader(repo: ProjectRepoWriter): ProjectRepoReader {
  return Object.fromEntries(
    READER_KEYS.map((key) => [key, repo[key].bind(repo)]),
  ) as ProjectRepoReader;
}

export async function withProjectRepo<T>(
  projectId: string,
  fn: (repo: ProjectRepoWriter) => Promise<T>,
): Promise<T> {
  return withProjectLock(projectId, async () => {
    const dir = repoDir(projectId);
    await ensureRepo(dir);
    await recover(dir);
    return fn(makeRepo(dir));
  });
}

export async function withExistingProjectRepo<T>(
  projectId: string,
  fn: (repo: ProjectRepoWriter) => Promise<T>,
): Promise<T | null> {
  return withProjectLock(projectId, async () => {
    const dir = repoDir(projectId);
    if (!(await exists(path.join(dir, ".git")))) return null;
    await recover(dir);
    return fn(makeRepo(dir));
  });
}

export async function withExistingProjectRepoReader<T>(
  projectId: string,
  fn: (repo: ProjectRepoReader) => Promise<T>,
): Promise<T | null> {
  return withProjectSharedLock(projectId, async () => {
    const dir = repoDir(projectId);
    if (!(await exists(path.join(dir, ".git")))) return null;
    return fn(makeRepoReader(makeRepo(dir)));
  });
}

export async function openProjectRepo(
  projectId: string,
): Promise<ProjectRepoReader | null> {
  const dir = repoDir(projectId);
  if (!(await exists(path.join(dir, ".git")))) return null;
  return makeRepoReader(makeRepo(dir));
}

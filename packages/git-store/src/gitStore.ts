import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  lstat,
  mkdir,
  open,
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
  ingestionRequestHash?: string | null;
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
        ...localGitEnvironment(dir),
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
    !relPath
      .split("/")
      .some((part) => part === ".." || part.toLowerCase() === ".git")
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
    segments.some((segment) => segment.toLowerCase() === ".git")
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

const PATH_LOG_FORMAT =
  "%x00WEAVER-COMMIT%x00%H%x00%an%x00%ae%x00%aI%x00" +
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
  "%(trailers:key=Weaver-Ingestion-Request-Hash,valueonly,separator=%x1f,unfold)%x00" +
  "%B%x00";
const PATH_LOG_FIELD_COUNT = 16;

const CHANGE_LOG_FORMAT =
  "%x00WEAVER-COMMIT%x00%H%x00%an%x00%ae%x00%aI%x00" +
  "%(trailers:key=Weaver-User-Id,valueonly,separator=%x1f,unfold)%x00" +
  "%(trailers:key=Weaver-Operation-Id,valueonly,separator=%x1f,unfold)%x00" +
  "%(trailers:key=Weaver-Run-Id,valueonly,separator=%x1f,unfold)%x00" +
  "%(trailers:key=Weaver-Project-Key-Id,valueonly,separator=%x1f,unfold)%x00" +
  "%(trailers:key=Weaver-Wiki-Agent-Id,valueonly,separator=%x1f,unfold)%x00" +
  "%B%x00";

function parseNameStatus(tokens: string[]): GitChangeEntry["changes"] {
  const changes: GitChangeEntry["changes"] = [];
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i]!.replace(/^\n+/, "");
    if (!/^[ACDMRTUXB][0-9]*$/.test(status)) continue;
    const first = tokens[++i];
    if (first === undefined) break;
    const renamed = /^[RC]/.test(status);
    const next = renamed ? tokens[++i] : first;
    if (next === undefined) break;
    if (!/^[AMDRC]/.test(status)) continue;
    changes.push({
      status: status[0] as GitChangeEntry["changes"][number]["status"],
      path: next,
      oldPath: renamed ? first : null,
    });
  }
  return changes;
}

function parseLogRecords(raw: string, fieldCount: number) {
  const tokens = raw.split("\0");
  const records: Array<{
    fields: string[];
    changes: GitChangeEntry["changes"];
  }> = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== "WEAVER-COMMIT" || !GIT_SHA_RE.test(tokens[i + 1] ?? ""))
      continue;
    const fields = tokens.slice(i + 1, i + 1 + fieldCount);
    i += fieldCount;
    const status: string[] = [];
    while (i + 1 < tokens.length && tokens[i + 1] !== "WEAVER-COMMIT") {
      const token = tokens[++i]!;
      status.push(token);
      if (/^[ACDMRTUXB][0-9]*$/.test(token.replace(/^\n+/, ""))) {
        status.push(tokens[++i] ?? "");
        if (/^[RC]/.test(token.replace(/^\n+/, "")))
          status.push(tokens[++i] ?? "");
      }
    }
    records.push({ fields, changes: parseNameStatus(status) });
  }
  return records;
}

function parseChangeLog(raw: string): GitChangeEntry[] {
  return parseLogRecords(raw, 10).map(({ fields, changes }) => {
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
    ] = fields;
    return {
      sha: sha!,
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

function parsePathLog(
  raw: string,
  trusted: Set<string>,
  relPath: string,
): GitLogEntry[] {
  return parseLogRecords(raw, PATH_LOG_FIELD_COUNT).map(
    ({ fields, changes }) => {
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
        ingestionRequestHashField,
        body,
      ] = fields;
      const pathAtSha = changes[0]?.path ?? relPath;
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
        ingestionRequestHash: trailerValue(
          ingestionRequestHashField,
          MCP_REQUEST_HASH_RE,
        ),
        apiRequestHash: trailerValue(apiHashField, MCP_REQUEST_HASH_RE),
        apiOperation: trailerValue(apiOperationField, API_OPERATION_RE),
        operationId: trailerValue(operationField, OPERATION_ID_RE),
        mcpRequestHash: trailerValue(mcpRequestHashField, MCP_REQUEST_HASH_RE),
        mcpToolName: trailerValue(mcpToolNameField, MCP_TOOL_NAME_RE),
        runId: trailerValue(runField, RUN_ID_RE),
        pathAtSha,
      };
    },
  );
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

function localGitEnvironment(dir: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: process.env.NODE_ENV ?? "production",
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: dir,
    XDG_CONFIG_HOME: dir,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    ...COMMITTER,
    GIT_CEILING_DIRECTORIES: serverEnv().WEAVER_DATA_DIR,
  };
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
    // The only custom config path is the fixed /dev/null global-config opt-out.
    unsafe: { allowUnsafeConfigPaths: true },
    timeout: { block: 60_000 },
    ...(currentProjectLock() ? { abort: currentProjectLock()!.signal } : {}),
  }).env({
    ...localGitEnvironment(dir),
    ...authorEnv,
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
          ...localGitEnvironment(dir),
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

async function readTrustLedger(
  dir: string,
  name: string,
): Promise<string | null> {
  try {
    return await readFile(path.join(dir, ".git", name), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    console.warn("Unable to read local commit attribution ledger");
    return null;
  }
}
const TRUST_CACHE_LIMIT = 32;
const trustCache = new Map<
  string,
  { signature: string; commits: Set<string> }
>();

async function trustSignature(dir: string): Promise<string | null> {
  try {
    return (
      await Promise.all(
        ["weaver-trusted-commits", "weaver-trusted-commits.pending"].map(
          async (name) => {
            const info = await stat(path.join(dir, ".git", name), {
              bigint: true,
            }).catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return null;
              throw error;
            });
            return info
              ? `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
              : "missing";
          },
        ),
      )
    ).join("/");
  } catch {
    return null;
  }
}

async function trustedCommits(dir: string): Promise<Set<string>> {
  const signature = await trustSignature(dir);
  const cached = trustCache.get(dir);
  if (signature !== null && cached?.signature === signature) {
    trustCache.delete(dir);
    trustCache.set(dir, cached);
    return cached.commits;
  }
  trustCache.delete(dir);
  const ledgers = await Promise.all([
    readTrustLedger(dir, "weaver-trusted-commits"),
    readTrustLedger(dir, "weaver-trusted-commits.pending"),
  ]);
  const commits = new Set(
    ledgers
      .join("\n")
      .split("\n")
      .filter((sha) => GIT_SHA_RE.test(sha)),
  );
  if (
    ledgers.every((ledger) => ledger !== null) &&
    signature !== null &&
    signature === (await trustSignature(dir))
  ) {
    trustCache.set(dir, { signature, commits });
    if (trustCache.size > TRUST_CACHE_LIMIT)
      trustCache.delete(trustCache.keys().next().value!);
  }
  return commits;
}

async function appendDurably(file: string, text: string) {
  const handle = await open(file, "a", 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncGitDirectory(dir: string) {
  const directory = await open(path.join(dir, ".git"), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function prepareTrustedCommit(dir: string, sha: string) {
  const commits = await trustedCommits(dir);
  const cacheable = trustCache.get(dir)?.commits === commits;
  await appendDurably(
    path.join(dir, ".git", "weaver-trusted-commits.pending"),
    `\n${sha}\n`,
  );
  await syncGitDirectory(dir);
  commits.add(sha);
  const signature = await trustSignature(dir);
  if (cacheable && signature !== null)
    trustCache.set(dir, { signature, commits });
}

async function rememberTrustedCommit(dir: string, sha: string) {
  const commits = await trustedCommits(dir);
  const cacheable = trustCache.get(dir)?.commits === commits;
  const pendingPath = path.join(dir, ".git", "weaver-trusted-commits.pending");
  const pending = await readTrustLedger(dir, "weaver-trusted-commits.pending");
  if (pending === null) return;
  try {
    await appendDurably(
      path.join(dir, ".git", "weaver-trusted-commits"),
      `\n${[...new Set([...pending.split("\n").filter((entry) => GIT_SHA_RE.test(entry)), sha])].join("\n")}\n`,
    );
    await syncGitDirectory(dir);
    await rmFile(pendingPath, { force: true });
  } catch {
    // Published commits remain trusted through the durable pending ledger.
    console.warn("Local commit attribution requires reconciliation");
  }
  const signature = await trustSignature(dir);
  if (cacheable && signature !== null)
    trustCache.set(dir, { signature, commits });
}

const operationCache = new Map<
  string,
  { head: string; byId: Map<string, string[]> }
>();
const operationRefreshes = new Map<string, Promise<void>>();
function operationCommits(dir: string, head: string, operationId: string) {
  const previous = operationRefreshes.get(dir) ?? Promise.resolve();
  const result = previous.then(() =>
    refreshOperationCommits(dir, head, operationId),
  );
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  operationRefreshes.set(dir, settled);
  return result.finally(() => {
    if (operationRefreshes.get(dir) === settled) operationRefreshes.delete(dir);
  });
}

async function refreshOperationCommits(
  dir: string,
  head: string,
  operationId: string,
) {
  let cached = operationCache.get(dir);
  if (cached?.head !== head) {
    let append = false;
    if (cached) {
      append =
        (
          await gitFor(dir)
            .raw(["merge-base", cached.head, head])
            .catch(() => "")
        ).trim() === cached.head;
    }
    const byId = append ? cached!.byId : new Map<string, string[]>();
    const raw = await gitFor(dir).raw([
      "log",
      "-z",
      "--format=%x00WEAVER-COMMIT%x00%H%x00%(trailers:key=Weaver-Operation-Id,valueonly,separator=%x1f,unfold)%x00",
      head,
      ...(append ? ["--not", cached!.head] : []),
      "--",
    ]);
    const additions = new Map<string, string[]>();
    for (const {
      fields: [sha, operation],
    } of parseLogRecords(raw, 2)) {
      const id = trailerValue(operation, OPERATION_ID_RE);
      if (id && sha) {
        const shas = additions.get(id) ?? [];
        shas.push(sha);
        additions.set(id, shas);
      }
    }
    for (const [id, shas] of additions)
      byId.set(id, [...shas, ...(byId.get(id) ?? [])]);
    cached = { head, byId };
    operationCache.set(dir, cached);
    if (operationCache.size > TRUST_CACHE_LIMIT)
      operationCache.delete(operationCache.keys().next().value!);
  }
  return cached.byId.get(operationId) ?? [];
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
      const tracked = await gitFor(dir).raw([
        "--literal-pathspecs",
        "ls-files",
        "--",
        relPath,
      ]);
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
      await gitFor(dir).raw(["--literal-pathspecs", "mv", "--", from, to]);
    },
    async rm(relPath: string) {
      await worktreePathState(dir, relPath);
      await gitFor(dir).raw(["--literal-pathspecs", "rm", "-q", "--", relPath]);
    },
    async rmDir(folderRel: string) {
      await worktreePathState(dir, folderRel);
      await gitFor(dir).raw([
        "--literal-pathspecs",
        "rm",
        "-r",
        "-q",
        "--",
        folderRel,
      ]);
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
        ingestionRequestHash?: string;
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
      const ingestionRequestHash = options?.ingestionRequestHash;
      if (
        ingestionRequestHash !== undefined &&
        (author.kind === "machine" ||
          !operationId?.startsWith("ingestion:") ||
          !MCP_REQUEST_HASH_RE.test(ingestionRequestHash))
      ) {
        throw new Error("invalid ingestion request identity");
      }
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
      if (ingestionRequestHash !== undefined)
        args.push(
          "--trailer",
          `Weaver-Ingestion-Request-Hash: ${ingestionRequestHash}`,
        );
      if (wikiInputId !== undefined)
        args.push("--trailer", `Weaver-Wiki-Input-Id: ${wikiInputId}`);
      if (overridden.length > 0) {
        args.push(
          "--trailer",
          `Weaver-Metadata-Override: ${overridden.join(",")}`,
        );
      }
      const parent = (await git.revparse(["HEAD"])).trim();
      const tree = (await git.raw(["write-tree"])).trim();
      if (tree === (await git.revparse(["HEAD^{tree}"])).trim()) {
        await currentProjectLock()?.assertHeld();
        await options?.beforeCommit?.();
        await currentProjectLock()?.assertHeld();
        return parent;
      }
      const trailers = args.flatMap((arg, index) =>
        arg === "--trailer" ? [args[index + 1]!] : [],
      );
      const sha = (
        await git.raw([
          "commit-tree",
          tree,
          "-p",
          parent,
          "-m",
          `${sanitizeCommitMessage(message)}\n\n${trailers.join("\n")}`,
        ])
      ).trim();
      await prepareTrustedCommit(dir, sha);
      await currentProjectLock()?.assertHeld();
      await options?.beforeCommit?.();
      await currentProjectLock()?.assertHeld();
      await git.raw(["update-ref", "HEAD", sha, parent]);
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
        "--literal-pathspecs",
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
        "--literal-pathspecs",
        "log",
        "--format=",
        "--name-status",
        "-z",
        "--diff-merges=first-parent",
        "--find-renames",
        "--diff-filter=DR",
        "-z",
        "--",
        ...(prefix ? [prefix] : []),
      ]);
      return [
        ...new Set(
          parseNameStatus(out.split("\0")).map(
            (change) => change.oldPath ?? change.path,
          ),
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
          "-z",
          "-z",
          "--find-renames",
          fromCommitish,
          toCommitish,
          "--",
        ]);
        for (const change of parseNameStatus(out.split("\0"))) {
          if (change.status === "R" && change.oldPath === relPath)
            return change.path;
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
        trustedOperationsOnly = false,
      }: {
        skip: number;
        limit: number;
        commitish?: string;
        operationId?: string;
        trustedOperationsOnly?: boolean;
      },
    ) {
      if (trustedOperationsOnly && (relPath !== "." || !operationId))
        throw new Error(
          "trusted operation history requires a repository-wide operation id lookup",
        );
      const indexedShas =
        operationId && relPath === "."
          ? await operationCommits(
              dir,
              (await resolveCommit(dir, commitish)) ?? commitish,
              operationId,
            )
          : null;
      const trusted = trustedOperationsOnly
        ? await trustedCommits(dir)
        : undefined;
      const operationShas =
        trusted && indexedShas
          ? indexedShas.filter((sha) => trusted.has(sha))
          : indexedShas;
      if (operationShas?.length === 0) return [];
      const raw = await gitFor(dir).raw([
        "--literal-pathspecs",
        "log",
        ...(operationShas ? ["--no-walk=unsorted"] : ["--follow"]),
        "--name-status",
        "-z",
        "-n",
        String(skip + limit),
        ...(operationId
          ? ["--fixed-strings", `--grep=Weaver-Operation-Id: ${operationId}`]
          : []),
        `--format=${PATH_LOG_FORMAT}`,
        ...(operationShas?.slice(0, skip + limit) ?? [commitish]),
        "--",
        relPath,
      ]);
      return parsePathLog(
        raw,
        trusted ?? (await trustedCommits(dir)),
        relPath,
      ).slice(skip, skip + limit);
    },
    async latestLogForPaths(paths: string[], commitish: string) {
      assertCommitish(commitish);
      if (paths.length === 0) return new Map<string, GitLogEntry>();
      const wanted = new Set(paths);
      const ancestry = (
        await gitFor(dir).raw([
          "rev-list",
          "--parents",
          "--topo-order",
          commitish,
          "--",
        ])
      )
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(" "));
      if (ancestry.some((entry) => entry.length > 2)) {
        // Merge simplification must follow the same path history as ordinary reads.
        const latest = new Map<string, GitLogEntry>();
        for (const relPath of wanted) {
          const [entry] = await this.logForPath(relPath, {
            skip: 0,
            limit: 1,
            commitish,
          });
          if (entry) latest.set(relPath, entry);
        }
        return latest;
      }
      const shas = ancestry
        .map(([sha]) => sha!)
        .filter((sha) => GIT_SHA_RE.test(sha));
      const trusted = await trustedCommits(dir);
      const latest = new Map<string, GitLogEntry>();
      for (
        let offset = 0;
        offset < shas.length && latest.size < wanted.size;
        offset += 200
      ) {
        const raw = await gitFor(dir).raw([
          "log",
          "--no-walk=unsorted",
          "--name-status",
          "-z",
          "--diff-merges=first-parent",
          `--format=${PATH_LOG_FORMAT}`,
          ...shas.slice(offset, offset + 200),
          "--",
        ]);
        const records = parseLogRecords(raw, PATH_LOG_FIELD_COUNT);
        const entries = parsePathLog(raw, trusted, "");
        for (const [index, record] of records.entries()) {
          for (const change of record.changes) {
            if (wanted.has(change.path) && !latest.has(change.path))
              latest.set(change.path, {
                ...entries[index]!,
                pathAtSha: change.path,
              });
          }
        }
      }
      return latest;
    },
    async logSince(
      fromSha: string | null,
      options: { limit: number; sinceDate?: Date },
    ): Promise<GitChangeEntry[]> {
      const raw = await gitFor(dir).raw([
        "log",
        "--name-status",
        "-z",
        "--diff-merges=first-parent",
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
          "-z",
          "--diff-merges=first-parent",
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
      options: { exclude: string | null; maxCount: number; skip?: number },
    ) {
      assertCommitish(commitish);
      if (options.exclude !== null) assertCommitish(options.exclude);
      try {
        const raw = await gitFor(dir).raw([
          "rev-list",
          "--max-count",
          String(options.maxCount),
          ...(options.skip === undefined ? [] : [`--skip=${options.skip}`]),
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
        "-z",
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
    async createTreeCommit(
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
      return (await git.raw(args)).trim();
    },
    async publishTreeCommit(
      sha: string,
      expectedHead: string,
      preparedParent?: string,
    ) {
      if (!GIT_SHA_RE.test(sha) || !GIT_SHA_RE.test(expectedHead))
        throw new Error("invalid commit SHA");
      if (preparedParent !== undefined) {
        if (!GIT_SHA_RE.test(preparedParent))
          throw new Error("invalid commit SHA");
        await prepareTrustedCommit(dir, preparedParent);
      }
      await prepareTrustedCommit(dir, sha);
      await currentProjectLock()?.assertHeld();
      // createTreeCommit already staged this exact tree.
      await gitFor(dir).raw(["update-ref", "HEAD", sha, expectedHead]);
      await rememberTrustedCommit(dir, sha).catch(() => {
        console.warn("Local commit attribution requires reconciliation");
      });
    },
    async commitTreeWithParents(
      message: string,
      author: CommitAuthor,
      parents: string[],
    ) {
      const expectedHead = await this.resolveHead();
      const sha = await this.createTreeCommit(message, author, parents);
      await this.publishTreeCommit(sha, expectedHead);
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
  "latestLogForPaths",
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

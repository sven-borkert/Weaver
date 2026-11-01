import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** `git cat-file --batch -z` (batched blob reads) needs Git 2.36. */
export const MIN_GIT_VERSION = "2.36.0";
/** A missing or old Git is re-checked this often, so an upgrade clears the banner without a restart. */
export const GIT_FAILURE_CACHE_MS = 30_000;

export type GitRuntimeStatus =
  | { status: "ok"; version: string }
  | { status: "missing" }
  | { status: "unsupported"; version: string; minimum: string };

const VERSION_RE = /^git version (\d+)\.(\d+)(?:\.(\d+))?/;

/** Parses `git --version` output, e.g. `git version 2.39.3 (Apple Git-145)`. */
export function parseGitVersion(
  output: string,
): [number, number, number] | null {
  const match = VERSION_RE.exec(output.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

export function classifyGitVersion(output: string): GitRuntimeStatus {
  const parsed = parseGitVersion(output);
  if (!parsed) return { status: "missing" };
  const version = parsed.join(".");
  const minimum = MIN_GIT_VERSION.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (parsed[i]! > minimum[i]!) break;
    if (parsed[i]! < minimum[i]!) {
      return { status: "unsupported", version, minimum: MIN_GIT_VERSION };
    }
  }
  return { status: "ok", version };
}

async function gitVersionOutput(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["--version"], {
    timeout: 5_000,
  });
  return stdout;
}

export function createGitRuntimeCheck(
  deps: { exec: () => Promise<string>; now: () => number } = {
    exec: gitVersionOutput,
    now: Date.now,
  },
): () => Promise<GitRuntimeStatus> {
  let cached: { result: GitRuntimeStatus; until: number } | undefined;
  return async () => {
    if (cached && deps.now() < cached.until) return cached.result;
    let result: GitRuntimeStatus;
    try {
      result = classifyGitVersion(await deps.exec());
    } catch {
      result = { status: "missing" };
    }
    cached = {
      result,
      until:
        result.status === "ok"
          ? Number.POSITIVE_INFINITY
          : deps.now() + GIT_FAILURE_CACHE_MS,
    };
    return result;
  };
}

export const checkGitRuntime = createGitRuntimeCheck();

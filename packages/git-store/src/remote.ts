import { resolveSshTargetAddress } from "@weaver/config/outboundSsh";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { repoDir, withExistingProjectRepoReader } from "./gitStore";
import {
  runGitRemoteCommand,
  type GitRemoteCommand,
  type GitRemoteCommandResult,
} from "./remoteCommand";

export type { GitRemoteCommand, GitRemoteCommandResult } from "./remoteCommand";
const messages = {
  INVALID_REMOTE_URL:
    "Use an SSH Git URL such as git@host:team/repository.git.",
  INVALID_BRANCH: "Use a valid branch name such as main or backup/project.",
  INVALID_PRIVATE_KEY: "Upload a valid unencrypted OpenSSH or PEM private key.",
  ENCRYPTED_PRIVATE_KEY:
    "This key requires a passphrase. Upload an unencrypted deployment key.",
  REPOSITORY_NOT_FOUND: "The project has no committed Git repository to push.",
  REMOTE_BRANCH_MISSING:
    "The remote branch does not exist yet. Push existing content before pulling.",
  HOST_KEY_CHANGED:
    "The remote SSH host key does not match the saved host key. Verify the remote before reconnecting.",
  AUTHENTICATION_FAILED:
    "The SSH key was not accepted. Check the deployment key and repository write access.",
  REMOTE_REJECTED:
    "The remote rejected the push. Check branch permissions and conflicting remote commits.",
  NETWORK_ERROR:
    "The Git remote could not be reached. Check its address and network access.",
  TIMEOUT: "The Git remote operation timed out and can be retried.",
  CANCELLED: "The Git remote operation was cancelled and can be retried.",
  PUSH_FAILED: "The Git push failed. Check the remote configuration and retry.",
  MERGE_FAILED:
    "The fetched remote branch could not be merged into the project repository.",
  UNSUPPORTED_REMOTE_CONTENT:
    "The remote branch contains symbolic links or submodules, which Weaver does not support.",
} as const;
export type GitRemoteErrorCode = keyof typeof messages;

export class GitRemoteError extends Error {
  constructor(
    public readonly code: GitRemoteErrorCode,
    public readonly knownHosts: string | null = null,
    /** Operator-facing cause for the diagnostics log; never shown to project members. */
    public readonly detail: string | null = null,
  ) {
    super(messages[code]);
    this.name = "GitRemoteError";
  }
}

export function pinnedHostFingerprints(knownHosts: string | null): string[] {
  if (!knownHosts || knownHosts.length > 65_536) return [];
  const fingerprints = new Set<string>();
  for (const line of knownHosts.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields[0]?.startsWith("#")) continue;
    const key = fields[0]?.startsWith("@") ? fields[3] : fields[2];
    if (!key || !/^[A-Za-z0-9+/]+={0,2}$/.test(key)) continue;
    fingerprints.add(
      `SHA256:${createHash("sha256").update(Buffer.from(key, "base64")).digest("base64").replace(/=+$/, "")}`,
    );
  }
  return [...fingerprints];
}

export function validateGitRemoteTarget(
  url: string,
  branch: string,
): { url: string; branch: string } {
  if (/[\x00-\x1f\x7f]/.test(url) || url.length > 2048)
    throw new GitRemoteError("INVALID_REMOTE_URL");
  url = url.trim();
  const user = "(?:[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}@)?";
  const host = "(\\[[0-9A-Fa-f:]+\\]|[A-Za-z0-9][A-Za-z0-9.-]{0,252})";
  const match = url.startsWith("ssh://")
    ? new RegExp(`^ssh://${user}${host}(?::([0-9]{1,5}))?(/[^?#]+)$`).exec(url)
    : new RegExp(`^${user}${host}:([^?#]+)$`).exec(url);
  const hostname = match?.[1];
  const port = url.startsWith("ssh://") ? match?.[2] : undefined;
  const remotePath = url.startsWith("ssh://") ? match?.[3] : match?.[2];
  const validHost = hostname?.startsWith("[")
    ? isIP(hostname.slice(1, -1)) === 6
    : hostname
        ?.split(".")
        .every((label) =>
          /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label),
        );
  if (
    !validHost ||
    (port !== undefined && (+port < 1 || +port > 65535)) ||
    !remotePath ||
    !/^\/?[A-Za-z0-9_~][A-Za-z0-9_./~-]*$/.test(remotePath) ||
    remotePath.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new GitRemoteError("INVALID_REMOTE_URL");
  }
  if (/[\x00-\x1f\x7f]/.test(branch))
    throw new GitRemoteError("INVALID_BRANCH");
  branch = branch.trim();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/.test(branch) ||
    branch.startsWith("refs/") ||
    branch.includes("..") ||
    branch.endsWith(".") ||
    branch
      .split("/")
      .some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
  ) {
    throw new GitRemoteError("INVALID_BRANCH");
  }
  return { url, branch };
}

function isolatedEnvironment(directory: string): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    NODE_ENV: "production",
    HOME: directory,
    XDG_CONFIG_HOME: directory,
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "ssh",
    GIT_SSH_VARIANT: "ssh",
    SSH_ASKPASS_REQUIRE: "never",
  };
}

async function removeTemporaryDirectory(directory: string): Promise<void> {
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
}

async function temporaryDirectory<T>(
  fn: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), "weaver-git-remote-"));
  try {
    await chmod(directory, 0o700);
    return await fn(directory);
  } finally {
    await removeTemporaryDirectory(directory);
  }
}

async function writePrivateKey(directory: string, key: string) {
  if (
    key.length > 65_536 ||
    key.includes("\0") ||
    !/^-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/.test(
      key.trim(),
    )
  ) {
    throw new GitRemoteError("INVALID_PRIVATE_KEY");
  }
  const keyPath = path.join(directory, "identity");
  await writeFile(keyPath, `${key.trim()}\n`, { mode: 0o600, flag: "wx" });
  return keyPath;
}

function commandDetail(result: GitRemoteCommandResult): string | null {
  return result.stderr.trim().slice(-1000) || null;
}
function errorDetail(error: unknown): string | null {
  if (error instanceof GitRemoteError) return error.detail;
  return error instanceof Error ? error.message.slice(0, 1000) : null;
}

function commandError(result: GitRemoteCommandResult): GitRemoteErrorCode {
  if (result.stopped) return result.stopped;
  if (
    /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(
      result.stderr,
    )
  )
    return "HOST_KEY_CHANGED";
  if (
    /Permission denied|Authentication failed|Could not read from remote repository/i.test(
      result.stderr,
    )
  )
    return "NETWORK_ERROR";
  if (
    /\[rejected\]|\[remote rejected\]|non-fast-forward|fetch first|pre-receive hook declined/i.test(
      `${result.stdout}\n${result.stderr}`,
    )
  )
    return "REMOTE_REJECTED";
  if (
    /Could not resolve hostname|Connection refused|Connection timed out|Network is unreachable|Connection reset|Connection closed/i.test(
      result.stderr,
    )
  )
    return "NETWORK_ERROR";
  return "PUSH_FAILED";
}

function fetchCommandError(result: GitRemoteCommandResult): GitRemoteErrorCode {
  if (result.stopped) return result.stopped;
  if (
    /couldn't find remote ref|Remote branch .* not found/i.test(
      `${result.stdout}\n${result.stderr}`,
    )
  )
    return "REMOTE_BRANCH_MISSING";
  return commandError(result);
}

// Only generated local file paths and fixed options enter Git's SSH shell command.
function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function sshCommand(
  directory: string,
  pinned: boolean,
  target: { hostKeyAlias: string; address: string },
) {
  return [
    "ssh",
    "-F",
    "/dev/null",
    "-i",
    path.join(directory, "identity"),
    "-o",
    "BatchMode=yes",
    "-o",
    `Hostname=${target.address}`,
    "-o",
    `HostKeyAlias=${target.hostKeyAlias}`,
    "-o",
    "CanonicalizeHostname=no",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "IdentityAgent=none",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    "-o",
    "PreferredAuthentications=publickey",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "ProxyCommand=none",
    "-o",
    "ProxyJump=none",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    `UserKnownHostsFile=${path.join(directory, "known_hosts")}`,
    "-o",
    `StrictHostKeyChecking=${pinned ? "yes" : "accept-new"}`,
    "-o",
    "UpdateHostKeys=no",
    "-o",
    "VerifyHostKeyDNS=no",
    "-o",
    "ConnectTimeout=20",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
  ]
    .map(shellQuote)
    .join(" ");
}

export type PushProjectToRemoteInput = {
  projectId: string;
  remoteUrl: string;
  branch: string;
  privateKey: string;
  knownHosts: string | null;
  lastPushedSha?: string | null;
  signal?: AbortSignal;
};
export type PushProjectToRemoteResult = {
  commitSha: string;
  knownHosts: string | null;
  skipped?: boolean;
};

export type FetchRemoteBranchInput = {
  remoteUrl: string;
  branch: string;
  privateKey: string;
  knownHosts: string | null;
  signal?: AbortSignal;
};
export type FetchedRemoteBranch = {
  bareDirectory: string;
  remoteHead: string;
  knownHosts: string | null;
  dispose(): Promise<void>;
};

export function createGitRemoteTransport(
  dependencies: {
    runCommand?: (command: GitRemoteCommand) => Promise<GitRemoteCommandResult>;
    captureHead?: (projectId: string) => Promise<string | null>;
    repositoryDirectory?: (projectId: string) => string;
    resolveAddress?: typeof resolveSshTargetAddress;
  } = {},
) {
  const run = dependencies.runCommand ?? runGitRemoteCommand;
  const captureHead =
    dependencies.captureHead ??
    ((projectId: string) =>
      withExistingProjectRepoReader(projectId, (repo) => repo.resolveHead()));
  const repositoryDirectory = dependencies.repositoryDirectory ?? repoDir;
  const resolveAddress = dependencies.resolveAddress ?? resolveSshTargetAddress;
  const approvedTarget = async (remoteUrl: string, signal?: AbortSignal) => {
    const separator = remoteUrl.lastIndexOf(":");
    const target = new URL(
      remoteUrl.startsWith("ssh://")
        ? remoteUrl
        : `ssh://${remoteUrl.slice(0, separator)}/${remoteUrl.slice(separator + 1)}`,
    );
    const hostname = target.hostname.replace(/^\[|\]$/g, "");
    const port = Number(target.port || 22);
    const hostKeyAlias = port === 22 ? hostname : `[${hostname}]:${port}`;
    try {
      return {
        hostKeyAlias,
        address: await resolveAddress(hostname, port, { signal }),
      };
    } catch (error) {
      throw new GitRemoteError(
        signal?.aborted ? "CANCELLED" : "NETWORK_ERROR",
        null,
        errorDetail(error),
      );
    }
  };

  async function inspectSshPrivateKey(
    privateKey: string,
  ): Promise<{ fingerprint: string }> {
    try {
      return await temporaryDirectory(async (directory) => {
        const keyPath = await writePrivateKey(directory, privateKey);
        const result = await run({
          executable: "ssh-keygen",
          args: ["-y", "-P", "", "-f", keyPath],
          cwd: directory,
          env: isolatedEnvironment(directory),
          timeoutMs: 10_000,
        });
        if (result.code !== 0 || result.stopped)
          throw new GitRemoteError(
            /passphrase|encrypted/i.test(result.stderr)
              ? "ENCRYPTED_PRIVATE_KEY"
              : "INVALID_PRIVATE_KEY",
          );
        const publicKey = result.stdout.trim().split(/\s+/)[1];
        if (!publicKey || !/^[A-Za-z0-9+/]+={0,2}$/.test(publicKey))
          throw new GitRemoteError("INVALID_PRIVATE_KEY");
        return {
          fingerprint: `SHA256:${createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("base64").replace(/=+$/, "")}`,
        };
      });
    } catch (error) {
      throw error instanceof GitRemoteError
        ? error
        : new GitRemoteError("INVALID_PRIVATE_KEY");
    }
  }

  async function pushProjectToRemote(
    input: PushProjectToRemoteInput,
  ): Promise<PushProjectToRemoteResult> {
    let knownHosts = input.knownHosts?.trim() ? input.knownHosts : null;
    try {
      const target = validateGitRemoteTarget(input.remoteUrl, input.branch);
      if (input.signal?.aborted) throw new GitRemoteError("CANCELLED");
      const commitSha = await captureHead(input.projectId);
      if (!commitSha || !/^[a-f0-9]{40,64}$/.test(commitSha))
        throw new GitRemoteError("REPOSITORY_NOT_FOUND");
      if (commitSha === input.lastPushedSha)
        return { commitSha, knownHosts, skipped: true };
      const approved = await approvedTarget(target.url, input.signal);
      return await temporaryDirectory(async (directory) => {
        await writePrivateKey(directory, input.privateKey);
        const hostFile = path.join(directory, "known_hosts");
        if (
          knownHosts &&
          (knownHosts.length > 65_536 || knownHosts.includes("\0"))
        )
          throw new GitRemoteError("HOST_KEY_CHANGED");
        await writeFile(hostFile, knownHosts ?? "", {
          mode: 0o600,
          flag: "wx",
        });
        const env = isolatedEnvironment(directory);
        const gitDirectory = path.join(directory, "repository.git");
        const initialized = await run({
          executable: "git",
          args: ["init", "--bare", "--template=", gitDirectory],
          cwd: directory,
          env,
          signal: input.signal,
          timeoutMs: 10_000,
        });
        if (initialized.code !== 0 || initialized.stopped)
          throw new GitRemoteError(
            commandError(initialized),
            null,
            commandDetail(initialized),
          );
        env.GIT_OBJECT_DIRECTORY = path.join(
          repositoryDirectory(input.projectId),
          ".git",
          "objects",
        );
        env.GIT_SSH_COMMAND = sshCommand(
          directory,
          knownHosts !== null,
          approved,
        );
        let result: GitRemoteCommandResult;
        try {
          result = await run({
            executable: "git",
            args: [
              "--git-dir",
              gitDirectory,
              "-c",
              "core.hooksPath=/dev/null",
              "push",
              "--porcelain",
              "--",
              target.url,
              `${commitSha}:refs/heads/${target.branch}`,
            ],
            cwd: directory,
            env,
            signal: input.signal,
            timeoutMs: 120_000,
          });
        } finally {
          await rm(path.join(directory, "identity"), { force: true });
          if ((await stat(hostFile)).size <= 65_536)
            knownHosts = (await readFile(hostFile, "utf8")) || knownHosts;
        }
        if (result.code !== 0 || result.stopped)
          throw new GitRemoteError(
            commandError(result),
            null,
            commandDetail(result),
          );
        if (!knownHosts?.trim()) throw new GitRemoteError("PUSH_FAILED");
        return { commitSha, knownHosts };
      });
    } catch (error) {
      throw new GitRemoteError(
        error instanceof GitRemoteError ? error.code : "PUSH_FAILED",
        knownHosts,
        errorDetail(error),
      );
    }
  }
  async function fetchRemoteBranch(
    input: FetchRemoteBranchInput,
  ): Promise<FetchedRemoteBranch> {
    let knownHosts = input.knownHosts?.trim() ? input.knownHosts : null;
    let directory: string | undefined;
    try {
      const target = validateGitRemoteTarget(input.remoteUrl, input.branch);
      if (input.signal?.aborted) throw new GitRemoteError("CANCELLED");
      const approved = await approvedTarget(target.url, input.signal);
      directory = await mkdtemp(path.join(tmpdir(), "weaver-git-remote-"));
      await chmod(directory, 0o700);
      await writePrivateKey(directory, input.privateKey);
      const hostFile = path.join(directory, "known_hosts");
      if (
        knownHosts &&
        (knownHosts.length > 65_536 || knownHosts.includes("\0"))
      )
        throw new GitRemoteError("HOST_KEY_CHANGED");
      await writeFile(hostFile, knownHosts ?? "", {
        mode: 0o600,
        flag: "wx",
      });
      const env = isolatedEnvironment(directory);
      const bareDirectory = path.join(directory, "fetched.git");
      const initialized = await run({
        executable: "git",
        args: ["init", "--bare", "--template=", bareDirectory],
        cwd: directory,
        env,
        signal: input.signal,
        timeoutMs: 10_000,
      });
      if (initialized.code !== 0 || initialized.stopped)
        throw new GitRemoteError(
          commandError(initialized),
          null,
          commandDetail(initialized),
        );
      env.GIT_SSH_COMMAND = sshCommand(
        directory,
        knownHosts !== null,
        approved,
      );
      let result: GitRemoteCommandResult;
      try {
        result = await run({
          executable: "git",
          args: [
            "--git-dir",
            bareDirectory,
            "-c",
            "core.hooksPath=/dev/null",
            "fetch",
            "--no-tags",
            "--",
            target.url,
            `+refs/heads/${target.branch}:refs/heads/${target.branch}`,
          ],
          cwd: directory,
          env,
          signal: input.signal,
          timeoutMs: 60_000,
        });
      } finally {
        await rm(path.join(directory, "identity"), { force: true });
        if ((await stat(hostFile)).size <= 65_536)
          knownHosts = (await readFile(hostFile, "utf8")) || knownHosts;
      }
      if (result.code !== 0 || result.stopped)
        throw new GitRemoteError(
          fetchCommandError(result),
          null,
          commandDetail(result),
        );
      const revParse = await run({
        executable: "git",
        args: [
          "--git-dir",
          bareDirectory,
          "rev-parse",
          `refs/heads/${target.branch}`,
        ],
        cwd: directory,
        env,
        signal: input.signal,
        timeoutMs: 10_000,
      });
      const remoteHead = revParse.stdout.trim();
      if (
        revParse.code !== 0 ||
        revParse.stopped ||
        !/^[a-f0-9]{40,64}$/.test(remoteHead)
      )
        throw new GitRemoteError(
          commandError(revParse),
          null,
          commandDetail(revParse),
        );
      const resolvedDirectory = directory;
      return {
        bareDirectory,
        remoteHead,
        knownHosts,
        dispose: () => removeTemporaryDirectory(resolvedDirectory),
      };
    } catch (error) {
      if (directory) await removeTemporaryDirectory(directory);
      throw new GitRemoteError(
        error instanceof GitRemoteError ? error.code : "PUSH_FAILED",
        knownHosts,
        errorDetail(error),
      );
    }
  }
  return { inspectSshPrivateKey, pushProjectToRemote, fetchRemoteBranch };
}

export const { inspectSshPrivateKey, pushProjectToRemote, fetchRemoteBranch } =
  createGitRemoteTransport();

export async function sweepStaleGitRemoteKeys(now = Date.now()): Promise<void> {
  for (const entry of await readdir(tmpdir(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("weaver-git-remote-"))
      continue;
    const directory = path.join(tmpdir(), entry.name);
    try {
      const info = await stat(directory);
      if (info.uid === process.getuid?.() && now - info.mtimeMs > 86_400_000)
        await removeTemporaryDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

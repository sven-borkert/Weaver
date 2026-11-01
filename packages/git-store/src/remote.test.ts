import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createGitRemoteTransport,
  inspectSshPrivateKey,
  validateGitRemoteTarget,
  type GitRemoteCommand,
} from "./remote";

const exec = promisify(execFile);
let directory: string;
let privateKey: string;
let encryptedKey: string;
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "weaver-remote-test-"));
  for (const [name, passphrase] of [
    ["key", ""],
    ["encrypted", "test-only"],
  ]) {
    await exec("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      passphrase!,
      "-f",
      path.join(directory, name!),
    ]);
  }
  privateKey = await readFile(path.join(directory, "key"), "utf8");
  encryptedKey = await readFile(path.join(directory, "encrypted"), "utf8");
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("Git remote target validation", () => {
  it.each([
    "git@example.test:team/repo.git",
    "ssh://git@example.test:2222/team/repo.git",
    "ssh://git@[::1]:2222/team/repo.git",
  ])("accepts SSH target %s", (url) => {
    expect(validateGitRemoteTarget(` ${url} `, " topic/backup ")).toEqual({
      url,
      branch: "topic/backup",
    });
  });
  it.each([
    "https://git:secret@example.test/repo",
    "file:///repo",
    "ext::sh -c whoami",
    "/repo",
    "-oProxyCommand=evil:path",
    "git@-host:repo",
    "git@host:-repo",
    "git@host:repo;touch",
    "git@host:repo$(id)",
    "ssh://git:secret@host/repo",
    "ssh://git@host/repo%0aevil",
    "ssh://git@host/repo?x",
    "git@host:repo\n",
    "git@host:../repo",
    "ssh://git@host:0/repo",
  ])("rejects unsafe URL %j", (url) => {
    expect(() => validateGitRemoteTarget(url, "main")).toThrow(
      expect.objectContaining({ code: "INVALID_REMOTE_URL" }),
    );
  });
  it.each([
    "",
    "-main",
    "refs/heads/main",
    "a..b",
    "a.lock",
    "a/.b",
    "a//b",
    "a@{b",
    "a:b",
    "a b",
    "a*",
    "a\\b",
    "a/",
    "a.",
    "a\nb",
  ])("rejects invalid branch %j", (branch) => {
    expect(() => validateGitRemoteTarget("git@host:repo", branch)).toThrow(
      expect.objectContaining({ code: "INVALID_BRANCH" }),
    );
  });
});

describe("SSH private keys", () => {
  it("derives the same fingerprint as OpenSSH", async () => {
    const { stdout } = await exec("ssh-keygen", [
      "-l",
      "-E",
      "sha256",
      "-f",
      path.join(directory, "key.pub"),
    ]);
    expect(await inspectSshPrivateKey(privateKey)).toEqual({
      fingerprint: stdout.split(" ")[1],
    });
  });
  it("rejects encrypted keys without waiting for input", async () => {
    await expect(inspectSshPrivateKey(encryptedKey)).rejects.toMatchObject({
      code: "ENCRYPTED_PRIVATE_KEY",
    });
  });
  it("rejects invalid keys without returning their contents", async () => {
    await expect(
      inspectSshPrivateKey("PRIVATE-SENTINEL"),
    ).rejects.toMatchObject({
      code: "INVALID_PRIVATE_KEY",
      message: "Upload a valid unencrypted OpenSSH or PEM private key.",
    });
  });
});

const sha = "a".repeat(40);
const pinnedHost = "example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPinned\n";
const input = () => ({
  projectId: "project",
  remoteUrl: "git@example.test:team/repo.git",
  branch: "main",
  privateKey,
  knownHosts: null,
});

it("uses a captured SHA, private files and an isolated SSH environment; cleans them after success", async () => {
  let temporaryDirectory = "";
  let captured = false;
  const transport = createGitRemoteTransport({
    resolveAddress: async () => "93.184.216.34",
    captureHead: async () => {
      captured = true;
      return sha;
    },
    repositoryDirectory: () => directory,
    runCommand: async (command: GitRemoteCommand) => {
      if (command.args.includes("push")) {
        expect(captured).toBe(true);
        expect(command.args.slice(-2)).toEqual([
          "git@example.test:team/repo.git",
          `${sha}:refs/heads/main`,
        ]);
        temporaryDirectory = command.cwd;
        expect(
          (await stat(path.join(command.cwd, "identity"))).mode & 0o777,
        ).toBe(0o600);
        expect(command.env.SSH_AUTH_SOCK).toBeUndefined();
        expect(command.env.AUTH_SECRET).toBeUndefined();
        expect(command.env.GIT_SSH_COMMAND).toContain(
          "StrictHostKeyChecking=accept-new",
        );
        expect(command.env.GIT_SSH_COMMAND).toContain("IdentityAgent=none");
        expect(command.env.GIT_SSH_COMMAND).toContain("Hostname=93.184.216.34");
        expect(command.env.GIT_SSH_COMMAND).toContain(
          "HostKeyAlias=example.test",
        );
        expect(command.env.GIT_SSH_COMMAND).toContain("'-F' '/dev/null'");
        await writeFile(path.join(command.cwd, "known_hosts"), pinnedHost);
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  expect(await transport.pushProjectToRemote(input())).toEqual({
    commitSha: sha,
    knownHosts: pinnedHost,
  });
  await expect(stat(temporaryDirectory)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("preserves newly learned host keys and sanitizes errors after rejected authentication", async () => {
  let temporaryDirectory = "";
  const transport = createGitRemoteTransport({
    resolveAddress: async () => "93.184.216.34",
    captureHead: async () => sha,
    repositoryDirectory: () => directory,
    runCommand: async (command) => {
      if (!command.args.includes("push"))
        return { code: 0, stdout: "", stderr: "" };
      temporaryDirectory = command.cwd;
      await writeFile(path.join(command.cwd, "known_hosts"), pinnedHost);
      return {
        code: 128,
        stdout: "",
        stderr: `Permission denied (publickey). ${privateKey}`,
      };
    },
  });
  await expect(transport.pushProjectToRemote(input())).rejects.toMatchObject({
    code: "NETWORK_ERROR",
    knownHosts: pinnedHost,
    message:
      "The Git remote could not be reached. Check its address and network access.",
  });
  await expect(stat(temporaryDirectory)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("enforces the existing pin and refuses a changed host key", async () => {
  const transport = createGitRemoteTransport({
    resolveAddress: async () => "93.184.216.34",
    captureHead: async () => sha,
    repositoryDirectory: () => directory,
    runCommand: async (command) => {
      if (!command.args.includes("push"))
        return { code: 0, stdout: "", stderr: "" };
      expect(
        await readFile(path.join(command.cwd, "known_hosts"), "utf8"),
      ).toBe(pinnedHost);
      expect(command.env.GIT_SSH_COMMAND).toContain(
        "StrictHostKeyChecking=yes",
      );
      return {
        code: 128,
        stdout: "",
        stderr: "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!",
      };
    },
  });
  await expect(
    transport.pushProjectToRemote({ ...input(), knownHosts: pinnedHost }),
  ).rejects.toMatchObject({ code: "HOST_KEY_CHANGED", knownHosts: pinnedHost });
});

it("skips unchanged commits without materializing credentials or starting a command", async () => {
  const transport = createGitRemoteTransport({
    resolveAddress: async () => "93.184.216.34",
    captureHead: async () => sha,
    runCommand: async () => {
      throw new Error("Must not execute");
    },
  });
  expect(
    await transport.pushProjectToRemote({
      ...input(),
      lastPushedSha: sha,
      privateKey: "unused",
    }),
  ).toEqual({ commitSha: sha, knownHosts: null, skipped: true });
});

it("does not start a command when cancelled before admission", async () => {
  const transport = createGitRemoteTransport({
    resolveAddress: async () => "93.184.216.34",
    captureHead: async () => {
      throw new Error("Must not read");
    },
  });
  await expect(
    transport.pushProjectToRemote({ ...input(), signal: AbortSignal.abort() }),
  ).rejects.toMatchObject({ code: "CANCELLED" });
});

it.each(["TIMEOUT", "CANCELLED"] as const)(
  "cleans up credentials after %s and retains the first host pin",
  async (stopped) => {
    let temporaryDirectory = "";
    const transport = createGitRemoteTransport({
      resolveAddress: async () => "93.184.216.34",
      captureHead: async () => sha,
      repositoryDirectory: () => directory,
      runCommand: async (command) => {
        if (!command.args.includes("push"))
          return { code: 0, stdout: "", stderr: "" };
        temporaryDirectory = command.cwd;
        await writeFile(path.join(command.cwd, "known_hosts"), pinnedHost);
        return { code: -1, stdout: "", stderr: "", stopped };
      },
    });
    await expect(transport.pushProjectToRemote(input())).rejects.toMatchObject({
      code: stopped,
      knownHosts: pinnedHost,
    });
    await expect(stat(temporaryDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it("reports cancellation even when the process exits successfully during cancellation", async () => {
  const transport = createGitRemoteTransport({
    resolveAddress: async () => "93.184.216.34",
    captureHead: async () => sha,
    repositoryDirectory: () => directory,
    runCommand: async (command) => {
      if (!command.args.includes("push"))
        return { code: 0, stdout: "", stderr: "" };
      await writeFile(path.join(command.cwd, "known_hosts"), pinnedHost);
      return { code: 0, stdout: "", stderr: "", stopped: "CANCELLED" };
    },
  });
  await expect(transport.pushProjectToRemote(input())).rejects.toMatchObject({
    code: "CANCELLED",
    knownHosts: pinnedHost,
  });
});

it("pushes real committed history at the captured SHA, excludes dirty/newer content, and never forces divergence", async () => {
  const { runGitRemoteCommand } = await import("./remoteCommand");
  const source = path.join(directory, "source");
  const destination = path.join(directory, "destination.git");
  await exec("git", ["init", "-b", "main", source]);
  await exec("git", ["init", "--bare", destination]);
  const git = async (...args: string[]) =>
    (await exec("git", ["-C", source, ...args])).stdout.trim();
  await git("config", "user.name", "Transport Test");
  await git("config", "user.email", "transport@example.test");
  await writeFile(path.join(source, "project.json"), '{"id":"test"}\n');
  await writeFile(path.join(source, "guide.md"), "committed\n");
  await git("add", ".");
  await git("commit", "-m", "first");
  const first = await git("rev-parse", "HEAD");
  await writeFile(path.join(source, "guide.md"), "dirty\n");
  await git("config", "url.ext::unwanted.insteadOf", "git@example.test:");
  const shim = path.join(directory, "local-ssh");
  await writeFile(
    shim,
    '#!/bin/sh\nunset GIT_OBJECT_DIRECTORY\nexec git-receive-pack "$WEAVER_TEST_REMOTE"\n',
    { mode: 0o700 },
  );
  const transport = createGitRemoteTransport({
    resolveAddress: async () => "93.184.216.34",
    captureHead: async () => first,
    repositoryDirectory: () => source,
    runCommand: async (command) => {
      if (!command.args.includes("push")) return runGitRemoteCommand(command);
      await writeFile(path.join(command.cwd, "known_hosts"), pinnedHost);
      await writeFile(path.join(source, "new.md"), "newer commit\n");
      await git("add", "new.md");
      await git("commit", "-m", "concurrent new commit");
      return runGitRemoteCommand({
        ...command,
        env: {
          ...command.env,
          GIT_SSH_COMMAND: `'${shim}'`,
          WEAVER_TEST_REMOTE: destination,
        },
      });
    },
  });
  expect(await transport.pushProjectToRemote(input())).toMatchObject({
    commitSha: first,
  });
  expect(
    (
      await exec("git", [
        "--git-dir",
        destination,
        "rev-parse",
        "refs/heads/main",
      ])
    ).stdout.trim(),
  ).toBe(first);
  expect(
    (await exec("git", ["--git-dir", destination, "show", "main:guide.md"]))
      .stdout,
  ).toBe("committed\n");
  expect(
    (await exec("git", ["--git-dir", destination, "show", "main:project.json"]))
      .stdout,
  ).toBe('{"id":"test"}\n');
  expect(
    (
      await exec("git", [
        "--git-dir",
        destination,
        "ls-tree",
        "--name-only",
        "main",
      ])
    ).stdout,
  ).not.toContain("new.md");
  expect(await git("rev-parse", "HEAD")).not.toBe(first);
  await git("checkout", "--orphan", "unrelated");
  await git("add", ".");
  await git("commit", "-m", "diverging root");
  const divergent = await git("rev-parse", "HEAD");
  const divergentTransport = createGitRemoteTransport({
    resolveAddress: async () => "93.184.216.34",
    captureHead: async () => divergent,
    repositoryDirectory: () => source,
    runCommand: async (command) => {
      if (!command.args.includes("push")) return runGitRemoteCommand(command);
      return runGitRemoteCommand({
        ...command,
        env: {
          ...command.env,
          GIT_SSH_COMMAND: `'${shim}'`,
          WEAVER_TEST_REMOTE: destination,
        },
      });
    },
  });
  await expect(
    divergentTransport.pushProjectToRemote({
      ...input(),
      knownHosts: pinnedHost,
    }),
  ).rejects.toMatchObject({ code: "REMOTE_REJECTED" });
  expect(
    (
      await exec("git", [
        "--git-dir",
        destination,
        "rev-parse",
        "refs/heads/main",
      ])
    ).stdout.trim(),
  ).toBe(first);
});

const fetchInput = () => ({
  remoteUrl: "git@example.test:team/repo.git",
  branch: "main",
  privateKey,
  knownHosts: null,
});

describe("fetchRemoteBranch", () => {
  it("fetches into a bare directory that survives until dispose", async () => {
    let bareDirectory = "";
    let temporaryDirectoryPath = "";
    const transport = createGitRemoteTransport({
      resolveAddress: async () => "93.184.216.34",
      runCommand: async (command: GitRemoteCommand) => {
        if (command.args.includes("fetch")) {
          expect(command.args.slice(-2)).toEqual([
            "git@example.test:team/repo.git",
            "+refs/heads/main:refs/heads/main",
          ]);
          temporaryDirectoryPath = command.cwd;
          await writeFile(path.join(command.cwd, "known_hosts"), pinnedHost);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command.args.includes("rev-parse")) {
          bareDirectory = command.args[command.args.indexOf("--git-dir") + 1]!;
          return { code: 0, stdout: `${sha}\n`, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const fetched = await transport.fetchRemoteBranch(fetchInput());
    expect(fetched).toMatchObject({
      bareDirectory,
      remoteHead: sha,
      knownHosts: pinnedHost,
    });
    expect(typeof fetched.dispose).toBe("function");
    await expect(
      stat(path.join(temporaryDirectoryPath, "identity")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(fetched.bareDirectory).toBe(
      path.join(temporaryDirectoryPath, "fetched.git"),
    );
    await fetched.dispose();
    await expect(stat(temporaryDirectoryPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("maps a missing remote branch to REMOTE_BRANCH_MISSING and disposes before throwing", async () => {
    let temporaryDirectoryPath = "";
    const transport = createGitRemoteTransport({
      resolveAddress: async () => "93.184.216.34",
      runCommand: async (command: GitRemoteCommand) => {
        if (command.args.includes("fetch")) {
          temporaryDirectoryPath = command.cwd;
          return {
            code: 128,
            stdout: "",
            stderr: "fatal: couldn't find remote ref refs/heads/main",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await expect(
      transport.fetchRemoteBranch(fetchInput()),
    ).rejects.toMatchObject({ code: "REMOTE_BRANCH_MISSING" });
    await expect(stat(temporaryDirectoryPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fetches real committed history from a local bare source", async () => {
    const { runGitRemoteCommand } = await import("./remoteCommand");
    const source = path.join(directory, "fetch-source.git");
    await exec("git", ["init", "--bare", "-b", "main", source]);
    const worktree = path.join(directory, "fetch-worktree");
    await exec("git", ["clone", source, worktree]);
    const git = async (...args: string[]) =>
      (await exec("git", ["-C", worktree, ...args])).stdout.trim();
    await git("config", "user.name", "Fetch Test");
    await git("config", "user.email", "fetch@example.test");
    await writeFile(path.join(worktree, "guide.md"), "committed\n");
    await git("add", ".");
    await git("commit", "-m", "first");
    await git("push", "origin", "HEAD:main");
    const head = await git("rev-parse", "HEAD");

    const shim = path.join(directory, "local-upload-ssh");
    await writeFile(
      shim,
      '#!/bin/sh\nexec git-upload-pack "$WEAVER_TEST_REMOTE"\n',
      { mode: 0o700 },
    );
    const transport = createGitRemoteTransport({
      resolveAddress: async () => "93.184.216.34",
      runCommand: async (command) => {
        if (!command.args.includes("fetch"))
          return runGitRemoteCommand(command);
        await writeFile(path.join(command.cwd, "known_hosts"), pinnedHost);
        return runGitRemoteCommand({
          ...command,
          env: {
            ...command.env,
            GIT_SSH_COMMAND: `'${shim}'`,
            WEAVER_TEST_REMOTE: source,
          },
        });
      },
    });
    const fetched = await transport.fetchRemoteBranch(fetchInput());
    try {
      expect(fetched.remoteHead).toBe(head);
      expect(fetched.knownHosts).toBe(pinnedHost);
      expect(
        (
          await exec("git", [
            "--git-dir",
            fetched.bareDirectory,
            "show",
            `${fetched.remoteHead}:guide.md`,
          ])
        ).stdout,
      ).toBe("committed\n");
    } finally {
      await fetched.dispose();
    }
    await expect(stat(fetched.bareDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

it("exposes the SHA256 fingerprint of the pinned SSH host key", async () => {
  const { pinnedHostFingerprints } = await import("./remote");
  const publicKey = (
    await readFile(path.join(directory, "key.pub"), "utf8")
  ).trim();
  const expected = (
    await exec("ssh-keygen", [
      "-lf",
      path.join(directory, "key.pub"),
      "-E",
      "sha256",
    ])
  ).stdout.split(" ")[1];
  expect(
    pinnedHostFingerprints(`host ${publicKey}\n# comment\nhost ${publicKey}`),
  ).toEqual([expected]);
  expect(pinnedHostFingerprints(null)).toEqual([]);
});

it("rejects an unapproved destination before starting SSH or writing a key", async () => {
  let commands = 0;
  const transport = createGitRemoteTransport({
    captureHead: async () => sha,
    resolveAddress: async () => {
      throw new Error("private destination");
    },
    runCommand: async () => {
      commands++;
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  await expect(transport.pushProjectToRemote(input())).rejects.toMatchObject({
    code: "NETWORK_ERROR",
  });
  await expect(transport.fetchRemoteBranch(input())).rejects.toMatchObject({
    code: "NETWORK_ERROR",
  });
  expect(commands).toBe(0);
});

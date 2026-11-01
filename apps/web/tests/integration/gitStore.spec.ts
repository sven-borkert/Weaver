import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "./_harness";
import {
  openProjectRepo,
  repoDir,
  withExistingProjectRepo,
  withProjectRepo,
} from "@weaver/git-store";
import type { ProjectRepoReader } from "@weaver/git-store";

const AUTHOR = {
  name: "Alice",
  email: "alice@test.local",
  userId: "11111111-1111-4111-8111-111111111111",
};
const P = "22222222-2222-4222-8222-222222222222";

async function writeStaleLock(file: string, contents = "stale"): Promise<void> {
  await writeFile(file, contents);
  const staleAt = new Date(Date.now() - 60_000);
  await utimes(file, staleAt, staleAt);
}

describe("gitStore", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("initializes lazily with a resolvable HEAD (empty root commit)", async () => {
    await withProjectRepo(P, async (repo) => {
      expect(await repo.lastCommitForPath("nope.md")).toBeNull();
      expect(await repo.listTrackedFiles()).toEqual([]);
    });
  });

  it("commits with author, committer, user and operation trailers", async () => {
    const sha = await withProjectRepo(P, async (repo) => {
      await repo.writeFileAtomic("readme.md", "hello\n");
      return repo.commitAll("create: readme.md", AUTHOR, {
        operationId: "op-1",
      });
    });
    const repo = (await openProjectRepo(P))!;
    const [entry] = await repo.logForPath("readme.md", { skip: 0, limit: 10 });
    expect(entry!.sha).toBe(sha);
    expect(entry!.authorName).toBe("Alice");
    expect(entry!.userId).toBe(AUTHOR.userId);
    expect(entry!.operationId).toBe("op-1");
    expect(entry!.message).toBe("create: readme.md");
  });

  it("uses the canonical final userId trailer when the message contains a forged trailer", async () => {
    const forgedUserId = "33333333-3333-4333-8333-333333333333";
    await withProjectRepo(P, async (repo) => {
      await repo.writeFileAtomic("readme.md", "hello\n");
      await repo.commitAll(
        `create: readme.md\n\nWeaver-User-Id: ${forgedUserId}`,
        AUTHOR,
      );
    });

    const repo = (await openProjectRepo(P))!;
    const [entry] = await repo.logForPath("readme.md", { skip: 0, limit: 1 });

    expect(entry!.message).toBe("create: readme.md");
    expect(entry!.userId).toBe(AUTHOR.userId);
    expect(entry!.operationId).toBeNull();
  });

  it("falls back to the email local-part when name is null", async () => {
    await withProjectRepo(P, async (repo) => {
      await repo.writeFileAtomic("a.md", "x\n");
      await repo.commitAll("create: a.md", { ...AUTHOR, name: null });
    });
    const repo = (await openProjectRepo(P))!;
    const [entry] = await repo.logForPath("a.md", { skip: 0, limit: 1 });
    expect(entry!.authorName).toBe("alice");
  });

  it("tracks renames: logForPath follows and reports pathAtSha", async () => {
    await withProjectRepo(P, async (repo) => {
      await repo.writeFileAtomic("old.md", "content v1\n");
      await repo.commitAll("create: old.md", AUTHOR);
      await repo.mv("old.md", "new.md");
      await repo.commitAll("move: new.md (was old.md)", AUTHOR);
    });
    const repo = (await openProjectRepo(P))!;
    const entries = await repo.logForPath("new.md", { skip: 0, limit: 10 });
    expect(entries).toHaveLength(2);
    expect(entries[0]!.pathAtSha).toBe("new.md");
    expect(entries[1]!.pathAtSha).toBe("old.md");
    expect(await repo.showFileAt(entries[1]!.sha, entries[1]!.pathAtSha)).toBe(
      "content v1\n",
    );
  });

  it("recovers from a stale index.lock", async () => {
    await withProjectRepo(P, async (repo) => {
      await repo.writeFileAtomic("a.md", "1\n");
      await repo.commitAll("create: a.md", AUTHOR);
    });
    await writeStaleLock(path.join(repoDir(P), ".git", "index.lock"), "");
    const sha = await withProjectRepo(P, async (repo) => {
      await repo.writeFileAtomic("a.md", "2\n");
      return repo.commitAll("update: a.md", AUTHOR);
    });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("recovers from a stale branch ref lock before the next writer", async () => {
    await withProjectRepo(P, async (repo) => {
      await repo.writeFileAtomic("a.md", "1\n");
      await repo.commitAll("create: a.md", AUTHOR);
    });
    const lock = path.join(repoDir(P), ".git", "refs", "heads", "main.lock");
    await writeStaleLock(lock);

    const sha = await withProjectRepo(P, async (repo) => {
      await repo.writeFileAtomic("a.md", "2\n");
      return repo.commitAll("update: a.md", AUTHOR);
    });

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    await expect(readFile(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers from locks stranded by an interrupted recovery", async () => {
    await withProjectRepo(P, async (repo) => {
      await repo.writeFileAtomic("a.md", "1\n");
      await repo.commitAll("create: a.md", AUTHOR);
    });
    await writeStaleLock(path.join(repoDir(P), ".git", "ORIG_HEAD.lock"));
    const reflogLock = path.join(
      repoDir(P),
      ".git",
      "logs",
      "refs",
      "heads",
      "main.lock",
    );
    await writeStaleLock(reflogLock);

    const sha = await withProjectRepo(P, async (repo) => {
      await repo.writeFileAtomic("a.md", "2\n");
      return repo.commitAll("update: a.md", AUTHOR);
    });

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    await expect(
      readFile(path.join(repoDir(P), ".git", "ORIG_HEAD.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(reflogLock)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a symlinked .git root without deleting external locks", async () => {
    await withProjectRepo(P, async (repo) => {
      await repo.writeFileAtomic("a.md", "1\n");
      await repo.commitAll("create: a.md", AUTHOR);
    });
    const externalRoot = await mkdtemp(path.join(tmpdir(), "weaver-git-root-"));
    const externalGit = path.join(externalRoot, "metadata");
    const gitDir = path.join(repoDir(P), ".git");
    await rename(gitDir, externalGit);
    const sentinel = path.join(externalGit, "external-sentinel.lock");
    await writeFile(sentinel, "keep");
    await symlink(externalGit, gitDir, "dir");

    let recoveryError: unknown;
    try {
      await withProjectRepo(P, async () => undefined);
    } catch (error) {
      recoveryError = error;
    }
    const sentinelContent = await readFile(sentinel, "utf8").catch(() => null);
    await rm(externalRoot, { recursive: true, force: true });

    expect(recoveryError).toBeInstanceOf(Error);
    expect((recoveryError as Error).message).toContain(
      ".git must be a real directory",
    );
    expect(sentinelContent).toBe("keep");
  });

  it("rejects a non-directory .git root before recovery", async () => {
    await withProjectRepo(P, async (repo) => {
      await repo.writeFileAtomic("a.md", "1\n");
      await repo.commitAll("create: a.md", AUTHOR);
    });
    const gitDir = path.join(repoDir(P), ".git");
    await rename(gitDir, path.join(repoDir(P), "metadata-backup"));
    await writeFile(gitDir, "not a directory");

    await expect(withProjectRepo(P, async () => undefined)).rejects.toThrow(
      "repository .git must be a real directory",
    );
  });

  it("ignores nested metadata symlinks while cleaning real lock files", async () => {
    await withProjectRepo(P, async (repo) => {
      await repo.writeFileAtomic("a.md", "1\n");
      await repo.commitAll("create: a.md", AUTHOR);
    });
    const externalRoot = await mkdtemp(
      path.join(tmpdir(), "weaver-git-nested-"),
    );
    const sentinel = path.join(externalRoot, "external-sentinel.lock");
    await writeFile(sentinel, "keep");
    const nested = path.join(repoDir(P), ".git", "recovery-test");
    await mkdir(nested);
    const nestedSymlink = path.join(nested, "external.lock");
    const localLock = path.join(nested, "local.lock");
    await symlink(externalRoot, nestedSymlink, "dir");
    await writeStaleLock(localLock);

    let recoveryError: unknown;
    try {
      await withProjectRepo(P, async () => undefined);
    } catch (error) {
      recoveryError = error;
    }
    const symlinkStat = await lstat(nestedSymlink).catch(() => null);
    const sentinelContent = await readFile(sentinel, "utf8").catch(() => null);
    await rm(externalRoot, { recursive: true, force: true });

    expect(recoveryError).toBeUndefined();
    expect(symlinkStat?.isSymbolicLink()).toBe(true);
    expect(sentinelContent).toBe("keep");
    await expect(readFile(localLock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("discards half-written state and orphaned atomic temp files on recovery", async () => {
    await withProjectRepo(P, async (repo) => {
      await repo.writeFileAtomic("a.md", "committed\n");
      await repo.commitAll("create: a.md", AUTHOR);
    });
    const orphanedTemp = path.join(repoDir(P), "a.md.tmp-999999");
    await writeFile(path.join(repoDir(P), "a.md"), "torn write");
    await writeFile(orphanedTemp, "orphaned atomic write");
    await mkdir(path.join(repoDir(P), "junk"), { recursive: true });
    await writeFile(path.join(repoDir(P), "junk", "x.txt"), "untracked");
    await withProjectRepo(P, async (repo) => {
      expect(await repo.readFileFromWorktree("a.md")).toBe("committed\n");
      await repo.writeFileAtomic("b.md", "next write\n");
      await repo.commitAll("create: b.md", AUTHOR);
    });

    const repo = (await openProjectRepo(P))!;
    expect(await repo.listTrackedFiles()).toEqual(["a.md", "b.md"]);
    await expect(readFile(orphanedTemp)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("recovers an existing dirty worktree inside the lock before its callback", async () => {
    await withProjectRepo(P, async (repo) => {
      await repo.writeFileAtomic("a.md", "committed\n");
      await repo.commitAll("create: a.md", AUTHOR);
    });
    const staleLock = path.join(repoDir(P), ".git", "index.lock");
    const untracked = path.join(repoDir(P), "untracked.md");
    await writeFile(path.join(repoDir(P), "a.md"), "dirty\n");
    await writeFile(untracked, "untracked\n");
    await writeStaleLock(staleLock);

    const observed = await withExistingProjectRepo(P, async (repo) => ({
      content: await repo.readFileFromWorktree("a.md"),
      staleLock: await readFile(staleLock, "utf8").catch(() => null),
      untracked: await readFile(untracked, "utf8").catch(() => null),
    }));

    expect(observed).toEqual({
      content: "committed\n",
      staleLock: null,
      untracked: null,
    });
  });

  it("keeps a locked committed reader read-only without recovering the worktree", async () => {
    const gitStore = await import("@weaver/git-store");
    await withProjectRepo(P, async (repo) => {
      await repo.writeFileAtomic("a.md", "committed\n");
      await repo.commitAll("create: a.md", AUTHOR);
    });
    const staleLock = path.join(repoDir(P), ".git", "index.lock");
    await writeFile(path.join(repoDir(P), "a.md"), "dirty\n");
    await writeStaleLock(staleLock);
    const helper = (
      gitStore as typeof gitStore & {
        withExistingProjectRepoReader?: <T>(
          id: string,
          fn: (repo: ProjectRepoReader) => Promise<T>,
        ) => Promise<T | null>;
      }
    ).withExistingProjectRepoReader;

    const observed = await helper?.(P, async (repo) => ({
      content: (await repo.readCommittedFile("a.md"))?.content,
      hasMutation: "commitAll" in repo,
    }));

    expect(observed).toEqual({ content: "committed\n", hasMutation: false });
    await expect(readFile(path.join(repoDir(P), "a.md"), "utf8")).resolves.toBe(
      "dirty\n",
    );
    await expect(readFile(staleLock, "utf8")).resolves.toBe("stale");
  });

  it("unlocked readers serve HEAD content while the worktree is dirty", async () => {
    await withProjectRepo(P, async (repo) => {
      await repo.writeFileAtomic("a.md", "committed\n");
      await repo.commitAll("create: a.md", AUTHOR);
    });
    await writeFile(path.join(repoDir(P), "a.md"), "dirty");
    const repo = (await openProjectRepo(P))!;
    expect((await repo.readCommittedFile("a.md"))?.content).toBe("committed\n");
    expect(await readFile(path.join(repoDir(P), "a.md"), "utf8")).toBe("dirty");
  });

  it.each(["", " ", "two words", "line\nbreak", "x".repeat(201)])(
    "rejects invalid operation id %j",
    async (operationId) => {
      await expect(
        withProjectRepo(P, async (repo) => {
          await repo.writeFileAtomic("invalid.md", "invalid\n");
          return repo.commitAll("create: invalid.md", AUTHOR, { operationId });
        }),
      ).rejects.toThrow("invalid operation id");
    },
  );

  it("serializes concurrent writers per project", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        withProjectRepo(P, async (repo) => {
          await repo.writeFileAtomic(`f${i}.md`, `${i}\n`);
          return repo.commitAll(`create: f${i}.md`, AUTHOR);
        }),
      ),
    );
    expect(new Set(results).size).toBe(5);
    const repo = (await openProjectRepo(P))!;
    expect((await repo.listTrackedFiles()).sort()).toEqual([
      "f0.md",
      "f1.md",
      "f2.md",
      "f3.md",
      "f4.md",
    ]);
  });
});

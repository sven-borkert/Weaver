import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
import type { ProjectRepoReader, ProjectRepoWriter } from "./gitStore";
import type * as AdvisoryLockModule from "./advisoryLock";

const lockDoubles = vi.hoisted(() => ({
  poolConstructor: vi.fn(),
  withProjectAdvisoryLock: vi.fn(
    async (
      _pool: unknown,
      _projectId: string,
      _options: unknown,
      fn: () => Promise<unknown>,
    ) => fn(),
  ),
}));

vi.mock("pg", () => ({
  Pool: class {
    constructor(options: unknown) {
      lockDoubles.poolConstructor(options);
    }
    on() {
      return this;
    }
  },
}));

vi.mock("@weaver/git-store/advisory-lock", async (importOriginal) => {
  const original = await importOriginal<typeof AdvisoryLockModule>();
  return {
    ...original,
    withProjectAdvisoryLock: lockDoubles.withProjectAdvisoryLock,
  };
});

let testDataDir: string;

beforeAll(async () => {
  testDataDir = await mkdtemp(path.join(tmpdir(), "weaver-git-store-unit-"));
  vi.stubEnv(
    "DATABASE_URL",
    "postgresql://weaver:weaver@localhost/weaver_test",
  );
  vi.stubEnv("AUTH_SECRET", "test-secret-that-is-at-least-32-characters");
  vi.stubEnv("WEAVER_DATA_DIR", testDataDir);
});

beforeEach(() => {
  lockDoubles.withProjectAdvisoryLock.mockClear();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(testDataDir, { recursive: true, force: true });
});

describe("Git-store contracts", () => {
  it.each(["../escape", "a/b", "a\\b", "..", ""])(
    "rejects unsafe repo id %s",
    async (id) => {
      const { repoDir } = await import("./gitStore");
      expect(() => repoDir(id)).toThrow();
    },
  );
  it("places project repositories beneath the configured Git root", async () => {
    const { repoDir } = await import("./gitStore");

    expect(repoDir("project-id")).toBe(
      path.join(testDataDir, "git", "project-id"),
    );
  });

  it("uses one repository path for upper- and lower-case UUID spellings", async () => {
    const { repoDir } = await import("./gitStore");
    const projectId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";

    expect(repoDir(projectId)).toBe(repoDir(projectId.toLowerCase()));
  });

  it("keeps mutation methods off unlocked readers", () => {
    expectTypeOf<ProjectRepoReader>().not.toHaveProperty("writeFileAtomic");
    expectTypeOf<ProjectRepoReader>().not.toHaveProperty("commitAll");
    expectTypeOf<ProjectRepoReader>().not.toHaveProperty(
      "readFileFromWorktree",
    );
    expectTypeOf<ProjectRepoReader>().not.toHaveProperty("listWorktreeDirs");
    expectTypeOf<ProjectRepoWriter>().toHaveProperty("commitAll");
  });

  it("returns a runtime reader facade without worktree or mutation methods", async () => {
    const { openProjectRepo, repoDir } = await import("./gitStore");
    const projectId = "66666666-6666-4666-8666-666666666666";
    await mkdir(path.join(repoDir(projectId), ".git"), { recursive: true });

    const reader = (await openProjectRepo(projectId))!;

    expect(Object.keys(reader).sort()).toEqual([
      "blobShaAt",
      "blobSizeAt",
      "commitDate",
      "isAncestor",
      "lastCommitForPath",
      "listHistoricalPaths",
      "listTrackedBlobs",
      "listTrackedFiles",
      "logChangesBefore",
      "logForPath",
      "logSince",
      "orderCommits",
      "readBlob",
      "readBlobsAt",
      "readCommittedBlobAt",
      "readCommittedFile",
      "readCommittedFileAt",
      "renamedPathBetween",
      "resolveHead",
      "showFileAt",
    ]);
    for (const forbidden of [
      "dir",
      "writeFileAtomic",
      "ensureFolder",
      "commitAll",
      "recover",
      "readFileFromWorktree",
      "fileExistsInWorktree",
      "listWorktreeDirs",
      "mv",
      "rm",
      "rmDir",
      "remove",
    ]) {
      expect(reader).not.toHaveProperty(forbidden);
    }
  });

  it("creates the process pool lazily and locks both writer helpers", async () => {
    const { withExistingProjectRepo, withProjectRepo } =
      await import("./gitStore");
    const projectId = "11111111-1111-4111-8111-111111111111";

    expect(lockDoubles.poolConstructor).not.toHaveBeenCalled();
    await withProjectRepo(projectId, async () => undefined);
    await withExistingProjectRepo(projectId, async () => undefined);

    expect(lockDoubles.poolConstructor).toHaveBeenCalledOnce();
    expect(lockDoubles.withProjectAdvisoryLock).toHaveBeenCalledTimes(2);
    expect(lockDoubles.withProjectAdvisoryLock.mock.calls[0]?.[1]).toBe(
      projectId,
    );
    expect(lockDoubles.withProjectAdvisoryLock.mock.calls[1]?.[1]).toBe(
      projectId,
    );
  });

  it("walks name-status history backwards from a commit", async () => {
    const { openProjectRepo, withProjectRepo } = await import("./gitStore");
    const projectId = "88888888-8888-4888-8888-888888888888";
    const author = {
      name: "Alice",
      email: "alice@test.local",
      userId: "11111111-1111-4111-8111-111111111111",
    };
    const shas = await withProjectRepo(projectId, async (repo) => {
      await repo.writeFileAtomic("a.md", "one\n");
      const first = await repo.commitAll("create: a.md", author);
      await repo.writeFileAtomic("b.md", "two\n");
      const second = await repo.commitAll("create: b.md", author);
      await repo.rm("a.md");
      const third = await repo.commitAll("delete: a.md", author);
      return { first, second, third };
    });

    const reader = (await openProjectRepo(projectId))!;
    const all = await reader.logChangesBefore(shas.third, { limit: 10 });
    expect(all[0]?.sha).toBe(shas.third);
    expect(all[0]?.changes).toEqual([
      { status: "D", path: "a.md", oldPath: null },
    ]);
    expect(all.map((entry) => entry.sha)).toContain(shas.first);

    // Bounded, and resumable from an earlier tip.
    const page = await reader.logChangesBefore(shas.third, { limit: 1 });
    expect(page).toHaveLength(1);
    expect(page[0]?.sha).toBe(shas.third);
    const rest = await reader.logChangesBefore(shas.second, { limit: 10 });
    expect(rest.map((entry) => entry.sha)).not.toContain(shas.third);
    expect(rest[0]?.sha).toBe(shas.second);

    expect(await reader.logChangesBefore("0".repeat(40), { limit: 5 })).toEqual(
      [],
    );
  });

  it("writes and reads binary blobs byte-exactly and refuses oversize reads", async () => {
    const { openProjectRepo, withProjectRepo } = await import("./gitStore");
    const projectId = "77777777-7777-4777-8777-777777777777";
    const bytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10, 0x0d,
      0x0a,
    ]);
    const sha = await withProjectRepo(projectId, async (repo) => {
      await repo.writeBinaryFileAtomic("guide.assets/a.png", bytes);
      return repo.commitAll("asset: guide.assets/a.png (for guide.md)", {
        name: "Alice",
        email: "alice@test.local",
        userId: "11111111-1111-4111-8111-111111111111",
      });
    });
    const reader = (await openProjectRepo(projectId))!;
    const blob = await reader.readCommittedBlobAt(
      sha,
      "guide.assets/a.png",
      1_024,
    );
    expect(blob?.bytes.equals(bytes)).toBe(true);
    expect(blob?.size).toBe(bytes.byteLength);
    expect(blob?.blobSha).toMatch(/^[0-9a-f]{40}$/);
    expect(
      await reader.readCommittedBlobAt(
        sha,
        "guide.assets/a.png",
        bytes.byteLength - 1,
      ),
    ).toBeNull();
    expect(
      await reader.readCommittedBlobAt(sha, "missing.png", 1_024),
    ).toBeNull();
    expect(
      await reader.readCommittedBlobAt(sha, "guide.assets", 1_024),
    ).toBeNull();
  });

  it("reads a listed blob by its object id and refuses anything else", async () => {
    const { openProjectRepo, withProjectRepo } = await import("./gitStore");
    const projectId = "78787878-7878-4787-8787-787878787878";
    const bytes = Buffer.from([0x89, 0x50, 0x00, 0xff, 0x0d, 0x0a]);
    const sha = await withProjectRepo(projectId, async (repo) => {
      await repo.writeBinaryFileAtomic("guide.assets/a.png", bytes);
      return repo.commitAll("asset: guide.assets/a.png (for guide.md)", {
        name: "Alice",
        email: "alice@test.local",
        userId: "11111111-1111-4111-8111-111111111111",
      });
    });
    const reader = (await openProjectRepo(projectId))!;
    const [listed] = (await reader.listTrackedBlobs(sha)).filter(
      (blob) => blob.path === "guide.assets/a.png",
    );

    expect((await reader.readBlob(listed!.sha)).equals(bytes)).toBe(true);
    // A commit is an object, but not a blob.
    await expect(reader.readBlob(sha)).rejects.toThrow();
    await expect(reader.readBlob("0".repeat(40))).rejects.toThrow();
    await expect(reader.readBlob("HEAD:guide.assets/a.png")).rejects.toThrow(
      "invalid blob id",
    );
  });

  it("locks an existing committed reader without exposing writer methods", async () => {
    const gitStore = await import("./gitStore");
    const projectId = "77777777-7777-4777-8777-777777777777";
    await mkdir(path.join(gitStore.repoDir(projectId), ".git"), {
      recursive: true,
    });
    const helper = (
      gitStore as typeof gitStore & {
        withExistingProjectRepoReader?: <T>(
          id: string,
          fn: (repo: ProjectRepoReader) => Promise<T>,
        ) => Promise<T | null>;
      }
    ).withExistingProjectRepoReader;

    const keys = await helper?.(projectId, async (repo) =>
      Object.keys(repo).sort(),
    );

    expect(keys).toEqual([
      "blobShaAt",
      "blobSizeAt",
      "commitDate",
      "isAncestor",
      "lastCommitForPath",
      "listHistoricalPaths",
      "listTrackedBlobs",
      "listTrackedFiles",
      "logChangesBefore",
      "logForPath",
      "logSince",
      "orderCommits",
      "readBlob",
      "readBlobsAt",
      "readCommittedBlobAt",
      "readCommittedFile",
      "readCommittedFileAt",
      "renamedPathBetween",
      "resolveHead",
      "showFileAt",
    ]);
    expect(lockDoubles.withProjectAdvisoryLock).toHaveBeenCalledWith(
      expect.anything(),
      projectId,
      expect.objectContaining({ mode: "shared" }),
      expect.any(Function),
    );
  });

  it("keeps dirty worktree content invisible to unlocked readers", async () => {
    const { openProjectRepo, repoDir, withProjectRepo } =
      await import("./gitStore");
    const projectId = "22222222-2222-4222-8222-222222222222";
    await withProjectRepo(projectId, async (repo) => {
      await repo.writeFileAtomic("guide.md", "committed\n");
      await repo.commitAll("create: guide.md", {
        name: "Alice",
        email: "alice@example.test",
        userId: "33333333-3333-4333-8333-333333333333",
      });
    });
    await writeFile(path.join(repoDir(projectId), "guide.md"), "dirty\n");

    const reader = (await openProjectRepo(projectId))!;
    const snapshot = await reader.readCommittedFile("guide.md");

    expect(snapshot?.content).toBe("committed\n");
    expect(
      await readFile(path.join(repoDir(projectId), "guide.md"), "utf8"),
    ).toBe("dirty\n");
  });

  it.each(["", "   ", "two words", "line\nbreak", "x".repeat(201)])(
    "rejects invalid operation id %j before committing",
    async (operationId) => {
      const { withProjectRepo } = await import("./gitStore");
      const projectId = "44444444-4444-4444-8444-444444444444";

      await expect(
        withProjectRepo(projectId, async (repo) => {
          await repo.writeFileAtomic("invalid.md", operationId);
          return repo.commitAll(
            "create: invalid.md",
            {
              name: "Alice",
              email: "alice@example.test",
              userId: "55555555-5555-4555-8555-555555555555",
            },
            { operationId },
          );
        }),
      ).rejects.toThrow("invalid operation id");
    },
  );

  it("finds a create operation across the project after its file was deleted", async () => {
    const { withProjectRepo } = await import("./gitStore");
    await withProjectRepo(
      "88888888-8888-4888-8888-888888888880",
      async (repo) => {
        const actor = {
          name: "Alice",
          email: "alice@example.test",
          userId: "user-1",
        };
        await repo.writeFileAtomic("created.md", "original");
        const sha = await repo.commitAll("create", actor, {
          operationId: "create-once",
        });
        await repo.rm("created.md");
        await repo.commitAll("delete", actor);
        const entries = await repo.logForPath(".", {
          skip: 0,
          limit: 1,
          operationId: "create-once",
        });
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          sha,
          operationId: "create-once",
          pathAtSha: "created.md",
        });
      },
    );
  });

  it("round-trips user, operation, and MCP request trailers through commit and log", async () => {
    const { withProjectRepo } = await import("./gitStore");
    const projectId = "88888888-8888-4888-8888-888888888881";

    const entry = await withProjectRepo(projectId, async (repo) => {
      await repo.writeFileAtomic("guide.md", "content\n");
      const metadata = {
        operationId: "op-1",
        mcpRequestHash: "a".repeat(64),
        mcpToolName: "update_document",
      };
      await repo.commitAll(
        "save: guide",
        { name: "Alice", email: "alice@example.test", userId: "user-1" },
        metadata,
      );
      const [head] = await repo.logForPath("guide.md", { skip: 0, limit: 1 });
      return head;
    });

    expect(entry).toMatchObject({
      userId: "user-1",
      operationId: "op-1",
      mcpRequestHash: "a".repeat(64),
      mcpToolName: "update_document",
      runId: null,
    });
  });

  it("rejects invalid MCP request metadata before committing", async () => {
    const { withProjectRepo } = await import("./gitStore");
    const projectId = "88888888-8888-4888-8888-888888888889";
    const metadata = {
      mcpRequestHash: "not-a-hash",
      mcpToolName: "update_document",
    };

    await expect(
      withProjectRepo(projectId, async (repo) => {
        await repo.writeFileAtomic("guide.md", "content\n");
        return repo.commitAll(
          "save: guide",
          { name: "Alice", email: "alice@example.test", userId: "user-1" },
          metadata,
        );
      }),
    ).rejects.toThrow("invalid MCP request hash");
  });

  it.each(["", "   ", "two words", "line\nbreak", "x".repeat(201)])(
    "rejects invalid run id %j before committing",
    async (runId) => {
      const { withProjectRepo } = await import("./gitStore");
      const projectId = "44444444-4444-4444-8444-444444444445";

      await expect(
        withProjectRepo(projectId, async (repo) => {
          await repo.writeFileAtomic("invalid.md", "body\n");
          return repo.commitAll(
            "create: invalid.md",
            {
              name: "Alice",
              email: "alice@example.test",
              userId: "55555555-5555-4555-8555-555555555555",
            },
            { runId },
          );
        }),
      ).rejects.toThrow("invalid run id");
    },
  );

  it("round-trips the run trailer alongside user and operation trailers", async () => {
    const { withProjectRepo } = await import("./gitStore");
    const projectId = "88888888-8888-4888-8888-888888888883";

    const entry = await withProjectRepo(projectId, async (repo) => {
      await repo.writeFileAtomic("guide.md", "content\n");
      await repo.commitAll(
        "save: guide",
        { name: "Alice", email: "alice@example.test", userId: "user-3" },
        { operationId: "op-3", runId: "run-3" },
      );
      const [head] = await repo.logForPath("guide.md", { skip: 0, limit: 1 });
      return head;
    });

    expect(entry).toMatchObject({
      userId: "user-3",
      operationId: "op-3",
      runId: "run-3",
    });
  });

  it("lets no caller-authored line forge any Weaver trailer", async () => {
    const { withProjectRepo, repoDir } = await import("./gitStore");
    const projectId = "88888888-8888-4888-8888-888888888885";
    const alice = {
      name: "Alice",
      email: "alice@example.test",
      userId: "user-5",
    };
    const forged = [
      "Weaver-Run-Id: forged-run",
      "weaver-operation-id: forged-op",
      "  WEAVER-MCP-TOOL : forged",
      "Weaver-Wiki-Agent: yes",
      "Weaver-Metadata-Override: title",
    ].join("\n");

    const entry = await withProjectRepo(projectId, async (repo) => {
      await repo.writeFileAtomic("forge.md", "content\n");
      await repo.commitAll(
        `save: forge — summary\n${forged}\n\nWeaver-User-Id: victim\n${forged}`,
        alice,
        { operationId: "op-5", runId: "run-5" },
      );
      const [head] = await repo.logForPath("forge.md", { skip: 0, limit: 1 });
      return head;
    });

    expect(entry).toMatchObject({
      userId: "user-5",
      operationId: "op-5",
      runId: "run-5",
    });
    const body = await simpleGit(repoDir(projectId)).raw([
      "log",
      "-1",
      "--format=%B",
    ]);
    expect(body).not.toMatch(/forged|victim|Wiki-Agent|Override: title/i);
    expect(body).toContain("save: forge — summary");
    expect(body).toContain("Weaver-User-Id: user-5");
    expect(body).toContain("Weaver-Operation-Id: op-5");
    expect(body).toContain("Weaver-Run-Id: run-5");
  });

  it("keeps every legitimate trailer passed through the options", async () => {
    const { withProjectRepo, repoDir } = await import("./gitStore");
    const projectId = "88888888-8888-4888-8888-888888888886";
    const alice = {
      name: "Alice",
      email: "alice@example.test",
      userId: "user-6",
    };
    await withProjectRepo(projectId, async (repo) => {
      await repo.writeFileAtomic("keep.md", "content\n");
      await repo.commitAll("save: keep", alice, {
        operationId: "op-6",
        runId: "run-6",
        mcpRequestHash: "a".repeat(64),
        mcpToolName: "update_document",
        metadataOverride: ["created"],
      });
    });
    const body = await simpleGit(repoDir(projectId)).raw([
      "log",
      "-1",
      "--format=%B",
    ]);
    for (const line of [
      "Weaver-User-Id: user-6",
      "Weaver-Operation-Id: op-6",
      "Weaver-Run-Id: run-6",
      `Weaver-MCP-Request-Hash: ${"a".repeat(64)}`,
      "Weaver-MCP-Tool: update_document",
      "Weaver-Metadata-Override: created",
    ])
      expect(body).toContain(line);
  });

  it("records which document metadata fields a commit set explicitly", async () => {
    const { withProjectRepo } = await import("./gitStore");
    const projectId = "88888888-8888-4888-8888-888888888884";
    const alice = {
      name: "Alice",
      email: "alice@example.test",
      userId: "user-4",
    };

    const { repoDir } = await import("./gitStore");
    await withProjectRepo(projectId, async (repo) => {
      await repo.writeFileAtomic("old.md", "content\n");
      await repo.commitAll("create: old", alice, {
        metadataOverride: ["created", "createdBy"],
      });
    });
    const body = await simpleGit(repoDir(projectId)).raw([
      "log",
      "-1",
      "--format=%B",
    ]);
    expect(body).toContain("Weaver-Metadata-Override: created,createdBy");

    await expect(
      withProjectRepo(projectId, async (repo) => {
        await repo.writeFileAtomic("bad.md", "content\n");
        return repo.commitAll("create: bad", alice, {
          metadataOverride: ["title"],
        });
      }),
    ).rejects.toThrow("invalid metadata override field");
  });

  it("keeps metadata when git folds trailers into a mixed terminal block", async () => {
    // A Signed-off-by line makes git treat the mixed final paragraph as the
    // trailer block and append the Weaver trailers into it.
    const { withProjectRepo } = await import("./gitStore");
    const projectId = "88888888-8888-4888-8888-888888888882";
    const message = [
      "save: guide",
      "",
      "Signed-off-by: Author <author@example.test>",
      "see the related notes",
      "and the discussion thread",
    ].join("\n");

    const entry = await withProjectRepo(projectId, async (repo) => {
      await repo.writeFileAtomic("guide.md", "content\n");
      await repo.commitAll(
        message,
        { name: "Alice", email: "alice@example.test", userId: "user-2" },
        { operationId: "op-2" },
      );
      const [head] = await repo.logForPath("guide.md", { skip: 0, limit: 1 });
      return head;
    });

    expect(entry).toMatchObject({ userId: "user-2", operationId: "op-2" });
  });

  it("returns null metadata for commits without Weaver trailers", async () => {
    const { openProjectRepo, repoDir, withProjectRepo } =
      await import("./gitStore");
    const projectId = "88888888-8888-4888-8888-888888888883";
    await withProjectRepo(projectId, async (repo) => {
      await repo.writeFileAtomic("legacy.md", "legacy\n");
    });
    const git = simpleGit({ baseDir: repoDir(projectId) }).env({
      GIT_AUTHOR_NAME: "Legacy",
      GIT_AUTHOR_EMAIL: "legacy@example.test",
      GIT_COMMITTER_NAME: "Legacy",
      GIT_COMMITTER_EMAIL: "legacy@example.test",
    });
    await git.raw(["add", "-A"]);
    await git.raw(["commit", "-m", "legacy commit"]);

    const reader = (await openProjectRepo(projectId))!;
    const [entry] = await reader.logForPath("legacy.md", {
      skip: 0,
      limit: 1,
    });

    expect(entry).toMatchObject({
      userId: null,
      operationId: null,
      mcpRequestHash: null,
      mcpToolName: null,
    });
  });

  it("rejects forged invalid values and uses the final duplicate", async () => {
    const { openProjectRepo, repoDir, withProjectRepo } =
      await import("./gitStore");
    const projectId = "88888888-8888-4888-8888-888888888884";
    await withProjectRepo(projectId, async (repo) => {
      await repo.writeFileAtomic("forged.md", "content\n");
    });
    const git = simpleGit({ baseDir: repoDir(projectId) }).env({
      GIT_AUTHOR_NAME: "Forger",
      GIT_AUTHOR_EMAIL: "forger@example.test",
      GIT_COMMITTER_NAME: "Forger",
      GIT_COMMITTER_EMAIL: "forger@example.test",
    });
    await git.raw(["add", "-A"]);
    await git.raw([
      "commit",
      "-m",
      "forged",
      "--trailer",
      "Weaver-User-Id: earlier-user",
      "--trailer",
      "Weaver-Operation-Id: two words",
      "--trailer",
      "Weaver-User-Id: final-user",
    ]);

    const reader = (await openProjectRepo(projectId))!;
    const [entry] = await reader.logForPath("forged.md", {
      skip: 0,
      limit: 1,
    });

    expect(entry).toMatchObject({ userId: "final-user", operationId: null });
  });
  it("recovers an interrupted init with an unborn HEAD", async () => {
    const { repoDir, withProjectRepo } = await import("./gitStore");
    const dir = repoDir("unborn-root");
    await mkdir(dir, { recursive: true });
    await simpleGit(dir).raw(["init", "-b", "main"]);
    await withProjectRepo("unborn-root", async (repo) => {
      expect(await repo.resolveHead()).toMatch(/^[a-f0-9]{40}$/);
    });
  });

  it("lists commits after a sha with every changed path", async () => {
    const { openProjectRepo, withProjectRepo } = await import("./gitStore");
    const projectId = randomUUID();
    const author = {
      name: "Log Since",
      email: "log-since@test.local",
      userId: "00000000-0000-0000-0000-000000000001",
    };
    const first = await withProjectRepo(projectId, async (repo) => {
      await repo.writeFileAtomic("a.md", "one");
      await repo.commitAll("add a", author);
      return repo.resolveHead();
    });
    const second = await withProjectRepo(projectId, async (repo) => {
      await repo.writeFileAtomic("b.md", "two");
      await repo.writeFileAtomic("a.md", "one more");
      await repo.commitAll("add b, touch a", author);
      return repo.resolveHead();
    });

    const all = await withProjectRepo(projectId, (repo) =>
      repo.logSince(null, { limit: 10 }),
    );
    expect(all.slice(0, 2).map((entry) => entry.sha)).toEqual([second, first]);

    const since = await withProjectRepo(projectId, (repo) =>
      repo.logSince(first, { limit: 10 }),
    );
    expect(since).toHaveLength(1);
    expect(since[0]!.message).toBe("add b, touch a");
    expect(
      since[0]!.changes
        .map((change) => `${change.status}:${change.path}`)
        .sort(),
    ).toEqual(["A:b.md", "M:a.md"]);

    const reader = await openProjectRepo(projectId);
    expect(await reader!.logSince(first, { limit: 10 })).toHaveLength(1);
    await expect(
      withProjectRepo(projectId, (repo) =>
        repo.logSince("0000000000000000000000000000000000000000", {
          limit: 10,
        }),
      ),
    ).rejects.toThrow();
  });
});

it("orders schema/data heads by ancestry in either argument order", async () => {
  const { withProjectRepo } = await import("./gitStore");
  await withProjectRepo("ancestry-order-review", async (repo) => {
    const author = {
      name: "Writer",
      email: "writer@example.test",
      userId: "11111111-1111-4111-8111-111111111111",
    };
    await repo.writeFileAtomic("schema.json", "first");
    const first = await repo.commitAll("first", author);
    await repo.writeFileAtomic("schema.json", "second");
    const second = await repo.commitAll("second", author);
    expect(await repo.isAncestor(first, second)).toBe(true);
    expect(await repo.isAncestor(second, first)).toBe(false);
    expect(await repo.orderCommits(second, [first, second])).toEqual([
      second,
      first,
    ]);
    expect(await repo.orderCommits(second, [second, first])).toEqual([
      second,
      first,
    ]);
    expect(await repo.listTrackedBlobs(second)).toContainEqual(
      expect.objectContaining({ path: "schema.json", size: 6 }),
    );
  });
});

describe("repository discovery containment", () => {
  it("fails instead of committing into the repository enclosing the data dir", async () => {
    const outer = await mkdtemp(path.join(tmpdir(), "weaver-outer-repo-"));
    const outerGit = simpleGit({ baseDir: outer });
    await outerGit.raw(["init", "-b", "main", "."]);
    await outerGit.raw(["config", "user.email", "outer@test.local"]);
    await outerGit.raw(["config", "user.name", "Outer"]);
    await writeFile(path.join(outer, "tracked.txt"), "committed\n");
    await outerGit.raw(["add", "tracked.txt"]);
    await outerGit.raw(["commit", "-m", "outer base"]);
    const baseSha = (await outerGit.revparse(["HEAD"])).trim();
    // Uncommitted work that a stray `add -A` would sweep into the outer repo.
    await writeFile(path.join(outer, "tracked.txt"), "uncommitted\n");

    const nestedDataDir = path.join(outer, "data");
    await mkdir(nestedDataDir, { recursive: true });
    vi.stubEnv("WEAVER_DATA_DIR", nestedDataDir);
    vi.resetModules();
    const { withProjectRepo, repoDir } = await import("./gitStore");
    const projectId = "99999999-9999-4999-8999-999999999991";

    await expect(
      withProjectRepo(projectId, async (repo) => {
        await repo.writeFileAtomic("notes.md", "hello");
        // resetTestState() wipes ${dataDir}/git; lose the repo mid-write.
        await rm(path.join(repoDir(projectId), ".git"), {
          recursive: true,
          force: true,
        });
        return repo.commitAll("create: notes.md", {
          name: "Alice",
          email: "alice@example.test",
          userId: "55555555-5555-4555-8555-555555555555",
        });
      }),
    ).rejects.toThrow();

    expect((await outerGit.revparse(["HEAD"])).trim()).toBe(baseSha);
    expect(await readFile(path.join(outer, "tracked.txt"), "utf8")).toBe(
      "uncommitted\n",
    );

    vi.stubEnv("WEAVER_DATA_DIR", testDataDir);
    vi.resetModules();
    await rm(outer, { recursive: true, force: true });
  });
});

it("keeps history paths and attribution intact for control-character input", async () => {
  const { withProjectRepo } = await import("./gitStore");
  await withProjectRepo(randomUUID(), async (repo) => {
    await repo.writeFileAtomic("safe.md", "safe\n");
    const sha = await repo.commitAll("fix\x1fM\tother.md\x1e", {
      userId: randomUUID(),
      name: "Alice\x1eMallory",
      email: "alice\x1f@example.com",
    });
    const history = await repo.logForPath("safe.md", { skip: 0, limit: 10 });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      sha,
      pathAtSha: "safe.md",
      authorName: "AliceMallory",
      authorEmail: "alice@example.com",
    });
    const changes = await repo.logSince(null, { limit: 1 });
    expect(changes).toHaveLength(1);
    expect(changes[0]?.changes).toEqual([
      { status: "A", path: "safe.md", oldPath: null },
    ]);
  });
});

it("keeps line breaks in commit messages while stripping other control characters", async () => {
  const { repoDir, withProjectRepo } = await import("./gitStore");
  const projectId = randomUUID();
  await withProjectRepo(projectId, async (repo) => {
    await repo.writeFileAtomic("notes.md", "notes\n");
    await repo.commitAll("save: notes\x1e\n\nsecond\x1f paragraph\r\nthird", {
      userId: randomUUID(),
      name: "Alice",
      email: "alice@example.com",
    });
    const git = simpleGit({ baseDir: repoDir(projectId) });
    const body = await git.raw(["log", "-1", "--format=%B"]);
    expect(body).toContain("save: notes\n\nsecond paragraph\nthird");
    expect(body).not.toMatch(/[\x1e\x1f\r]/);
    const [entry] = await repo.logForPath("notes.md", { skip: 0, limit: 1 });
    expect(entry?.message).toBe("save: notes");
  });
});

it("distinguishes absent blobs from operational Git failures", async () => {
  const { rename } = await import("node:fs/promises");
  const { withProjectRepo, repoDir } = await import("./gitStore");
  await withProjectRepo("source-errors", async (repo) => {
    await repo.writeFileAtomic("source.md", "source");
    const sha = await repo.commitAll("source", {
      name: "Writer",
      email: "writer@example.test",
      userId: "11111111-1111-4111-8111-111111111111",
    });
    expect(await repo.blobSizeAt(sha, "missing.md")).toBeNull();
    expect(await repo.blobSizeAt(sha, "source.md")).toBe(6);
    const gitPath = path.join(repoDir("source-errors"), ".git");
    await rename(gitPath, `${gitPath}-offline`);
    try {
      await expect(repo.blobSizeAt(sha, "source.md")).rejects.toThrow();
      await expect(repo.isAncestor(sha, "HEAD")).rejects.toThrow();
    } finally {
      await rename(`${gitPath}-offline`, gitPath);
    }
  });
});

it("treats absent and non-commit revisions as unavailable ancestry", async () => {
  const { withProjectRepo, repoDir } = await import("./gitStore");
  const projectId = randomUUID();
  await withProjectRepo(projectId, async (repo) => {
    await repo.writeFileAtomic("source.md", "source");
    const sha = await repo.commitAll("source", {
      name: "Writer",
      email: "writer@example.test",
      userId: randomUUID(),
    });
    const git = simpleGit({ baseDir: repoDir(projectId) });
    const blob = (await git.revparse([`${sha}:source.md`])).trim();
    const tree = (await git.revparse([`${sha}^{tree}`])).trim();
    for (const unavailable of [
      "0".repeat(40),
      blob,
      tree,
      `${sha}\nHEAD`,
      `${sha}\0`,
      "a".repeat(201),
    ]) {
      await expect(repo.isAncestor(unavailable, sha)).resolves.toBe(false);
      await expect(repo.isAncestor(sha, unavailable)).resolves.toBe(false);
    }
  });
});

it("preserves corrupt-object failures when verifying ancestry", async () => {
  const { chmod } = await import("node:fs/promises");
  const { withProjectRepo, repoDir } = await import("./gitStore");
  const projectId = randomUUID();
  await withProjectRepo(projectId, async (repo) => {
    await repo.writeFileAtomic("source.md", "source");
    const sha = await repo.commitAll("source", {
      name: "Writer",
      email: "writer@example.test",
      userId: randomUUID(),
    });
    const objectPath = path.join(
      repoDir(projectId),
      ".git",
      "objects",
      sha.slice(0, 2),
      sha.slice(2),
    );
    const original = await readFile(objectPath);
    await chmod(objectPath, 0o600);
    try {
      await writeFile(objectPath, "corrupt object");
      await expect(repo.isAncestor(sha, "HEAD")).rejects.toThrow();
    } finally {
      await writeFile(objectPath, original);
      await chmod(objectPath, 0o444);
    }
  });
});

describe("pull merge primitives", () => {
  it("fetches a local ref, resets and restores paths, commits a merge, and deletes the ref", async () => {
    const { withProjectRepo, repoDir } = await import("./gitStore");
    const localProjectId = randomUUID();
    const otherProjectId = randomUUID();
    const author = {
      name: "Puller",
      email: "puller@example.test",
      userId: randomUUID(),
    };

    const localHead = await withProjectRepo(localProjectId, async (repo) => {
      await repo.writeFileAtomic("a.md", "local\n");
      return repo.commitAll("create: a.md", author);
    });
    const otherHead = await withProjectRepo(otherProjectId, async (repo) => {
      await repo.writeFileAtomic("b.md", "other\n");
      return repo.commitAll("create: b.md", author);
    });

    await withProjectRepo(localProjectId, async (repo) => {
      const fetchedSha = await repo.fetchLocalRef(
        repoDir(otherProjectId),
        "refs/heads/main",
        "refs/weaver/pull",
      );
      expect(fetchedSha).toBe(otherHead);

      await repo.resetWorktreeTo("refs/weaver/pull");
      expect(await repo.fileExistsInWorktree("b.md")).toBe(true);
      expect(await repo.fileExistsInWorktree("a.md")).toBe(false);

      await repo.checkoutPathsFrom(localHead, ["a.md"]);
      expect(await repo.fileExistsInWorktree("a.md")).toBe(true);
      const indexed = await simpleGit(repo.dir).raw(["ls-files", "--", "a.md"]);
      expect(indexed.trim()).toBe("a.md");

      const mergeSha = await repo.commitTreeWithParents(
        "pull: merge main",
        author,
        [otherHead, localHead],
      );

      const parents = (
        await simpleGit(repo.dir).raw(["log", "--format=%P", "-1"])
      ).trim();
      expect(parents).toBe(`${otherHead} ${localHead}`);
      expect(await repo.resolveHead()).toBe(mergeSha);
      const status = await simpleGit(repo.dir).raw(["status", "--porcelain"]);
      expect(status.trim()).toBe("");
      expect((await repo.listTrackedFiles("HEAD")).sort()).toEqual([
        "a.md",
        "b.md",
      ]);

      await repo.deleteRef("refs/weaver/pull");
      const refs = await simpleGit(repo.dir).raw([
        "for-each-ref",
        "refs/weaver",
      ]);
      expect(refs.trim()).toBe("");
    });
  });

  it("rejects unsafe refs, directories, and paths", async () => {
    const { withProjectRepo, repoDir } = await import("./gitStore");
    const projectId = randomUUID();
    await withProjectRepo(projectId, async (repo) => {
      await expect(
        repo.fetchLocalRef(
          "relative/path",
          "refs/heads/main",
          "refs/weaver/pull",
        ),
      ).rejects.toThrow();
      await expect(
        repo.fetchLocalRef(
          repoDir(projectId),
          "heads/main",
          "refs/weaver/pull",
        ),
      ).rejects.toThrow();
      await expect(
        repo.fetchLocalRef(repoDir(projectId), "refs/heads/main", "not-a-ref"),
      ).rejects.toThrow();
      await expect(repo.resetWorktreeTo("main")).rejects.toThrow();
      await expect(
        repo.checkoutPathsFrom("HEAD", ["../escape"]),
      ).rejects.toThrow();
      await expect(
        repo.checkoutPathsFrom("HEAD", ["/absolute"]),
      ).rejects.toThrow();
      await expect(
        repo.checkoutPathsFrom("--upload-pack=x", ["a.md"]),
      ).rejects.toThrow("invalid commitish");
      await expect(repo.deleteRef("main")).rejects.toThrow();
    });
  });
});

describe("literal path handling", () => {
  it("restores only the named path when it contains glob metacharacters", async () => {
    const { withProjectRepo } = await import("./gitStore");
    const projectId = randomUUID();
    const author = {
      name: "Puller",
      email: "puller@example.test",
      userId: randomUUID(),
    };
    const globbed = ["a*.txt", "a[b].txt", "a?.txt"];
    const others = ["ab.txt", "ac.txt"];

    await withProjectRepo(projectId, async (repo) => {
      for (const name of [...globbed, ...others]) {
        await repo.writeFileAtomic(name, "one\n");
      }
      const first = await repo.commitAll("create: files", author);
      for (const name of [...globbed, ...others]) {
        await repo.writeFileAtomic(name, "two\n");
      }
      await repo.commitAll("update: files", author);

      await repo.checkoutPathsFrom(first, globbed);

      for (const name of globbed) {
        expect(await readFile(path.join(repo.dir, name), "utf8")).toBe("one\n");
      }
      for (const name of others) {
        expect(await readFile(path.join(repo.dir, name), "utf8")).toBe("two\n");
      }
    });
  });

  it("lists non-ASCII tracked paths literally", async () => {
    const { withProjectRepo } = await import("./gitStore");
    const projectId = randomUUID();
    const author = {
      name: "Puller",
      email: "puller@example.test",
      userId: randomUUID(),
    };
    await withProjectRepo(projectId, async (repo) => {
      await repo.writeFileAtomic("docs/Übersicht.md", "u\n");
      await repo.writeFileAtomic("Notizen-über.md", "n\n");
      const sha = await repo.commitAll("create: unicode", author);
      expect((await repo.listTrackedFiles(sha)).sort()).toEqual(
        ["Notizen-über.md", "docs/Übersicht.md"].sort(),
      );
      await repo.checkoutPathsFrom(sha, ["docs/Übersicht.md"]);
      expect(
        await readFile(path.join(repo.dir, "docs/Übersicht.md"), "utf8"),
      ).toBe("u\n");
    });
  });
});

describe("batched blob reads", () => {
  it("reads many blobs in one batch, skipping missing, oversize and non-blob paths", async () => {
    const { withProjectRepo } = await import("./gitStore");
    const projectId = randomUUID();
    const author = {
      name: "Reader",
      email: "reader@example.test",
      userId: randomUUID(),
    };
    await withProjectRepo(projectId, async (repo) => {
      await repo.writeFileAtomic("docs/Übersicht.md", "über\n");
      await repo.writeFileAtomic("a*.txt", "star\n");
      await repo.writeFileAtomic("plain.md", "plain\n");
      await repo.writeFileAtomic("big.md", "x".repeat(50));
      const sha = await repo.commitAll("create: batch", author);

      const blobs = await repo.readBlobsAt(sha, [
        "docs/Übersicht.md",
        "a*.txt",
        "plain.md",
        "missing.md",
        "docs",
        "../escape",
        "with\nnewline.md",
      ]);
      expect([...blobs.entries()].sort()).toEqual([
        ["a*.txt", "star\n"],
        ["docs/Übersicht.md", "über\n"],
        ["plain.md", "plain\n"],
      ]);

      // The size cap drops the oversize blob without desynchronising the
      // responses that follow it.
      const capped = await repo.readBlobsAt(sha, ["big.md", "plain.md"], 10);
      expect([...capped.keys()]).toEqual(["plain.md"]);
      expect(await repo.readBlobsAt(sha, [])).toEqual(new Map());
      await expect(
        repo.readBlobsAt("--upload-pack=x", ["a.md"]),
      ).rejects.toThrow("invalid commitish");
    });
  });

  it("drains an oversize blob between two accepted blobs without buffering it", async () => {
    const { withProjectRepo } = await import("./gitStore");
    const author = {
      name: "Reader",
      email: "reader@example.test",
      userId: randomUUID(),
    };
    const maxBytes = 1_000;
    await withProjectRepo(randomUUID(), async (repo) => {
      await repo.writeFileAtomic("a-before.md", "before\n");
      await repo.writeFileAtomic(
        "b-huge.md",
        "0123456789abcdef".repeat(250_000),
      );
      await repo.writeFileAtomic("c-after.md", "after ü\n");
      const sha = await repo.commitAll("create: huge", author);

      const concat = vi.spyOn(Buffer, "concat");
      try {
        const blobs = await repo.readBlobsAt(
          sha,
          ["a-before.md", "b-huge.md", "c-after.md"],
          maxBytes,
        );
        expect([...blobs.entries()]).toEqual([
          ["a-before.md", "before\n"],
          ["c-after.md", "after ü\n"],
        ]);
        // Only kept payloads (<= maxBytes + LF) and header lines are joined.
        const largest = Math.max(
          0,
          ...concat.mock.calls.map(([parts]) =>
            parts.reduce((total, part) => total + part.length, 0),
          ),
        );
        expect(largest).toBeLessThanOrEqual(maxBytes + 1);
      } finally {
        concat.mockRestore();
      }
    });
  });

  it("decodes multi-byte characters split across pipe chunks", async () => {
    const { withProjectRepo } = await import("./gitStore");
    const author = {
      name: "Reader",
      email: "reader@example.test",
      userId: randomUUID(),
    };
    const content = `x${"ü".repeat(200_000)}\n`;
    await withProjectRepo(randomUUID(), async (repo) => {
      await repo.writeFileAtomic("umlauts.md", content);
      await repo.writeFileAtomic("tail.md", "tail\n");
      const sha = await repo.commitAll("create: umlauts", author);
      const blobs = await repo.readBlobsAt(sha, ["umlauts.md", "tail.md"]);
      expect(blobs.get("umlauts.md")).toBe(content);
      expect(blobs.get("tail.md")).toBe("tail\n");
    });
  });
});

describe("worktree containment", () => {
  it("refuses to read or write through a Git-supplied symlink", async () => {
    const { withProjectRepo, WorktreePathError } = await import("./gitStore");
    const outside = await mkdtemp(path.join(tmpdir(), "weaver-outside-"));
    const author = {
      name: "Writer",
      email: "writer@example.test",
      userId: randomUUID(),
    };
    try {
      await withProjectRepo(randomUUID(), async (repo) => {
        await repo.writeFileAtomic("real/note.md", "note\n");
        await symlink(outside, path.join(repo.dir, "link"));
        await repo.commitAll("create: symlink", author);
        expect(
          (await repo.listTreeEntries()).find((entry) => entry.path === "link")
            ?.mode,
        ).toBe("120000");

        expect(await repo.fileExistsInWorktree("link")).toBe(false);
        expect(await repo.fileExistsInWorktree("link/x.md")).toBe(false);
        expect(await repo.fileExistsInWorktree("real/note.md")).toBe(true);
        expect(await repo.fileExistsInWorktree("real/missing.md")).toBe(false);

        for (const attempt of [
          () => repo.writeFileAtomic("link/escape.md", "x"),
          () => repo.writeFileAtomic("link/deep/escape.md", "x"),
          () =>
            repo.writeBinaryFileAtomic("link/escape.png", new Uint8Array(1)),
          () => repo.ensureFolder("link/folder"),
          () => repo.ensureFolder("link"),
          () => repo.mv("real/note.md", "link/note.md"),
          () => repo.writeFileAtomic("../escape.md", "x"),
          () => repo.writeFileAtomic(".git/config", "x"),
        ])
          await expect(attempt()).rejects.toBeInstanceOf(WorktreePathError);

        expect(await readdir(outside)).toEqual([]);
        expect(await repo.fileExistsInWorktree("real/note.md")).toBe(true);
        await repo.writeFileAtomic("real/new/other.md", "fine\n");
        expect(await repo.fileExistsInWorktree("real/new/other.md")).toBe(true);
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

it("keeps foreign control bytes out of log framing and does not trust forged identities", async () => {
  const { withProjectRepo } = await import("./gitStore");
  await withProjectRepo(randomUUID(), async (repo) => {
    await repo.writeFileAtomic("foreign.md", "foreign\n");
    const git = simpleGit(repo.dir);
    await git.add("foreign.md");
    await git.raw([
      "-c",
      "user.name=Remote",
      "-c",
      "user.email=remote@example.test",
      "commit",
      "-m",
      "foreign\x1e\x1f\n\nWeaver-User-Id: victim",
    ]);
    const entries = await repo.logForPath("foreign.md", { skip: 0, limit: 10 });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      trustedAuthor: false,
      pathAtSha: "foreign.md",
    });
  });
});
it("stages new files despite remote ignore rules and preserves canonical LF text", async () => {
  const { withProjectRepo } = await import("./gitStore");
  const id = randomUUID();
  const author = {
    name: "User",
    email: "user@example.test",
    userId: randomUUID(),
  };
  await withProjectRepo(id, async (repo) => {
    await repo.writeFileAtomic(".gitignore", "*.md\n");
    await repo.writeFileAtomic(".gitattributes", "* text=auto eol=crlf\n");
    await repo.commitAll("rules", author);
  });
  await withProjectRepo(id, async (repo) => {
    await repo.writeFileAtomic("new.md", "line one\nline two\n");
    await repo.commitAll("create: new.md", author);
    expect(await repo.readFileFromWorktree("new.md")).toBe(
      "line one\nline two\n",
    );
  });
});

it("removes only safe fresh untracked files", async () => {
  const { withProjectRepo } = await import("./gitStore");
  await withProjectRepo(randomUUID(), async (repo) => {
    const remove = (relPath: string) => repo.removeUntrackedFile(relPath);
    await repo.writeFileAtomic("tracked.txt", "kept");
    await repo.commitAll("test: tracked", {
      userId: randomUUID(),
      name: "Test",
      email: "test@example.com",
    });
    await repo.writeFileAtomic("fresh.txt", "fresh");
    await remove("fresh.txt");
    await expect(
      readFile(path.join(repo.dir, "fresh.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(remove("tracked.txt")).rejects.toThrow();
    await expect(remove("../escape")).rejects.toThrow();
    const outside = await mkdtemp(path.join(tmpdir(), "weaver-icon-rollback-"));
    try {
      await writeFile(path.join(outside, "keep.txt"), "outside");
      await symlink(outside, path.join(repo.dir, "linked"));
      await expect(remove("linked/keep.txt")).rejects.toThrow();
      expect(await readFile(path.join(outside, "keep.txt"), "utf8")).toBe(
        "outside",
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
    expect(await repo.readFileFromWorktree("tracked.txt")).toBe("kept");
  });
});

it("checks a publishing guard after staging and before committing", async () => {
  const { withProjectRepo } = await import("./gitStore");
  await withProjectRepo(randomUUID(), async (repo) => {
    const head = await repo.resolveHead();
    await repo.writeFileAtomic("audit.md", "Pending audit");
    await expect(
      repo.commitAll(
        "audit",
        { name: "Audit", email: "audit@test.local", userId: randomUUID() },
        {
          beforeCommit: async () => {
            throw new Error("expired before commit");
          },
        },
      ),
    ).rejects.toThrow("expired before commit");
    expect(await repo.resolveHead()).toBe(head);
    await repo.resetWorktreeTo(head);
  });
});

it.each(["commitAll", "commitTreeWithParents"] as const)(
  "preserves accepted %s when the trusted ledger is unavailable",
  async (method) => {
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const { withProjectRepo } = await import("./gitStore");
    await withProjectRepo(randomUUID(), async (repo) => {
      const head = await repo.resolveHead();
      await mkdir(path.join(repo.dir, ".git", "weaver-trusted-commits"));
      await repo.writeFileAtomic("accepted.md", "Persisted");
      const author = {
        name: "Writer",
        email: "writer@test.local",
        userId: "writer",
      };
      const sha =
        method === "commitAll"
          ? await repo.commitAll("accepted", author)
          : await repo.commitTreeWithParents("accepted", author, [head]);
      expect(sha).toBe(await repo.resolveHead());
      expect(await repo.showFileAt(sha, "accepted.md")).toBe("Persisted");
      expect(
        (await repo.logForPath("accepted.md", { skip: 0, limit: 1 }))[0]
          ?.trustedAuthor,
      ).toBe(true);
      await rm(path.join(repo.dir, ".git", "weaver-trusted-commits"), {
        recursive: true,
      });
      await repo.writeFileAtomic("second.md", "Second");
      await repo.commitAll("second", author);
      expect(
        await readFile(
          path.join(repo.dir, ".git", "weaver-trusted-commits"),
          "utf8",
        ),
      ).toContain(sha);
    });
    warning.mockRestore();
  },
);

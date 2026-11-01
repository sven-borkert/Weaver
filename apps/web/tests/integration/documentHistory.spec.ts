import { beforeEach, describe, expect, it, vi } from "vitest";
import { simpleGit } from "simple-git";
import {
  addMembership,
  callerFor,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
  markdownContent,
} from "./_harness";
import { parseDocumentFile } from "@weaver/core/documents/frontmatter";
import { pathAtCommit, restoreDocument } from "@weaver/core/services/documents";
import {
  openProjectRepo,
  type ProjectRepoReader,
  withProjectRepo,
} from "@weaver/git-store";

type MatrixRole = "Owner" | "Maintainer" | "Editor" | "Viewer" | null;

async function setupProjectWith(role: MatrixRole, suffix: string) {
  const owner = await makeUser("User", `owner-${suffix}`);
  const project = await makeProject(`P-${suffix}`);
  await addMembership(project.id, owner.id, "Owner");
  if (role === null) {
    const actor = await makeUser("User", `out-${suffix}`);
    return { project, caller: callerFor(actor), actor };
  }
  const actor = await makeUser("User", `${role.toLowerCase()}-${suffix}`);
  await addMembership(project.id, actor.id, role);
  return { project, caller: callerFor(actor), actor };
}

const PARA = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

const PARAS = (prefix: string, count: number) => ({
  type: "doc",
  content: Array.from({ length: count }, (_, index) => ({
    type: "paragraph",
    content: [{ type: "text", text: `${prefix}-${index}` }],
  })),
});

describe("document history", () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function docWithVersions(suffix: string) {
    const ctx = await setupProjectWith("Editor", suffix);
    const v1 = await ctx.caller.document.create({
      projectId: ctx.project.id,
      folderPath: [],
      title: "Doc",
      contentJson: PARA("version one"),
    });
    const v2 = await ctx.caller.document.update({
      projectId: ctx.project.id,
      documentId: v1.id,
      baseCommitSha: v1.headCommitSha,
      content: { kind: "markdown", contentJson: PARA("version two") },
      changeSummary: "Explain the second version",
    });
    return { ...ctx, id: v1.id, v1, v2 };
  }

  it("returns stored change summaries beside the raw commit message", async () => {
    const { caller, project, id, v2 } =
      await docWithVersions("summary-overlay");
    const v3 = await caller.document.update({
      projectId: project.id,
      documentId: id,
      baseCommitSha: v2.headCommitSha,
      content: { kind: "markdown", contentJson: PARA("version three") },
    });
    const now = new Date();
    await getPrisma().documentChangeSummary.create({
      data: {
        projectId: project.id,
        commitSha: v3.headCommitSha,
        documentId: id,
        pathAtSha: v3.path,
        baseCommitSha: v2.headCommitSha,
        status: "ready",
        summary: "Explain the second version in detail",
        attempts: 1,
        createdAt: now,
        updatedAt: now,
        completedAt: now,
      },
    });
    const history = await caller.document.history({
      projectId: project.id,
      documentId: id,
    });
    expect(history.entries[0]).toMatchObject({
      sha: v3.headCommitSha,
      message: `update: ${v3.path}`,
      changeSummary: {
        status: "ready",
        summary: "Explain the second version in detail",
      },
    });
    expect(history.entries[1]?.changeSummary).toBeNull();
  });

  it("lists commits newest-first with attribution and offset paging", async () => {
    const { project, caller, id, v1, v2, actor } = await docWithVersions("h1");
    const page1 = await caller.document.history({
      projectId: project.id,
      documentId: id,
      offset: 0,
      limit: 1,
    });
    expect(page1.entries).toHaveLength(1);
    expect(page1.entries[0]).toMatchObject({
      sha: v2.headCommitSha,
      userId: actor.id,
      userName: "User editor-h1",
    });
    expect(page1.hasMore).toBe(true);

    const page2 = await caller.document.history({
      projectId: project.id,
      documentId: id,
      offset: 1,
      limit: 10,
    });
    expect(page2.entries.map((entry) => entry.sha)).toEqual([v1.headCommitSha]);
    expect(page2.hasMore).toBe(false);
  });

  it("records an explicit change summary in update history", async () => {
    const { project, caller, id, v2 } = await docWithVersions("summary");
    const history = await caller.document.history({
      projectId: project.id,
      documentId: id,
      offset: 0,
      limit: 1,
    });
    expect(history.entries[0]).toMatchObject({
      sha: v2.headCommitSha,
      message: "update: doc.md — Explain the second version",
    });
  });

  it("pages across renames with offset-based --follow history", async () => {
    const { project, caller, id, v1, v2 } = await docWithVersions("h2");
    const v3 = await caller.document.update({
      projectId: project.id,
      documentId: id,
      baseCommitSha: v2.headCommitSha,
      title: "Renamed Doc",
      content: { kind: "markdown", contentJson: PARA("version three") },
      changeSummary: "Rename the history document",
    });
    const firstPage = await caller.document.history({
      projectId: project.id,
      documentId: id,
      offset: 0,
      limit: 2,
    });
    expect(firstPage.entries.map((entry) => entry.sha)).toEqual([
      v3.headCommitSha,
      v2.headCommitSha,
    ]);
    expect(firstPage.hasMore).toBe(true);
    const secondPage = await caller.document.history({
      projectId: project.id,
      documentId: id,
      offset: 2,
      limit: 2,
    });
    expect(secondPage.entries.map((entry) => entry.sha)).toEqual([
      v1.headCommitSha,
    ]);
    expect(secondPage.hasMore).toBe(false);
  });

  it("keeps untrusted authors external despite matching trailers or email", async () => {
    const { project, caller, id, actor } = await docWithVersions("h3");
    const emailUser = await makeUser("User", "history-email");
    await withProjectRepo(project.id, async (repo) => {
      const original = await repo.readFileFromWorktree("doc.md");
      await repo.writeFileAtomic(
        "doc.md",
        original.replace("version two", "version three"),
      );
      const git = simpleGit({ baseDir: repo.dir }).env({
        GIT_AUTHOR_NAME: "Email User",
        GIT_AUTHOR_EMAIL: emailUser.email,
        GIT_COMMITTER_NAME: "Weaver",
        GIT_COMMITTER_EMAIL: "weaver@local",
      });
      await git.raw(["add", "-A"]);
      await git.raw([
        "commit",
        "-m",
        "legacy with trailer",
        "--trailer",
        `Weaver-User-Id: ${actor.id.toUpperCase()}`,
      ]);

      const next = await repo.readFileFromWorktree("doc.md");
      await repo.writeFileAtomic(
        "doc.md",
        next.replace("version three", "version four"),
      );
      await git.raw(["add", "-A"]);
      await git.raw([
        "commit",
        "-m",
        "legacy with unknown trailer",
        "--trailer",
        "Weaver-User-Id: 11111111-1111-4111-8111-111111111111",
      ]);

      const latest = await repo.readFileFromWorktree("doc.md");
      await repo.writeFileAtomic(
        "doc.md",
        latest.replace("version four", "version five"),
      );
      await git.raw(["add", "-A"]);
      await git.raw([
        "commit",
        "-m",
        "legacy with malformed trailer",
        "--trailer",
        "Weaver-User-Id: ------------------------------------",
      ]);
    });

    const history = await caller.document.history({
      projectId: project.id,
      documentId: id,
      offset: 0,
      limit: 3,
    });
    expect(history.entries[0]).toMatchObject({
      message: "legacy with malformed trailer",
      userId: null,
      userName: null,
      authorName: "Email User",
    });
    expect(history.entries[1]).toMatchObject({
      message: "legacy with unknown trailer",
      userId: null,
      userName: null,
      authorName: "Email User",
    });
    expect(history.entries[2]).toMatchObject({
      message: "legacy with trailer",
      userId: null,
      userName: null,
      authorName: "Email User",
    });
  });

  it("resolves a rename-aware version beyond the first ten pages", async () => {
    const targetSha = "f".repeat(40);
    const repo = {
      isAncestor: async () => true,
      logForPath: vi.fn(
        async (_path: string, input: { skip: number; limit: number }) =>
          [
            ...Array.from({ length: 1_000 }, (_, index) => ({
              sha: `${index}`.padStart(40, "0"),
              pathAtSha: "current.md",
            })),
            { sha: targetSha, pathAtSha: "historic.md" },
          ].slice(input.skip, input.skip + input.limit),
      ),
    } as unknown as ProjectRepoReader;

    await expect(pathAtCommit(repo, "current.md", targetSha)).resolves.toBe(
      "historic.md",
    );
  });

  it("diffs bodies across rename boundaries via pathAtSha", async () => {
    const { project, caller, id, v1, v2 } = await docWithVersions("h4");
    const latest = await caller.document.update({
      projectId: project.id,
      documentId: id,
      baseCommitSha: v2.headCommitSha,
      title: "Renamed",
      content: { kind: "markdown", contentJson: PARA("version three") },
      changeSummary: "Rename the diff document",
    });
    const diff = await caller.document.diff({
      projectId: project.id,
      documentId: id,
      fromSha: v1.headCommitSha,
      toSha: latest.headCommitSha,
    });
    if (!("lines" in diff) || !diff.lines) {
      throw new Error("expected a structured diff");
    }
    expect(
      diff.lines.some(
        (line) => line.type === "del" && line.text.includes("version one"),
      ),
    ).toBe(true);
    expect(
      diff.lines.some(
        (line) => line.type === "add" && line.text.includes("version three"),
      ),
    ).toBe(true);
    expect(diff.lines.some((line) => line.text.includes("title:"))).toBe(false);
  });

  it("degrades oversized inputs and adversarial edit work", async () => {
    const chars = await setupProjectWith("Editor", "h5-chars");
    const c1 = await chars.caller.document.create({
      projectId: chars.project.id,
      folderPath: [],
      title: "Big",
      contentJson: PARA("a".repeat(510_000)),
    });
    const c2 = await chars.caller.document.update({
      projectId: chars.project.id,
      documentId: c1.id,
      baseCommitSha: c1.headCommitSha,
      content: { kind: "markdown", contentJson: PARA("b".repeat(510_000)) },
      changeSummary: "Replace the oversized body",
    });
    await expect(
      chars.caller.document.diff({
        projectId: chars.project.id,
        documentId: c1.id,
        fromSha: c1.headCommitSha,
        toSha: c2.headCommitSha,
      }),
    ).resolves.toEqual({ tooLarge: true });

    const edits = await setupProjectWith("Editor", "h5-edits");
    const e1 = await edits.caller.document.create({
      projectId: edits.project.id,
      folderPath: [],
      title: "Edits",
      contentJson: PARAS("old", 300),
    });
    const e2 = await edits.caller.document.update({
      projectId: edits.project.id,
      documentId: e1.id,
      baseCommitSha: e1.headCommitSha,
      content: { kind: "markdown", contentJson: PARAS("new", 300) },
      changeSummary: "Replace the adversarial edits",
    });
    await expect(
      edits.caller.document.diff({
        projectId: edits.project.id,
        documentId: e1.id,
        fromSha: e1.headCommitSha,
        toSha: e2.headCommitSha,
      }),
    ).resolves.toEqual({ tooLarge: true });
  });

  it("restores title and body in one final commit while preserving identity", async () => {
    const { project, caller, actor } = await setupProjectWith("Editor", "h6");
    const v1 = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Original",
      contentJson: PARA("version one"),
    });
    const repo = (await openProjectRepo(project.id))!;
    const originalFile = parseDocumentFile(
      await repo.showFileAt(v1.headCommitSha, v1.path),
      "markdown",
    );
    const v2 = await caller.document.update({
      projectId: project.id,
      documentId: v1.id,
      baseCommitSha: v1.headCommitSha,
      title: "Current",
      content: { kind: "markdown", contentJson: PARA("version two") },
      changeSummary: "Prepare the document restore",
    });
    await withProjectRepo(project.id, async (lockedRepo) => {
      await lockedRepo.writeFileAtomic("original.md", "tracked drift\n");
      await lockedRepo.commitAll("external: original.md", {
        name: null,
        email: actor.email,
        userId: actor.id,
      });
    });

    const restored = await caller.document.restore({
      projectId: project.id,
      documentId: v1.id,
      sha: v1.headCommitSha,
      expectedHeadCommitSha: (
        await caller.document.get({ projectId: project.id, documentId: v1.id })
      ).baseCommitSha,
    });
    expect(restored).toMatchObject({
      id: v1.id,
      title: "Original",
      slug: "original-2",
      path: "original-2.md",
    });
    expect(restored.headCommitSha).not.toBe(v1.headCommitSha);
    expect(restored.headCommitSha).not.toBe(v2.headCommitSha);

    const got = await caller.document.get({
      projectId: project.id,
      documentId: v1.id,
    });
    expect(got).toMatchObject({
      id: v1.id,
      title: "Original",
      path: "original-2.md",
      baseCommitSha: restored.headCommitSha,
    });
    expect(JSON.stringify(markdownContent(got))).toContain("version one");
    const restoredFile = parseDocumentFile(
      await repo.showFileAt(restored.headCommitSha, restored.path),
      "markdown",
    );
    expect(restoredFile.meta.id).toBe(originalFile.meta.id);
    expect(restoredFile.meta.created).toBe(originalFile.meta.created);
    expect(new Date(restoredFile.meta.updated).getTime()).toBeGreaterThan(
      new Date(originalFile.meta.updated).getTime(),
    );

    const [entry] = (
      await caller.document.history({
        projectId: project.id,
        documentId: v1.id,
        offset: 0,
        limit: 1,
      })
    ).entries;
    expect(entry).toMatchObject({
      sha: restored.headCommitSha,
      message: `restore: original-2.md (from ${v1.headCommitSha.slice(0, 7)})`,
      userId: actor.id,
    });
    const row = await getPrisma().document.findUniqueOrThrow({
      where: { id: v1.id },
    });
    expect(row.headCommitSha).toBe(restored.headCommitSha);
    expect(row.lastEditedById).toBe(actor.id);
    expect(row.lastEditedAt).toEqual(entry!.date);
  });

  it("returns Git success when the restore projection transaction fails", async () => {
    const { project, caller, actor, id, v1, v2 } =
      await docWithVersions("h6-projection");
    const db = getPrisma();
    const failingDb = new Proxy(db, {
      get(target, property): unknown {
        if (property === "$transaction") {
          return async () => {
            throw new Error("projection unavailable");
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let restored;
    try {
      restored = await restoreDocument(
        failingDb,
        {
          projectId: project.id,
          documentId: id,
          sha: v1.headCommitSha,
          expectedHeadCommitSha: v2.headCommitSha,
        },
        { ...securityContextFor(actor), email: actor.email, name: null },
      );
    } finally {
      log.mockRestore();
    }

    expect(restored.headCommitSha).not.toBe(v2.headCommitSha);
    const repo = (await openProjectRepo(project.id))!;
    expect(await repo.lastCommitForPath(restored.path)).toBe(
      restored.headCommitSha,
    );
    const restoredFile = parseDocumentFile(
      await repo.showFileAt(restored.headCommitSha, restored.path),
      "markdown",
    );
    expect(restoredFile.body).toContain("version one");
    const stale = await db.document.findUniqueOrThrow({ where: { id } });
    expect(stale.headCommitSha).toBe(v2.headCommitSha);

    const repaired = await caller.document.get({
      projectId: project.id,
      documentId: id,
    });
    expect(repaired.baseCommitSha).toBe(restored.headCommitSha);
    expect(JSON.stringify(markdownContent(repaired))).toContain("version one");
  });

  it("serializes an overlapping restore and document writer", async () => {
    const { project, caller, id, v1, v2 } =
      await docWithVersions("h6-concurrent");
    const [restoreResult, writerResult] = await Promise.allSettled([
      caller.document.restore({
        projectId: project.id,
        documentId: id,
        sha: v1.headCommitSha,
        expectedHeadCommitSha: (
          await caller.document.get({ projectId: project.id, documentId: id })
        ).baseCommitSha,
      }),
      caller.document.update({
        projectId: project.id,
        documentId: id,
        baseCommitSha: v2.headCommitSha,
        content: { kind: "markdown", contentJson: PARA("overlapping writer") },
        changeSummary: "Write during restore",
      }),
    ]);

    const results = [restoreResult, writerResult];
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "CONFLICT" });
    const winner = results.find((result) => result.status === "fulfilled");
    if (!winner) throw new Error("Expected one successful writer");
    const restored = restoreResult.status === "fulfilled";
    const got = await caller.document.get({
      projectId: project.id,
      documentId: id,
    });
    expect(got.baseCommitSha).toBe(winner.value.headCommitSha);
    expect(JSON.stringify(markdownContent(got))).toContain(
      restored ? "version one" : "overlapping writer",
    );
    const history = await caller.document.history({
      projectId: project.id,
      documentId: id,
      offset: 0,
      limit: 1,
    });
    expect(history.entries[0]!.sha).toBe(winner.value.headCommitSha);
    expect(history.entries[0]!.message).toBe(
      restored
        ? `restore: doc.md (from ${v1.headCommitSha.slice(0, 7)})`
        : "update: doc.md — Write during restore",
    );
  });

  it("allows Viewer history/diff, requires Editor restore, and hides existence", async () => {
    const { project, id, v1, v2 } = await docWithVersions("h7");
    const viewer = await makeUser("User", "h7-viewer");
    await addMembership(project.id, viewer.id, "Viewer");
    const viewerCaller = callerFor(viewer);
    await expect(
      viewerCaller.document.history({
        projectId: project.id,
        documentId: id,
        offset: 0,
        limit: 5,
      }),
    ).resolves.toBeTruthy();
    await expect(
      viewerCaller.document.diff({
        projectId: project.id,
        documentId: id,
        fromSha: v1.headCommitSha,
        toSha: v2.headCommitSha,
      }),
    ).resolves.toBeTruthy();
    await expect(
      viewerCaller.document.restore({
        projectId: project.id,
        documentId: id,
        sha: v1.headCommitSha,
        expectedHeadCommitSha: "a".repeat(40),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const outsider = await makeUser("User", "h7-outsider");
    const outsiderCaller = callerFor(outsider);
    await expect(
      outsiderCaller.document.history({
        projectId: project.id,
        documentId: id,
        offset: 0,
        limit: 5,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      outsiderCaller.document.diff({
        projectId: project.id,
        documentId: id,
        fromSha: v1.headCommitSha,
        toSha: v2.headCommitSha,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      outsiderCaller.document.restore({
        projectId: project.id,
        documentId: id,
        sha: v1.headCommitSha,
        expectedHeadCommitSha: "a".repeat(40),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

it("refuses a stale document restore without overwriting another edit", async () => {
  await resetDb();
  const { project, caller } = await setupProjectWith(
    "Editor",
    "restore-stale-review",
  );
  const created = await caller.document.create({
    projectId: project.id,
    folderPath: [],
    title: "Guarded restore",
    contentJson: PARA("original"),
  });
  const updated = await caller.document.update({
    projectId: project.id,
    documentId: created.id,
    baseCommitSha: created.headCommitSha,
    content: { kind: "markdown", contentJson: PARA("another editor") },
    changeSummary: "Another edit",
  });
  await expect(
    caller.document.restore({
      projectId: project.id,
      documentId: created.id,
      sha: created.headCommitSha,
      expectedHeadCommitSha: created.headCommitSha,
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  expect(
    (
      await caller.document.get({
        projectId: project.id,
        documentId: created.id,
      })
    ).baseCommitSha,
  ).toBe(updated.headCommitSha);
});

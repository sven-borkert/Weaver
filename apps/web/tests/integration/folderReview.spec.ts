import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { repoDir } from "@weaver/git-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import {
  composeDocumentFile,
  parseDocumentFile,
} from "@weaver/core/documents/frontmatter";
import {
  composeFolderMetadata,
  newFolderMetadata,
  parseFolderMetadata,
} from "@weaver/core/documents/folderMetadata";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import {
  createDocument,
  rebuildIndex,
  getDocument,
} from "@weaver/core/services/documents";
import * as reviewerGroups from "@weaver/core/services/reviewerGroups";
import * as remoteJobs from "@weaver/core/services/projectGitRemoteJobs";
import * as documents from "@weaver/core/services/documents";
import * as projectRepo from "@weaver/core/services/projectRepo";
import {
  getFolderReviewDefaults,
  previewFolderReview,
  setFolderReviewRecursively,
  clearFolderReviewDefault,
  previewFolderMarkReviewed,
  markFolderReviewed,
} from "@weaver/core/services/folderReview";
import { setDocumentReview } from "@weaver/core/services/documentReview";
import {
  addMembership,
  callerFor,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
} from "./_harness";

async function fixture() {
  const db = getPrisma();
  const owner = {
    ...(await makeUser("User", "folder-owner")),
    name: "User folder-owner",
  };
  const viewer = {
    ...(await makeUser("User", "folder-viewer")),
    name: "User folder-viewer",
  };
  const editor = await makeUser("User", "folder-editor");
  const project = await makeProject("Folder review");
  await addMembership(project.id, owner.id, "Owner");
  await addMembership(project.id, viewer.id, "Viewer");
  await addMembership(project.id, editor.id, "Editor");
  const actor = {
    ...securityContextFor(owner),
    name: owner.name,
    email: owner.email,
  };
  const caller = callerFor(owner);
  await caller.folder.create({
    projectId: project.id,
    parentPath: [],
    name: "Guides",
  });
  const input = {
    projectId: project.id,
    path: ["guides"],
    reviewers: [{ type: "user" as const, id: viewer.id }],
  };
  const doc = await createDocument(
    db,
    {
      projectId: project.id,
      folderPath: ["guides"],
      title: "First",
      content: {
        kind: "markdown",
        contentJson: parseDocumentBody("Preserved text\n"),
      },
    },
    actor,
  );
  return { db, owner, viewer, editor, project, actor, caller, input, doc };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const fileAt = (f: Fixture, path: string) =>
  projectRepo.withProjectRepo(f.project.id, (repo) =>
    repo.readFileFromWorktree(path),
  );
async function apply(f: Fixture) {
  const preview = await previewFolderReview(f.db, f.input, f.actor);
  return setFolderReviewRecursively(
    f.db,
    { ...f.input, expectedHeadCommitSha: preview.baseProjectCommitSha },
    f.actor,
  );
}

describe("recursive folder review", () => {
  let queue: FakeJobQueue;
  beforeEach(async () => {
    await resetDb();
    queue = new FakeJobQueue();
    setJobQueueForTests(queue);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setJobQueueForTests(null);
  });

  it("recursive_assignment_clears_child_overrides_in_one_commit", async () => {
    const f = await fixture();
    await f.caller.folder.create({
      projectId: f.project.id,
      parentPath: ["guides"],
      name: "Nested",
    });
    await projectRepo.withProjectRepo(f.project.id, async (repo) => {
      await repo.writeFileAtomic(
        "guides/nested/.folder.json",
        composeFolderMetadata({
          ...newFolderMetadata(
            "Nested",
            { id: f.owner.id, name: "Owner" },
            new Date("2020-01-01Z"),
          ),
          appearance: { backgroundColor: "#aabbcc" },
          reviewDefaults: { reviewers: [] },
        }),
      );
      const parsed = parseDocumentFile(
        await repo.readFileFromWorktree(f.doc.path),
        "markdown",
      );
      await repo.writeFileAtomic(
        f.doc.path,
        composeDocumentFile(
          {
            ...parsed.meta,
            appearance: { backgroundColor: "#aabbcc" },
            review: {
              ...parsed.meta.review!,
              everyMonths: 6,
              lastReviewed: "2020-01-01T00:00:00.000Z",
              reviewedBy: { id: f.owner.id, name: "Owner" },
            },
          },
          parsed.body,
          "markdown",
        ),
      );
      await repo.commitAll("test: overrides", {
        name: "Owner",
        email: f.owner.email,
        userId: f.owner.id,
      });
    });
    const before = parseDocumentFile(await fileAt(f, f.doc.path), "markdown");
    const preview = await previewFolderReview(f.db, f.input, f.actor);
    expect(preview).toMatchObject({
      documentCount: 1,
      changedDocumentCount: 1,
      descendantDefaultOverrideCount: 1,
      exceedsLimits: false,
    });
    queue.jobs.length = 0;
    const notified = vi
      .spyOn(remoteJobs, "notifyProjectContentChanged")
      .mockResolvedValue(undefined);
    const result = await setFolderReviewRecursively(
      f.db,
      { ...f.input, expectedHeadCommitSha: preview.baseProjectCommitSha },
      f.actor,
    );
    expect(notified).toHaveBeenCalledTimes(1);
    expect(notified.mock.calls[0]?.[0]).toBe(f.db);
    expect(notified.mock.calls[0]?.[1]).toBe(f.project.id);
    expect(
      queue.jobs.some((job) => job.name === "document.change-summary"),
    ).toBe(false);

    expect(result.changedDocumentCount).toBe(1);
    const after = parseDocumentFile(await fileAt(f, f.doc.path), "markdown");
    expect(after).toEqual({
      ...before,
      meta: {
        ...before.meta,
        review: {
          ...before.meta.review!,
          reviewers: [{ type: "user", id: f.viewer.id, name: f.viewer.name }],
        },
      },
    });
    const child = parseFolderMetadata(
      await fileAt(f, "guides/nested/.folder.json"),
    );
    expect(child).toMatchObject({
      appearance: { backgroundColor: "#aabbcc" },
      created: "2020-01-01T00:00:00.000Z",
    });
    expect(child?.reviewDefaults).toBeUndefined();
    await projectRepo.withProjectRepo(f.project.id, async (repo) =>
      expect(
        (await repo.logSince(preview.baseProjectCommitSha, { limit: 2 }))
          .length,
      ).toBe(1),
    );
    expect(
      await getFolderReviewDefaults(
        f.db,
        { ...f.input, path: ["guides", "nested"] },
        f.actor,
      ),
    ).toMatchObject({
      hasOwnDefault: false,
      inheritedFrom: ["guides"],
      reviewers: [{ id: f.viewer.id }],
    });
  });

  it("missing_projection_is_still_updated", async () => {
    const f = await fixture();
    await f.db.document.delete({ where: { id: f.doc.id } });
    expect((await apply(f)).changedDocumentCount).toBe(1);
    expect(
      await f.db.documentReviewer.findMany({ where: { documentId: f.doc.id } }),
    ).toMatchObject([{ userId: f.viewer.id }]);
  });

  it("stale_head_and_removed_target_write_nothing", async () => {
    const f = await fixture();
    const preview = await previewFolderReview(f.db, f.input, f.actor);
    const before = await fileAt(f, f.doc.path);
    await expect(
      setFolderReviewRecursively(
        f.db,
        { ...f.input, expectedHeadCommitSha: "0".repeat(40) },
        f.actor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await f.db.member.deleteMany({
      where: {
        organizationId: (
          await f.db.project.findUniqueOrThrow({ where: { id: f.project.id } })
        ).organizationId,
        userId: f.viewer.id,
      },
    });
    await expect(
      setFolderReviewRecursively(
        f.db,
        { ...f.input, expectedHeadCommitSha: preview.baseProjectCommitSha },
        f.actor,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await fileAt(f, f.doc.path)).toBe(before);
    expect(
      await projectRepo.withProjectRepo(f.project.id, (repo) =>
        repo.resolveHead(),
      ),
    ).toBe(preview.baseProjectCommitSha);
  });

  it("sibling_prefix_is_excluded", async () => {
    const f = await fixture();
    await f.caller.folder.create({
      projectId: f.project.id,
      parentPath: [],
      name: "Guides extra",
    });
    const sibling = await createDocument(
      f.db,
      {
        projectId: f.project.id,
        folderPath: ["guides-extra"],
        title: "Sibling",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("sibling\n"),
        },
      },
      f.actor,
    );
    const before = await fileAt(f, sibling.path);
    expect((await apply(f)).changedDocumentCount).toBe(1);
    expect(await fileAt(f, sibling.path)).toBe(before);
  });

  it("same_assignment_is_noop", async () => {
    const f = await fixture();
    const first = await apply(f);
    expect(await apply(f)).toEqual({
      headCommitSha: first.headCommitSha,
      changedDocumentCount: 0,
    });
    expect(await previewFolderReview(f.db, f.input, f.actor)).toMatchObject({
      changedDocumentCount: 0,
      rewrittenBytes: 0,
    });
  });

  it("clear changes only the selected default; root and empty folders work", async () => {
    const f = await fixture();
    await apply(f);
    const before = await fileAt(f, f.doc.path);
    const head = await projectRepo.withProjectRepo(f.project.id, (repo) =>
      repo.resolveHead(),
    );
    await clearFolderReviewDefault(
      f.db,
      { ...f.input, expectedHeadCommitSha: head },
      f.actor,
    );
    expect(await fileAt(f, f.doc.path)).toBe(before);
    expect(await getFolderReviewDefaults(f.db, f.input, f.actor)).toMatchObject(
      {
        hasOwnDefault: false,
        inheritedFrom: null,
        reviewers: [{ id: f.owner.id }],
      },
    );
    f.input.path = [];
    await apply(f);
    expect(JSON.parse(await fileAt(f, ".folder.json"))).toEqual({
      reviewDefaults: {
        reviewers: [{ type: "user", id: f.viewer.id, name: f.viewer.name }],
      },
    });
    await f.caller.folder.create({
      projectId: f.project.id,
      parentPath: [],
      name: "Empty",
    });
    f.input.path = ["empty"];
    expect((await apply(f)).changedDocumentCount).toBe(0);
  });

  it("rejects unknown folders and unauthorized roles", async () => {
    const f = await fixture();
    await expect(
      previewFolderReview(f.db, { ...f.input, path: ["missing"] }, f.actor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    for (const user of [f.viewer, f.editor]) {
      const actor = {
        ...securityContextFor(user),
        name: null,
        email: user.email,
      };
      expect(
        (await getFolderReviewDefaults(f.db, f.input, actor)).canManage,
      ).toBe(false);
      await expect(
        previewFolderReview(f.db, f.input, actor),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        setFolderReviewRecursively(
          f.db,
          { ...f.input, expectedHeadCommitSha: f.doc.headCommitSha },
          actor,
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        clearFolderReviewDefault(
          f.db,
          { ...f.input, expectedHeadCommitSha: f.doc.headCommitSha },
          actor,
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(
      getFolderReviewDefaults(
        f.db,
        { ...f.input, projectId: randomUUID() },
        f.actor,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("projection_failure_after_commit_is_repairable", async () => {
    const f = await fixture();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = vi
      .spyOn(documents, "projectPreparedDocumentInRepo")
      .mockRejectedValueOnce(new Error("projection unavailable"));
    const result = await apply(f);
    expect(result.changedDocumentCount).toBe(1);
    expect(errorLog).toHaveBeenCalled();
    failure.mockRestore();
    expect(
      await getDocument(
        f.db,
        { projectId: f.project.id, documentId: f.doc.id },
        f.actor,
      ),
    ).toMatchObject({
      baseCommitSha: result.headCommitSha,
      review: { reviewers: [{ id: f.viewer.id }] },
    });
    await rebuildIndex(f.db, { projectId: f.project.id }, f.actor);
    expect(
      await f.db.documentReviewer.findMany({ where: { documentId: f.doc.id } }),
    ).toMatchObject([{ userId: f.viewer.id }]);
  });
  it.each(["write", "commit"])(
    "oversized_batch_and_write_failure_are_atomic: %s failure",
    async (failureAt) => {
      const f = await fixture();
      const before = await fileAt(f, f.doc.path);
      const folderBefore = await fileAt(f, "guides/.folder.json");
      const preview = await previewFolderReview(f.db, f.input, f.actor);
      const real = projectRepo.withProjectRepo;
      let checked = false;
      vi.spyOn(projectRepo, "withProjectRepo").mockImplementationOnce(
        (id, fn) =>
          real(id, async (repo) => {
            let writes = 0;
            try {
              return await fn({
                ...repo,
                writeFileAtomic: async (path, content) => {
                  if (failureAt === "write" && ++writes === 2)
                    throw new Error("write failed");
                  return repo.writeFileAtomic(path, content);
                },
                commitAll: async (...args) => {
                  if (failureAt === "commit") throw new Error("commit failed");
                  return repo.commitAll(...args);
                },
              });
            } finally {
              expect(await readFile(join(repo.dir, f.doc.path), "utf8")).toBe(
                before,
              );
              expect(
                await readFile(join(repo.dir, "guides/.folder.json"), "utf8"),
              ).toBe(folderBefore);
              expect(
                await simpleGit(repo.dir).raw([
                  "diff",
                  "--cached",
                  "--name-only",
                ]),
              ).toBe("");
              expect(
                await simpleGit(repo.dir).raw([
                  "status",
                  "--porcelain",
                  "--untracked-files=all",
                ]),
              ).toBe("");
              expect(await repo.resolveHead()).toBe(
                preview.baseProjectCommitSha,
              );
              checked = true;
            }
          }),
      );
      await expect(
        setFolderReviewRecursively(
          f.db,
          { ...f.input, expectedHeadCommitSha: preview.baseProjectCommitSha },
          f.actor,
        ),
      ).rejects.toThrow(`${failureAt} failed`);
      expect(checked).toBe(true);
    },
  );

  it("removes newly staged root defaults and restores disk and index before releasing the writer", async () => {
    const f = await fixture();
    const input = { ...f.input, path: [] };
    const before = await fileAt(f, f.doc.path);
    const folderBefore = await fileAt(f, "guides/.folder.json");
    const preview = await previewFolderReview(f.db, input, f.actor);
    const real = projectRepo.withProjectRepo;
    let checked = false;
    vi.spyOn(projectRepo, "withProjectRepo").mockImplementationOnce((id, fn) =>
      real(id, async (repo) => {
        await expect(
          readFile(join(repo.dir, ".folder.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        try {
          return await fn({
            ...repo,
            commitAll: async () => {
              const git = simpleGit(repo.dir);
              await git.raw(["add", "-f", "-A"]);
              expect(
                await git.raw(["diff", "--cached", "--name-status"]),
              ).toContain("A\t.folder.json");
              expect(await git.raw(["show", ":.folder.json"])).toContain(
                f.viewer.id,
              );
              throw new Error("staged commit failed");
            },
          });
        } finally {
          expect(await readFile(join(repo.dir, f.doc.path), "utf8")).toBe(
            before,
          );
          expect(
            await readFile(join(repo.dir, "guides/.folder.json"), "utf8"),
          ).toBe(folderBefore);
          await expect(
            readFile(join(repo.dir, ".folder.json")),
          ).rejects.toMatchObject({ code: "ENOENT" });
          expect(await repo.resolveHead()).toBe(preview.baseProjectCommitSha);
          expect(
            await simpleGit(repo.dir).raw(["diff", "--cached", "--name-only"]),
          ).toBe("");
          expect(
            await simpleGit(repo.dir).raw([
              "status",
              "--porcelain",
              "--untracked-files=all",
            ]),
          ).toBe("");
          checked = true;
        }
      }),
    );
    await expect(
      setFolderReviewRecursively(
        f.db,
        { ...input, expectedHeadCommitSha: preview.baseProjectCommitSha },
        f.actor,
      ),
    ).rejects.toThrow("staged commit failed");
    expect(checked).toBe(true);
  });

  async function perDocumentBoundaryFixture(overflow: boolean) {
    const f = await fixture();
    const name = "é".repeat(100);
    await f.db.user.update({ where: { id: f.viewer.id }, data: { name } });
    const second = await createDocument(
      f.db,
      {
        projectId: f.project.id,
        folderPath: ["guides"],
        title: "Second",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("Small sibling\n"),
        },
      },
      f.actor,
    );
    await f.caller.folder.create({
      projectId: f.project.id,
      parentPath: ["guides"],
      name: "Nested",
    });
    const path = "guides/nested/large.md";
    const head = await projectRepo.withProjectRepo(
      f.project.id,
      async (repo) => {
        for (const folder of ["guides", "guides/nested"]) {
          const meta = parseFolderMetadata(
            await repo.readFileFromWorktree(`${folder}/.folder.json`),
          )!;
          await repo.writeFileAtomic(
            `${folder}/.folder.json`,
            composeFolderMetadata({
              ...meta,
              reviewDefaults: { reviewers: [] },
            }),
          );
        }
        const template = parseDocumentFile(
          await repo.readFileFromWorktree(f.doc.path),
          "markdown",
        );
        const meta = {
          ...template.meta,
          id: randomUUID(),
          review: {
            ...template.meta.review!,
            reviewers: [{ type: "user" as const, id: f.viewer.id, name: "A" }],
          },
        };
        const target = {
          ...meta,
          review: {
            ...meta.review,
            reviewers: [{ type: "user" as const, id: f.viewer.id, name }],
          },
        };
        const remaining =
          2_000_000 +
          Number(overflow) -
          Buffer.byteLength(
            composeDocumentFile(target, "\n", "markdown"),
            "utf8",
          );
        const body =
          "é".repeat(Math.floor(remaining / 2)) +
          "x".repeat(remaining % 2) +
          "\n";
        expect(
          Buffer.byteLength(
            composeDocumentFile(target, body, "markdown"),
            "utf8",
          ),
        ).toBe(overflow ? 2_000_001 : 2_000_000);
        const original = composeDocumentFile(meta, body, "markdown");
        expect(Buffer.byteLength(original, "utf8")).toBeLessThan(2_000_000);
        await repo.writeFileAtomic(path, original);
        return repo.commitAll("test: per-document byte boundary", {
          name: f.owner.name,
          email: f.owner.email,
          userId: f.owner.id,
        });
      },
    );
    return { f, path, second, head };
  }

  it("accepts exactly 2,000,000 composed UTF-8 bytes in preview and apply", async () => {
    const { f, path } = await perDocumentBoundaryFixture(false);
    const preview = await previewFolderReview(f.db, f.input, f.actor);
    expect(preview).toMatchObject({
      documentCount: 3,
      changedDocumentCount: 3,
      descendantDefaultOverrideCount: 1,
      exceedsLimits: false,
    });
    expect((await apply(f)).changedDocumentCount).toBe(3);
    expect(
      Buffer.byteLength(
        await readFile(join(repoDir(f.project.id), path), "utf8"),
        "utf8",
      ),
    ).toBe(2_000_000);
    expect(
      parseFolderMetadata(await fileAt(f, "guides/nested/.folder.json"))
        ?.reviewDefaults,
    ).toBeUndefined();
  });

  it.each(["preview", "apply"])(
    "rejects an overflowing member before any changes during %s",
    async (operation) => {
      const { f, path, second, head } = await perDocumentBoundaryFixture(true);
      const dir = repoDir(f.project.id);
      const paths = [
        f.doc.path,
        second.path,
        path,
        "guides/.folder.json",
        "guides/nested/.folder.json",
      ];
      const before = await Promise.all(
        paths.map((path) => readFile(join(dir, path), "utf8")),
      );
      const real = projectRepo.withProjectRepo;
      let writes = 0;
      if (operation === "apply")
        vi.spyOn(projectRepo, "withProjectRepo").mockImplementationOnce(
          (id, fn) =>
            real(id, (repo) =>
              fn({
                ...repo,
                writeFileAtomic: async (...args) => {
                  writes++;
                  return repo.writeFileAtomic(...args);
                },
              }),
            ),
        );
      const result =
        operation === "preview"
          ? previewFolderReview(f.db, f.input, f.actor)
          : setFolderReviewRecursively(
              f.db,
              { ...f.input, expectedHeadCommitSha: head },
              f.actor,
            );
      await expect(result).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringContaining(path),
      });
      expect(writes).toBe(0);
      expect(await simpleGit(dir).revparse(["HEAD"])).toBe(head);
      expect(
        await Promise.all(
          paths.map((path) => readFile(join(dir, path), "utf8")),
        ),
      ).toEqual(before);
      expect(
        await simpleGit(dir).raw(["diff", "--cached", "--name-only"]),
      ).toBe("");
      expect(
        await simpleGit(dir).raw([
          "status",
          "--porcelain",
          "--untracked-files=all",
        ]),
      ).toBe("");
      for (const [index, path] of paths.entries())
        expect(await simpleGit(dir).show([`HEAD:${path}`])).toBe(before[index]);
    },
  );

  it("keeps accepted Git and projections when the commit acknowledgement fails", async () => {
    const f = await fixture();
    const real = projectRepo.withProjectRepo;
    vi.spyOn(projectRepo, "withProjectRepo").mockImplementationOnce((id, fn) =>
      real(id, (repo) =>
        fn({
          ...repo,
          commitAll: async (...args) => {
            await repo.commitAll(...args);
            throw new Error("acknowledgement lost");
          },
        }),
      ),
    );
    expect((await apply(f)).changedDocumentCount).toBe(1);
    expect(
      await f.db.documentReviewer.findMany({ where: { documentId: f.doc.id } }),
    ).toMatchObject([{ userId: f.viewer.id }]);
  });

  it("concurrent_create_and_real_assignment_use_serialized_current_defaults", async () => {
    const f = await fixture();
    const preview = await previewFolderReview(f.db, f.input, f.actor);
    let release!: () => void;
    let enter!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const real = projectRepo.withProjectRepo;
    const spy = vi
      .spyOn(projectRepo, "withProjectRepo")
      .mockImplementationOnce((id, fn) =>
        real(id, async (repo) => {
          enter();
          await barrier;
          return fn(repo);
        }),
      );
    const assignment = setFolderReviewRecursively(
      f.db,
      { ...f.input, expectedHeadCommitSha: preview.baseProjectCommitSha },
      f.actor,
    );
    await entered;
    const creation = createDocument(
      f.db,
      {
        projectId: f.project.id,
        folderPath: ["guides"],
        title: "Concurrent child",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("concurrent\n"),
        },
      },
      f.actor,
    );
    try {
      await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
      release();
      await assignment;
    } finally {
      release();
      await Promise.allSettled([assignment, creation]);
      spy.mockRestore();
    }
    const doc = await creation;
    for (const path of [doc.path, f.doc.path])
      expect(
        parseDocumentFile(await fileAt(f, path), "markdown").meta.review
          ?.reviewers,
      ).toMatchObject([{ id: f.viewer.id }]);
    await projectRepo.withProjectRepo(f.project.id, async (repo) =>
      expect(
        await repo.isAncestor(
          (await assignment).headCommitSha,
          doc.headCommitSha,
        ),
      ).toBe(true),
    );
  });

  it("rejects 1,001 rewrites and accepts exactly 1,000; unchanged files do not count", async () => {
    const f = await fixture();
    const template = parseDocumentFile(await fileAt(f, f.doc.path), "markdown");
    await projectRepo.withProjectRepo(f.project.id, async (repo) => {
      for (let index = 0; index < 1000; index++)
        await repo.writeFileAtomic(
          `guides/bulk-${index}.md`,
          composeDocumentFile(
            { ...template.meta, id: randomUUID() },
            template.body,
            "markdown",
          ),
        );
      await repo.commitAll("test: 1001 documents", {
        name: "Owner",
        email: f.owner.email,
        userId: f.owner.id,
      });
    });
    const oversized = await previewFolderReview(f.db, f.input, f.actor);
    expect(oversized).toMatchObject({
      documentCount: 1001,
      changedDocumentCount: 1001,
      exceedsLimits: true,
    });
    await expect(
      setFolderReviewRecursively(
        f.db,
        { ...f.input, expectedHeadCommitSha: oversized.baseProjectCommitSha },
        f.actor,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await projectRepo.withProjectRepo(f.project.id, async (repo) => {
      expect(await repo.resolveHead()).toBe(oversized.baseProjectCommitSha);
      await repo.writeFileAtomic(
        f.doc.path,
        composeDocumentFile(
          {
            ...template.meta,
            review: {
              ...template.meta.review!,
              reviewers: [
                { type: "user", id: f.viewer.id, name: f.viewer.name },
              ],
            },
          },
          template.body,
          "markdown",
        ),
      );
      await repo.commitAll("test: one unchanged", {
        name: "Owner",
        email: f.owner.email,
        userId: f.owner.id,
      });
    });
    expect(await previewFolderReview(f.db, f.input, f.actor)).toMatchObject({
      documentCount: 1001,
      changedDocumentCount: 1000,
      exceedsLimits: false,
    });
  }, 60_000);

  it("counts rewritten UTF-8 bytes at exactly 50 MiB and one byte over", async () => {
    const f = await fixture();
    const template = parseDocumentFile(await fileAt(f, f.doc.path), "markdown");
    const limit = 50 * 1024 * 1024;
    const count = 30;
    await projectRepo.withProjectRepo(f.project.id, async (repo) => {
      await repo.rm(f.doc.path);
      for (let index = 0; index < count; index++) {
        const meta = { ...template.meta, id: randomUUID() };
        const target = {
          ...meta,
          review: {
            ...meta.review!,
            reviewers: [
              { type: "user" as const, id: f.viewer.id, name: f.viewer.name },
            ],
          },
        };
        const size =
          Math.floor(limit / count) + (index === 0 ? limit % count : 0);
        const overhead = Buffer.byteLength(
          composeDocumentFile(target, "\n", "markdown"),
        );
        await repo.writeFileAtomic(
          `guides/bulk-${index}.md`,
          composeDocumentFile(
            meta,
            "x".repeat(size - overhead) + "\n",
            "markdown",
          ),
        );
      }
      await repo.commitAll("test: byte boundary", {
        name: "Owner",
        email: f.owner.email,
        userId: f.owner.id,
      });
    });
    expect(await previewFolderReview(f.db, f.input, f.actor)).toMatchObject({
      changedDocumentCount: count,
      rewrittenBytes: limit,
      exceedsLimits: false,
    });
    await projectRepo.withProjectRepo(f.project.id, async (repo) => {
      const text = await repo.readFileFromWorktree("guides/bulk-0.md");
      await repo.writeFileAtomic("guides/bulk-0.md", text.slice(0, -1) + "x\n");
      await repo.commitAll("test: byte overflow", {
        name: "Owner",
        email: f.owner.email,
        userId: f.owner.id,
      });
    });
    const oversized = await previewFolderReview(f.db, f.input, f.actor);
    expect(oversized).toMatchObject({
      rewrittenBytes: limit + 1,
      exceedsLimits: true,
    });
    await expect(
      setFolderReviewRecursively(
        f.db,
        { ...f.input, expectedHeadCommitSha: oversized.baseProjectCommitSha },
        f.actor,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(
      await projectRepo.withProjectRepo(f.project.id, (repo) =>
        repo.resolveHead(),
      ),
    ).toBe(oversized.baseProjectCommitSha);
  }, 60_000);
  it.each(["document", "folder"])(
    "validates every %s before any writes",
    async (kind) => {
      const f = await fixture();
      const before = await fileAt(f, f.doc.path);
      const head = await projectRepo.withProjectRepo(
        f.project.id,
        async (repo) => {
          await repo.writeFileAtomic(
            kind === "document"
              ? "guides/invalid.md"
              : "guides/invalid/.folder.json",
            "malformed",
          );
          return repo.commitAll("test: invalid source", {
            name: "Owner",
            email: f.owner.email,
            userId: f.owner.id,
          });
        },
      );
      await expect(
        previewFolderReview(f.db, f.input, f.actor),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(
        setFolderReviewRecursively(
          f.db,
          { ...f.input, expectedHeadCommitSha: head },
          f.actor,
        ),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(await fileAt(f, f.doc.path)).toBe(before);
      expect(
        await projectRepo.withProjectRepo(f.project.id, (repo) =>
          repo.resolveHead(),
        ),
      ).toBe(head);
    },
  );

  it("supports an empty document root and clears only its default", async () => {
    const f = await fixture();
    const project = await makeProject("Empty root");
    await addMembership(project.id, f.owner.id, "Owner");
    const input = { projectId: project.id, path: [], reviewers: [] };
    await projectRepo.withProjectRepo(project.id, (repo) => repo.resolveHead());
    const preview = await previewFolderReview(f.db, input, f.actor);
    expect(preview).toMatchObject({
      documentCount: 0,
      changedDocumentCount: 0,
      rewrittenBytes: 0,
    });
    const result = await setFolderReviewRecursively(
      f.db,
      { ...input, expectedHeadCommitSha: preview.baseProjectCommitSha },
      f.actor,
    );
    expect(await getFolderReviewDefaults(f.db, input, f.actor)).toMatchObject({
      hasOwnDefault: true,
      reviewers: [{ id: f.owner.id }],
    });
    await clearFolderReviewDefault(
      f.db,
      { ...input, expectedHeadCommitSha: result.headCommitSha },
      f.actor,
    );
    expect(await getFolderReviewDefaults(f.db, input, f.actor)).toMatchObject({
      hasOwnDefault: false,
      inheritedFrom: null,
    });
  });
  it.each(["selected", "descendant", "root"])(
    "rejects structured invalid defaults at %s without changing any bytes",
    async (kind) => {
      const f = await fixture();
      const target = kind === "root" ? [] : ["guides"];
      const path =
        kind === "root"
          ? ".folder.json"
          : kind === "descendant"
            ? "guides/nested/.folder.json"
            : "guides/.folder.json";
      const malformed = JSON.stringify({
        ...(kind === "root" ? {} : { name: "Nested" }),
        reviewDefaults: { reviewers: "invalid" },
      });
      const beforeDocument = await fileAt(f, f.doc.path);
      const head = await projectRepo.withProjectRepo(
        f.project.id,
        async (repo) => {
          await repo.writeFileAtomic(path, malformed);
          return repo.commitAll("test: structured invalid default", {
            name: "Owner",
            email: f.owner.email,
            userId: f.owner.id,
          });
        },
      );
      const input = { ...f.input, path: target };
      expect(await getFolderReviewDefaults(f.db, input, f.actor)).toMatchObject(
        { hasOwnDefault: false },
      );
      await expect(
        previewFolderReview(f.db, input, f.actor),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(
        setFolderReviewRecursively(
          f.db,
          { ...input, expectedHeadCommitSha: head },
          f.actor,
        ),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      if (kind !== "descendant")
        await expect(
          clearFolderReviewDefault(
            f.db,
            { ...input, expectedHeadCommitSha: head },
            f.actor,
          ),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(await fileAt(f, f.doc.path)).toBe(beforeDocument);
      expect(await fileAt(f, path)).toBe(malformed);
      expect(
        await projectRepo.withProjectRepo(f.project.id, (repo) =>
          repo.resolveHead(),
        ),
      ).toBe(head);
    },
  );

  it.each(["empty", "owner"])(
    "keeps the configured %s selection distinct and unchanged apply is a no-op",
    async (kind) => {
      const f = await fixture();
      const reviewers =
        kind === "empty" ? [] : [{ type: "user" as const, id: f.owner.id }];
      const preview = await previewFolderReview(
        f.db,
        { ...f.input, reviewers },
        f.actor,
      );
      const first = await setFolderReviewRecursively(
        f.db,
        {
          ...f.input,
          reviewers,
          expectedHeadCommitSha: preview.baseProjectCommitSha,
        },
        f.actor,
      );
      const read = await getFolderReviewDefaults(f.db, f.input, f.actor);
      expect(read).toMatchObject({
        hasOwnDefault: true,
        reviewers: [{ id: f.owner.id }],
        configuredReviewers:
          kind === "empty"
            ? []
            : [{ type: "user", id: f.owner.id, name: f.owner.name }],
      });
      expect(
        await setFolderReviewRecursively(
          f.db,
          {
            ...f.input,
            reviewers: read.configuredReviewers,
            expectedHeadCommitSha: read.baseProjectCommitSha,
          },
          f.actor,
        ),
      ).toEqual({
        headCommitSha: first.headCommitSha,
        changedDocumentCount: 0,
      });
    },
  );

  it("preserves inherited empty settings and reads project configured refs without Owner materialization", async () => {
    const f = await fixture();
    const target = { projectId: f.project.id, path: ["guides"] };
    expect(await getFolderReviewDefaults(f.db, target, f.actor)).toMatchObject({
      configuredReviewers: [],
      inheritedFrom: null,
      reviewers: [{ id: f.owner.id }],
    });
    await f.caller.reviewerGroup.setDefaults({
      projectId: f.project.id,
      everyMonths: 6,
      reviewers: [{ type: "user", id: f.viewer.id }],
    });
    expect(await getFolderReviewDefaults(f.db, target, f.actor)).toMatchObject({
      configuredReviewers: [{ id: f.viewer.id, name: f.viewer.name }],
      inheritedFrom: null,
      reviewers: [{ id: f.viewer.id }],
    });
    const input = { ...target, path: [], reviewers: [] };
    const preview = await previewFolderReview(f.db, input, f.actor);
    await setFolderReviewRecursively(
      f.db,
      { ...input, expectedHeadCommitSha: preview.baseProjectCommitSha },
      f.actor,
    );
    expect(await getFolderReviewDefaults(f.db, target, f.actor)).toMatchObject({
      configuredReviewers: [],
      hasOwnDefault: false,
      inheritedFrom: [],
      reviewers: [{ id: f.owner.id }],
    });
  });

  it("returns configured source names and unresolved identities while resolving effective names", async () => {
    const f = await fixture();
    const missing = randomUUID();
    const configured = [
      { type: "user" as const, id: f.viewer.id, name: "Stored name" },
      { type: "group" as const, id: missing, name: "Removed group" },
    ];
    await projectRepo.withProjectRepo(f.project.id, async (repo) => {
      const meta = parseFolderMetadata(
        await repo.readFileFromWorktree("guides/.folder.json"),
      )!;
      await repo.writeFileAtomic(
        "guides/.folder.json",
        composeFolderMetadata({
          ...meta,
          reviewDefaults: { reviewers: configured },
        }),
      );
      await repo.commitAll("test: configured names", {
        name: "Owner",
        email: f.owner.email,
        userId: f.owner.id,
      });
    });
    const read = await getFolderReviewDefaults(f.db, f.input, f.actor);
    expect(read.configuredReviewers).toEqual([configured[1], configured[0]]);
    expect(read.reviewers).toEqual([
      { type: "user", id: f.viewer.id, name: f.viewer.name },
    ]);
  });
  it("derives configured and effective project selections from one chosen setting read", async () => {
    const f = await fixture();
    await f.caller.reviewerGroup.setDefaults({
      projectId: f.project.id,
      everyMonths: 6,
      reviewers: [{ type: "user", id: f.viewer.id }],
    });
    const readConfigured = reviewerGroups.getConfiguredProjectReviewers;
    const captured = vi
      .spyOn(reviewerGroups, "getConfiguredProjectReviewers")
      .mockImplementationOnce(async (db, projectId) => {
        const refs = await readConfigured(db, projectId);
        await f.db.projectDefaultReviewer.deleteMany({ where: { projectId } });
        await f.db.projectDefaultReviewer.create({
          data: { projectId, userId: f.owner.id },
        });
        return refs;
      });
    const read = await getFolderReviewDefaults(f.db, f.input, f.actor);
    expect(captured).toHaveBeenCalledTimes(1);
    expect(read.configuredReviewers).toEqual([
      { type: "user", id: f.viewer.id, name: f.viewer.name },
    ]);
    expect(read.reviewers).toEqual(read.configuredReviewers);
    expect(
      await f.db.projectDefaultReviewer.findMany({
        where: { projectId: f.project.id },
      }),
    ).toMatchObject([{ userId: f.owner.id }]);
  });
});

describe("mark a folder reviewed", () => {
  beforeEach(async () => {
    await resetDb();
    setJobQueueForTests(new FakeJobQueue());
  });
  afterEach(() => setJobQueueForTests(null));

  async function markFixture() {
    const f = await fixture();
    for (const [parentPath, name] of [
      [["guides"], "Nested"],
      [[], "Guides 2"],
    ] as const)
      await f.caller.folder.create({
        projectId: f.project.id,
        parentPath: [...parentPath],
        name,
      });
    const create = (folderPath: string[], title: string) =>
      createDocument(
        f.db,
        {
          projectId: f.project.id,
          folderPath,
          title,
          content: {
            kind: "markdown",
            contentJson: parseDocumentBody("Body\n"),
          },
        },
        f.actor,
      );
    const nested = await create(["guides", "nested"], "Second");
    const sibling = await create(["guides-2"], "Sibling");
    const other = await create(["guides"], "Other");
    await setDocumentReview(
      f.db,
      {
        projectId: f.project.id,
        documentId: other.id,
        expectedHeadCommitSha: other.headCommitSha,
        reviewers: [{ type: "user", id: f.viewer.id }],
      },
      f.actor,
    );
    const target = { projectId: f.project.id, path: ["guides"] };
    const reviewedAt = async () =>
      Object.fromEntries(
        (
          await f.db.document.findMany({ where: { projectId: f.project.id } })
        ).map((row) => [row.title, row.lastReviewedAt]),
      );
    const commits = async () =>
      (await simpleGit(repoDir(f.project.id)).log()).total;
    return { ...f, nested, sibling, other, target, reviewedAt, commits };
  }
  const actorFor = (user: Fixture["editor"]) => ({
    ...securityContextFor(user),
    name: null,
    email: user.email,
  });

  it("marks the reviewer's documents in the whole subtree in one commit and skips the rest", async () => {
    const f = await markFixture();
    const preview = await previewFolderMarkReviewed(f.db, f.target, f.actor);
    expect(preview).toMatchObject({
      documentCount: 3,
      eligibleDocumentCount: 2,
      skippedDocumentCount: 1,
      exceedsLimits: false,
    });
    const before = await f.commits();
    const untouched = await fileAt(f, f.other.path);
    const result = await markFolderReviewed(
      f.db,
      { ...f.target, expectedHeadCommitSha: preview.baseProjectCommitSha },
      f.actor,
    );
    expect(result.changedDocumentCount).toBe(2);
    expect(await f.commits()).toBe(before + 1);
    const at = await f.reviewedAt();
    expect(at.First).toBeInstanceOf(Date);
    expect(at.Second).toEqual(at.First);
    expect(at.Other).toBeNull();
    expect(at.Sibling).toBeNull();
    expect(await fileAt(f, f.other.path)).toBe(untouched);
    const original = parseDocumentFile(
      await projectRepo.withProjectRepo(f.project.id, (repo) =>
        repo.showFileAt(preview.baseProjectCommitSha, f.nested.path),
      ),
      "markdown",
    );
    const marked = parseDocumentFile(
      await fileAt(f, f.nested.path),
      "markdown",
    );
    expect(marked.meta.review).toMatchObject({
      reviewers: original.meta.review!.reviewers,
      everyMonths: original.meta.review!.everyMonths,
      since: original.meta.review!.since,
      reviewedBy: { id: f.owner.id, name: f.owner.name },
    });
    expect(marked.meta.updated).toBe(original.meta.updated);
    expect(marked.body).toBe(original.body);
    expect(await f.db.documentChangeSummary.count()).toBe(0);
  });

  it("lets a Viewer who is a reviewer mark only their own documents, also from the root", async () => {
    const f = await markFixture();
    const viewer = actorFor(f.viewer);
    const target = { projectId: f.project.id, path: [] };
    const preview = await previewFolderMarkReviewed(f.db, target, viewer);
    expect(preview).toMatchObject({
      documentCount: 4,
      eligibleDocumentCount: 1,
      skippedDocumentCount: 3,
    });
    await markFolderReviewed(
      f.db,
      { ...target, expectedHeadCommitSha: preview.baseProjectCommitSha },
      viewer,
    );
    const at = await f.reviewedAt();
    expect(at.Other).toBeInstanceOf(Date);
    expect(at.First).toBeNull();
    const row = await f.db.document.findUniqueOrThrow({
      where: { id: f.other.id },
    });
    expect(row.reviewedById).toBe(f.viewer.id);
  });

  it("writes nothing when no document is the actor's to review", async () => {
    const f = await markFixture();
    const editor = actorFor(f.editor);
    const preview = await previewFolderMarkReviewed(f.db, f.target, editor);
    expect(preview.eligibleDocumentCount).toBe(0);
    const before = await f.commits();
    expect(
      await markFolderReviewed(
        f.db,
        { ...f.target, expectedHeadCommitSha: preview.baseProjectCommitSha },
        editor,
      ),
    ).toEqual({
      headCommitSha: preview.baseProjectCommitSha,
      changedDocumentCount: 0,
    });
    expect(await f.commits()).toBe(before);
  });

  it("rejects a stale head, unknown folders, outsiders and read-only credentials", async () => {
    const f = await markFixture();
    const before = await f.commits();
    await expect(
      markFolderReviewed(
        f.db,
        { ...f.target, expectedHeadCommitSha: f.doc.headCommitSha },
        f.actor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      previewFolderMarkReviewed(
        f.db,
        { ...f.target, path: ["missing"] },
        f.actor,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const outsider = actorFor(await makeUser("User", "mark-outsider"));
    await expect(
      previewFolderMarkReviewed(f.db, f.target, outsider),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const head = (await previewFolderMarkReviewed(f.db, f.target, f.actor))
      .baseProjectCommitSha;
    await expect(
      markFolderReviewed(
        f.db,
        { ...f.target, expectedHeadCommitSha: head },
        outsider,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      markFolderReviewed(f.db, { ...f.target, expectedHeadCommitSha: head }, {
        ...f.actor,
        capabilities: new Set(["content:read"]),
      } as never),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await f.commits()).toBe(before);
    expect((await f.reviewedAt()).First).toBeNull();
  });
});

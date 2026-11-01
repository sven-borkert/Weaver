import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addMembership,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
  TEST_PASSWORD,
  testAuth,
} from "./_harness";
import { getSessionUser, type SessionUser } from "~/server/auth";
import { openProjectRepo, withProjectRepo } from "@weaver/git-store";
import {
  createDocument,
  deleteDocument,
  getDocument,
  getHistory,
  moveDocument,
  rebuildIndex,
  restoreDocument,
  saveDocument,
} from "@weaver/core/services/documents";
import {
  readProjectImage,
  storeDocumentImage,
  validateFileSegments,
} from "@weaver/core/services/documentImages";
import { getTree, createFolder } from "@weaver/core/services/folders";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const GIF_1X1 = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');

const AUTHOR = { name: "Editor", email: "editor@test.local" };

async function projectWithEditor(suffix: string) {
  const owner = await makeUser("User", `owner-${suffix}`);
  const editor = await makeUser("User", `editor-${suffix}`);
  const viewer = await makeUser("User", `viewer-${suffix}`);
  const outsider = await makeUser("User", `out-${suffix}`);
  const project = await makeProject(`Images ${suffix}`);
  await addMembership(project.id, owner.id, "Owner");
  await addMembership(project.id, editor.id, "Editor");
  await addMembership(project.id, viewer.id, "Viewer");
  const actor = {
    ...securityContextFor(editor),
    ...AUTHOR,
    email: editor.email,
  };
  return {
    project,
    owner,
    editor,
    viewer,
    outsider,
    actor,
    ownerActor: { ...securityContextFor(owner), ...AUTHOR, email: owner.email },
    viewerActor: {
      ...securityContextFor(viewer),
      ...AUTHOR,
      email: viewer.email,
    },
    outsiderActor: {
      ...securityContextFor(outsider),
      ...AUTHOR,
      email: outsider.email,
    },
  };
}

const IMAGE_DOC = (src: string) => ({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Intro" }] },
    { type: "image", attrs: { src, alt: "Shot", title: null } },
  ],
});

async function trackedFiles(projectId: string) {
  const repo = (await openProjectRepo(projectId))!;
  return repo.listTrackedFiles();
}

async function markdownOf(projectId: string, path: string) {
  const repo = (await openProjectRepo(projectId))!;
  return (await repo.readCommittedFile(path))!.content;
}

let queue: FakeJobQueue;

beforeEach(async () => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("WEAVER_JOBS_ENABLED", "true");
  queue = new FakeJobQueue();
  setJobQueueForTests(queue);
  await resetDb();
});

afterEach(() => {
  setJobQueueForTests(null);
  vi.unstubAllEnvs();
});

describe("storeDocumentImage and readProjectImage", () => {
  it("commits the image beside the document without touching the document", async () => {
    const db = getPrisma();
    const { project, actor, viewerActor } = await projectWithEditor("store");
    await createFolder(
      db,
      { projectId: project.id, parentPath: [], name: "guides" },
      actor,
    );
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: ["guides"],
        title: "Onboarding",
        content: {
          kind: "markdown",
          contentJson: IMAGE_DOC("https://x/y.png"),
        },
      },
      actor,
    );
    const historyBefore = await getHistory(
      db,
      { projectId: project.id, documentId: doc.id, offset: 0, limit: 10 },
      actor,
    );

    const stored = await storeDocumentImage(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        fileName: "Architecture Overview.PNG",
        bytes: PNG_1X1,
      },
      actor,
    );

    expect(stored).toMatchObject({
      src: "onboarding.assets/architecture-overview.png",
      path: "guides/onboarding.assets/architecture-overview.png",
      contentType: "image/png",
      byteSize: PNG_1X1.byteLength,
    });
    expect(await trackedFiles(project.id)).toContain(stored.path);
    const repo = (await openProjectRepo(project.id))!;
    const [commit] = await repo.logForPath(stored.path, { skip: 0, limit: 1 });
    expect(commit?.sha).toBe(stored.commitSha);
    expect(commit?.message).toBe(
      "asset: guides/onboarding.assets/architecture-overview.png (for guides/onboarding.md)",
    );
    const after = await getDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      actor,
    );
    expect(after.baseCommitSha).toBe(doc.headCommitSha);
    const historyAfter = await getHistory(
      db,
      { projectId: project.id, documentId: doc.id, offset: 0, limit: 10 },
      actor,
    );
    expect(historyAfter.entries.length).toBe(historyBefore.entries.length);

    const served = await readProjectImage(
      db,
      {
        projectId: project.id,
        segments: ["guides", "onboarding.assets", "architecture-overview.png"],
      },
      viewerActor,
    );
    expect(served?.bytes.equals(PNG_1X1)).toBe(true);
    expect(served?.contentType).toBe("image/png");
    expect(served?.fileName).toBe("architecture-overview.png");
  });

  it("suffixes colliding names, sniffs the type, and stamps nameless uploads", async () => {
    const db = getPrisma();
    const { project, actor } = await projectWithEditor("names");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Doc",
        content: {
          kind: "markdown",
          contentJson: IMAGE_DOC("https://x/y.png"),
        },
      },
      actor,
    );
    const first = await storeDocumentImage(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        fileName: "shot.png",
        bytes: PNG_1X1,
      },
      actor,
    );
    const second = await storeDocumentImage(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        fileName: "shot.jpg",
        bytes: PNG_1X1,
      },
      actor,
    );
    const gif = await storeDocumentImage(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        fileName: null,
        bytes: GIF_1X1,
      },
      actor,
    );
    expect(first.src).toBe("doc.assets/shot.png");
    expect(second.src).toBe("doc.assets/shot-2.png");
    expect(gif.src).toMatch(/^doc\.assets\/image-\d{8}-\d{6}\.gif$/);
    expect(gif.contentType).toBe("image/gif");
  });

  it("refuses SVG, non-Editors, nonmembers, and unknown documents", async () => {
    const db = getPrisma();
    const { project, actor, viewerActor, outsiderActor } =
      await projectWithEditor("deny");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Doc",
        content: {
          kind: "markdown",
          contentJson: IMAGE_DOC("https://x/y.png"),
        },
      },
      actor,
    );
    const input = {
      projectId: project.id,
      documentId: doc.id,
      fileName: "a.png",
      bytes: PNG_1X1,
    };
    await expect(
      storeDocumentImage(db, { ...input, bytes: SVG }, actor),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      storeDocumentImage(db, input, viewerActor),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      storeDocumentImage(db, input, outsiderActor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      storeDocumentImage(
        db,
        { ...input, documentId: "00000000-0000-4000-8000-000000000000" },
        actor,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      (await trackedFiles(project.id)).filter((f) => f.includes(".assets/")),
    ).toEqual([]);
  });

  it("serves only committed image blobs, hides nonmembers, and honors `at`", async () => {
    const db = getPrisma();
    const { project, actor, viewerActor, outsiderActor } =
      await projectWithEditor("serve");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Doc",
        content: {
          kind: "markdown",
          contentJson: IMAGE_DOC("https://x/y.png"),
        },
      },
      actor,
    );
    const stored = await storeDocumentImage(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        fileName: "a.png",
        bytes: PNG_1X1,
      },
      actor,
    );
    const segments = ["doc.assets", "a.png"];

    await expect(
      readProjectImage(db, { projectId: project.id, segments }, outsiderActor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      await readProjectImage(
        db,
        { projectId: project.id, segments: ["doc.md"] },
        viewerActor,
      ),
    ).toBeNull();
    expect(
      await readProjectImage(
        db,
        { projectId: project.id, segments: ["project.json"] },
        viewerActor,
      ),
    ).toBeNull();
    expect(
      await readProjectImage(
        db,
        { projectId: project.id, segments: ["..", "x.png"] },
        viewerActor,
      ),
    ).toBeNull();
    expect(
      await readProjectImage(
        db,
        { projectId: project.id, segments: ["doc.assets", "missing.png"] },
        viewerActor,
      ),
    ).toBeNull();

    // A committed non-image blob is not served even under an image name.
    await withProjectRepo(project.id, async (repo) => {
      await repo.writeBinaryFileAtomic("doc.assets/fake.png", SVG);
      await repo.commitAll("asset: doc.assets/fake.png (for doc.md)", {
        ...AUTHOR,
        userId: actor.userId,
      });
    });
    expect(
      await readProjectImage(
        db,
        { projectId: project.id, segments: ["doc.assets", "fake.png"] },
        viewerActor,
      ),
    ).toBeNull();

    const pinned = await readProjectImage(
      db,
      { projectId: project.id, segments, at: stored.commitSha },
      viewerActor,
    );
    expect(pinned?.bytes.equals(PNG_1X1)).toBe(true);
    expect(
      await readProjectImage(
        db,
        { projectId: project.id, segments, at: "0".repeat(40) },
        viewerActor,
      ),
    ).toBeNull();
  });

  it("validates served path segments", () => {
    expect(validateFileSegments(["docs", "guide.assets", "a.png"])).toBe(
      "docs/guide.assets/a.png",
    );
    expect(validateFileSegments(["Screen Shot.png"])).toBe("Screen Shot.png");
    for (const bad of [
      [],
      [""],
      ["."],
      ["..", "a.png"],
      [".git", "config"],
      ["project.json"],
      ["tables", "t.table", "schema.json"],
      ["guide.md"],
      ["a\\b.png"],
      ["a\tb.png"],
      ["s".repeat(256)],
    ]) {
      expect(validateFileSegments(bad)).toBeNull();
    }
  });
});

describe("document lifecycle with images", () => {
  async function docWithImage(suffix: string, folderPath: string[] = []) {
    const db = getPrisma();
    const ctx = await projectWithEditor(suffix);
    for (let depth = 1; depth <= folderPath.length; depth++) {
      await createFolder(
        db,
        {
          projectId: ctx.project.id,
          parentPath: folderPath.slice(0, depth - 1),
          name: folderPath[depth - 1]!,
        },
        ctx.actor,
      );
    }
    const created = await createDocument(
      db,
      {
        projectId: ctx.project.id,
        folderPath,
        title: "Guide",
        content: {
          kind: "markdown",
          contentJson: IMAGE_DOC("https://x/y.png"),
        },
      },
      ctx.actor,
    );
    const stored = await storeDocumentImage(
      db,
      {
        projectId: ctx.project.id,
        documentId: created.id,
        fileName: "shot.png",
        bytes: PNG_1X1,
      },
      ctx.actor,
    );
    const head = await getDocument(
      db,
      { projectId: ctx.project.id, documentId: created.id },
      ctx.actor,
    );
    const saved = await saveDocument(
      db,
      {
        projectId: ctx.project.id,
        documentId: created.id,
        baseCommitSha: head.baseCommitSha,
        content: { kind: "markdown", contentJson: IMAGE_DOC(stored.src) },
        changeSummary: "",
      },
      ctx.actor,
    );
    return { db, ...ctx, doc: saved, stored };
  }

  it("rename moves the assets directory and rewrites own links in one commit", async () => {
    const { db, project, actor, doc } = await docWithImage("rename");
    const renamed = await saveDocument(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        baseCommitSha: doc.headCommitSha,
        title: "Handbook",
        content: {
          kind: "markdown",
          contentJson: IMAGE_DOC("guide.assets/shot.png"),
        },
        changeSummary: "",
      },
      actor,
    );
    expect(renamed.path).toBe("handbook.md");
    const files = await trackedFiles(project.id);
    expect(files).toContain("handbook.assets/shot.png");
    expect(files).not.toContain("guide.assets/shot.png");
    expect(await markdownOf(project.id, "handbook.md")).toContain(
      "![Shot](handbook.assets/shot.png)",
    );
    const repo = (await openProjectRepo(project.id))!;
    const [assetCommit] = await repo.logForPath("handbook.assets/shot.png", {
      skip: 0,
      limit: 1,
    });
    expect(assetCommit?.sha).toBe(renamed.headCommitSha);
  });

  it("keeps the width of a resized image when the document is renamed", async () => {
    const { db, project, actor, doc } = await docWithImage("rename-width");
    const sized = {
      type: "doc",
      content: [
        {
          type: "image",
          attrs: { src: "guide.assets/shot.png", alt: "Shot", width: 240 },
        },
      ],
    };
    const resized = await saveDocument(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        baseCommitSha: doc.headCommitSha,
        content: { kind: "markdown", contentJson: sized },
        changeSummary: "",
      },
      actor,
    );
    expect(await markdownOf(project.id, "guide.md")).toContain(
      '<img src="guide.assets/shot.png" alt="Shot" width="240">',
    );
    const renamed = await saveDocument(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        baseCommitSha: resized.headCommitSha,
        title: "Handbook",
        content: { kind: "markdown", contentJson: sized },
        changeSummary: "",
      },
      actor,
    );
    expect(await markdownOf(project.id, renamed.path)).toContain(
      '<img src="handbook.assets/shot.png" alt="Shot" width="240">',
    );
    expect(await trackedFiles(project.id)).toContain(
      "handbook.assets/shot.png",
    );
    await expect(
      saveDocument(
        db,
        {
          projectId: project.id,
          documentId: doc.id,
          baseCommitSha: renamed.headCommitSha,
          content: {
            kind: "markdown",
            contentJson: {
              type: "doc",
              content: [
                {
                  type: "image",
                  attrs: { src: "handbook.assets/shot.png", width: 8 },
                },
              ],
            },
          },
          changeSummary: "",
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rename leaves foreign relative links untouched", async () => {
    const { db, project, actor, doc } = await docWithImage("foreign");
    const content = {
      type: "doc",
      content: [
        {
          type: "image",
          attrs: { src: "guide.assets/shot.png", alt: "own", title: null },
        },
        {
          type: "image",
          attrs: { src: "other.assets/x.png", alt: "foreign", title: null },
        },
      ],
    };
    await saveDocument(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        baseCommitSha: doc.headCommitSha,
        title: "Renamed",
        content: { kind: "markdown", contentJson: content },
        changeSummary: "",
      },
      actor,
    );
    const markdown = await markdownOf(project.id, "renamed.md");
    expect(markdown).toContain("renamed.assets/shot.png");
    expect(markdown).toContain("other.assets/x.png");
  });

  it("move carries the assets directory and keeps links valid", async () => {
    const { db, project, actor, doc } = await docWithImage("move");
    await createFolder(
      db,
      { projectId: project.id, parentPath: [], name: "archive" },
      actor,
    );
    const moved = await moveDocument(
      db,
      { projectId: project.id, documentId: doc.id, folderPath: ["archive"] },
      actor,
    );
    expect(moved.path).toBe("archive/guide.md");
    const files = await trackedFiles(project.id);
    expect(files).toContain("archive/guide.assets/shot.png");
    expect(files).not.toContain("guide.assets/shot.png");
    expect(await markdownOf(project.id, "archive/guide.md")).toContain(
      "![Shot](guide.assets/shot.png)",
    );
  });

  it("move re-slugs on collision and rewrites own links", async () => {
    const { db, project, actor, doc } = await docWithImage("move-collide");
    await createFolder(
      db,
      { projectId: project.id, parentPath: [], name: "archive" },
      actor,
    );
    // Slugs are unique per repository, so a second "Guide" created through the
    // API would already be guide-2. An externally added file takes the target.
    await withProjectRepo(project.id, async (repo) => {
      await repo.writeFileAtomic(
        "archive/guide.md",
        "---\nid: 4b1b2c1e-2222-4222-8222-222222222222\ntitle: Guide\ncreated: 2026-09-11T00:00:00.000Z\nupdated: 2026-09-11T00:00:00.000Z\n---\n\nexternal\n",
      );
      await repo.commitAll("external: archive/guide.md", {
        ...AUTHOR,
        userId: actor.userId,
      });
    });
    const moved = await moveDocument(
      db,
      { projectId: project.id, documentId: doc.id, folderPath: ["archive"] },
      actor,
    );
    expect(moved.path).toBe("archive/guide-2.md");
    expect(await trackedFiles(project.id)).toContain(
      "archive/guide-2.assets/shot.png",
    );
    expect(await markdownOf(project.id, "archive/guide-2.md")).toContain(
      "guide-2.assets/shot.png",
    );
  });

  it("move keeps the width of a resized image, also when it re-slugs", async () => {
    const { db, project, actor, doc } = await docWithImage("move-width");
    const resized = await saveDocument(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        baseCommitSha: doc.headCommitSha,
        content: {
          kind: "markdown",
          contentJson: {
            type: "doc",
            content: [
              {
                type: "image",
                attrs: {
                  src: "guide.assets/shot.png",
                  alt: "Shot\nwide",
                  width: 240,
                },
              },
            ],
          },
        },
        changeSummary: "",
      },
      actor,
    );
    expect(resized.headCommitSha).not.toBe(doc.headCommitSha);
    for (const name of ["archive", "vault"])
      await createFolder(
        db,
        { projectId: project.id, parentPath: [], name },
        actor,
      );
    const moved = await moveDocument(
      db,
      { projectId: project.id, documentId: doc.id, folderPath: ["archive"] },
      actor,
    );
    expect(await markdownOf(project.id, moved.path)).toContain(
      '<img src="guide.assets/shot.png" alt="Shot&#10;wide" width="240">',
    );
    await withProjectRepo(project.id, async (repo) => {
      await repo.writeFileAtomic(
        "vault/guide.md",
        "---\nid: 4b1b2c1e-3333-4333-8333-333333333333\ntitle: Guide\ncreated: 2026-09-11T00:00:00.000Z\nupdated: 2026-09-11T00:00:00.000Z\n---\n\nexternal\n",
      );
      await repo.commitAll("external: vault/guide.md", {
        ...AUTHOR,
        userId: actor.userId,
      });
    });
    const again = await moveDocument(
      db,
      { projectId: project.id, documentId: doc.id, folderPath: ["vault"] },
      actor,
    );
    expect(again.path).toBe("vault/guide-2.md");
    expect(await markdownOf(project.id, again.path)).toContain(
      '<img src="guide-2.assets/shot.png" alt="Shot&#10;wide" width="240">',
    );
    expect(await trackedFiles(project.id)).toContain(
      "vault/guide-2.assets/shot.png",
    );
  });

  it("move re-slugs when only a stray assets directory holds the target slug", async () => {
    const { db, project, actor, viewerActor, doc } =
      await docWithImage("move-stray");
    await createFolder(
      db,
      { projectId: project.id, parentPath: [], name: "archive" },
      actor,
    );
    await withProjectRepo(project.id, async (repo) => {
      await repo.writeBinaryFileAtomic(
        "archive/guide.assets/other.png",
        GIF_1X1,
      );
      await repo.commitAll("external: archive/guide.assets/other.png", {
        ...AUTHOR,
        userId: actor.userId,
      });
    });
    const moved = await moveDocument(
      db,
      { projectId: project.id, documentId: doc.id, folderPath: ["archive"] },
      actor,
    );
    expect(moved.path).toBe("archive/guide-2.md");
    expect(moved.slug).toBe("guide-2");
    const files = await trackedFiles(project.id);
    expect(files).toContain("archive/guide-2.assets/shot.png");
    expect(files).toContain("archive/guide.assets/other.png");
    expect(files).not.toContain("archive/guide.md");
    expect(files.filter((f) => f.split(".assets/").length > 2)).toEqual([]);
    expect(await markdownOf(project.id, "archive/guide-2.md")).toContain(
      "![Shot](guide-2.assets/shot.png)",
    );
    const served = await readProjectImage(
      db,
      {
        projectId: project.id,
        segments: ["archive", "guide-2.assets", "shot.png"],
      },
      viewerActor,
    );
    expect(served?.bytes.equals(PNG_1X1)).toBe(true);
    const stray = await readProjectImage(
      db,
      {
        projectId: project.id,
        segments: ["archive", "guide.assets", "other.png"],
      },
      viewerActor,
    );
    expect(stray?.bytes.equals(GIF_1X1)).toBe(true);
  });

  it("delete removes the assets directory in the same commit", async () => {
    const { db, project, actor, doc } = await docWithImage("delete");
    await deleteDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      actor,
    );
    const files = await trackedFiles(project.id);
    expect(files.some((f) => f.startsWith("guide.assets/"))).toBe(false);
    expect(files).not.toContain("guide.md");
  });

  it("restore rewrites the historic assets prefix to the current slug", async () => {
    const { db, project, actor, doc } = await docWithImage("restore");
    const beforeRename = doc.headCommitSha;
    const renamed = await saveDocument(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        baseCommitSha: beforeRename,
        title: "Handbook",
        content: {
          kind: "markdown",
          contentJson: IMAGE_DOC("guide.assets/shot.png"),
        },
        changeSummary: "",
      },
      actor,
    );
    const restored = await restoreDocument(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        sha: beforeRename,
        expectedHeadCommitSha: renamed.headCommitSha,
      },
      actor,
    );
    // The restored title is "Guide" again, so the slug and directory return to guide.*
    expect(restored.path).toBe("guide.md");
    expect(await trackedFiles(project.id)).toContain("guide.assets/shot.png");
    expect(await markdownOf(project.id, "guide.md")).toContain(
      "![Shot](guide.assets/shot.png)",
    );
  });

  it("hides assets directories from the tree and rebuild, and reserves their slug", async () => {
    const { db, project, actor, ownerActor, doc } = await docWithImage("hide", [
      "docs",
    ]);
    await withProjectRepo(project.id, async (repo) => {
      await repo.writeFileAtomic(
        "docs/guide.assets/stray.md",
        "---\nid: 4b1b2c1e-1111-4111-8111-111111111111\ntitle: Stray\ncreated: 2026-09-11T00:00:00.000Z\nupdated: 2026-09-11T00:00:00.000Z\n---\n\nstray\n",
      );
      await repo.writeBinaryFileAtomic("orphan.assets/x.png", PNG_1X1);
      await repo.commitAll("external: stray files", {
        ...AUTHOR,
        userId: actor.userId,
      });
    });
    const tree = await getTree(db, { projectId: project.id }, actor);
    expect(tree.folders).toEqual(["docs"]);
    const rebuilt = await rebuildIndex(
      db,
      { projectId: project.id },
      ownerActor,
    );
    expect(rebuilt.indexed).toBe(1);
    expect(await db.document.count({ where: { projectId: project.id } })).toBe(
      1,
    );
    const orphan = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Orphan",
        content: {
          kind: "markdown",
          contentJson: IMAGE_DOC("https://x/y.png"),
        },
      },
      actor,
    );
    expect(orphan.slug).toBe("orphan-2");
    expect(doc.id).toBeTruthy();
  });

  it("rejects relative image paths that escape the repository and accepts contained ones", async () => {
    const { db, project, actor, doc } = await docWithImage("contain", [
      "docs",
      "sub",
    ]);
    await expect(
      saveDocument(
        db,
        {
          projectId: project.id,
          documentId: doc.id,
          baseCommitSha: doc.headCommitSha,
          content: {
            kind: "markdown",
            contentJson: IMAGE_DOC("../../../x.png"),
          },
          changeSummary: "",
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const ok = await saveDocument(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        baseCommitSha: doc.headCommitSha,
        content: {
          kind: "markdown",
          contentJson: IMAGE_DOC("../shared/x.png"),
        },
        changeSummary: "",
      },
      actor,
    );
    expect(await markdownOf(project.id, ok.path)).toContain("../shared/x.png");
  });
});

type UploadRoute = (
  req: Request,
  ctx: { params: Promise<{ documentId: string }> },
) => Promise<Response>;

async function sessionCookieFor(email: string): Promise<string> {
  const response = await testAuth().api.signInEmail({
    body: { email, password: TEST_PASSWORD },
    asResponse: true,
  });
  const cookie = (response.headers.get("set-cookie") ?? "").split(";", 1)[0];
  expect(cookie).toMatch(/session_token=/);
  return cookie!;
}

async function resolveTestSession(
  headers: Headers,
): Promise<SessionUser | null> {
  const session = await testAuth().api.getSession({ headers });
  if (!session || session.user.banned) return null;
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role === "Admin" ? "Admin" : "User",
    sessionId: session.session.id,
    mustChangePassword: session.user.mustChangePassword === true,
  };
}

function imageForm(projectId: string, file: File | null): FormData {
  const form = new FormData();
  form.set("projectId", projectId);
  if (file) form.append("file", file);
  return form;
}

function uploadRequest(
  documentId: string,
  body: BodyInit,
  cookie?: string,
  origin: string | null = "http://localhost:3000",
): [Request, { params: Promise<{ documentId: string }> }] {
  const headers = new Headers();
  if (origin) headers.set("origin", origin);
  if (cookie) headers.set("cookie", cookie);
  return [
    new Request(`http://localhost:3000/api/documents/${documentId}/images`, {
      method: "POST",
      headers,
      body,
    }),
    { params: Promise.resolve({ documentId }) },
  ];
}

describe("POST /api/documents/{documentId}/images", () => {
  let uploadRoute: UploadRoute;

  beforeEach(async () => {
    vi.mocked(getSessionUser).mockImplementation(resolveTestSession);
    const route = await import("~/app/api/documents/[documentId]/images/route");
    uploadRoute = route.POST as unknown as UploadRoute;
  });

  afterEach(() => {
    vi.mocked(getSessionUser).mockImplementation(() => Promise.resolve(null));
  });

  it("stores a PNG for an Editor and returns the relative src and serving url", async () => {
    const db = getPrisma();
    const { project, editor, actor } = await projectWithEditor("route-ok");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Doc",
        content: {
          kind: "markdown",
          contentJson: IMAGE_DOC("https://x/y.png"),
        },
      },
      actor,
    );
    const cookie = await sessionCookieFor(editor.email);
    const file = new File([PNG_1X1], "Cover Art.png", { type: "image/png" });

    const response = await uploadRoute(
      ...uploadRequest(doc.id, imageForm(project.id, file), cookie),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      src: "doc.assets/cover-art.png",
      path: "doc.assets/cover-art.png",
      url: `/api/projects/${project.id}/files/doc.assets/cover-art.png`,
      contentType: "image/png",
      byteSize: PNG_1X1.byteLength,
    });
    expect(body.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await trackedFiles(project.id)).toContain(
      "doc.assets/cover-art.png",
    );
  });

  it("rejects anonymous, cross-origin, Viewer, nonmember, and wrong-type uploads", async () => {
    const db = getPrisma();
    const { project, editor, viewer, outsider, actor } =
      await projectWithEditor("route-deny");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Doc",
        content: {
          kind: "markdown",
          contentJson: IMAGE_DOC("https://x/y.png"),
        },
      },
      actor,
    );
    const png = () => new File([PNG_1X1], "a.png", { type: "image/png" });

    expect(
      (
        await uploadRoute(
          ...uploadRequest(doc.id, imageForm(project.id, png())),
        )
      ).status,
    ).toBe(401);
    const editorCookie = await sessionCookieFor(editor.email);
    expect(
      (
        await uploadRoute(
          ...uploadRequest(
            doc.id,
            imageForm(project.id, png()),
            editorCookie,
            "https://evil.test",
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await uploadRoute(
          ...uploadRequest(
            doc.id,
            imageForm(project.id, png()),
            editorCookie,
            null,
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await uploadRoute(
          ...uploadRequest(
            doc.id,
            imageForm(project.id, png()),
            await sessionCookieFor(viewer.email),
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await uploadRoute(
          ...uploadRequest(
            doc.id,
            imageForm(project.id, png()),
            await sessionCookieFor(outsider.email),
          ),
        )
      ).status,
    ).toBe(404);
    const svg = new File([SVG], "a.svg", { type: "image/svg+xml" });
    expect(
      (
        await uploadRoute(
          ...uploadRequest(doc.id, imageForm(project.id, svg), editorCookie),
        )
      ).status,
    ).toBe(415);
    const mislabeled = new File([SVG], "a.png", { type: "image/png" });
    expect(
      (
        await uploadRoute(
          ...uploadRequest(
            doc.id,
            imageForm(project.id, mislabeled),
            editorCookie,
          ),
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await uploadRoute(
          ...uploadRequest(doc.id, imageForm(project.id, null), editorCookie),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await uploadRoute(
          ...uploadRequest(
            "not-a-uuid",
            imageForm(project.id, png()),
            editorCookie,
          ),
        )
      ).status,
    ).toBe(404);
    expect(
      (await trackedFiles(project.id)).some((f) => f.includes(".assets/")),
    ).toBe(false);
  });

  it("refuses files above the cap and a mismatched declared type in the parser", async () => {
    const { parseImageUpload } = await import("~/server/documents/imageUpload");
    const big = Buffer.concat([PNG_1X1, Buffer.alloc(2_048)]);
    const [request] = uploadRequest(
      "d",
      imageForm(
        "11111111-1111-4111-8111-111111111111",
        new File([big], "big.png", { type: "image/png" }),
      ),
    );
    await expect(
      parseImageUpload(request, {
        maxFileBytes: 1_024,
        authorize: async () => undefined,
      }),
    ).rejects.toMatchObject({ status: 413 });
    const [mismatch] = uploadRequest(
      "d",
      imageForm(
        "11111111-1111-4111-8111-111111111111",
        new File([PNG_1X1], "a.jpg", { type: "image/jpeg" }),
      ),
    );
    await expect(
      parseImageUpload(mismatch, {
        maxFileBytes: 1_024 * 1_024,
        authorize: async () => undefined,
      }),
    ).rejects.toMatchObject({ status: 415 });
    const [ok] = uploadRequest(
      "d",
      imageForm(
        "11111111-1111-4111-8111-111111111111",
        new File([PNG_1X1], "a.png", { type: "application/octet-stream" }),
      ),
    );
    await expect(
      parseImageUpload(ok, {
        maxFileBytes: 1_024 * 1_024,
        authorize: async () => undefined,
      }),
    ).resolves.toMatchObject({ fileName: "a.png", bytes: PNG_1X1 });
  });
});

type FilesRoute = (
  req: Request,
  ctx: { params: Promise<{ projectId: string; path: string[] }> },
) => Promise<Response>;

function filesRequest(
  projectId: string,
  segments: string[],
  cookie?: string,
  headers: Record<string, string> = {},
  query = "",
): [Request, { params: Promise<{ projectId: string; path: string[] }> }] {
  const h = new Headers(headers);
  if (cookie) h.set("cookie", cookie);
  const url = `http://localhost:3000/api/projects/${projectId}/files/${segments.map(encodeURIComponent).join("/")}${query}`;
  return [
    new Request(url, { headers: h }),
    { params: Promise.resolve({ projectId, path: segments }) },
  ];
}

describe("GET /api/projects/{projectId}/files/{...path}", () => {
  let filesRoute: FilesRoute;

  beforeEach(async () => {
    vi.mocked(getSessionUser).mockImplementation(resolveTestSession);
    const route =
      await import("~/app/api/projects/[projectId]/files/[...path]/route");
    filesRoute = route.GET as unknown as FilesRoute;
  });

  afterEach(() => {
    vi.mocked(getSessionUser).mockImplementation(() => Promise.resolve(null));
  });

  it("serves a committed image to a Viewer with sniffed type, ETag, and 304 support", async () => {
    const db = getPrisma();
    const { project, viewer, outsider, actor } =
      await projectWithEditor("files-ok");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Doc",
        content: {
          kind: "markdown",
          contentJson: IMAGE_DOC("https://x/y.png"),
        },
      },
      actor,
    );
    const stored = await storeDocumentImage(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        fileName: "a.png",
        bytes: PNG_1X1,
      },
      actor,
    );
    const cookie = await sessionCookieFor(viewer.email);

    const response = await filesRoute(
      ...filesRequest(project.id, ["doc.assets", "a.png"], cookie),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toBe(
      "inline; filename=\"a.png\"; filename*=UTF-8''a.png",
    );
    expect(response.headers.get("cross-origin-resource-policy")).toBe(
      "same-origin",
    );
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    const etag = response.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{40}"$/);
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG_1X1)).toBe(
      true,
    );

    const notModified = await filesRoute(
      ...filesRequest(project.id, ["doc.assets", "a.png"], cookie, {
        "if-none-match": etag!,
      }),
    );
    expect(notModified.status).toBe(304);
    const cached = await readProjectImage(
      db,
      {
        projectId: project.id,
        segments: ["doc.assets", "a.png"],
        ifNoneMatch: etag,
      },
      actor,
    );
    expect(cached).toEqual({ notModified: true, blobSha: etag!.slice(1, -1) });
    await withProjectRepo(project.id, async (repo) => {
      await repo.writeBinaryFileAtomic("画像.png", PNG_1X1);
      await repo.commitAll("asset: foreign filename", {
        name: "Editor",
        email: actor.email,
        userId: actor.userId,
      });
    });
    const unicode = await filesRoute(
      ...filesRequest(project.id, ["画像.png"], cookie),
    );
    expect(unicode.status).toBe(200);
    expect(unicode.headers.get("content-disposition")).toContain(
      "filename*=UTF-8''%E7%94%BB%E5%83%8F.png",
    );

    const pinned = await filesRoute(
      ...filesRequest(
        project.id,
        ["doc.assets", "a.png"],
        cookie,
        {},
        `?at=${stored.commitSha}`,
      ),
    );
    expect(pinned.status).toBe(200);
    expect(pinned.headers.get("cache-control")).toBe("private, no-cache");
    expect(pinned.headers.get("etag")).toBe(etag);

    const pinnedNotModified = await filesRoute(
      ...filesRequest(
        project.id,
        ["doc.assets", "a.png"],
        cookie,
        { "if-none-match": etag! },
        `?at=${stored.commitSha}`,
      ),
    );
    expect(pinnedNotModified.status).toBe(304);
    expect(pinnedNotModified.headers.get("cache-control")).toBe(
      "private, no-cache",
    );

    const pinnedOutsider = await filesRoute(
      ...filesRequest(
        project.id,
        ["doc.assets", "a.png"],
        await sessionCookieFor(outsider.email),
        { "if-none-match": etag! },
        `?at=${stored.commitSha}`,
      ),
    );
    expect(pinnedOutsider.status).toBe(404);
  });

  it("answers 401 anonymously and 404 for nonmembers, documents, metadata, and bad commits", async () => {
    const db = getPrisma();
    const { project, viewer, outsider, actor } =
      await projectWithEditor("files-deny");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Doc",
        content: {
          kind: "markdown",
          contentJson: IMAGE_DOC("https://x/y.png"),
        },
      },
      actor,
    );
    await storeDocumentImage(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        fileName: "a.png",
        bytes: PNG_1X1,
      },
      actor,
    );
    const viewerCookie = await sessionCookieFor(viewer.email);

    expect(
      (await filesRoute(...filesRequest(project.id, ["doc.assets", "a.png"])))
        .status,
    ).toBe(401);
    expect(
      (
        await filesRoute(
          ...filesRequest(
            project.id,
            ["doc.assets", "a.png"],
            await sessionCookieFor(outsider.email),
          ),
        )
      ).status,
    ).toBe(404);
    expect(
      (await filesRoute(...filesRequest(project.id, ["doc.md"], viewerCookie)))
        .status,
    ).toBe(404);
    expect(
      (
        await filesRoute(
          ...filesRequest(project.id, ["project.json"], viewerCookie),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await filesRoute(
          ...filesRequest(
            project.id,
            ["doc.assets", "a.png"],
            viewerCookie,
            {},
            "?at=nothex",
          ),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await filesRoute(
          ...filesRequest(
            "00000000-0000-4000-8000-000000000000",
            ["doc.assets", "a.png"],
            viewerCookie,
          ),
        )
      ).status,
    ).toBe(404);
  });
});

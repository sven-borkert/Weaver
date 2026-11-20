import type { Readable } from "node:stream";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import {
  createDocumentArchive,
  createFolderArchive,
  readDocumentFile,
} from "@weaver/core/services/documentDownload";
import {
  readProjectImage,
  storeDocumentImage,
} from "@weaver/core/services/documentImages";
import { openProjectRepo } from "@weaver/git-store";
import {
  addMembership,
  callerFor,
  getPrisma,
  makeUser,
  resetDb,
  securityContextFor,
} from "./_harness";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const EMPTY = { type: "doc", content: [{ type: "paragraph" }] };
const BODY = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

async function unzip(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return JSZip.loadAsync(Buffer.concat(chunks));
}

async function setup(suffix: string) {
  const owner = await makeUser("User", `untracked-owner-${suffix}`);
  const caller = callerFor(owner);
  const { id: projectId } = await caller.project.create({
    name: `Untracked ${suffix}`,
  });
  const actor = {
    ...securityContextFor(owner),
    name: "Owner",
    email: owner.email,
  };
  return { owner, caller, projectId, actor };
}

async function committedFiles(projectId: string) {
  const repo = await openProjectRepo(projectId);
  return repo ? repo.listTrackedFiles() : [];
}

describe("documents kept out of Git", () => {
  beforeEach(async () => {
    await resetDb();
    setJobQueueForTests(new FakeJobQueue());
  });
  afterEach(() => setJobQueueForTests(null));

  it("lists, reads and saves an untracked document beside tracked ones without committing", async () => {
    const { caller, projectId } = await setup("basic");
    await caller.folder.create({ projectId, parentPath: [], name: "Guides" });
    const tracked = await caller.document.create({
      projectId,
      folderPath: ["guides"],
      title: "Runbook",
      contentJson: EMPTY,
    });
    const before = await committedFiles(projectId);
    const created = await caller.document.create({
      projectId,
      folderPath: ["guides"],
      title: "Scratch notes",
      contentJson: BODY("first draft"),
      untracked: true,
    });
    expect(created.path).toBe("guides/scratch-notes.md");
    expect(await committedFiles(projectId)).toEqual(before);

    const tree = await caller.folder.tree({ projectId });
    expect(
      tree.documents.map((document) => [document.id, document.untracked]),
    ).toEqual([
      [tracked.id, false],
      [created.id, true],
    ]);
    expect(tree.documents.find((d) => d.id === created.id)?.index).toBeNull();

    const loaded = await caller.document.get({
      projectId,
      documentId: created.id,
    });
    expect(loaded).toMatchObject({
      untracked: true,
      title: "Scratch notes",
      path: "guides/scratch-notes.md",
      kind: "markdown",
    });
    expect(loaded.baseCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(loaded.review).not.toBeNull();

    const saved = await caller.document.update({
      projectId,
      documentId: created.id,
      baseCommitSha: loaded.baseCommitSha,
      title: "Scratch ideas",
      content: { kind: "markdown", contentJson: BODY("second draft") },
    });
    expect(saved.path).toBe("guides/scratch-ideas.md");
    expect(saved.headCommitSha).not.toBe(loaded.baseCommitSha);
    await expect(
      caller.document.update({
        projectId,
        documentId: created.id,
        baseCommitSha: loaded.baseCommitSha,
        content: { kind: "markdown", contentJson: BODY("stale") },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await committedFiles(projectId)).toEqual(before);
    await expect(
      caller.document.history({
        projectId,
        documentId: created.id,
        offset: 0,
        limit: 20,
      }),
    ).resolves.toEqual({ hasMore: false, entries: [] });
    const refs = await caller.document.resolveRefs({
      projectId,
      ids: [created.id],
    });
    expect(refs).toEqual([
      expect.objectContaining({
        id: created.id,
        title: "Scratch ideas",
        exists: true,
      }),
    ]);
  });

  it("keeps slugs unique across Git and untracked documents", async () => {
    const { caller, projectId } = await setup("slugs");
    await caller.document.create({
      projectId,
      folderPath: [],
      title: "Plan",
      contentJson: EMPTY,
    });
    const untracked = await caller.document.create({
      projectId,
      folderPath: [],
      title: "Plan",
      contentJson: EMPTY,
      untracked: true,
    });
    expect(untracked.slug).toBe("plan-2");
    const tracked = await caller.document.create({
      projectId,
      folderPath: [],
      title: "Plan",
      contentJson: EMPTY,
    });
    expect(tracked.slug).toBe("plan-3");
  });

  it("puts everything inside an untracked folder out of Git and moves it with tracked folders", async () => {
    const { caller, projectId } = await setup("folders");
    await caller.folder.create({ projectId, parentPath: [], name: "Team" });
    const scratch = await caller.folder.create({
      projectId,
      parentPath: ["team"],
      name: "Scratch",
      untracked: true,
    });
    expect(scratch.path).toEqual(["team", "scratch"]);
    const nestedFolder = await caller.folder.create({
      projectId,
      parentPath: ["team", "scratch"],
      name: "Ideas",
    });
    const nested = await caller.document.create({
      projectId,
      folderPath: nestedFolder.path,
      title: "Idea",
      contentJson: EMPTY,
    });
    const tree = await caller.folder.tree({ projectId });
    expect(tree.untrackedFolders).toEqual([
      "team/scratch",
      "team/scratch/ideas",
    ]);
    expect(tree.folders).toEqual(
      expect.arrayContaining(["team", "team/scratch", "team/scratch/ideas"]),
    );
    expect(tree.folderNames["team/scratch"]).toBe("Scratch");
    expect(tree.documents.find((d) => d.id === nested.id)?.untracked).toBe(
      true,
    );
    expect(
      (await committedFiles(projectId)).some((file) =>
        file.includes("scratch"),
      ),
    ).toBe(false);

    await caller.folder.rename({ projectId, path: ["team"], name: "Crew" });
    const moved = await caller.document.get({
      projectId,
      documentId: nested.id,
    });
    expect(moved.path).toBe("crew/scratch/ideas/idea.md");

    await caller.folder.rename({
      projectId,
      path: ["crew", "scratch"],
      name: "Drafts",
    });
    expect(
      (await caller.document.get({ projectId, documentId: nested.id })).path,
    ).toBe("crew/drafts/ideas/idea.md");

    await expect(
      caller.folder.delete({ projectId, path: ["crew"] }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(
      caller.folder.delete({ projectId, path: ["crew", "drafts"] }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const tracked = await caller.document.create({
      projectId,
      folderPath: ["crew"],
      title: "Tracked",
      contentJson: EMPTY,
    });
    await expect(
      caller.document.move({
        projectId,
        documentId: tracked.id,
        folderPath: ["crew", "drafts"],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await caller.document.move({
      projectId,
      documentId: nested.id,
      folderPath: [],
    });
    expect(
      (await caller.document.get({ projectId, documentId: nested.id })).path,
    ).toBe("idea.md");
    await caller.folder.delete({
      projectId,
      path: ["crew", "drafts", "ideas"],
    });
    await caller.folder.delete({ projectId, path: ["crew", "drafts"] });
    expect((await caller.folder.tree({ projectId })).untrackedFolders).toEqual(
      [],
    );
    await caller.document.delete({ projectId, documentId: nested.id });
    await expect(
      caller.document.get({ projectId, documentId: nested.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("reviews, sets properties and appearance on an untracked document", async () => {
    const { caller, owner, projectId } = await setup("header");
    const editor = await makeUser("User", "untracked-editor-header");
    await addMembership(projectId, editor.id, "Editor");
    const created = await caller.document.create({
      projectId,
      folderPath: [],
      title: "Checklist",
      contentJson: EMPTY,
      untracked: true,
    });
    const loaded = await caller.document.get({
      projectId,
      documentId: created.id,
    });
    await expect(
      caller.document.reviewPermissions({ projectId, documentId: created.id }),
    ).resolves.toEqual({ canMarkReviewed: true, canEditReview: true });
    await expect(
      callerFor(editor).document.reviewPermissions({
        projectId,
        documentId: created.id,
      }),
    ).resolves.toEqual({ canMarkReviewed: false, canEditReview: false });

    const reviewed = await caller.document.markReviewed({
      projectId,
      documentId: created.id,
      expectedHeadCommitSha: loaded.baseCommitSha,
    });
    const afterReview = await caller.document.get({
      projectId,
      documentId: created.id,
    });
    expect(afterReview.baseCommitSha).toBe(reviewed.headCommitSha);
    expect(afterReview.review?.reviewedBy?.id).toBe(owner.id);
    const tree = await caller.folder.tree({ projectId });
    expect(tree.documents[0]?.lastReviewedAt).not.toBeNull();

    const settings = await caller.document.setReview({
      projectId,
      documentId: created.id,
      expectedHeadCommitSha: reviewed.headCommitSha,
      everyMonths: 3,
    });
    const withProperties = await caller.document.setProperties({
      projectId,
      documentId: created.id,
      expectedHeadCommitSha: settings.headCommitSha,
      properties: { type: "checklist", summary: "Weekly checks" },
    });
    const appearance = await caller.appearance.set({
      target: { projectId, kind: "document", id: created.id },
      expectedRevision: withProperties.headCommitSha,
      patch: { backgroundColor: "#dbeafe" },
    });
    const final = await caller.document.get({
      projectId,
      documentId: created.id,
    });
    expect(final.baseCommitSha).toBe(appearance.revision);
    expect(final.review?.everyMonths).toBe(3);
    expect(final.properties).toMatchObject({
      type: "checklist",
      summary: "Weekly checks",
    });
    expect(final.appearance).toMatchObject({ backgroundColor: "#dbeafe" });
    expect(await committedFiles(projectId)).not.toContain("checklist.md");
  });

  it("stores, serves and downloads images and files of untracked content", async () => {
    const { caller, projectId, actor } = await setup("files");
    const db = getPrisma();
    await caller.folder.create({
      projectId,
      parentPath: [],
      name: "Private",
      untracked: true,
    });
    const created = await caller.document.create({
      projectId,
      folderPath: ["private"],
      title: "Diagram",
      contentJson: EMPTY,
    });
    const stored = await storeDocumentImage(
      db,
      {
        projectId,
        documentId: created.id,
        fileName: "chart.png",
        bytes: PNG_1X1,
      },
      actor,
    );
    expect(stored).toMatchObject({
      src: "diagram.assets/chart.png",
      path: "private/diagram.assets/chart.png",
    });
    const served = await readProjectImage(
      db,
      { projectId, segments: stored.path.split("/"), at: "a".repeat(40) },
      actor,
    );
    expect(served?.bytes.equals(PNG_1X1)).toBe(true);

    const file = await readDocumentFile(
      db,
      { projectId, documentId: created.id },
      actor,
    );
    expect(file.fileName).toBe("diagram.md");
    expect(file.bytes.toString("utf8")).toContain("Diagram");

    const single = await unzip(
      (
        await createDocumentArchive(
          db,
          { projectId, documentId: created.id },
          actor,
        )
      ).stream,
    );
    expect(Object.keys(single.files).sort()).toEqual([
      "diagram.assets/",
      "diagram.assets/chart.png",
      "diagram.md",
    ]);

    const folder = await unzip(
      (
        await createFolderArchive(
          db,
          { projectId, folderPath: ["private"] },
          actor,
        )
      ).stream,
    );
    expect(Object.keys(folder.files)).toEqual(
      expect.arrayContaining([
        "private/diagram.md",
        "private/diagram.assets/chart.png",
        "private/.folder.json",
      ]),
    );

    await caller.document.update({
      projectId,
      documentId: created.id,
      baseCommitSha: (
        await caller.document.get({ projectId, documentId: created.id })
      ).baseCommitSha,
      title: "Chart",
      content: {
        kind: "markdown",
        contentJson: {
          type: "doc",
          content: [
            {
              type: "image",
              attrs: { src: "diagram.assets/chart.png", alt: "chart" },
            },
          ],
        },
      },
    });
    const renamed = await caller.document.get({
      projectId,
      documentId: created.id,
    });
    expect(renamed.path).toBe("private/chart.md");
    expect(JSON.stringify(renamed.content)).toContain("chart.assets/chart.png");
    expect(
      await readProjectImage(
        db,
        { projectId, segments: ["private", "chart.assets", "chart.png"] },
        actor,
      ),
    ).not.toBeNull();
    expect(await committedFiles(projectId)).toEqual(
      expect.not.arrayContaining([expect.stringContaining("private")]),
    );
  });

  it("denies writes to Viewers and reads to outsiders", async () => {
    const { caller, projectId } = await setup("access");
    const viewer = await makeUser("User", "untracked-viewer");
    const outsider = await makeUser("User", "untracked-outsider");
    await addMembership(projectId, viewer.id, "Viewer");
    const created = await caller.document.create({
      projectId,
      folderPath: [],
      title: "Secret",
      contentJson: EMPTY,
      untracked: true,
    });
    const loaded = await callerFor(viewer).document.get({
      projectId,
      documentId: created.id,
    });
    await expect(
      callerFor(viewer).document.update({
        projectId,
        documentId: created.id,
        baseCommitSha: loaded.baseCommitSha,
        content: { kind: "markdown", contentJson: BODY("changed") },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      callerFor(viewer).document.create({
        projectId,
        folderPath: [],
        title: "Viewer draft",
        contentJson: EMPTY,
        untracked: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      callerFor(outsider).document.get({ projectId, documentId: created.id }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/NOT_FOUND|FORBIDDEN/),
    });
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import { createApiKeySecurityContext } from "@weaver/core/security/context";
import { openProjectRepo, repoDir } from "@weaver/git-store";
import { simpleGit } from "simple-git";
import {
  addMembership,
  callerFor,
  callerWithSecurity,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
} from "./_harness";

describe("localDocument router", () => {
  let queue: FakeJobQueue;

  beforeEach(async () => {
    await resetDb();
    queue = new FakeJobQueue();
    setJobQueueForTests(queue);
  });
  afterEach(() => setJobQueueForTests(null));

  it("stores a nested tree separately from tracked documents and Git", async () => {
    const owner = await makeUser("User", "local-tree-owner");
    const caller = callerFor(owner);
    const { id: projectId } = await caller.project.create({
      name: "Local tree",
    });
    const tracked = await caller.document.create({
      projectId,
      folderPath: [],
      title: "Runbook",
      contentJson: { type: "doc", content: [{ type: "paragraph" }] },
    });
    const repo = await openProjectRepo(projectId);
    const trackedFiles = await repo!.listTrackedFiles();
    const jobCount = queue.jobs.length;
    const folder = await caller.localDocument.create({
      projectId,
      kind: "folder",
      title: "Drafts",
    });
    const nested = await caller.localDocument.create({
      projectId,
      parentId: folder.id,
      kind: "folder",
      title: "November",
    });
    const draft = await caller.localDocument.create({
      projectId,
      parentId: nested.id,
      kind: "document",
      title: "Runbook",
    });
    const draftInput = { projectId, entryId: draft.id };
    const markdown = "# Local notes\n\nRetain **Markdown** as written.\n";
    const saved = await caller.localDocument.update({
      ...draftInput,
      revision: draft.revision,
      title: "Revised runbook",
      markdown,
    });
    expect(saved).toMatchObject({
      revision: 2,
      title: "Revised runbook",
      markdown,
    });
    await expect(caller.localDocument.get(draftInput)).resolves.toEqual(saved);
    const listing = await caller.localDocument.list({ projectId });
    expect(listing).toHaveLength(3);
    expect(listing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: folder.id,
          parentId: null,
          kind: "folder",
        }),
        expect.objectContaining({
          id: nested.id,
          parentId: folder.id,
          kind: "folder",
        }),
        expect.objectContaining({
          id: draft.id,
          parentId: nested.id,
          kind: "document",
        }),
      ]),
    );
    expect(listing.every((entry) => !("markdown" in entry))).toBe(true);
    await expect(
      caller.document.get({ projectId, documentId: draft.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const trackedList = await caller.document.list({ projectId });
    expect(trackedList.items.map(({ id }) => id)).toEqual([tracked.id]);

    await expect(
      caller.localDocument.delete({
        projectId,
        entryId: nested.id,
        revision: nested.revision,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await caller.localDocument.delete({
      ...draftInput,
      revision: saved.revision,
    });
    await expect(caller.localDocument.get(draftInput)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await caller.localDocument.delete({
      projectId,
      entryId: nested.id,
      revision: nested.revision,
    });

    await expect(repo!.resolveHead()).resolves.toBe(tracked.headCommitSha);
    await expect(repo!.listTrackedFiles()).resolves.toEqual(trackedFiles);
    expect((await simpleGit(repoDir(projectId)).status()).isClean()).toBe(true);
    expect(queue.jobs).toHaveLength(jobCount);
  });

  it("prevents stale edits and deletes from overwriting another editor's save", async () => {
    const first = await makeUser("User", "local-revision-first");
    const second = await makeUser("User", "local-revision-second");
    const { id: projectId } = await makeProject("Local revisions");
    await addMembership(projectId, first.id, "Editor");
    await addMembership(projectId, second.id, "Editor");
    const firstCaller = callerFor(first).localDocument;
    const secondCaller = callerFor(second).localDocument;
    const draft = await firstCaller.create({
      projectId,
      kind: "document",
      title: "Notes",
    });
    const input = { projectId, entryId: draft.id };
    const baseline = await secondCaller.get(input);

    const writes = await Promise.allSettled([
      firstCaller.update({
        ...input,
        revision: draft.revision,
        markdown: "First editor.\n",
      }),
      secondCaller.update({
        ...input,
        revision: baseline.revision,
        markdown: "Second editor.\n",
      }),
    ]);
    expect(writes.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(writes).toContainEqual({
      status: "rejected",
      reason: expect.objectContaining({ code: "CONFLICT" }),
    });
    await expect(
      secondCaller.delete({ ...input, revision: baseline.revision }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const saved = await firstCaller.get(input);
    expect(saved.revision).toBe(2);
    expect(["First editor.\n", "Second editor.\n"]).toContain(saved.markdown);
  });

  it("keeps sibling names unique and requires a folder as parent", async () => {
    const editor = await makeUser("User", "local-structure-editor");
    const { id: projectId } = await makeProject("Local structure");
    await addMembership(projectId, editor.id, "Editor");
    const local = callerFor(editor).localDocument;
    const draft = await local.create({
      projectId,
      kind: "document",
      title: "Notes",
    });
    const folder = await local.create({
      projectId,
      kind: "folder",
      title: "Drafts",
    });

    await expect(
      local.create({ projectId, kind: "folder", title: "Notes" }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      cause: { details: { field: "title" } },
    });
    await expect(
      local.update({
        projectId,
        entryId: folder.id,
        revision: folder.revision,
        title: "Notes",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      cause: { details: { field: "title" } },
    });
    await expect(
      local.create({
        projectId,
        parentId: draft.id,
        kind: "document",
        title: "Child",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      cause: { details: { field: "parentId" } },
    });
    await expect(
      local.create({
        projectId,
        parentId: folder.id,
        kind: "document",
        title: "Notes",
      }),
    ).resolves.toMatchObject({ parentId: folder.id, title: "Notes" });
  });

  it("keeps reads and writes within current project membership and role", async () => {
    const editor = await makeUser("User", "local-access-editor");
    const viewer = await makeUser("User", "local-access-viewer");
    const outsider = await makeUser("Admin", "local-access-outsider");
    const { id: projectId } = await makeProject("Visible local documents");
    const other = await makeProject("Other local documents");
    await addMembership(projectId, editor.id, "Editor");
    await addMembership(projectId, viewer.id, "Viewer");
    await addMembership(other.id, editor.id, "Editor");
    const editorCaller = callerFor(editor).localDocument;
    const viewerCaller = callerFor(viewer).localDocument;
    const outsiderCaller = callerFor(outsider).localDocument;
    const folder = await editorCaller.create({
      projectId,
      kind: "folder",
      title: "Drafts",
    });
    const visible = { projectId, entryId: folder.id };
    const write = { ...visible, revision: folder.revision };

    await expect(viewerCaller.list({ projectId })).resolves.toHaveLength(1);
    await expect(viewerCaller.get(visible)).resolves.toEqual(folder);
    await expect(
      viewerCaller.create({ projectId, kind: "document", title: "Denied" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      viewerCaller.update({ ...write, title: "Denied" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(viewerCaller.delete(write)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(outsiderCaller.list({ projectId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(outsiderCaller.get(visible)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    const key = createApiKeySecurityContext({
      userId: editor.id,
      globalRole: editor.role,
      keyId: "local-access-key",
      permissions: { mcp: ["use"], content: ["read", "write"] },
      projectIds: [projectId],
    });
    const bearerCaller = callerWithSecurity(editor, key).localDocument;
    await expect(bearerCaller.get(visible)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(bearerCaller.delete(write)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    await expect(
      editorCaller.get({ ...visible, projectId: other.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      editorCaller.update({ ...write, projectId: other.id, title: "Denied" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      editorCaller.delete({ ...write, projectId: other.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      editorCaller.create({
        projectId: other.id,
        parentId: folder.id,
        kind: "document",
        title: "Denied",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await getPrisma().project.update({
      where: { id: projectId },
      data: { deletedAt: new Date() },
    });
    await expect(editorCaller.get(visible)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

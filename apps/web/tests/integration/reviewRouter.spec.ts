import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addMonthsUtc } from "@weaver/core/documents/review";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import { createCaller } from "~/server/api/root";
import {
  addMembership,
  callerFor,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
} from "./_harness";

const PAST = new Date("2021-03-01T00:00:00Z");

async function fixture(suffix: string) {
  const db = getPrisma();
  const owner = await makeUser("User", `${suffix}-owner`);
  const maintainer = await makeUser("User", `${suffix}-maintainer`);
  const editor = await makeUser("User", `${suffix}-editor`);
  const viewer = await makeUser("User", `${suffix}-viewer`);
  const stranger = await makeUser("User", `${suffix}-stranger`);
  const project = await makeProject(`Review router ${suffix}`);
  await addMembership(project.id, owner.id, "Owner");
  await addMembership(project.id, maintainer.id, "Maintainer");
  await addMembership(project.id, editor.id, "Editor");
  await addMembership(project.id, viewer.id, "Viewer");
  const doc = await callerFor(owner).document.create({
    projectId: project.id,
    folderPath: [],
    title: "Reviewed",
    contentJson: parseDocumentBody("Text\n"),
  });
  return { db, owner, maintainer, editor, viewer, stranger, project, doc };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Makes the viewer the document's only reviewer and returns the new head. */
async function assignViewer(f: Fixture) {
  const { headCommitSha } = await callerFor(f.maintainer).document.setReview({
    projectId: f.project.id,
    documentId: f.doc.id,
    expectedHeadCommitSha: f.doc.headCommitSha,
    reviewers: [{ type: "user", id: f.viewer.id }],
  });
  return headCommitSha;
}

describe("review router", () => {
  beforeEach(async () => {
    await resetDb();
    setJobQueueForTests(new FakeJobQueue());
  });
  afterEach(() => setJobQueueForTests(null));

  describe("document.markReviewed", () => {
    it("rejects a non-reviewer and lets a reviewer mark the document", async () => {
      const f = await fixture("mark");
      const head = await assignViewer(f);
      const input = {
        projectId: f.project.id,
        documentId: f.doc.id,
        expectedHeadCommitSha: head,
      };
      await expect(
        callerFor(f.editor).document.markReviewed(input),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      const result = await callerFor(f.viewer).document.markReviewed(input);
      expect(result.headCommitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(result.headCommitSha).not.toBe(head);

      const read = await callerFor(f.viewer).document.get({
        projectId: f.project.id,
        documentId: f.doc.id,
      });
      expect(read.review?.lastReviewedAt).toBeInstanceOf(Date);
      expect(read.review?.dueAt).toBeInstanceOf(Date);
      expect(read.review?.reviewedBy?.id).toBe(f.viewer.id);
    });

    it("rejects a malformed head sha before reaching the service", async () => {
      const f = await fixture("sha");
      await expect(
        callerFor(f.owner).document.markReviewed({
          projectId: f.project.id,
          documentId: f.doc.id,
          expectedHeadCommitSha: "nope",
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });
  });

  describe("document.setReview", () => {
    it("is forbidden for an Editor and succeeds for a Maintainer", async () => {
      const f = await fixture("set");
      const input = {
        projectId: f.project.id,
        documentId: f.doc.id,
        expectedHeadCommitSha: f.doc.headCommitSha,
        everyMonths: 6,
      };
      await expect(
        callerFor(f.editor).document.setReview(input),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      await callerFor(f.maintainer).document.setReview(input);
      const read = await callerFor(f.maintainer).document.get({
        projectId: f.project.id,
        documentId: f.doc.id,
      });
      expect(read.review?.everyMonths).toBe(6);
    });

    it("maps an out-of-range interval to BAD_REQUEST from zod", async () => {
      const f = await fixture("range");
      const base = {
        projectId: f.project.id,
        documentId: f.doc.id,
        expectedHeadCommitSha: f.doc.headCommitSha,
      };
      for (const everyMonths of [0, 121, 1.5])
        await expect(
          callerFor(f.owner).document.setReview({ ...base, everyMonths }),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("rejects a call that changes nothing", async () => {
      const f = await fixture("nothing");
      await expect(
        callerFor(f.owner).document.setReview({
          projectId: f.project.id,
          documentId: f.doc.id,
          expectedHeadCommitSha: f.doc.headCommitSha,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });
  });

  describe("document.reviewPermissions", () => {
    it("flags a reviewer-Viewer and a non-reviewer Editor", async () => {
      const f = await fixture("perm");
      await assignViewer(f);
      const input = { projectId: f.project.id, documentId: f.doc.id };
      expect(
        await callerFor(f.viewer).document.reviewPermissions(input),
      ).toEqual({ canMarkReviewed: true, canEditReview: false });
      expect(
        await callerFor(f.editor).document.reviewPermissions(input),
      ).toEqual({ canMarkReviewed: false, canEditReview: false });
      expect(
        await callerFor(f.maintainer).document.reviewPermissions(input),
      ).toEqual({ canMarkReviewed: false, canEditReview: true });
    });
  });

  describe("reviewerGroup", () => {
    it("lets an Owner create, rename, set members of and delete a group", async () => {
      const f = await fixture("group");
      const owner = callerFor(f.owner).reviewerGroup;
      const created = await owner.create({
        projectId: f.project.id,
        name: "Team",
        memberIds: [f.editor.id],
      });
      expect(created).toMatchObject({
        name: "Team",
        members: [{ userId: f.editor.id }],
      });

      await owner.rename({
        projectId: f.project.id,
        groupId: created.id,
        name: "Crew",
      });
      await owner.setMembers({
        projectId: f.project.id,
        groupId: created.id,
        memberIds: [f.editor.id, f.viewer.id],
      });
      const listed = await owner.list({ projectId: f.project.id });
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ id: created.id, name: "Crew" });
      expect(listed[0]!.members.map((m) => m.userId).sort()).toEqual(
        [f.editor.id, f.viewer.id].sort(),
      );

      await owner.delete({ projectId: f.project.id, groupId: created.id });
      expect(await owner.list({ projectId: f.project.id })).toEqual([]);
    });

    it("forbids an Editor from creating a group and maps a duplicate name to CONFLICT", async () => {
      const f = await fixture("dup");
      await expect(
        callerFor(f.editor).reviewerGroup.create({
          projectId: f.project.id,
          name: "Team",
          memberIds: [],
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      const owner = callerFor(f.owner).reviewerGroup;
      await owner.create({
        projectId: f.project.id,
        name: "Team",
        memberIds: [],
      });
      await expect(
        owner.create({ projectId: f.project.id, name: "Team", memberIds: [] }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("rejects an empty group name from zod", async () => {
      const f = await fixture("name");
      await expect(
        callerFor(f.owner).reviewerGroup.create({
          projectId: f.project.id,
          name: "   ",
          memberIds: [],
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("lets a Viewer read groups and defaults but not change defaults", async () => {
      const f = await fixture("defaults");
      const viewer = callerFor(f.viewer).reviewerGroup;
      expect(await viewer.list({ projectId: f.project.id })).toEqual([]);
      const defaults = await viewer.getDefaults({ projectId: f.project.id });
      expect(defaults).toMatchObject({ everyMonths: 12, canManage: false });
      expect(defaults.reviewers.map((r) => r.id)).toEqual([f.owner.id]);

      const change = {
        projectId: f.project.id,
        everyMonths: 3,
        reviewers: [{ type: "user" as const, id: f.owner.id }],
      };
      await expect(viewer.setDefaults(change)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(
        callerFor(f.maintainer).reviewerGroup.setDefaults(change),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      await callerFor(f.owner).reviewerGroup.setDefaults(change);
      expect(
        await callerFor(f.owner).reviewerGroup.getDefaults({
          projectId: f.project.id,
        }),
      ).toMatchObject({ everyMonths: 3, canManage: true });
    });
  });

  describe("review.dueCount", () => {
    it("counts a newly created document as due for a fresh project's Owner", async () => {
      const f = await fixture("count");
      expect(await callerFor(f.owner).review.dueCount()).toEqual({
        count: 1,
        isReviewer: true,
      });
    });

    it("drops a document from the list and count once it is reviewed", async () => {
      const f = await fixture("reviewed-leaves");
      const owner = callerFor(f.owner);
      expect((await owner.review.listDue({})).items).toMatchObject([
        { id: f.doc.id, lastReviewedAt: null },
      ]);
      await owner.document.markReviewed({
        projectId: f.project.id,
        documentId: f.doc.id,
        expectedHeadCommitSha: f.doc.headCommitSha,
      });
      expect(await owner.review.dueCount()).toEqual({
        count: 0,
        isReviewer: true,
      });
      expect((await owner.review.listDue({})).items).toEqual([]);
      const read = await owner.document.get({
        projectId: f.project.id,
        documentId: f.doc.id,
      });
      expect(read.review!.dueAt).toEqual(
        addMonthsUtc(read.review!.lastReviewedAt!.toISOString(), 12),
      );
    });

    it("does not throw for a user without projects", async () => {
      const f = await fixture("lonely");
      expect(await callerFor(f.stranger).review.dueCount()).toEqual({
        count: 0,
        isReviewer: false,
      });
    });

    it("counts the due documents of a reviewer", async () => {
      const f = await fixture("due-count");
      await assignViewer(f);
      await f.db.document.update({
        where: { id: f.doc.id },
        data: { reviewDueAt: PAST },
      });
      expect(await callerFor(f.viewer).review.dueCount()).toEqual({
        count: 1,
        isReviewer: true,
      });
    });
  });

  describe("review.listDue", () => {
    it("returns a due document for its reviewer with Date fields", async () => {
      const f = await fixture("list");
      await assignViewer(f);
      await f.db.document.update({
        where: { id: f.doc.id },
        data: { reviewDueAt: PAST },
      });
      const page = await callerFor(f.viewer).review.listDue({});
      expect(page.nextCursor).toBeNull();
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        id: f.doc.id,
        title: "Reviewed",
        projectId: f.project.id,
        lastReviewedAt: null,
      });
      expect(page.items[0]!.dueAt).toBeInstanceOf(Date);
      expect(page.items[0]!.dueAt.toISOString()).toBe(PAST.toISOString());
      expect((await callerFor(f.editor).review.listDue({})).items).toEqual([]);
    });

    it("pages with the cursor without repeating or losing documents", async () => {
      const f = await fixture("page");
      const ids = Array.from({ length: 52 }, () => randomUUID());
      await f.db.document.createMany({
        data: ids.map((id, index) => ({
          id,
          projectId: f.project.id,
          path: `bulk-${index}.md`,
          slug: `bulk-${index}`,
          title: `Bulk ${index}`,
          excerpt: "",
          headCommitSha: "0".repeat(40),
          lastEditedAt: PAST,
          createdAt: PAST,
          updatedAt: PAST,
          reviewEveryMonths: 12,
          reviewSince: PAST,
          reviewDueAt: new Date(PAST.getTime() + (index % 3) * 1000),
        })),
      });
      const owner = callerFor(f.owner);
      const first = await owner.review.listDue({});
      expect(first.items).toHaveLength(50);
      expect(first.nextCursor).toEqual(expect.any(String));
      const second = await owner.review.listDue({ cursor: first.nextCursor! });
      expect(second.items).toHaveLength(3);
      expect(second.nextCursor).toBeNull();
      const seen = [...first.items, ...second.items].map((item) => item.id);
      expect(new Set(seen).size).toBe(53);
      expect([...seen].sort()).toEqual([...ids, f.doc.id].sort());
    });

    it("rejects an invalid cursor", async () => {
      const f = await fixture("cursor");
      await expect(
        callerFor(f.owner).review.listDue({ cursor: "garbage" }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });
  });

  describe("review.listRecent", () => {
    const row = (f: Fixture, index: number, extra: object) => ({
      id: randomUUID(),
      projectId: f.project.id,
      path: `recent-${index}.md`,
      slug: `recent-${index}`,
      title: `Recent ${index}`,
      excerpt: "",
      headCommitSha: "0".repeat(40),
      lastEditedAt: PAST,
      createdAt: PAST,
      updatedAt: PAST,
      ...extra,
    });

    it("lists only reviewed documents, newest first, with the reviewer by anyone", async () => {
      const f = await fixture("recent-order");
      const older = new Date("2022-01-01T00:00:00Z");
      const newer = new Date("2023-01-01T00:00:00Z");
      await f.db.document.createMany({
        data: [
          row(f, 1, {
            lastReviewedAt: older,
            reviewedById: f.viewer.id,
            reviewedByName: "Stored Viewer",
            reviewDueAt: new Date("2023-01-01T00:00:00Z"),
          }),
          row(f, 2, {
            lastReviewedAt: newer,
            reviewedById: null,
            reviewedByName: "Gone Gary",
            reviewDueAt: new Date("2024-01-01T00:00:00Z"),
          }),
        ],
      });
      await f.db.user.update({
        where: { id: f.viewer.id },
        data: { name: "Current Viewer" },
      });
      const page = await callerFor(f.editor).review.listRecent({});
      expect(page.nextCursor).toBeNull();
      expect(page.items.map((item) => item.title)).toEqual([
        "Recent 2",
        "Recent 1",
      ]);
      expect(page.items[0]).toMatchObject({
        projectId: f.project.id,
        projectName: "Review router recent-order",
        path: "recent-2.md",
        reviewedBy: { id: null, name: "Gone Gary" },
      });
      expect(page.items[0]!.lastReviewedAt.toISOString()).toBe(
        newer.toISOString(),
      );
      expect(page.items[0]!.dueAt!.toISOString()).toBe(
        "2024-01-01T00:00:00.000Z",
      );
      expect(page.items[1]!.reviewedBy).toEqual({
        id: f.viewer.id,
        name: "Current Viewer",
      });
    });

    it("shows a review made through the app to every member", async () => {
      const f = await fixture("recent-app");
      await callerFor(f.owner).document.markReviewed({
        projectId: f.project.id,
        documentId: f.doc.id,
        expectedHeadCommitSha: f.doc.headCommitSha,
      });
      const page = await callerFor(f.viewer).review.listRecent({});
      expect(page.items).toMatchObject([
        { id: f.doc.id, title: "Reviewed", reviewedBy: { id: f.owner.id } },
      ]);
    });

    it("pages with the cursor across tied timestamps without repeats", async () => {
      const f = await fixture("recent-page");
      const ids = Array.from({ length: 52 }, () => randomUUID());
      await f.db.document.createMany({
        data: ids.map((id, index) =>
          row(f, index, {
            id,
            lastReviewedAt: new Date(PAST.getTime() + (index % 3) * 1000),
            reviewDueAt: PAST,
          }),
        ),
      });
      const owner = callerFor(f.owner);
      const first = await owner.review.listRecent({});
      expect(first.items).toHaveLength(50);
      expect(first.nextCursor).toEqual(expect.any(String));
      const second = await owner.review.listRecent({
        cursor: first.nextCursor!,
      });
      expect(second.items).toHaveLength(2);
      expect(second.nextCursor).toBeNull();
      const all = [...first.items, ...second.items];
      expect(new Set(all.map((item) => item.id)).size).toBe(52);
      const times = all.map((item) => item.lastReviewedAt.getTime());
      expect(times).toEqual([...times].sort((a, b) => b - a));
    });

    it("hides the list from non-members and soft-deleted projects", async () => {
      const f = await fixture("recent-scope");
      await f.db.document.createMany({
        data: [row(f, 1, { lastReviewedAt: PAST, reviewDueAt: PAST })],
      });
      expect((await callerFor(f.stranger).review.listRecent({})).items).toEqual(
        [],
      );
      expect(
        (await callerFor(f.viewer).review.listRecent({})).items,
      ).toHaveLength(1);
      await f.db.project.update({
        where: { id: f.project.id },
        data: { deletedAt: new Date() },
      });
      expect((await callerFor(f.viewer).review.listRecent({})).items).toEqual(
        [],
      );
    });

    it("rejects an invalid cursor and an anonymous caller", async () => {
      const f = await fixture("recent-bad");
      await expect(
        callerFor(f.owner).review.listRecent({ cursor: "garbage" }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      const anonymous = createCaller({
        db: getPrisma(),
        session: null,
        security: null,
        headers: new Headers(),
      } as never);
      await expect(anonymous.review.listRecent({})).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    });
  });

  describe("folder reviewer procedures", () => {
    it("refreshes document reads, review lists/counts and defaults after assignment", async () => {
      const f = await fixture("folder-api");
      const owner = callerFor(f.owner);
      const maintainer = callerFor(f.maintainer);
      const target = { projectId: f.project.id, path: [] };
      const input = {
        ...target,
        reviewers: [{ type: "user" as const, id: f.viewer.id }],
      };
      const defaults = await owner.folder.reviewDefaults(target);
      expect(defaults).toMatchObject({
        hasOwnDefault: false,
        inheritedFrom: null,
        canManage: true,
        configuredReviewers: [],
      });
      const preview = await maintainer.folder.previewReview(input);
      const result = await maintainer.folder.setReviewRecursively({
        ...input,
        expectedHeadCommitSha: preview.baseProjectCommitSha,
      });
      expect(await callerFor(f.viewer).review.dueCount()).toEqual({
        count: 1,
        isReviewer: true,
      });
      expect(await owner.review.dueCount()).toMatchObject({ count: 0 });
      expect(
        (await callerFor(f.viewer).review.listDue({})).items,
      ).toMatchObject([{ id: f.doc.id }]);
      expect(
        await owner.document.get({
          projectId: f.project.id,
          documentId: f.doc.id,
        }),
      ).toMatchObject({
        baseCommitSha: result.headCommitSha,
        review: { reviewers: [{ id: f.viewer.id }] },
      });
      expect(await owner.folder.reviewDefaults(target)).toMatchObject({
        hasOwnDefault: true,
        configuredReviewers: [{ id: f.viewer.id }],
        baseProjectCommitSha: result.headCommitSha,
        reviewers: [{ id: f.viewer.id }],
      });
      await expect(
        owner.document.update({
          projectId: f.project.id,
          documentId: f.doc.id,
          baseCommitSha: f.doc.headCommitSha,
          title: "Dirty editor",
          content: {
            kind: "markdown",
            contentJson: parseDocumentBody("stale\n"),
          },
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await maintainer.folder.clearReviewDefault({
        ...target,
        expectedHeadCommitSha: result.headCommitSha,
      });
      expect(await owner.folder.reviewDefaults(target)).toMatchObject({
        hasOwnDefault: false,
      });
    });

    it("validates paths, reviewer limits, SHA and every access boundary", async () => {
      const f = await fixture("folder-guards");
      const input = { projectId: f.project.id, path: [], reviewers: [] };
      const guard = { expectedHeadCommitSha: f.doc.headCommitSha };
      const owner = callerFor(f.owner).folder;
      await expect(
        owner.previewReview({
          ...input,
          reviewers: Array.from({ length: 51 }, () => ({
            type: "user" as const,
            id: f.viewer.id,
          })),
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(
        owner.reviewDefaults({ ...input, path: ["../bad"] }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(
        owner.setReviewRecursively({
          ...input,
          expectedHeadCommitSha: "not-sha",
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(
        owner.clearReviewDefault({
          ...input,
          expectedHeadCommitSha: "A".repeat(40),
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(
        owner.setReviewRecursively({
          ...input,
          expectedHeadCommitSha: "0".repeat(40),
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      for (const user of [f.editor, f.viewer, f.stranger]) {
        const folder = callerFor(user).folder;
        const code = user.id === f.stranger.id ? "NOT_FOUND" : "FORBIDDEN";
        await expect(folder.previewReview(input)).rejects.toMatchObject({
          code,
        });
        await expect(
          folder.setReviewRecursively({ ...input, ...guard }),
        ).rejects.toMatchObject({ code });
        await expect(
          folder.clearReviewDefault({ ...input, ...guard }),
        ).rejects.toMatchObject({ code });
      }
      await expect(
        callerFor(f.stranger).folder.reviewDefaults(input),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("access", () => {
    it("answers NOT_FOUND to a non-member on every project-scoped procedure", async () => {
      const f = await fixture("outsider");
      const stranger = callerFor(f.stranger);
      const projectId = f.project.id;
      const documentId = f.doc.id;
      const groupId = randomUUID();
      const expectedHeadCommitSha = f.doc.headCommitSha;
      const calls = [
        stranger.document.markReviewed({
          projectId,
          documentId,
          expectedHeadCommitSha,
        }),
        stranger.document.setReview({
          projectId,
          documentId,
          expectedHeadCommitSha,
          everyMonths: 6,
        }),
        stranger.document.reviewPermissions({ projectId, documentId }),
        stranger.reviewerGroup.list({ projectId }),
        stranger.reviewerGroup.create({ projectId, name: "G", memberIds: [] }),
        stranger.reviewerGroup.rename({ projectId, groupId, name: "G" }),
        stranger.reviewerGroup.setMembers({
          projectId,
          groupId,
          memberIds: [],
        }),
        stranger.reviewerGroup.delete({ projectId, groupId }),
        stranger.reviewerGroup.getDefaults({ projectId }),
        stranger.reviewerGroup.setDefaults({
          projectId,
          everyMonths: 6,
          reviewers: [],
        }),
      ];
      for (const result of await Promise.allSettled(calls)) {
        expect(result).toMatchObject({
          status: "rejected",
          reason: { code: "NOT_FOUND" },
        });
      }
    });

    it("rejects an unauthenticated caller", async () => {
      const anonymous = createCaller({
        db: getPrisma(),
        session: null,
        security: null,
        headers: new Headers(),
      } as never);
      await expect(anonymous.review.dueCount()).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
      await expect(anonymous.review.listDue({})).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
      await expect(
        anonymous.reviewerGroup.list({ projectId: randomUUID() }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { stat } from "node:fs/promises";
import * as metadata from "@weaver/core/services/projectMetadata";
import { TRPCError } from "@trpc/server";
import { fromOrganizationRole } from "@weaver/core/roles";
import { openProjectRepo, repoDir } from "@weaver/git-store";
import {
  addMembership,
  callerFor,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
} from "./_harness";

describe("project router", () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe("project.create", () => {
    it("removes the fresh repository when creation rolls back after its Git commit", async () => {
      const user = await makeUser("User", "create-rollback");
      let createdId = "";
      const original = metadata.syncProjectMetadata;
      const sync = vi
        .spyOn(metadata, "syncProjectMetadata")
        .mockImplementationOnce(async (...args) => {
          createdId = args[1];
          await original(...args);
          throw new Error("Injected failure after Git commit");
        });
      try {
        await expect(
          callerFor(user).project.create({ name: "Rolled back" }),
        ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
        expect(createdId).not.toBe("");
        expect(
          await getPrisma().project.findFirst({ where: { id: createdId } }),
        ).toBeNull();
        await expect(stat(repoDir(createdId))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        sync.mockRestore();
      }
    });

    it("creates a project and makes the creator Owner", async () => {
      const user = await makeUser("User", "c1");
      const caller = callerFor(user);
      const project = await caller.project.create({ name: "New Project" });
      expect(project.name).toBe("New Project");
      const membership = await getPrisma().member.findUnique({
        where: {
          organizationId_userId: {
            organizationId: project.organizationId,
            userId: user.id,
          },
        },
      });
      expect(membership ? fromOrganizationRole(membership.role) : null).toBe(
        "Owner",
      );
    });

    it("initializes the Git repository with a committed project.json", async () => {
      const user = await makeUser("User", "c3");
      const caller = callerFor(user);
      const project = await caller.project.create({
        name: "Stored Project",
        description: "Kept on disk",
      });

      const repo = await openProjectRepo(project.id);
      expect(repo).not.toBeNull();
      const file = await repo!.readCommittedFile("project.json");
      expect(file).not.toBeNull();
      expect(JSON.parse(file!.content)).toEqual({
        id: project.id,
        name: "Stored Project",
        description: "Kept on disk",
        created: project.createdAt.toISOString(),
        members: [
          {
            userId: user.id,
            email: user.email,
            name: "User c3",
            role: "Owner",
          },
        ],
        documentReview: {
          everyMonths: 12,
          defaultReviewers: [{ type: "user", id: user.id }],
        },
        reviewerGroups: [],
      });
      expect(await repo!.listTrackedFiles()).toEqual(["project.json"]);
      const [entry] = await repo!.logForPath("project.json", {
        skip: 0,
        limit: 1,
      });
      expect(entry).toMatchObject({
        sha: file!.baseCommitSha,
        message: "create: project.json",
        userId: user.id,
        authorEmail: user.email,
      });
    });

    it("rejects empty names", async () => {
      const user = await makeUser("User", "c2");
      const caller = callerFor(user);
      await expect(caller.project.create({ name: "   " })).rejects.toThrow(
        TRPCError,
      );
    });
  });

  describe("project.list", () => {
    it("lists only projects the caller is a member of, with their role", async () => {
      const member = await makeUser("User", "l1");
      const stranger = await makeUser("User", "l2");
      const p1 = await makeProject("P1");
      const p2 = await makeProject("P2");
      await addMembership(p1.id, member.id, "Editor");
      await addMembership(p2.id, stranger.id, "Owner");

      const list = await callerFor(member).project.list();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        id: p1.id,
        name: "P1",
        myRole: "Editor",
      });
    });

    it("lists only projects the Admin is a member of", async () => {
      const admin = await makeUser("Admin", "l3");
      const p1 = await makeProject("P1");
      await makeProject("P2");
      await addMembership(p1.id, admin.id, "Viewer");
      const list = await callerFor(admin).project.list();
      expect(list).toHaveLength(1);
      expect(list[0]?.id).toBe(p1.id);
      expect(list[0]?.myRole).toBe("Viewer");
    });

    it("excludes soft-deleted projects", async () => {
      const owner = await makeUser("User", "l4");
      const p1 = await makeProject("P1");
      await addMembership(p1.id, owner.id, "Owner");
      await getPrisma().project.update({
        where: { id: p1.id },
        data: { deletedAt: new Date() },
      });
      expect(await callerFor(owner).project.list()).toHaveLength(0);
    });
  });

  describe("project.get", () => {
    it("returns the project for a member", async () => {
      const viewer = await makeUser("User", "g1");
      const project = await makeProject("P1");
      await addMembership(project.id, viewer.id, "Viewer");
      const got = await callerFor(viewer).project.get({
        projectId: project.id,
      });
      expect(got).toMatchObject({ id: project.id, name: "P1" });
      expect(got.myRole).toBe("Viewer");
    });

    it("throws NOT_FOUND for non-members (no existence leak) and for deleted projects", async () => {
      const viewer = await makeUser("User", "g2");
      const stranger = await makeUser("User", "g3");
      const project = await makeProject("P1");
      await addMembership(project.id, viewer.id, "Viewer");
      await expect(
        callerFor(stranger).project.get({ projectId: project.id }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await getPrisma().project.update({
        where: { id: project.id },
        data: { deletedAt: new Date() },
      });
      await expect(
        callerFor(viewer).project.get({ projectId: project.id }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("project.update", () => {
    it("allows Editor and above to edit name/description", async () => {
      const editor = await makeUser("User", "u1");
      const project = await makeProject("P1");
      await addMembership(project.id, editor.id, "Editor");
      const updated = await callerFor(editor).project.update({
        projectId: project.id,
        name: "Renamed",
        description: "New",
      });
      expect(updated).toMatchObject({ name: "Renamed", description: "New" });

      const file = await (await openProjectRepo(project.id))!.readCommittedFile(
        "project.json",
      );
      expect(JSON.parse(file!.content)).toMatchObject({
        id: project.id,
        name: "Renamed",
        description: "New",
        members: [{ userId: editor.id, role: "Editor" }],
      });
    });

    it("forbids Viewer and non-members", async () => {
      const viewer = await makeUser("User", "u2");
      const stranger = await makeUser("User", "u3");
      const project = await makeProject("P1");
      await addMembership(project.id, viewer.id, "Viewer");
      await expect(
        callerFor(viewer).project.update({ projectId: project.id, name: "X" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        callerFor(stranger).project.update({
          projectId: project.id,
          name: "X",
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("requires membership before an Admin can edit or delete, and role rules apply after", async () => {
      const admin = await makeUser("Admin", "u4");
      const project = await makeProject("P1");
      await expect(
        callerFor(admin).project.update({ projectId: project.id, name: "x" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      await addMembership(project.id, admin.id, "Owner");
      const updated = await callerFor(admin).project.update({
        projectId: project.id,
        name: "Admin Edit",
      });
      expect(updated).toMatchObject({ name: "Admin Edit" });
      await callerFor(admin).project.delete({ projectId: project.id });
      expect(
        (await getPrisma().project.findUnique({ where: { id: project.id } }))
          ?.deletedAt,
      ).toBeInstanceOf(Date);
    });

    it("rejects updates with neither name nor description", async () => {
      const editor = await makeUser("User", "u5");
      const project = await makeProject("P1");
      await addMembership(project.id, editor.id, "Editor");
      await expect(
        callerFor(editor).project.update({ projectId: project.id }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });
  });

  describe("project.delete (soft)", () => {
    it("allows Owner and global Admin; sets deletedAt", async () => {
      const owner = await makeUser("User", "d1");
      const admin = await makeUser("Admin", "d2");
      const p1 = await makeProject("P1");
      const p2 = await makeProject("P2");
      await addMembership(p1.id, owner.id, "Owner");
      await addMembership(p2.id, admin.id, "Owner");

      await callerFor(owner).project.delete({ projectId: p1.id });
      expect(
        (await getPrisma().project.findUnique({ where: { id: p1.id } }))
          ?.deletedAt,
      ).toBeInstanceOf(Date);

      await callerFor(admin).project.delete({ projectId: p2.id });
      expect(
        (await getPrisma().project.findUnique({ where: { id: p2.id } }))
          ?.deletedAt,
      ).toBeInstanceOf(Date);
    });

    it("forbids Maintainer and below", async () => {
      const maintainer = await makeUser("User", "d3");
      const project = await makeProject("P1");
      await addMembership(project.id, maintainer.id, "Maintainer");
      await expect(
        callerFor(maintainer).project.delete({ projectId: project.id }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("refuses to delete a personal workspace and exposes personalOwnerId", async () => {
      const owner = await makeUser("User", "pw-del");
      const caller = callerFor(owner);
      const { projectId } = await caller.account.landingProject();
      const project = await caller.project.get({ projectId: projectId! });
      expect(project.personalOwnerId).toBe(owner.id);
      expect(
        (await caller.project.list()).find((p) => p.id === projectId)
          ?.personalOwnerId,
      ).toBe(owner.id);
      await expect(
        caller.project.delete({ projectId: projectId! }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    });
  });
});

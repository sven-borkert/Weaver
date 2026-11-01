import { beforeEach, describe, expect, it } from "vitest";
import {
  addMembership,
  callerFor,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
} from "./_harness";

describe("landing project", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("records a project the user can view and resolves it as the landing project", async () => {
    const user = await makeUser("User", "lp1");
    const project = await makeProject("Landing");
    await addMembership(project.id, user.id, "Viewer");
    const caller = callerFor(user);

    await caller.account.recordLastOpenedProject({ projectId: project.id });

    expect(await caller.account.landingProject()).toEqual({
      projectId: project.id,
    });
    const row = await getPrisma().user.findUniqueOrThrow({
      where: { id: user.id },
      select: { lastOpenedProjectId: true },
    });
    expect(row.lastOpenedProjectId).toBe(project.id);
  });

  it("hides projects the user is not a member of", async () => {
    const user = await makeUser("User", "lp2");
    const project = await makeProject("Foreign");
    await expect(
      callerFor(user).account.recordLastOpenedProject({
        projectId: project.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("falls back to the most recently updated membership when the stored project is soft-deleted", async () => {
    const user = await makeUser("User", "lp3");
    const older = await makeProject("Older");
    const deleted = await makeProject("Deleted");
    await addMembership(older.id, user.id, "Editor");
    await addMembership(deleted.id, user.id, "Editor");
    const caller = callerFor(user);
    await caller.account.recordLastOpenedProject({ projectId: deleted.id });
    await getPrisma().project.update({
      where: { id: deleted.id },
      data: { deletedAt: new Date() },
    });

    expect(await caller.account.landingProject()).toEqual({
      projectId: older.id,
    });
  });

  it("falls back when the user lost membership of the stored project", async () => {
    const user = await makeUser("User", "lp4");
    const kept = await makeProject("Kept");
    const lost = await makeProject("Lost");
    await addMembership(kept.id, user.id, "Viewer");
    await addMembership(lost.id, user.id, "Viewer");
    const caller = callerFor(user);
    await caller.account.recordLastOpenedProject({ projectId: lost.id });
    const { organizationId } = await getPrisma().project.findUniqueOrThrow({
      where: { id: lost.id },
      select: { organizationId: true },
    });
    await getPrisma().member.delete({
      where: { organizationId_userId: { organizationId, userId: user.id } },
    });

    expect(await caller.account.landingProject()).toEqual({
      projectId: kept.id,
    });
  });

  it("creates and returns the personal workspace for a user without projects", async () => {
    const user = await makeUser("User", "lp5");
    const first = await callerFor(user).account.landingProject();
    expect(first.projectId).toBeTruthy();
    const project = await getPrisma().project.findUniqueOrThrow({
      where: { id: first.projectId! },
    });
    expect(project.personalOwnerId).toBe(user.id);
    expect(project.name).toBe("User lp5's workspace");
    expect(await callerFor(user).account.landingProject()).toEqual(first);
  });

  it("prefers an existing membership over creating a personal workspace", async () => {
    const user = await makeUser("User", "lp6");
    const project = await makeProject("Shared");
    await addMembership(project.id, user.id, "Viewer");
    expect(await callerFor(user).account.landingProject()).toEqual({
      projectId: project.id,
    });
    expect(
      await getPrisma().project.count({ where: { personalOwnerId: user.id } }),
    ).toBe(0);
  });
});

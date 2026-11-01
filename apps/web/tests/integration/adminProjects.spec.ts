import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import {
  addMembership,
  callerFor,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
} from "./_harness";

async function addDocument(projectId: string, slug: string) {
  const now = new Date();
  await getPrisma().document.create({
    data: {
      id: randomUUID(),
      projectId,
      path: `${slug}.md`,
      slug,
      title: slug,
      excerpt: "",
      headCommitSha: "0".repeat(40),
      lastEditedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
}

async function addTable(projectId: string, slug: string) {
  const now = new Date();
  await getPrisma().dataTable.create({
    data: {
      id: randomUUID(),
      projectId,
      path: `tables/${slug}.table`,
      slug,
      title: slug,
      rowCount: 0,
      headCommitSha: "0".repeat(40),
      lastEditedAt: now,
      createdAt: now,
    },
  });
}

describe("admin project overview", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("refuses non-admins", async () => {
    const user = await makeUser("User", "ap-plain");
    const project = await makeProject("Hidden");
    await expect(callerFor(user).adminProject.list({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      callerFor(user).adminProject.get({ projectId: project.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("lists projects the admin is not a member of, with owners and counts", async () => {
    const admin = await makeUser("Admin", "ap-admin");
    const owner = await makeUser("User", "ap-owner");
    const editor = await makeUser("User", "ap-editor");
    const foreign = await makeProject("Beta");
    const mine = await makeProject("Alpha");
    await addMembership(foreign.id, owner.id, "Owner");
    await addMembership(foreign.id, editor.id, "Editor");
    await addMembership(mine.id, admin.id, "Owner");
    await addDocument(foreign.id, "one");
    await addDocument(foreign.id, "two");
    await addTable(foreign.id, "t");

    const { projects, nextCursor } = await callerFor(admin).adminProject.list(
      {},
    );

    expect(nextCursor).toBeNull();
    expect(projects.map((p) => p.name)).toEqual(["Alpha", "Beta"]);
    const beta = projects[1]!;
    expect(beta).toMatchObject({
      id: foreign.id,
      isPersonal: false,
      memberCount: 2,
      documentCount: 2,
      tableCount: 1,
      callerIsMember: false,
      owners: [{ userId: owner.id, email: owner.email, name: "User ap-owner" }],
    });
    expect(projects[0]).toMatchObject({ callerIsMember: true });
  });

  it("searches by name, pages with a cursor, and hides soft-deleted projects", async () => {
    const admin = await makeUser("Admin", "ap-pager");
    for (const name of ["Demo One", "Demo Two", "Demo Three", "Other"]) {
      await makeProject(name);
    }
    const deleted = await makeProject("Demo Gone");
    await getPrisma().project.update({
      where: { id: deleted.id },
      data: { deletedAt: new Date() },
    });
    const caller = callerFor(admin);

    const first = await caller.adminProject.list({ search: "demo", limit: 2 });
    expect(first.projects.map((p) => p.name)).toEqual([
      "Demo One",
      "Demo Three",
    ]);
    expect(first.nextCursor).not.toBeNull();

    const second = await caller.adminProject.list({
      search: "demo",
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.projects.map((p) => p.name)).toEqual(["Demo Two"]);
    expect(second.nextCursor).toBeNull();
  });

  it("returns members ordered by role and only metadata fields", async () => {
    const admin = await makeUser("Admin", "ap-detail");
    const owner = await makeUser("User", "ap-d-owner");
    const viewer = await makeUser("User", "ap-d-viewer");
    const project = await makeProject("Detail");
    await addMembership(project.id, viewer.id, "Viewer");
    await addMembership(project.id, owner.id, "Owner");
    await addDocument(project.id, "secret");

    const detail = await callerFor(admin).adminProject.get({
      projectId: project.id,
    });

    expect(detail.members.map((m) => [m.userId, m.role, m.active])).toEqual([
      [owner.id, "Owner", true],
      [viewer.id, "Viewer", true],
    ]);
    expect(detail).toMatchObject({ documentCount: 1, callerIsMember: false });
    expect(JSON.stringify(detail)).not.toContain("secret");
    expect(Object.keys(detail).sort()).toEqual([
      "callerIsMember",
      "createdAt",
      "description",
      "documentCount",
      "id",
      "isPersonal",
      "memberCount",
      "members",
      "name",
      "owners",
      "personalOwnerId",
      "tableCount",
    ]);
    expect(Object.keys(detail.members[0]!).sort()).toEqual([
      "active",
      "email",
      "name",
      "role",
      "userId",
    ]);
  });

  it("flags personal projects with their owner", async () => {
    const admin = await makeUser("Admin", "ap-personal-admin");
    const person = await makeUser("User", "ap-personal");
    const project = await makeProject("Personal");
    await getPrisma().project.update({
      where: { id: project.id },
      data: { personalOwnerId: person.id },
    });
    const caller = callerFor(admin);

    const detail = await caller.adminProject.get({ projectId: project.id });
    expect(detail).toMatchObject({
      isPersonal: true,
      personalOwnerId: person.id,
    });
    const { projects } = await caller.adminProject.list({});
    expect(projects.find((p) => p.id === project.id)).toMatchObject({
      isPersonal: true,
    });
  });

  it("reports banned members as inactive", async () => {
    const admin = await makeUser("Admin", "ap-ban-admin");
    const banned = await makeUser("User", "ap-banned");
    const project = await makeProject("Ban");
    await addMembership(project.id, banned.id, "Editor");
    await getPrisma().user.update({
      where: { id: banned.id },
      data: { banned: true },
    });

    const detail = await callerFor(admin).adminProject.get({
      projectId: project.id,
    });
    expect(detail.members).toMatchObject([
      { userId: banned.id, active: false },
    ]);
  });

  it("returns NOT_FOUND for missing and soft-deleted projects", async () => {
    const admin = await makeUser("Admin", "ap-missing");
    const project = await makeProject("Soon gone");
    await getPrisma().project.update({
      where: { id: project.id },
      data: { deletedAt: new Date() },
    });
    const caller = callerFor(admin);
    await expect(
      caller.adminProject.get({ projectId: project.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller.adminProject.get({ projectId: randomUUID() }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

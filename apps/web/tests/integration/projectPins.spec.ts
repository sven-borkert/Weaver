import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addMembership,
  callerFor,
  callerWithSecurity,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
} from "./_harness";
import {
  listProjectPinCandidates,
  pinProjectContent,
  unpinProjectContent,
} from "@weaver/core/services/dashboard/pins";
import { createCaller } from "~/server/api/root";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";

beforeEach(resetDb);

describe("ProjectContentPin storage", () => {
  it("keeps target identity unique within a project and kind", async () => {
    const db = getPrisma();
    const project = await makeProject("Pin identity");
    const resourceId = randomUUID();
    const createdAt = new Date("2026-09-09T08:00:00.000Z");

    await db.projectContentPin.create({
      data: { projectId: project.id, kind: "document", resourceId, createdAt },
    });
    await expect(
      db.projectContentPin.create({
        data: {
          projectId: project.id,
          kind: "document",
          resourceId,
          createdAt,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    await db.projectContentPin.create({
      data: { projectId: project.id, kind: "table", resourceId, createdAt },
    });
    expect(await db.projectContentPin.count()).toBe(2);
  });

  it("cascades pins with projects but preserves them when their creator is deleted", async () => {
    const db = getPrisma();
    const creator = await makeUser("User", "pin-creator");
    const keptProject = await makeProject("Creator deletion");
    const deletedProject = await makeProject("Project deletion");
    const createdAt = new Date("2026-09-09T09:00:00.000Z");
    const keptPin = await db.projectContentPin.create({
      data: {
        projectId: keptProject.id,
        kind: "document",
        resourceId: randomUUID(),
        createdById: creator.id,
        createdAt,
      },
    });
    await db.projectContentPin.create({
      data: {
        projectId: deletedProject.id,
        kind: "table",
        resourceId: randomUUID(),
        createdById: creator.id,
        createdAt,
      },
    });

    await db.project.delete({ where: { id: deletedProject.id } });
    expect(await db.projectContentPin.count()).toBe(1);
    await db.user.delete({ where: { id: creator.id } });
    expect(
      await db.projectContentPin.findUniqueOrThrow({
        where: { id: keptPin.id },
      }),
    ).toMatchObject({
      createdById: null,
    });
  });

  it("survives deletion and recreation of a content projection", async () => {
    const db = getPrisma();
    const project = await makeProject("Projection rebuild");
    const resourceId = randomUUID();
    const createdAt = new Date("2026-09-09T10:00:00.000Z");
    const projection = {
      id: resourceId,
      projectId: project.id,
      path: "docs/pinned.md",
      slug: "pinned",
      title: "Pinned",
      excerpt: "",
      headCommitSha: "a".repeat(40),
      lastEditedAt: createdAt,
      createdAt,
      updatedAt: createdAt,
    };
    await db.document.create({ data: projection });
    const pin = await db.projectContentPin.create({
      data: { projectId: project.id, kind: "document", resourceId, createdAt },
    });

    await db.document.delete({ where: { id: resourceId } });
    expect(
      await db.projectContentPin.findUnique({ where: { id: pin.id } }),
    ).not.toBeNull();
    await db.document.create({ data: projection });
    expect(
      await db.projectContentPin.findUnique({ where: { id: pin.id } }),
    ).toMatchObject({
      resourceId,
    });
  });
});

async function pinFixture(
  role: "Owner" | "Maintainer" | "Editor" | "Viewer" = "Maintainer",
) {
  const db = getPrisma();
  const user = await makeUser("User", `pin-${role}`);
  const project = await makeProject("Pin service");
  await addMembership(project.id, user.id, role);
  const resourceId = randomUUID();
  const now = new Date();
  await db.document.create({
    data: {
      id: resourceId,
      projectId: project.id,
      path: `docs/${resourceId}.md`,
      slug: resourceId,
      title: "Pinned document",
      excerpt: "",
      headCommitSha: "a".repeat(40),
      lastEditedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
  return {
    db,
    user,
    project,
    actor: securityContextFor(user),
    input: { projectId: project.id, kind: "document" as const, resourceId },
  };
}

describe("project pin mutations", () => {
  afterEach(() => setJobQueueForTests(null));

  it.each(["Owner", "Maintainer"] as const)(
    "allows %s to pin and idempotently remove content",
    async (role) => {
      const { db, actor, input, user } = await pinFixture(role);
      const first = await pinProjectContent(db, actor, input);
      expect(await pinProjectContent(db, actor, input)).toEqual(first);
      expect(
        await db.projectContentPin.findUnique({ where: { id: first.pinId } }),
      ).toMatchObject({ createdById: user.id, resourceId: input.resourceId });
      expect(
        await unpinProjectContent(db, actor, {
          projectId: input.projectId,
          pinId: first.pinId,
        }),
      ).toEqual({ removed: true });
      expect(
        await unpinProjectContent(db, actor, {
          projectId: input.projectId,
          pinId: first.pinId,
        }),
      ).toEqual({ removed: false });
      expect(
        await db.document.findUnique({ where: { id: input.resourceId } }),
      ).not.toBeNull();
    },
  );

  it.each(["Editor", "Viewer"] as const)(
    "denies %s pin management",
    async (role) => {
      const { db, actor, input } = await pinFixture(role);
      await expect(pinProjectContent(db, actor, input)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(
        unpinProjectContent(db, actor, {
          projectId: input.projectId,
          pinId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await db.projectContentPin.count()).toBe(0);
    },
  );

  it("requires session read/write capabilities and obeys project restrictions", async () => {
    const { db, actor, input } = await pinFixture();
    await expect(pinProjectContent(db, actor, input)).resolves.toHaveProperty(
      "pinId",
    );
    for (const authenticationMethod of ["apiKey", "oauth", "task"] as const) {
      await expect(
        pinProjectContent(db, { ...actor, authenticationMethod }, input),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    for (const missing of ["content:read", "content:write"] as const) {
      const capabilities = new Set(actor.capabilities);
      capabilities.delete(missing);
      await expect(
        pinProjectContent(db, { ...actor, capabilities }, input),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(
      pinProjectContent(db, { ...actor, allowedProjectIds: new Set() }, input),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("does not grant global Admins membership and rejects revoked/deleted projects", async () => {
    const { db, actor, input, user } = await pinFixture();
    const admin = securityContextFor(await makeUser("Admin", "pin-outsider"));
    await expect(pinProjectContent(db, admin, input)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await pinProjectContent(db, actor, input);
    await db.member.deleteMany({ where: { userId: user.id } });
    await expect(pinProjectContent(db, actor, input)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await addMembership(input.projectId, user.id, "Maintainer");
    await db.project.update({
      where: { id: input.projectId },
      data: { deletedAt: new Date() },
    });
    await expect(pinProjectContent(db, actor, input)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("validates same-project targets even for duplicates and isolates unpin IDs", async () => {
    const { db, actor, input, user } = await pinFixture();
    const pin = await pinProjectContent(db, actor, input);
    const otherProject = await makeProject("Other pins");
    await addMembership(otherProject.id, user.id, "Maintainer");
    await expect(
      pinProjectContent(db, actor, { ...input, projectId: otherProject.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      await unpinProjectContent(db, actor, {
        projectId: otherProject.id,
        pinId: pin.pinId,
      }),
    ).toEqual({ removed: false });
    await db.document.delete({ where: { id: input.resourceId } });
    await expect(pinProjectContent(db, actor, input)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(
      await unpinProjectContent(db, actor, {
        projectId: input.projectId,
        pinId: pin.pinId,
      }),
    ).toEqual({ removed: true });
  });

  it("serializes concurrent distinct additions and accepts duplicate pins at capacity", async () => {
    const { db, actor, input } = await pinFixture();
    const now = new Date();
    await db.projectContentPin.createMany({
      data: Array.from({ length: 11 }, () => ({
        projectId: input.projectId,
        kind: "document",
        resourceId: randomUUID(),
        createdAt: now,
      })),
    });
    const second = await db.document.create({
      data: {
        id: randomUUID(),
        projectId: input.projectId,
        path: "docs/second.md",
        slug: "second",
        title: "Second",
        excerpt: "",
        headCommitSha: "b".repeat(40),
        lastEditedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
    const outcomes = await Promise.allSettled([
      pinProjectContent(db, actor, input),
      pinProjectContent(db, actor, { ...input, resourceId: second.id }),
    ]);
    expect(outcomes.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((x) => x.status === "rejected")).toMatchObject({
      reason: {
        code: "PRECONDITION_FAILED",
        message: "A project can pin up to 12 items.",
      },
    });
    expect(
      await db.projectContentPin.count({
        where: { projectId: input.projectId },
      }),
    ).toBe(12);
    const kept = await db.projectContentPin.findFirstOrThrow({
      where: {
        projectId: input.projectId,
        resourceId: { in: [input.resourceId, second.id] },
      },
    });
    expect(
      await pinProjectContent(db, actor, {
        ...input,
        resourceId: kept.resourceId,
      }),
    ).toEqual({ pinId: kept.id });
  });

  it("coalesces concurrent duplicate additions", async () => {
    const { db, actor, input } = await pinFixture();
    const pins = await Promise.all([
      pinProjectContent(db, actor, input),
      pinProjectContent(db, actor, input),
    ]);
    expect(pins[0]).toEqual(pins[1]);
    expect(await db.projectContentPin.count()).toBe(1);
  });

  it("preserves a table pin through a real Git-backed rebuild", async () => {
    const { db, actor, input, user } = await pinFixture();
    setJobQueueForTests(new FakeJobQueue());
    const caller = callerFor(user);
    const table = await caller.table.create({
      projectId: input.projectId,
      folderPath: [],
      title: "Pinned table",
    });
    const pin = await pinProjectContent(db, actor, {
      ...input,
      kind: "table",
      resourceId: table.id,
    });
    const contents = await caller.table.get({
      projectId: input.projectId,
      tableId: table.id,
    });
    await caller.table.save({
      projectId: input.projectId,
      tableId: table.id,
      baseCommitSha: contents.baseCommitSha,
      title: "Renamed pinned table",
      columns: contents.columns,
      rows: contents.rows,
    });
    await caller.tableFolder.create({
      projectId: input.projectId,
      parentPath: [],
      name: "Reports",
    });
    await caller.table.move({
      projectId: input.projectId,
      tableId: table.id,
      folderPath: ["reports"],
    });
    await caller.table.rebuildIndex({ projectId: input.projectId });
    expect(
      await db.projectContentPin.findUnique({ where: { id: pin.pinId } }),
    ).toMatchObject({ resourceId: table.id, kind: "table" });
    expect(
      await caller.table.get({ projectId: input.projectId, tableId: table.id }),
    ).toMatchObject({ title: "Renamed pinned table" });
    expect(
      (await caller.dashboard.projectOverview({ projectId: input.projectId }))
        .pins,
    ).toContainEqual(
      expect.objectContaining({
        pinId: pin.pinId,
        available: true,
        content: expect.objectContaining({
          id: table.id,
          title: "Renamed pinned table",
        }),
      }),
    );
  });
});

describe("project pin candidates", () => {
  it("searches literal title characters within the project and caps recent results", async () => {
    const { db, actor, input } = await pinFixture();
    const now = new Date();
    const titles = [
      "100% done",
      "underscore_name",
      "back\\slash",
      "100X done",
      "underscoreXname",
      "backslash",
    ];
    await db.document.createMany({
      data: titles.map((title) => {
        const id = randomUUID();
        return {
          id,
          projectId: input.projectId,
          path: `docs/${id}.md`,
          slug: id,
          title,
          excerpt: "",
          headCommitSha: "a".repeat(40),
          lastEditedAt: now,
          createdAt: now,
          updatedAt: now,
        };
      }),
    });
    for (const [search, expected] of [
      ["%", "100% done"],
      ["_", "underscore_name"],
      ["\\", "back\\slash"],
    ]) {
      expect(
        (
          await listProjectPinCandidates(db, actor, {
            projectId: input.projectId,
            search,
          })
        ).items.map((x) => x.title),
      ).toEqual([expected]);
    }
    const foreign = await makeProject("Foreign candidates");
    await db.document.create({
      data: {
        id: randomUUID(),
        projectId: foreign.id,
        path: "docs/foreign.md",
        slug: "foreign",
        title: "Secret foreign candidate",
        excerpt: "",
        headCommitSha: "a".repeat(40),
        lastEditedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
    await db.dataTable.createMany({
      data: Array.from({ length: 25 }, (_, n) => {
        const id = randomUUID();
        return {
          id,
          projectId: input.projectId,
          path: `tables/${id}`,
          slug: id,
          title: `Candidate table ${n}`,
          rowCount: 0,
          headCommitSha: "b".repeat(40),
          lastEditedAt: now,
          createdAt: now,
        };
      }),
    });
    const candidates = await listProjectPinCandidates(db, actor, {
      projectId: input.projectId,
      kind: "table",
    });
    expect(candidates.items).toHaveLength(20);
    expect(
      candidates.items.every(
        (x) => x.kind === "table" && x.projectId === input.projectId,
      ),
    ).toBe(true);
    expect(
      JSON.stringify(
        await listProjectPinCandidates(db, actor, {
          projectId: input.projectId,
        }),
      ),
    ).not.toContain("Secret foreign candidate");
  });

  it("requires curator role and write capability even though candidates are a read", async () => {
    const { db, actor, input, user } = await pinFixture();
    expect(
      (
        await listProjectPinCandidates(db, actor, {
          projectId: input.projectId,
        })
      ).items,
    ).toHaveLength(1);
    await expect(
      listProjectPinCandidates(
        db,
        { ...actor, capabilities: new Set(["content:read"]) },
        { projectId: input.projectId },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db.member.updateMany({
      where: { userId: user.id },
      data: { role: "editor" },
    });
    await expect(
      listProjectPinCandidates(db, actor, { projectId: input.projectId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      listProjectPinCandidates(
        db,
        { ...actor, authenticationMethod: "apiKey" },
        { projectId: input.projectId },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("dashboard API", () => {
  it("rejects anonymous requests before exposing dashboard data", async () => {
    const caller = createCaller({
      db: getPrisma(),
      security: null,
      auth: { session: null },
      headers: new Headers(),
    } as never);
    await expect(caller.dashboard.recentContent({})).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      caller.dashboard.pin({
        projectId: randomUUID(),
        kind: "document",
        resourceId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
  it("exposes pin operations and keeps read-only project overview usable", async () => {
    const { db, actor, user, input } = await pinFixture();
    const caller = callerFor(user);
    const pin = await caller.dashboard.pin(input);
    const overview = await caller.dashboard.projectOverview({
      projectId: input.projectId,
    });
    expect(overview.canManagePins).toBe(true);
    expect(overview.pins).toContainEqual(
      expect.objectContaining({ pinId: pin.pinId, available: true }),
    );
    expect(
      (await caller.dashboard.pinCandidates({ projectId: input.projectId }))
        .items,
    ).toHaveLength(1);
    const reader = callerWithSecurity(user, {
      ...actor,
      capabilities: new Set(["content:read"]),
    });
    expect(
      await reader.dashboard.projectOverview({ projectId: input.projectId }),
    ).toMatchObject({
      canManagePins: false,
      pinCapacity: null,
      workAudience: "projects",
    });
    expect(
      (await reader.dashboard.recentContent({ projectId: input.projectId }))
        .items,
    ).toHaveLength(1);
    expect(
      await reader.dashboard.activity({ projectId: input.projectId }),
    ).toHaveProperty("items");
    expect(await reader.dashboard.reports()).toMatchObject({ items: [] });
    await expect(
      reader.dashboard.pinCandidates({ projectId: input.projectId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      reader.dashboard.unpin({ projectId: input.projectId, pinId: pin.pinId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      await caller.dashboard.unpin({
        projectId: input.projectId,
        pinId: pin.pinId,
      }),
    ).toEqual({ removed: true });
    expect(await db.projectContentPin.count()).toBe(0);
  });

  it.each(["apiKey", "oauth", "task"] as const)(
    "refuses all dashboard endpoints to %s credentials",
    async (authenticationMethod) => {
      const { actor, user, input } = await pinFixture();
      const caller = callerWithSecurity(user, {
        ...actor,
        authenticationMethod,
      });
      const requests = [
        () => caller.dashboard.recentContent({}),
        () => caller.dashboard.activity({}),
        () => caller.dashboard.reports(),
        () => caller.dashboard.projectOverview({ projectId: input.projectId }),
        () => caller.dashboard.pinCandidates({ projectId: input.projectId }),
        () => caller.dashboard.pin(input),
        () =>
          caller.dashboard.unpin({
            projectId: input.projectId,
            pinId: randomUUID(),
          }),
      ];
      for (const request of requests)
        await expect(request()).rejects.toMatchObject({ code: "FORBIDDEN" });
    },
  );
});

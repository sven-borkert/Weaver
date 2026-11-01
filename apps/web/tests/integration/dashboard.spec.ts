import { recentContentPageSql } from "@weaver/core/services/dashboard/content";
import { visibleProjectsSql } from "@weaver/core/services/backgroundWork/access";
import { Prisma } from "@weaver/db/client";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  encodeActivityCursor,
  activityFilterIdentity,
} from "../../../../packages/core/src/services/dashboard/cursor";
import {
  getRecentContent,
  listDashboardActivity,
  getReportShortcuts,
  getProjectOverview,
} from "@weaver/core/services/dashboard";
import {
  getPrisma,
  makeUser,
  makeProject,
  addMembership,
  resetDb,
  securityContextFor,
} from "./_harness";
import {
  createTaskRun,
  createImport,
  createAssistantRun,
  createKnowledge,
  removeMembership,
} from "./_dashboardFixtures";
const DAY = 86400000;
async function fixture() {
  const owner = await makeUser("User", "dashboard-owner");
  const maintainer = await makeUser("User", "dashboard-maintainer");
  const editor = await makeUser("User", "dashboard-editor");
  const viewer = await makeUser("User", "dashboard-viewer");
  const outsider = await makeUser("Admin", "dashboard-admin");
  const project = await makeProject("Dashboard");
  const second = await makeProject("Second");
  for (const [u, role] of [
    [owner, "Owner"],
    [maintainer, "Maintainer"],
    [editor, "Editor"],
    [viewer, "Viewer"],
  ] as const)
    await addMembership(project.id, u.id, role);
  await addMembership(second.id, owner.id, "Owner");
  return {
    owner,
    maintainer,
    editor,
    viewer,
    outsider,
    project,
    second,
    actor: securityContextFor(owner),
  };
}
async function content(
  projectId: string,
  editorId: string | null,
  kind: "document" | "table" = "document",
  at = new Date(Date.now() - 1000),
  id: string = randomUUID(),
) {
  const data = {
    id,
    projectId,
    path: id,
    slug: id,
    title: `Title ${id}`,
    headCommitSha: "head",
    lastEditedById: editorId,
    lastEditedAt: at,
    createdAt: at,
  };
  return kind === "document"
    ? getPrisma().document.create({
        data: { ...data, excerpt: "private body", updatedAt: at },
      })
    : getPrisma().dataTable.create({ data: { ...data, rowCount: 0 } });
}
describe("dashboard read model", () => {
  beforeEach(resetDb);
  it("authorizes before recent limits, returns current projections and safe attribution", async () => {
    const f = await fixture();
    const foreign = await makeProject("Foreign");
    for (let i = 0; i < 10; i++)
      await content(foreign.id, f.owner.id, "document", new Date());
    const doc = await content(f.project.id, f.editor.id);
    await content(f.project.id, null, "table");
    for (const user of [f.owner, f.maintainer, f.editor, f.viewer]) {
      const page = await getRecentContent(
        getPrisma(),
        securityContextFor(user),
        { limit: 2 },
      );
      expect(page.items).toHaveLength(2);
      expect(page.items.every((x) => x.projectId === f.project.id)).toBe(true);
      expect(page.items.find((x) => x.kind === "table")).toMatchObject({
        editorName: null,
        isOwnChange: false,
      });
      expect(JSON.stringify(page)).not.toMatch(
        /private body|@test.local|excerpt|lastEditedById/,
      );
    }
    expect(
      (await listDashboardActivity(getPrisma(), f.actor, { limit: 1 })).items[0]
        ?.projectId,
    ).toBe(f.project.id);
    await getPrisma().document.update({
      where: { id: doc.id },
      data: { title: "Revised", lastEditedAt: new Date() },
    });
    const after = await listDashboardActivity(getPrisma(), f.actor, {
      view: "all",
    });
    expect(after.items.filter((x) => x.id === doc.id)).toHaveLength(1);
    expect(after.items.find((x) => x.id === doc.id)?.title).toBe("Revised");
    expect(
      (
        await listDashboardActivity(getPrisma(), f.actor, { view: "others" })
      ).items.map((x) => x.id),
    ).toEqual([doc.id]);
  });
  it("enforces session capabilities, restrictions, live membership and deleted projects", async () => {
    const f = await fixture();
    await content(f.project.id, f.owner.id);
    expect(
      (await getRecentContent(getPrisma(), securityContextFor(f.outsider), {}))
        .items,
    ).toEqual([]);
    const calls = (actor: typeof f.actor) => [
      () => getRecentContent(getPrisma(), actor, {}),
      () => listDashboardActivity(getPrisma(), actor, {}),
      () => getReportShortcuts(getPrisma(), actor),
      () => getProjectOverview(getPrisma(), actor, { projectId: f.project.id }),
    ];
    for (const method of ["apiKey", "oauth", "task"] as const)
      for (const call of calls({ ...f.actor, authenticationMethod: method }))
        await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
    for (const call of calls({ ...f.actor, capabilities: new Set() }))
      await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
    const restricted = {
      ...f.actor,
      allowedProjectIds: new Set([f.second.id]),
    };
    expect((await getRecentContent(getPrisma(), restricted, {})).items).toEqual(
      [],
    );
    await expect(
      getRecentContent(getPrisma(), restricted, { projectId: f.project.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await removeMembership(f.project.id, f.owner.id);
    await expect(
      getProjectOverview(getPrisma(), f.actor, { projectId: f.project.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await getPrisma().project.update({
      where: { id: f.project.id },
      data: { deletedAt: new Date() },
    });
    await expect(
      listDashboardActivity(getPrisma(), securityContextFor(f.viewer), {
        projectId: f.project.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("uses project work only for Maintainers and keeps assistants private across every scope", async () => {
    const f = await fixture();
    const run = await createTaskRun({
      owner: f.owner,
      projectId: f.project.id,
      name: "Shared",
    });
    const assistant = await createAssistantRun({
      owner: f.owner,
      projectIds: [f.project.id, f.second.id],
      scopeSnapshot: {
        kind: "all",
        projectIds: [f.project.id, f.second.id],
        documentId: null,
        tableId: null,
        resolvedAt: new Date().toISOString(),
        truncated: false,
      },
    });
    expect(
      (
        await listDashboardActivity(getPrisma(), f.actor, {
          projectId: f.project.id,
          view: "results",
        })
      ).items.map((x) => x.id),
    ).toContain(assistant.id);
    for (const user of [f.editor, f.viewer])
      expect(
        (
          await listDashboardActivity(getPrisma(), securityContextFor(user), {
            projectId: f.project.id,
          })
        ).items,
      ).toEqual([]);
    expect(
      (
        await listDashboardActivity(
          getPrisma(),
          securityContextFor(f.maintainer),
          { projectId: f.project.id, audience: "projects" },
        )
      ).items.map((x) => x.id),
    ).toEqual([run.id]);
    expect(
      (
        await listDashboardActivity(
          getPrisma(),
          securityContextFor(f.maintainer),
          {},
        )
      ).items,
    ).toEqual([]);
    await removeMembership(f.second.id, f.owner.id);
    expect(
      (
        await listDashboardActivity(getPrisma(), f.actor, {
          projectId: f.project.id,
        })
      ).items.map((x) => x.id),
    ).not.toContain(assistant.id);
  });
  it("keeps Home project filters personal and requires explicit authorized shared audiences", async () => {
    const f = await fixture();
    const db = getPrisma();
    const actor = securityContextFor(f.maintainer);
    const own = await createTaskRun({
      owner: f.maintainer,
      projectId: f.project.id,
      name: "Mine",
    });
    const other = await createTaskRun({
      owner: f.owner,
      projectId: f.project.id,
      name: "Another owner",
    });
    const home = await listDashboardActivity(db, actor, {
      projectId: f.project.id,
      view: "results",
    });
    expect(home.items.map((x) => x.id)).toEqual([own.id]);
    const shared = await listDashboardActivity(db, actor, {
      projectId: f.project.id,
      audience: "projects",
      view: "results",
    });
    expect(new Set(shared.items.map((x) => x.id))).toEqual(
      new Set([own.id, other.id]),
    );
    for (const user of [f.viewer, f.editor])
      await expect(
        listDashboardActivity(db, securityContextFor(user), {
          projectId: f.project.id,
          audience: "projects",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      listDashboardActivity(db, actor, { audience: "projects" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const readonly = {
      ...actor,
      capabilities: new Set(["content:read"] as const),
    };
    expect(
      (
        await listDashboardActivity(db, readonly, {
          projectId: f.project.id,
          audience: "projects",
        })
      ).items,
    ).toHaveLength(2);
    const page = await listDashboardActivity(db, actor, {
      projectId: f.project.id,
      audience: "projects",
      limit: 1,
    });
    await expect(
      listDashboardActivity(db, actor, {
        projectId: f.project.id,
        audience: "mine",
        cursor: page.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("deduplicates eligible matching report commits before paging, preserving other and later edits", async () => {
    const f = await fixture();
    const doc = await content(f.project.id, f.editor.id);
    const run = await createTaskRun({
      owner: f.owner,
      projectId: f.project.id,
      name: "Report",
      at: new Date(Date.now() - 2000),
    });
    await getPrisma().scheduledTaskRun.update({
      where: { id: run.id },
      data: { outputDocumentId: doc.id, outputCommitSha: "head" },
    });
    const first = await listDashboardActivity(getPrisma(), f.actor, {
      limit: 1,
    });
    expect(first.items.map((x) => x.id)).toEqual([run.id]);
    expect(first.nextCursor).toBeNull();
    expect(first.items[0]?.currentReport).toMatchObject({ documentId: doc.id });
    expect(
      (
        await listDashboardActivity(getPrisma(), f.actor, { view: "others" })
      ).items.map((x) => x.id),
    ).toEqual([doc.id]);
    await getPrisma().document.update({
      where: { id: doc.id },
      data: { headCommitSha: "human" },
    });
    expect(
      (await listDashboardActivity(getPrisma(), f.actor, {})).items,
    ).toHaveLength(2);
    await getPrisma().scheduledTaskRun.update({
      where: { id: run.id },
      data: {
        outputCommitSha: "human",
        finishedAt: new Date(Date.now() - 8 * DAY),
      },
    });
    expect(
      (await listDashboardActivity(getPrisma(), f.actor, {})).items.map(
        (x) => x.id,
      ),
    ).toEqual([doc.id]);
  });
  it("traverses six equal-time sources without skips, retains windows and leaves receipts unchanged", async () => {
    const f = await fixture();
    const at = new Date(Date.now() - 1000);
    await content(f.project.id, f.owner.id, "document", at);
    await content(f.project.id, f.owner.id, "table", at);
    const run = await createTaskRun({
      owner: f.owner,
      projectId: f.project.id,
      name: "Task",
      at,
    });
    await createImport({
      owner: f.owner,
      projectId: f.project.id,
      name: "Import",
      at,
    });
    await createAssistantRun({
      owner: f.owner,
      projectIds: [f.project.id],
      at,
    });
    await createKnowledge({ projectId: f.project.id, status: "active", at });
    await getPrisma().scheduledTaskRun.update({
      where: { id: run.id },
      data: { queuedAt: new Date(Date.now() - 60 * DAY) },
    });
    const before = await getPrisma().backgroundWorkReceipt.findMany();
    const ids: string[] = [];
    let cursor: string | undefined;
    let observed: string | undefined;
    do {
      const page = await listDashboardActivity(getPrisma(), f.actor, {
        projectId: f.project.id,
        audience: "projects",
        limit: 1,
        cursor,
      });
      observed ??= page.observedAt;
      expect(page.observedAt).toBe(observed);
      ids.push(...page.items.map((x) => x.source));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toEqual([
      "task",
      "table",
      "knowledge",
      "import",
      "document",
      "assistant",
    ]);
    await getRecentContent(getPrisma(), f.actor, {});
    await getReportShortcuts(getPrisma(), f.actor);
    await getProjectOverview(getPrisma(), f.actor, { projectId: f.project.id });
    expect(await getPrisma().backgroundWorkReceipt.findMany()).toEqual(before);
  });
  it("applies exact content/result window boundaries and excludes future updates", async () => {
    const f = await fixture();
    const asOf = new Date(Date.now() - 1000);
    const contentStart = new Date(asOf.getTime() - 30 * DAY);
    const workStart = new Date(asOf.getTime() - 7 * DAY);
    const included = await content(
      f.project.id,
      f.owner.id,
      "document",
      contentStart,
    );
    await content(
      f.project.id,
      f.owner.id,
      "table",
      new Date(contentStart.getTime() - 1),
    );
    await content(
      f.project.id,
      f.owner.id,
      "document",
      new Date(asOf.getTime() + 1),
    );
    const run = await createTaskRun({
      owner: f.owner,
      projectId: f.project.id,
      name: "Boundary",
      at: workStart,
    });
    await createTaskRun({
      owner: f.owner,
      projectId: f.project.id,
      name: "Expired",
      at: new Date(workStart.getTime() - 1),
    });
    const cursor = encodeActivityCursor({
      version: 1,
      actorId: f.owner.id,
      filters: activityFilterIdentity({}),
      asOf: asOf.toISOString(),
      contentWindowStart: contentStart.toISOString(),
      workWindowStart: workStart.toISOString(),
      last: {
        sortAt: asOf.toISOString(),
        source: "task",
        id: "ffffffff-ffff-4fff-bfff-ffffffffffff",
      },
    });
    expect(
      (await listDashboardActivity(getPrisma(), f.actor, { cursor })).items.map(
        (x) => x.id,
      ),
    ).toEqual([run.id, included.id]);
    expect(
      (await getRecentContent(getPrisma(), f.actor, {})).items,
    ).toHaveLength(3);
  });
  it("rechecks SQL role and membership after preliminary project resolution", async () => {
    const f = await fixture();
    const db = getPrisma();
    await createTaskRun({
      owner: f.owner,
      projectId: f.project.id,
      name: "Private to members",
    });
    const project = await db.project.findUniqueOrThrow({
      where: { id: f.project.id },
      select: { organizationId: true },
    });
    const proxy = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "$queryRaw")
          return async (query: Prisma.Sql) => {
            await db.member.updateMany({
              where: {
                userId: f.maintainer.id,
                organizationId: project.organizationId,
              },
              data: { role: "viewer" },
            });
            return db.$queryRaw(query);
          };
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    expect(
      (
        await listDashboardActivity(proxy, securityContextFor(f.maintainer), {
          projectId: f.project.id,
          audience: "projects",
        })
      ).items,
    ).toEqual([]);
    const removed = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "$queryRaw")
          return async (query: Prisma.Sql) => {
            await removeMembership(f.project.id, f.owner.id);
            return db.$queryRaw(query);
          };
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    await expect(
      getProjectOverview(removed, f.actor, { projectId: f.project.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("uses UUID ordering within a source and allows page-size changes", async () => {
    const f = await fixture();
    const at = new Date(Date.now() - 1000);
    const ids = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
    ];
    for (const id of ids)
      await content(f.project.id, f.owner.id, "document", at, id);
    const first = await listDashboardActivity(getPrisma(), f.actor, {
      limit: 1,
    });
    expect(first.items[0]?.id).toBe(ids[2]);
    const second = await listDashboardActivity(getPrisma(), f.actor, {
      limit: 20,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((x) => x.id)).toEqual([ids[1], ids[0]]);
    expect(second.nextCursor).toBeNull();
  });
  it("saturates counts with populated indexed projection reads", async () => {
    const f = await fixture();
    const db = getPrisma();
    await db.$executeRaw(
      Prisma.sql`INSERT INTO "Document" (id,"projectId",path,slug,title,excerpt,"headCommitSha","lastEditedAt","createdAt","updatedAt") SELECT gen_random_uuid(),${f.project.id}::uuid,i::text,i::text,'Indexed '||i,'','head',timezone('UTC',now())-i*interval '1 second',timezone('UTC',now()),timezone('UTC',now()) FROM generate_series(1,10001) i`,
    );
    await db.$executeRaw(
      Prisma.sql`INSERT INTO "DataTable" (id,"projectId",path,slug,title,"rowCount","headCommitSha","lastEditedAt","createdAt") SELECT gen_random_uuid(),${f.project.id}::uuid,i::text,i::text,'Indexed '||i,0,'head',timezone('UTC',now())-i*interval '1 second',timezone('UTC',now()) FROM generate_series(1,10001) i`,
    );
    await db.$executeRaw(Prisma.sql`ANALYZE "Document"`);
    await db.$executeRaw(Prisma.sql`ANALYZE "DataTable"`);
    const recentPlan = await db.$queryRaw(
      Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) WITH visible_projects AS (${visibleProjectsSql({ actor: f.actor, audience: "mine" })}) ${recentContentPageSql({ actor: f.actor, projectId: f.project.id, workAudience: "projects" }, 21)}`,
    );
    console.info(
      "Dashboard authorized recent EXPLAIN",
      JSON.stringify(recentPlan),
    );
    await db.$executeRaw(
      Prisma.sql`INSERT INTO "ScheduledTask" (id,"ownerId",name,instruction,"scopeRequest","scopeSnapshot","outputProjectId","outputFolderPath",schedule,timezone,cron,"createdAt","updatedAt","lastRunAt") SELECT gen_random_uuid(),CASE WHEN i%100=0 THEN ${f.owner.id}::uuid ELSE ${f.editor.id}::uuid END,'Measured '||i,'','{}'::jsonb,'{}'::jsonb,${f.project.id}::uuid,ARRAY[]::text[],'{}'::jsonb,'UTC','0 7 * * *',timezone('UTC',now()),timezone('UTC',now()),timezone('UTC',now())-i*interval '1 second' FROM generate_series(1,2500) i`,
    );
    await db.$executeRaw(Prisma.sql`ANALYZE "ScheduledTask"`);
    expect((await getReportShortcuts(db, f.actor)).items).toHaveLength(5);
    const taskPlan = await db.$queryRaw(
      Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) WITH visible_projects AS (${visibleProjectsSql({ actor: f.actor, audience: "mine" })}) SELECT t.id,t.name FROM "ScheduledTask" t JOIN visible_projects p ON p.id=t."outputProjectId" WHERE t."ownerId"=${f.owner.id}::uuid ORDER BY t."lastRunAt" DESC NULLS LAST,t."createdAt" DESC,t.id DESC LIMIT 5`,
    );
    console.info("Dashboard report EXPLAIN", JSON.stringify(taskPlan));
    const snapshot = await getProjectOverview(db, f.actor, {
      projectId: f.project.id,
    });
    expect(snapshot.counts).toEqual({
      documents: { value: 10000, capped: true },
      tables: { value: 10000, capped: true },
    });
    expect((await getRecentContent(db, f.actor, {})).items).toHaveLength(8);
    for (const table of [Prisma.sql`"Document"`, Prisma.sql`"DataTable"`]) {
      const plan = await db.$queryRaw(
        Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id,title FROM ${table} WHERE "projectId"=${f.project.id}::uuid AND "lastEditedAt">=timezone('UTC',now())-interval '30 days' ORDER BY "lastEditedAt" DESC,id DESC LIMIT 21`,
      );
      console.info("Dashboard projection EXPLAIN", JSON.stringify(plan));
      expect(JSON.stringify(plan)).toContain("projectId_lastEditedAt_id_idx");
    }
  });
  it("filters report shortcuts by project before limiting and authorizes the project", async () => {
    const f = await fixture();
    const older = await createTaskRun({
      owner: f.owner,
      projectId: f.project.id,
      name: "Older report",
    });
    await getPrisma().scheduledTask.update({
      where: { id: older.taskId },
      data: { createdAt: new Date(Date.now() - DAY) },
    });
    for (let i = 0; i < 6; i++)
      await createTaskRun({
        owner: f.owner,
        projectId: f.second.id,
        name: `Newer ${i}`,
      });
    const scoped = await getReportShortcuts(getPrisma(), f.actor, {
      projectId: f.project.id,
    });
    expect(scoped.items.map((item) => item.taskId)).toEqual([older.taskId]);
    // Without a project the global top five crowd the older task out.
    const global = await getReportShortcuts(getPrisma(), f.actor);
    expect(global.items).toHaveLength(5);
    expect(global.items.map((item) => item.taskId)).not.toContain(older.taskId);
    expect(global.items.every((item) => item.projectId === f.second.id)).toBe(
      true,
    );
    const outsider = securityContextFor(f.outsider);
    const overviewError = await getProjectOverview(getPrisma(), outsider, {
      projectId: f.project.id,
    }).catch((error: unknown) => error);
    expect(overviewError).toMatchObject({ code: "NOT_FOUND" });
    await expect(
      getReportShortcuts(getPrisma(), outsider, { projectId: f.project.id }),
    ).rejects.toMatchObject({
      code: (overviewError as { code: string }).code,
    });
    await expect(
      getReportShortcuts(getPrisma(), f.actor, { projectId: "nope" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("bounds shortcuts and snapshots, scopes pin identities and hides unavailable slots from readers", async () => {
    const f = await fixture();
    const doc = await content(f.project.id, f.owner.id);
    const foreign = await content(f.second.id, f.owner.id);
    await getPrisma().projectContentPin.createMany({
      data: [
        {
          projectId: f.project.id,
          kind: "document",
          resourceId: doc.id,
          createdAt: new Date(),
        },
        {
          projectId: f.project.id,
          kind: "document",
          resourceId: foreign.id,
          createdAt: new Date(),
        },
      ],
    });
    for (let i = 0; i < 7; i++)
      await createTaskRun({
        owner: f.owner,
        projectId: f.project.id,
        name: `Report ${i}`,
      });
    const hiddenProject = await makeProject("Hidden reports");
    for (let i = 0; i < 6; i++)
      await createTaskRun({
        owner: f.owner,
        projectId: hiddenProject.id,
        name: "Hidden",
      });
    const latest = await getPrisma().scheduledTask.findFirstOrThrow({
      where: { outputProjectId: f.project.id },
      orderBy: { createdAt: "desc" },
    });
    await getPrisma().scheduledTask.update({
      where: { id: latest.id },
      data: {
        lastRunAt: new Date(),
        status: "paused",
        lastRunStatus: "succeeded",
        outputDocumentId: doc.id,
      },
    });
    const shortcuts = await getReportShortcuts(getPrisma(), f.actor);
    expect(shortcuts.items[0]).toMatchObject({
      taskId: latest.id,
      status: "paused",
      lastRunStatus: "succeeded",
      currentReport: { documentId: doc.id },
    });
    await getPrisma().scheduledTask.update({
      where: { id: latest.id },
      data: { outputDocumentId: foreign.id },
    });
    expect(
      (await getReportShortcuts(getPrisma(), f.actor)).items[0]?.currentReport,
    ).toBeNull();
    expect(shortcuts.items).toHaveLength(5);
    expect(JSON.stringify(shortcuts)).not.toMatch(
      /instruction|scopeSnapshot|scopeRequest/,
    );
    const owner = await getProjectOverview(getPrisma(), f.actor, {
      projectId: f.project.id,
    });
    expect(owner).toMatchObject({
      counts: {
        documents: { value: 1, capped: false },
        tables: { value: 0, capped: false },
      },
      canManagePins: true,
      pinCapacity: { used: 2, limit: 12 },
      workAudience: "projects",
    });
    expect(owner.pins).toHaveLength(2);
    const readonly = {
      ...securityContextFor(f.maintainer),
      capabilities: new Set(["content:read"] as const),
    };
    const reader = await getProjectOverview(getPrisma(), readonly, {
      projectId: f.project.id,
    });
    expect(reader).toMatchObject({
      canManagePins: false,
      pinCapacity: null,
      workAudience: "projects",
    });
    expect(reader.pins).toHaveLength(1);
  });
});

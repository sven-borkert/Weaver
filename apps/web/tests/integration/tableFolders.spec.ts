import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addMembership,
  callerFor,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
} from "./_harness";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import { openProjectRepo } from "@weaver/git-store";

async function setup(suffix: string) {
  const owner = await makeUser("User", `tf-owner-${suffix}`);
  const project = await makeProject(`TF-${suffix}`);
  await addMembership(project.id, owner.id, "Owner");
  return { project, caller: callerFor(owner) };
}

let knowledgeQueue: FakeJobQueue;

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("WEAVER_JOBS_ENABLED", "true");
  knowledgeQueue = new FakeJobQueue();
  setJobQueueForTests(knowledgeQueue);
});

afterEach(() => {
  setJobQueueForTests(null);
  vi.unstubAllEnvs();
});

describe("tableFolder router", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("creates, renames, moves, and deletes folders under tables/", async () => {
    const { project, caller } = await setup("1");
    const created = await caller.tableFolder.create({
      projectId: project.id,
      parentPath: [],
      name: "Finance",
    });
    expect(created.path).toEqual(["finance"]);

    const tree = await caller.tableFolder.tree({ projectId: project.id });
    expect(tree.folders).toEqual(["finance"]);
    expect(tree.folderNames).toEqual({ finance: "Finance" });
    expect(tree.tables).toEqual([]);

    await caller.tableFolder.create({
      projectId: project.id,
      parentPath: ["finance"],
      name: "2026",
    });
    await caller.tableFolder.rename({
      projectId: project.id,
      path: ["finance", "2026"],
      name: "2027",
    });
    await caller.tableFolder.move({
      projectId: project.id,
      path: ["finance", "2027"],
      newParentPath: [],
    });
    const after = await caller.tableFolder.tree({ projectId: project.id });
    expect(after.folders.sort()).toEqual(["2027", "finance"]);
    expect(after.folderNames).toEqual({ "2027": "2027", finance: "Finance" });

    await caller.tableFolder.delete({
      projectId: project.id,
      path: ["2027"],
    });
    expect(
      (await caller.tableFolder.tree({ projectId: project.id })).folders,
    ).toEqual(["finance"]);
  });

  it("returns row count and editor per table leaf", async () => {
    const owner = await makeUser("User", "row-count");
    const project = await makeProject("TF-row-count");
    await addMembership(project.id, owner.id, "Owner");
    const caller = callerFor(owner);
    const created = await caller.table.create({
      projectId: project.id,
      folderPath: [],
      title: "Budget",
      columns: [{ id: randomUUID(), name: "Name", type: "text" as const }],
      rows: [
        { id: randomUUID(), cells: {} },
        { id: randomUUID(), cells: {} },
      ],
    });
    const tree = await caller.tableFolder.tree({ projectId: project.id });
    const leaf = tree.tables.find((table) => table.id === created.id);
    expect(leaf).toMatchObject({
      rowCount: 2,
      lastEditedBy: { id: owner.id, email: owner.email },
    });
    expect(leaf?.lastEditedAt).toBeInstanceOf(Date);
  });

  it("hides table leaves and rewrites their projections when renaming a parent", async () => {
    const { project, caller } = await setup("table-leaf");
    await caller.tableFolder.create({
      projectId: project.id,
      parentPath: [],
      name: "Finance",
    });
    const table = await caller.table.create({
      projectId: project.id,
      folderPath: ["finance"],
      title: "Budget",
      columns: [{ id: randomUUID(), name: "Amount", type: "number" as const }],
      rows: [],
    });
    const forecast = await caller.table.create({
      projectId: project.id,
      folderPath: ["finance"],
      title: "Forecast",
      columns: [{ id: randomUUID(), name: "Quarter", type: "text" as const }],
      rows: [],
    });

    const before = await caller.tableFolder.tree({ projectId: project.id });
    expect(before.folders).toEqual(["finance"]);
    expect(before.tables).toContainEqual(
      expect.objectContaining({
        id: table.id,
        path: "tables/finance/budget.table",
      }),
    );
    knowledgeQueue.jobs.length = 0;

    await caller.tableFolder.rename({
      projectId: project.id,
      path: ["finance"],
      name: "Operations",
    });
    const repo = (await openProjectRepo(project.id))!;
    const moveSha = await repo.resolveHead();

    expect(knowledgeQueue.jobs).toEqual(
      [
        { id: table.id, path: "tables/operations/budget.table" },
        { id: forecast.id, path: "tables/operations/forecast.table" },
      ]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(({ id, path }) => ({
          name: "table.search-sync" as const,
          data: {
            projectId: project.id,
            tableId: id,
            sourceCommitSha: moveSha,
            pathAtSha: path,
          },
        })),
    );

    const after = await caller.tableFolder.tree({ projectId: project.id });
    expect(after.folders).toEqual(["operations"]);
    expect(after.tables).toContainEqual(
      expect.objectContaining({
        id: table.id,
        path: "tables/operations/budget.table",
      }),
    );
    const moved = await getPrisma().dataTable.findUniqueOrThrow({
      where: { id: table.id },
    });
    expect(moved.path).toBe("tables/operations/budget.table");
    expect(moved.headCommitSha).not.toBe(table.headCommitSha);
  });

  it("returns committed folder moves when the projection update fails", async () => {
    const { project, caller } = await setup("projection-drift");
    await caller.tableFolder.create({
      projectId: project.id,
      parentPath: [],
      name: "Finance",
    });
    const columnId = randomUUID();
    const table = await caller.table.create({
      projectId: project.id,
      folderPath: ["finance"],
      title: "Budget",
      columns: [{ id: columnId, name: "Amount", type: "number" }],
      rows: [],
    });
    const db = getPrisma();
    const transaction = vi
      .spyOn(db, "$transaction")
      .mockRejectedValueOnce(new Error("projection unavailable"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        caller.tableFolder.rename({
          projectId: project.id,
          path: ["finance"],
          name: "Operations",
        }),
      ).resolves.toEqual({ path: ["operations"] });
      expect(logged).toHaveBeenCalledWith(
        expect.stringMatching(
          /^Folder projection failed after git commit \(ref (none|[0-9a-f]{8})\)$/,
        ),
        { projectId: project.id },
      );
      const tree = await caller.tableFolder.tree({ projectId: project.id });
      expect(tree).toMatchObject({ folders: ["operations"] });
      expect(tree.tables).toContainEqual(
        expect.objectContaining({
          id: table.id,
          path: "tables/operations/budget.table",
        }),
      );
      await expect(
        db.dataTable.findUniqueOrThrow({ where: { id: table.id } }),
      ).resolves.toMatchObject({ path: "tables/operations/budget.table" });
    } finally {
      transaction.mockRestore();
      logged.mockRestore();
    }
  });

  it("rejects cycles, depth > 10, and non-empty deletes like documents folders", async () => {
    const { project, caller } = await setup("2");
    await caller.tableFolder.create({
      projectId: project.id,
      parentPath: [],
      name: "A",
    });
    await caller.tableFolder.create({
      projectId: project.id,
      parentPath: ["a"],
      name: "B",
    });
    await expect(
      caller.tableFolder.move({
        projectId: project.id,
        path: ["a"],
        newParentPath: ["a", "b"],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.tableFolder.delete({ projectId: project.id, path: ["a"] }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("keeps the documents tree free of tables/ and vice versa", async () => {
    const { project, caller } = await setup("3");
    await caller.tableFolder.create({
      projectId: project.id,
      parentPath: [],
      name: "Finance",
    });
    await caller.folder.create({
      projectId: project.id,
      parentPath: [],
      name: "Guides",
    });

    const docTree = await caller.folder.tree({ projectId: project.id });
    expect(docTree.folders).toEqual(["guides"]);
    const tableTree = await caller.tableFolder.tree({ projectId: project.id });
    expect(tableTree.folders).toEqual(["finance"]);
  });

  it("rejects a documents folder named tables and document paths under tables/", async () => {
    const { project, caller } = await setup("4");
    await expect(
      caller.folder.create({
        projectId: project.id,
        parentPath: [],
        name: "Tables",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await caller.tableFolder.create({
      projectId: project.id,
      parentPath: [],
      name: "Finance",
    });
    await expect(
      caller.document.create({
        projectId: project.id,
        folderPath: ["tables", "finance"],
        title: "Escape",
        contentJson: { type: "doc" },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const document = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Safe",
      contentJson: { type: "doc" },
    });
    await expect(
      caller.document.move({
        projectId: project.id,
        documentId: document.id,
        folderPath: ["tables", "finance"],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("hides the tables root from folder moves and enforces membership", async () => {
    const { project, caller } = await setup("5");
    await caller.folder.create({
      projectId: project.id,
      parentPath: [],
      name: "Guides",
    });
    await caller.tableFolder.create({
      projectId: project.id,
      parentPath: [],
      name: "Finance",
    });
    await expect(
      caller.folder.move({
        projectId: project.id,
        path: ["guides"],
        newParentPath: ["tables"],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const outsider = await makeUser("User", "tf-outsider");
    await expect(
      callerFor(outsider).tableFolder.tree({ projectId: project.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

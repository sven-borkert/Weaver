import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addMembership,
  callerFor,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
} from "./_harness";
import {
  parseSchemaFile,
  serializeRows,
  serializeSchemaFile,
} from "@weaver/core/tables/jsonl";
import type {
  SchemaFile,
  TableColumn,
  TableRow,
} from "@weaver/core/tables/types";
import { openProjectRepo, withProjectRepo } from "@weaver/git-store";
import * as gitStore from "@weaver/git-store";

const TEXT_COL = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Item",
  type: "text" as const,
};
const ROW_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function setup(suffix: string) {
  const actor = await makeUser("User", `th-owner-${suffix}`);
  const project = await makeProject(`TH-${suffix}`);
  await addMembership(project.id, actor.id, "Owner");
  return { actor, project, caller: callerFor(actor) };
}

async function createWithHistory(
  caller: ReturnType<typeof callerFor>,
  projectId: string,
  title = "Log",
) {
  const created = await caller.table.create({
    projectId,
    folderPath: [],
    title,
    columns: [TEXT_COL],
    rows: [{ id: ROW_1, cells: { [TEXT_COL.id]: "v1" } }],
  });
  const updated = await caller.table.save({
    projectId,
    tableId: created.id,
    baseCommitSha: created.headCommitSha,
    columns: [TEXT_COL],
    rows: [{ id: ROW_1, cells: { [TEXT_COL.id]: "v2" } }],
  });
  return { created, updated };
}

async function commitSnapshot(
  projectId: string,
  path: string,
  schema: SchemaFile,
  rows: TableRow[],
  actor: Awaited<ReturnType<typeof makeUser>>,
  message: string,
) {
  return withProjectRepo(projectId, async (repo) => {
    await repo.writeFileAtomic(
      `${path}/schema.json`,
      serializeSchemaFile(schema),
    );
    await repo.writeFileAtomic(
      `${path}/data.jsonl`,
      serializeRows(schema.columns, rows),
    );
    return repo.commitAll(message, {
      name: null,
      email: actor.email,
      userId: actor.id,
    });
  });
}

async function schemaAt(projectId: string, sha: string, path: string) {
  const repo = (await openProjectRepo(projectId))!;
  return parseSchemaFile(await repo.showFileAt(sha, `${path}/schema.json`));
}

describe("table history, diff, restore", () => {
  it("rejects table versions outside the pinned HEAD ancestry for diff, restore and save", async () => {
    const { actor, project, caller } = await setup("unmerged");
    const { created, updated } = await createWithHistory(caller, project.id);
    await withProjectRepo(project.id, async (repo) => {
      await repo.resetWorktreeTo(created.headCommitSha);
      return repo.commitTreeWithParents(
        "alternate history",
        { name: actor.email, email: actor.email, userId: actor.id },
        [created.headCommitSha],
      );
    });
    await expect(
      caller.table.diff({
        projectId: project.id,
        tableId: created.id,
        fromSha: updated.headCommitSha,
        toSha: created.headCommitSha,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller.table.restore({
        projectId: project.id,
        tableId: created.id,
        sha: updated.headCommitSha,
        expectedHeadCommitSha: created.headCommitSha,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller.table.save({
        projectId: project.id,
        tableId: created.id,
        baseCommitSha: updated.headCommitSha,
        columns: [TEXT_COL],
        rows: [{ id: ROW_1, cells: { [TEXT_COL.id]: "v3" } }],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  beforeEach(async () => {
    await resetDb();
  });

  it("lists schema/data union commits newest-first with attribution, path, and paging", async () => {
    const { actor, project, caller } = await setup("history");
    const { created, updated } = await createWithHistory(caller, project.id);
    const dataOnlySha = await withProjectRepo(project.id, async (repo) => {
      await repo.writeFileAtomic(
        `${updated.path}/data.jsonl`,
        serializeRows(
          [TEXT_COL],
          [{ id: ROW_1, cells: { [TEXT_COL.id]: "v3" } }],
        ),
      );
      return repo.commitAll("external: data-only table edit", {
        name: null,
        email: actor.email,
        userId: actor.id,
      });
    });

    const first = await caller.table.history({
      projectId: project.id,
      tableId: created.id,
      offset: 0,
      limit: 1,
    });
    expect(first).toEqual({
      entries: [
        expect.objectContaining({
          sha: dataOnlySha,
          pathAtSha: updated.path,
          authorName: "user-th-owner-history",
          userId: actor.id,
          userName: "User th-owner-history",
          date: expect.any(Date),
          message: "external: data-only table edit",
        }),
      ],
      hasMore: true,
    });

    const rest = await caller.table.history({
      projectId: project.id,
      tableId: created.id,
      offset: 1,
      limit: 10,
    });
    expect(rest.entries.map((entry) => entry.sha)).toEqual([
      updated.headCommitSha,
      created.headCommitSha,
    ]);
    expect(rest.entries.map((entry) => entry.pathAtSha)).toEqual([
      created.path,
      created.path,
    ]);
    expect(rest.hasMore).toBe(false);
  });

  it("reads history from one shared-lock committed snapshot", async () => {
    const { project, caller } = await setup("history-snapshot");
    const { created } = await createWithHistory(caller, project.id);
    const originalWithReader = gitStore.withExistingProjectRepoReader;
    const lockedWriter = vi.spyOn(gitStore, "withExistingProjectRepo");
    let resolveHeadCalls = 0;
    let snapshotSha = "";
    const implicitCommitishes: Array<string | undefined> = [];
    const orderedFrom: string[] = [];
    const openSpy = vi
      .spyOn(gitStore, "withExistingProjectRepoReader")
      .mockImplementation((projectId, fn) =>
        originalWithReader(projectId, async (repo) => {
          if (projectId !== project.id) return fn(repo);
          return fn({
            ...repo,
            resolveHead: async () => {
              resolveHeadCalls += 1;
              snapshotSha = await repo.resolveHead();
              return snapshotSha;
            },
            logForPath: async (relPath, options) => {
              implicitCommitishes.push(options.commitish);
              return repo.logForPath(relPath, options);
            },
            orderCommits: async (commitish, shas) => {
              orderedFrom.push(commitish);
              return repo.orderCommits(commitish, shas);
            },
          });
        }),
      );

    try {
      await caller.table.history({
        projectId: project.id,
        tableId: created.id,
        offset: 0,
        limit: 10,
      });
      expect(lockedWriter).not.toHaveBeenCalled();
      expect(resolveHeadCalls).toBe(1);
      expect(snapshotSha).toMatch(/^[0-9a-f]{40}$/);
      expect(implicitCommitishes).not.toContain(undefined);
      expect(implicitCommitishes).not.toContain("HEAD");
      expect(orderedFrom).toContain(snapshotSha);
      expect(orderedFrom).not.toContain("HEAD");
    } finally {
      openSpy.mockRestore();
      lockedWriter.mockRestore();
    }
  });

  it("reads a diff from one shared-lock committed snapshot", async () => {
    const { project, caller } = await setup("diff-snapshot");
    const { created, updated } = await createWithHistory(caller, project.id);
    const originalWithReader = gitStore.withExistingProjectRepoReader;
    const lockedWriter = vi.spyOn(gitStore, "withExistingProjectRepo");
    let resolveHeadCalls = 0;
    const implicitCommitishes: Array<string | undefined> = [];
    const openSpy = vi
      .spyOn(gitStore, "withExistingProjectRepoReader")
      .mockImplementation((projectId, fn) =>
        originalWithReader(projectId, async (repo) => {
          if (projectId !== project.id) return fn(repo);
          return fn({
            ...repo,
            resolveHead: async () => {
              resolveHeadCalls += 1;
              return repo.resolveHead();
            },
            logForPath: async (relPath, options) => {
              implicitCommitishes.push(options.commitish);
              return repo.logForPath(relPath, options);
            },
          });
        }),
      );

    try {
      await caller.table.diff({
        projectId: project.id,
        tableId: created.id,
        fromSha: created.headCommitSha,
        toSha: updated.headCommitSha,
      });
      expect(lockedWriter).not.toHaveBeenCalled();
      expect(resolveHeadCalls).toBe(1);
      expect(implicitCommitishes).not.toContain(undefined);
      expect(implicitCommitishes).not.toContain("HEAD");
    } finally {
      openSpy.mockRestore();
      lockedWriter.mockRestore();
    }
  });

  it("filters foreign path reuse before applying history offsets and page limits", async () => {
    const { actor, project, caller } = await setup("history-identity-page");
    const { created, updated } = await createWithHistory(caller, project.id);
    const schema = await schemaAt(
      project.id,
      updated.headCommitSha,
      updated.path,
    );
    const firstForeignSha = await commitSnapshot(
      project.id,
      updated.path,
      { ...schema, id: randomUUID() },
      [{ id: ROW_1, cells: { [TEXT_COL.id]: "foreign one" } }],
      actor,
      "external: first foreign table at reused path",
    );
    const middleValidSha = await commitSnapshot(
      project.id,
      updated.path,
      schema,
      [{ id: ROW_1, cells: { [TEXT_COL.id]: "middle valid" } }],
      actor,
      "external: requested table returns",
    );
    const secondForeignSha = await commitSnapshot(
      project.id,
      updated.path,
      { ...schema, id: randomUUID() },
      [{ id: ROW_1, cells: { [TEXT_COL.id]: "foreign two" } }],
      actor,
      "external: second foreign table at reused path",
    );
    const newestValidSha = await commitSnapshot(
      project.id,
      updated.path,
      schema,
      [{ id: ROW_1, cells: { [TEXT_COL.id]: "newest valid" } }],
      actor,
      "external: requested table returns again",
    );

    const pages = [];
    for (let offset = 0; offset < 4; offset += 1) {
      pages.push(
        await caller.table.history({
          projectId: project.id,
          tableId: created.id,
          offset,
          limit: 1,
        }),
      );
    }

    expect(pages.map((page) => page.entries.map((entry) => entry.sha))).toEqual(
      [
        [newestValidSha],
        [middleValidSha],
        [updated.headCommitSha],
        [created.headCommitSha],
      ],
    );
    expect(pages.map((page) => page.hasMore)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(
      pages.flatMap((page) => page.entries.map((entry) => entry.sha)),
    ).not.toContain(firstForeignSha);
    expect(
      pages.flatMap((page) => page.entries.map((entry) => entry.sha)),
    ).not.toContain(secondForeignSha);
  });

  it("skips incomplete and ambiguous commits from divergent schema/data directories", async () => {
    const { actor, project, caller } = await setup("history-divergent-paths");
    const { created, updated } = await createWithHistory(caller, project.id);
    const schema = await schemaAt(
      project.id,
      updated.headCommitSha,
      updated.path,
    );
    const schemaOnlyPath = "tables/schema-only.table";
    const dataOnlyPath = "tables/data-only.table";
    const currentPath = "tables/converged.table";
    const { incompleteSha, ambiguousSha, convergedSha } = await withProjectRepo(
      project.id,
      async (repo) => {
        await repo.mv(
          `${updated.path}/schema.json`,
          `${schemaOnlyPath}/schema.json`,
        );
        await repo.mv(
          `${updated.path}/data.jsonl`,
          `${dataOnlyPath}/data.jsonl`,
        );
        const incompleteSha = await repo.commitAll(
          "external: split table files across directories",
          { name: null, email: actor.email, userId: actor.id },
        );
        const ambiguousSchema = {
          ...schema,
          updated: new Date(
            new Date(schema.updated).getTime() + 1_000,
          ).toISOString(),
        };
        await repo.writeFileAtomic(
          `${schemaOnlyPath}/schema.json`,
          serializeSchemaFile(ambiguousSchema),
        );
        await repo.writeFileAtomic(
          `${schemaOnlyPath}/data.jsonl`,
          serializeRows(schema.columns, [
            { id: ROW_1, cells: { [TEXT_COL.id]: "schema candidate" } },
          ]),
        );
        await repo.writeFileAtomic(
          `${dataOnlyPath}/schema.json`,
          serializeSchemaFile({
            ...ambiguousSchema,
            title: "Duplicate candidate",
          }),
        );
        await repo.writeFileAtomic(
          `${dataOnlyPath}/data.jsonl`,
          serializeRows(schema.columns, [
            { id: ROW_1, cells: { [TEXT_COL.id]: "data candidate" } },
          ]),
        );
        const ambiguousSha = await repo.commitAll(
          "external: duplicate table across divergent directories",
          { name: null, email: actor.email, userId: actor.id },
        );
        await repo.mv(
          `${schemaOnlyPath}/schema.json`,
          `${currentPath}/schema.json`,
        );
        await repo.mv(
          `${dataOnlyPath}/data.jsonl`,
          `${currentPath}/data.jsonl`,
        );
        await repo.rm(`${schemaOnlyPath}/data.jsonl`);
        await repo.rm(`${dataOnlyPath}/schema.json`);
        const convergedSha = await repo.commitAll(
          "external: converge table files in one directory",
          { name: null, email: actor.email, userId: actor.id },
        );
        return { incompleteSha, ambiguousSha, convergedSha };
      },
    );

    const page = await caller.table.history({
      projectId: project.id,
      tableId: created.id,
      offset: 0,
      limit: 10,
    });

    expect(page.entries.map((entry) => entry.sha)).toEqual([
      convergedSha,
      updated.headCommitSha,
      created.headCommitSha,
    ]);
    expect(page.entries.map((entry) => entry.pathAtSha)).toEqual([
      currentPath,
      created.path,
      created.path,
    ]);
    expect(page.entries.map((entry) => entry.sha)).not.toContain(incompleteSha);
    expect(page.entries.map((entry) => entry.sha)).not.toContain(ambiguousSha);
    expect(page.hasMore).toBe(false);
    await expect(
      caller.table.diff({
        projectId: project.id,
        tableId: created.id,
        fromSha: ambiguousSha,
        toSha: convergedSha,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller.table.restore({
        projectId: project.id,
        tableId: created.id,
        sha: ambiguousSha,
        expectedHeadCommitSha: (
          await caller.table.get({ projectId: project.id, tableId: created.id })
        ).baseCommitSha,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("discovers history by table id across a rename with a complete rewrite", async () => {
    const { actor, project, caller } = await setup("zero-similarity-rename");
    const { created, updated } = await createWithHistory(caller, project.id);
    const schema = await schemaAt(
      project.id,
      updated.headCommitSha,
      updated.path,
    );
    const rewrittenPath = "tables/reinvented.table";
    const rewrittenSha = await withProjectRepo(project.id, async (repo) => {
      await repo.rmDir(updated.path);
      const columns = Array.from({ length: 12 }, (_, index) => ({
        id: randomUUID(),
        name: `Entirely new column ${index}`,
        type: "text" as const,
      }));
      await repo.writeFileAtomic(
        `${rewrittenPath}/schema.json`,
        serializeSchemaFile({
          ...schema,
          title: "Reinvented table with unrelated schema",
          columns,
          updated: new Date(
            new Date(schema.updated).getTime() + 5_000,
          ).toISOString(),
        }),
      );
      await repo.writeFileAtomic(
        `${rewrittenPath}/data.jsonl`,
        serializeRows(columns, [
          { id: randomUUID(), cells: { [columns[0]!.id]: "unrelated data" } },
        ]),
      );
      return repo.commitAll("external: rewrite and rename table", {
        name: null,
        email: actor.email,
        userId: actor.id,
      });
    });

    const page = await caller.table.history({
      projectId: project.id,
      tableId: created.id,
      offset: 0,
      limit: 10,
    });
    expect(page.entries.map((entry) => entry.sha)).toEqual([
      rewrittenSha,
      updated.headCommitSha,
      created.headCommitSha,
    ]);
  });

  it("ignores unrelated tracked files when applying the table discovery cap", async () => {
    const { project, caller } = await setup("many-unrelated-files");
    const { created, updated } = await createWithHistory(caller, project.id);
    const originalWithReader = gitStore.withExistingProjectRepoReader;
    const openSpy = vi
      .spyOn(gitStore, "withExistingProjectRepoReader")
      .mockImplementation((projectId, fn) =>
        originalWithReader(projectId, async (repo) => {
          return fn({
            ...repo,
            listTrackedFiles: async (commitish = "HEAD") => [
              ...(await repo.listTrackedFiles(commitish)),
              ...Array.from(
                { length: 10_001 },
                (_, index) => `documents/unrelated-${index}.md`,
              ),
            ],
          });
        }),
      );

    try {
      await expect(
        caller.table.history({
          projectId: project.id,
          tableId: created.id,
          offset: 0,
          limit: 10,
        }),
      ).resolves.toMatchObject({
        entries: [
          { sha: updated.headCommitSha },
          { sha: created.headCommitSha },
        ],
      });
    } finally {
      openSpy.mockRestore();
    }
  });

  it("returns a controlled error when a commit exceeds the table discovery cap", async () => {
    const { project, caller } = await setup("many-table-candidates");
    const { created } = await createWithHistory(caller, project.id);
    const originalWithReader = gitStore.withExistingProjectRepoReader;
    const openSpy = vi
      .spyOn(gitStore, "withExistingProjectRepoReader")
      .mockImplementation((projectId, fn) =>
        originalWithReader(projectId, async (repo) => {
          return fn({
            ...repo,
            listTrackedBlobs: async (commitish = "HEAD") => [
              ...(await repo.listTrackedBlobs(commitish)),
              ...Array.from({ length: 10_001 }, (_, index) => ({
                path: `tables/candidate-${index}.table/schema.json`,
                sha: "0".repeat(40),
                size: 0,
              })),
            ],
          });
        }),
      );

    try {
      await expect(
        caller.table.history({
          projectId: project.id,
          tableId: created.id,
          offset: 0,
          limit: 10,
        }),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: "table discovery exceeds the supported table count",
      });
    } finally {
      openSpy.mockRestore();
    }
  });

  it("follows moves from a stale projection and reports each historical directory", async () => {
    const { project, caller } = await setup("move");
    const { created, updated } = await createWithHistory(caller, project.id);
    await caller.tableFolder.create({
      projectId: project.id,
      parentPath: [],
      name: "Archive",
    });
    const moved = await caller.table.move({
      projectId: project.id,
      tableId: created.id,
      folderPath: ["archive"],
    });
    await getPrisma().dataTable.update({
      where: { id: created.id },
      data: { path: created.path },
    });

    const page = await caller.table.history({
      projectId: project.id,
      tableId: created.id,
      offset: 0,
      limit: 10,
    });
    expect(
      page.entries.map(({ sha, pathAtSha }) => ({ sha, pathAtSha })),
    ).toEqual([
      { sha: moved.headCommitSha, pathAtSha: moved.path },
      { sha: updated.headCommitSha, pathAtSha: created.path },
      { sha: created.headCommitSha, pathAtSha: created.path },
    ]);
    expect(page.entries.map((entry) => entry.message)).toEqual([
      expect.stringMatching(/^move:/),
      expect.stringMatching(/^update:/),
      expect.stringMatching(/^create:/),
    ]);
  });

  it("diffs two versions as structured row changes across a move", async () => {
    const { project, caller } = await setup("diff");
    const { created, updated } = await createWithHistory(caller, project.id);
    await caller.tableFolder.create({
      projectId: project.id,
      parentPath: [],
      name: "Archive",
    });
    await caller.table.move({
      projectId: project.id,
      tableId: created.id,
      folderPath: ["archive"],
    });
    await getPrisma().dataTable.delete({ where: { id: created.id } });

    await expect(
      caller.table.diff({
        projectId: project.id,
        tableId: created.id,
        fromSha: created.headCommitSha,
        toSha: updated.headCommitSha,
      }),
    ).resolves.toEqual({
      titleChange: null,
      columnChanges: [],
      columnsReordered: false,
      rowsReordered: false,
      addedRows: [],
      removedRows: [],
      changedCells: [
        { rowId: ROW_1, columnId: TEXT_COL.id, from: "v1", to: "v2" },
      ],
    });
  });

  it.each([
    {
      label: "row cap",
      columns: [TEXT_COL] satisfies TableColumn[],
      rows: Array.from({ length: 10_001 }, () => ({
        id: randomUUID(),
        cells: {},
      })),
    },
    {
      label: "column cap",
      columns: Array.from({ length: 101 }, (_, index) => ({
        id: randomUUID(),
        name: `Column ${index}`,
        type: "text" as const,
      })),
      rows: [] satisfies TableRow[],
    },
    {
      label: "200,000 represented-cell cap",
      columns: Array.from({ length: 100 }, (_, index) => ({
        id: randomUUID(),
        name: `Column ${index}`,
        type: "text" as const,
      })),
      rows: Array.from({ length: 2_001 }, () => ({
        id: randomUUID(),
        cells: {},
      })),
    },
  ])(
    "returns tooLarge when either snapshot exceeds the $label",
    async ({ columns, rows }) => {
      const { actor, project, caller } = await setup(
        `cap-${rows.length}-${columns.length}`,
      );
      const created = await caller.table.create({
        projectId: project.id,
        folderPath: [],
        title: "Capped",
        columns: [TEXT_COL],
        rows: [],
      });
      const original = await schemaAt(
        project.id,
        created.headCommitSha,
        created.path,
      );
      const oversizedSha = await commitSnapshot(
        project.id,
        created.path,
        { ...original, columns },
        rows,
        actor,
        "external: oversized table snapshot",
      );
      const currentSha = await commitSnapshot(
        project.id,
        created.path,
        original,
        [],
        actor,
        "external: return table within caps",
      );

      await expect(
        caller.table.diff({
          projectId: project.id,
          tableId: created.id,
          fromSha: oversizedSha,
          toSha: currentSha,
        }),
      ).resolves.toEqual({ tooLarge: true });
      if (rows.length > 10_000 || columns.length > 100) {
        await expect(
          caller.table.restore({
            projectId: project.id,
            tableId: created.id,
            sha: oversizedSha,
            expectedHeadCommitSha: (
              await caller.table.get({
                projectId: project.id,
                tableId: created.id,
              })
            ).baseCommitSha,
          }),
        ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      }
      await expect(
        caller.table.diff({
          projectId: project.id,
          tableId: created.id,
          fromSha: currentSha,
          toSha: oversizedSha,
        }),
      ).resolves.toEqual({ tooLarge: true });
    },
  );

  it("rejects mismatched table ids at either diff side and at the restore source", async () => {
    const { actor, project, caller } = await setup("identity");
    const { created } = await createWithHistory(caller, project.id);
    const valid = await schemaAt(
      project.id,
      created.headCommitSha,
      created.path,
    );
    const wrongSha = await commitSnapshot(
      project.id,
      created.path,
      { ...valid, id: randomUUID() },
      [{ id: ROW_1, cells: { [TEXT_COL.id]: "wrong table" } }],
      actor,
      "external: reuse path for another table id",
    );
    const currentSha = await commitSnapshot(
      project.id,
      created.path,
      valid,
      [{ id: ROW_1, cells: { [TEXT_COL.id]: "current" } }],
      actor,
      "external: restore path to requested table id",
    );

    await expect(
      caller.table.diff({
        projectId: project.id,
        tableId: created.id,
        fromSha: currentSha,
        toSha: currentSha,
      }),
    ).resolves.toEqual({
      titleChange: null,
      columnChanges: [],
      columnsReordered: false,
      rowsReordered: false,
      addedRows: [],
      removedRows: [],
      changedCells: [],
    });

    for (const [fromSha, toSha] of [
      [wrongSha, currentSha],
      [currentSha, wrongSha],
    ] as const) {
      await expect(
        caller.table.diff({
          projectId: project.id,
          tableId: created.id,
          fromSha,
          toSha,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    await expect(
      caller.table.restore({
        projectId: project.id,
        tableId: created.id,
        sha: wrongSha,
        expectedHeadCommitSha: (
          await caller.table.get({ projectId: project.id, tableId: created.id })
        ).baseCommitSha,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      (await openProjectRepo(project.id))!.resolveHead(),
    ).resolves.toBe(currentSha);
  });

  it("restores through the shared writer with identity, timestamps, slug allocation, and attribution", async () => {
    const { actor, project, caller } = await setup("restore");
    const created = await caller.table.create({
      projectId: project.id,
      folderPath: [],
      title: "Original",
      columns: [TEXT_COL],
      rows: [{ id: ROW_1, cells: { [TEXT_COL.id]: "v1" } }],
    });
    const originalSchema = await schemaAt(
      project.id,
      created.headCommitSha,
      created.path,
    );
    const current = await caller.table.save({
      projectId: project.id,
      tableId: created.id,
      baseCommitSha: created.headCommitSha,
      title: "Current",
      columns: [TEXT_COL],
      rows: [{ id: ROW_1, cells: { [TEXT_COL.id]: "v2" } }],
    });
    const currentSchema = await schemaAt(
      project.id,
      current.headCommitSha,
      current.path,
    );
    const sourceSha = await commitSnapshot(
      project.id,
      current.path,
      {
        ...currentSchema,
        title: "Original",
        created: "2035-01-01T00:00:00.000Z",
      },
      [{ id: ROW_1, cells: { [TEXT_COL.id]: "v1" } }],
      actor,
      "external: historical source with forged creation time",
    );
    await commitSnapshot(
      project.id,
      current.path,
      currentSchema,
      [{ id: ROW_1, cells: { [TEXT_COL.id]: "v2" } }],
      actor,
      "external: return table to current state",
    );
    await commitSnapshot(
      project.id,
      created.path,
      {
        ...originalSchema,
        id: randomUUID(),
        title: "External collision",
      },
      [],
      actor,
      "external: occupy the historical table directory",
    );

    const restored = await caller.table.restore({
      projectId: project.id,
      tableId: created.id,
      sha: sourceSha,
      expectedHeadCommitSha: (
        await caller.table.get({ projectId: project.id, tableId: created.id })
      ).baseCommitSha,
    });
    expect(restored).toMatchObject({
      id: created.id,
      title: "Original",
      slug: "original-2",
      path: "tables/original-2.table",
      rows: [{ id: ROW_1, cells: { [TEXT_COL.id]: "v1" } }],
    });
    const restoredSchema = await schemaAt(
      project.id,
      restored.headCommitSha,
      restored.path,
    );
    expect(restoredSchema.id).toBe(created.id);
    expect(restoredSchema.created).toBe(originalSchema.created);
    expect(new Date(restoredSchema.updated).getTime()).toBeGreaterThan(
      new Date(currentSchema.updated).getTime(),
    );

    const history = await caller.table.history({
      projectId: project.id,
      tableId: created.id,
      offset: 0,
      limit: 100,
    });
    expect(
      history.entries.filter((entry) => entry.sha === restored.headCommitSha),
    ).toEqual([
      expect.objectContaining({
        pathAtSha: restored.path,
        message: `restore: ${restored.path} (was ${current.path}) (from ${sourceSha.slice(0, 7)})`,
        userId: actor.id,
        userName: "User th-owner-restore",
      }),
    ]);
    await expect(
      getPrisma().dataTable.findUniqueOrThrow({ where: { id: created.id } }),
    ).resolves.toMatchObject({
      projectId: project.id,
      path: restored.path,
      slug: restored.slug,
      headCommitSha: restored.headCommitSha,
      lastEditedById: actor.id,
    });
  });

  it("restores from Git truth when the projection row is missing", async () => {
    const { project, caller } = await setup("missing-projection");
    const { created } = await createWithHistory(caller, project.id);
    await getPrisma().dataTable.delete({ where: { id: created.id } });

    const restored = await caller.table.restore({
      projectId: project.id,
      tableId: created.id,
      sha: created.headCommitSha,
      expectedHeadCommitSha: (
        await caller.table.get({ projectId: project.id, tableId: created.id })
      ).baseCommitSha,
    });
    expect(restored).toMatchObject({
      id: created.id,
      rows: [{ id: ROW_1, cells: { [TEXT_COL.id]: "v1" } }],
    });
    await expect(
      getPrisma().dataTable.findUniqueOrThrow({ where: { id: created.id } }),
    ).resolves.toMatchObject({ headCommitSha: restored.headCommitSha });
  });

  it("keeps a committed restore successful when its projection transaction fails", async () => {
    const { project, caller } = await setup("projection-failure");
    const { created, updated } = await createWithHistory(caller, project.id);
    const db = getPrisma();
    const projectionFailure = vi
      .spyOn(db, "$transaction")
      .mockRejectedValueOnce(new Error("injected restore projection failure"));
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    let restored: Awaited<ReturnType<typeof caller.table.restore>>;
    try {
      restored = await caller.table.restore({
        projectId: project.id,
        tableId: created.id,
        sha: created.headCommitSha,
        expectedHeadCommitSha: updated.headCommitSha,
      });
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringMatching(
          /^DataTable projection failed after git commit \(ref (none|[0-9a-f]{8})\)$/,
        ),
        { projectId: project.id, tableId: created.id },
      );
    } finally {
      projectionFailure.mockRestore();
      errorLog.mockRestore();
    }

    expect(restored!.headCommitSha).not.toBe(updated.headCommitSha);
    await expect(
      db.dataTable.findUniqueOrThrow({ where: { id: created.id } }),
    ).resolves.toMatchObject({ headCommitSha: updated.headCommitSha });
    await expect(
      caller.table.get({ projectId: project.id, tableId: created.id }),
    ).resolves.toMatchObject({
      baseCommitSha: restored!.headCommitSha,
      rows: [{ id: ROW_1, cells: { [TEXT_COL.id]: "v1" } }],
    });
  });

  it("serializes an overlapping restore and table save", async () => {
    const { project, caller } = await setup("concurrent");
    const { created, updated } = await createWithHistory(caller, project.id);
    const [restoreResult, writerResult] = await Promise.allSettled([
      caller.table.restore({
        projectId: project.id,
        tableId: created.id,
        sha: created.headCommitSha,
        expectedHeadCommitSha: (
          await caller.table.get({ projectId: project.id, tableId: created.id })
        ).baseCommitSha,
      }),
      caller.table.save({
        projectId: project.id,
        tableId: created.id,
        baseCommitSha: updated.headCommitSha,
        columns: [TEXT_COL],
        rows: [{ id: ROW_1, cells: { [TEXT_COL.id]: "overlapping writer" } }],
      }),
    ]);

    // Whichever request takes the repository lock first wins; the other must
    // fail with CONFLICT, and the committed table must match the winner.
    if (restoreResult.status === "fulfilled") {
      if (writerResult.status === "rejected") {
        expect(writerResult.reason).toMatchObject({ code: "CONFLICT" });
      }
      await expect(
        caller.table.get({ projectId: project.id, tableId: created.id }),
      ).resolves.toMatchObject({
        baseCommitSha: restoreResult.value.headCommitSha,
        rows: [{ id: ROW_1, cells: { [TEXT_COL.id]: "v1" } }],
      });
      return;
    }
    expect(restoreResult.reason).toMatchObject({ code: "CONFLICT" });
    expect(writerResult.status).toBe("fulfilled");
    if (writerResult.status !== "fulfilled") return;
    await expect(
      caller.table.get({ projectId: project.id, tableId: created.id }),
    ).resolves.toMatchObject({
      baseCommitSha: writerResult.value.headCommitSha,
      rows: [{ id: ROW_1, cells: { [TEXT_COL.id]: "overlapping writer" } }],
    });
  });

  it("allows Viewer history/diff, requires Editor restore, and hides existence", async () => {
    const { project, caller } = await setup("access");
    const { created, updated } = await createWithHistory(caller, project.id);
    const viewer = await makeUser("User", "th-viewer-access");
    await addMembership(project.id, viewer.id, "Viewer");
    const viewerCaller = callerFor(viewer);
    await expect(
      viewerCaller.table.history({
        projectId: project.id,
        tableId: created.id,
        offset: 0,
        limit: 5,
      }),
    ).resolves.toBeTruthy();
    await expect(
      viewerCaller.table.diff({
        projectId: project.id,
        tableId: created.id,
        fromSha: created.headCommitSha,
        toSha: updated.headCommitSha,
      }),
    ).resolves.toBeTruthy();
    await expect(
      viewerCaller.table.restore({
        projectId: project.id,
        tableId: created.id,
        sha: created.headCommitSha,
        expectedHeadCommitSha: "a".repeat(40),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const outsider = await makeUser("User", "th-outsider-access");
    const outsiderCaller = callerFor(outsider);
    await expect(
      outsiderCaller.table.history({
        projectId: project.id,
        tableId: created.id,
        offset: 0,
        limit: 5,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      outsiderCaller.table.diff({
        projectId: project.id,
        tableId: created.id,
        fromSha: created.headCommitSha,
        toSha: updated.headCommitSha,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      outsiderCaller.table.restore({
        projectId: project.id,
        tableId: created.id,
        sha: created.headCommitSha,
        expectedHeadCommitSha: "a".repeat(40),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

it("ends ordinary table history without scanning unrelated table commits", async () => {
  await resetDb();
  const { project, caller } = await setup("review-history-cost");
  const { created, updated } = await createWithHistory(caller, project.id);
  const original = gitStore.openProjectRepo;
  const spy = vi
    .spyOn(gitStore, "openProjectRepo")
    .mockImplementation(async (projectId) => {
      const repo = await original(projectId);
      return repo
        ? {
            ...repo,
            logForPath: async (path, options) => {
              if (path === "tables")
                throw new Error("unrelated whole-root history scan");
              return repo.logForPath(path, options);
            },
          }
        : repo;
    });
  try {
    const result = await caller.table.history({
      projectId: project.id,
      tableId: created.id,
      offset: 0,
      limit: 50,
    });
    expect(result.entries.map((entry) => entry.sha)).toEqual([
      updated.headCommitSha,
      created.headCommitSha,
    ]);
    expect(result.hasMore).toBe(false);
  } finally {
    spy.mockRestore();
  }
});

it("refuses a restore after another editor saves and preserves their content", async () => {
  await resetDb();
  const { project, caller } = await setup("restore-stale-review");
  const { created, updated } = await createWithHistory(caller, project.id);
  await expect(
    caller.table.restore({
      projectId: project.id,
      tableId: created.id,
      sha: created.headCommitSha,
      expectedHeadCommitSha: created.headCommitSha,
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  const current = await caller.table.get({
    projectId: project.id,
    tableId: created.id,
  });
  expect(current.baseCommitSha).toBe(updated.headCommitSha);
  expect(current.rows).toEqual(updated.rows);
});

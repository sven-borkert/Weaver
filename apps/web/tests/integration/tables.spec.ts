import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addMembership,
  callerFor,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
} from "./_harness";
import { openProjectRepo, repoDir, withProjectRepo } from "@weaver/git-store";
import type { ProjectRepoReader, ProjectRepoWriter } from "@weaver/git-store";
import * as gitStore from "@weaver/git-store";
import { retypeColumn } from "@weaver/core/tables/cellValues";
import type { SchemaFile, TableColumn } from "@weaver/core/tables/types";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import {
  flushDiagnostics,
  startDiagnosticWriter,
  stopDiagnosticWriter,
  waitForDiagnosticWriterReady,
} from "@weaver/core/diagnostics/writer";

const execFileAsync = promisify(execFile);

type MatrixRole = "Owner" | "Maintainer" | "Editor" | "Viewer" | null;

async function setupProjectWith(role: MatrixRole, suffix: string) {
  const owner = await makeUser("User", `t-owner-${suffix}`);
  const project = await makeProject(`T-${suffix}`);
  await addMembership(project.id, owner.id, "Owner");
  if (role === null) {
    const outsider = await makeUser("User", `t-out-${suffix}`);
    return { project, caller: callerFor(outsider), actor: outsider };
  }
  const actor = await makeUser("User", `t-${role.toLowerCase()}-${suffix}`);
  await addMembership(project.id, actor.id, role);
  return { project, caller: callerFor(actor), actor };
}

const TEXT_COL = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Item",
  type: "text" as const,
};
const NUM_COL = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Qty",
  type: "number" as const,
};
const ROW_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROW_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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

async function commitAt(
  repo: ProjectRepoWriter,
  message: string,
  actor: { id: string; email: string },
  timestamp: string,
  amend = false,
) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Table Test",
    GIT_AUTHOR_EMAIL: actor.email,
    GIT_AUTHOR_DATE: timestamp,
    GIT_COMMITTER_NAME: "Weaver",
    GIT_COMMITTER_EMAIL: "weaver@local",
    GIT_COMMITTER_DATE: timestamp,
  };
  await execFileAsync("git", ["add", "-A"], { cwd: repo.dir, env });
  await execFileAsync(
    "git",
    [
      "commit",
      ...(amend ? ["--amend"] : []),
      "-m",
      message,
      "--trailer",
      `Weaver-User-Id: ${actor.id}`,
    ],
    { cwd: repo.dir, env },
  );
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: repo.dir,
    env,
  });
  return stdout.trim();
}

async function readCommittedText(repo: ProjectRepoReader, relPath: string) {
  return (await repo.readCommittedFile(relPath))!.content;
}

async function worktreePathExists(projectId: string, relPath: string) {
  return stat(pathForProject(projectId, relPath)).then(
    () => true,
    () => false,
  );
}

function pathForProject(projectId: string, relPath: string) {
  return `${repoDir(projectId)}/${relPath}`;
}

async function createGroceries(
  caller: ReturnType<typeof callerFor>,
  projectId: string,
) {
  return caller.table.create({
    projectId,
    folderPath: [],
    title: "Groceries",
    columns: [TEXT_COL, NUM_COL],
    rows: [
      { id: ROW_1, cells: { [TEXT_COL.id]: "milk", [NUM_COL.id]: 2 } },
      { id: ROW_2, cells: { [TEXT_COL.id]: "bread" } },
    ],
  });
}

async function commitRawTable(
  repo: ProjectRepoWriter,
  dir: string,
  id: string,
  title: string,
  actor: { id: string; email: string },
) {
  await repo.writeFileAtomic(
    `${dir}/schema.json`,
    `${JSON.stringify(
      {
        id,
        title,
        sourceOfTruth: "git",
        columns: [],
        created: "2030-01-01T00:00:00.000Z",
        updated: "2030-01-01T00:00:00.000Z",
      },
      null,
      2,
    )}\n`,
  );
  await repo.writeFileAtomic(`${dir}/data.jsonl`, "");
  return repo.commitAll(`external raw table: ${dir}`, {
    name: null,
    email: actor.email,
    userId: actor.id,
  });
}

describe("table router — core", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("creates files + commit + index row; returns the save contract", async () => {
    const { project, caller } = await setupProjectWith("Editor", "tc1");
    const res = await createGroceries(caller, project.id);
    expect(res).toMatchObject({
      slug: "groceries",
      path: "tables/groceries.table",
      title: "Groceries",
    });
    expect(res.headCommitSha).toMatch(/^[0-9a-f]{40}$/);
    const repo = (await openProjectRepo(project.id))!;
    const schemaText = await readCommittedText(
      repo,
      "tables/groceries.table/schema.json",
    );
    expect(schemaText).toContain(`"id": "${res.id}"`);
    expect(schemaText).toContain('"sourceOfTruth": "git"');
    const dataText = await readCommittedText(
      repo,
      "tables/groceries.table/data.jsonl",
    );
    expect(dataText.trim().split("\n")).toHaveLength(2);
    expect(dataText).toContain('"milk"');
    const row = await getPrisma().dataTable.findUnique({
      where: { id: res.id },
    });
    expect(row).toMatchObject({
      projectId: project.id,
      rowCount: 2,
      headCommitSha: res.headCommitSha,
    });
    expect(knowledgeQueue.jobs).toContainEqual({
      name: "table.search-sync",
      data: {
        projectId: project.id,
        tableId: res.id,
        sourceCommitSha: res.headCommitSha,
        pathAtSha: res.path,
      },
    });
  });

  it("creates with a default single text column and zero rows", async () => {
    const { project, caller } = await setupProjectWith("Editor", "tc2");
    const res = await caller.table.create({
      projectId: project.id,
      folderPath: [],
      title: "Empty",
    });
    const got = await caller.table.get({
      projectId: project.id,
      tableId: res.id,
    });
    expect(got.columns).toHaveLength(1);
    expect(got.columns[0]).toMatchObject({ name: "Name", type: "text" });
    expect(got.rows).toEqual([]);
  });

  it("round-trips get and save with a fresh base", async () => {
    const { project, caller } = await setupProjectWith("Editor", "tc3");
    const created = await createGroceries(caller, project.id);
    const loaded = await caller.table.get({
      projectId: project.id,
      tableId: created.id,
    });
    expect(loaded.baseCommitSha).toBe(created.headCommitSha);
    expect(loaded.rows).toHaveLength(2);

    const saved = await caller.table.save({
      projectId: project.id,
      tableId: created.id,
      baseCommitSha: loaded.baseCommitSha,
      columns: loaded.columns,
      rows: [
        { id: ROW_1, cells: { [TEXT_COL.id]: "oat milk", [NUM_COL.id]: 3 } },
        { id: ROW_2, cells: { [TEXT_COL.id]: "bread" } },
      ],
    });
    expect(saved.headCommitSha).not.toBe(loaded.baseCommitSha);
    const reloaded = await caller.table.get({
      projectId: project.id,
      tableId: created.id,
    });
    expect(reloaded.rows[0]!.cells[TEXT_COL.id]).toBe("oat milk");
    expect(reloaded.rows[0]!.cells[NUM_COL.id]).toBe(3);
    const row = await getPrisma().dataTable.findUnique({
      where: { id: created.id },
    });
    expect(row!.headCommitSha).toBe(saved.headCommitSha);
    expect(knowledgeQueue.jobs).toContainEqual({
      name: "table.search-sync",
      data: {
        projectId: project.id,
        tableId: saved.id,
        sourceCommitSha: saved.headCommitSha,
        pathAtSha: saved.path,
      },
    });
  });

  it("enqueues the exact restored table snapshot", async () => {
    const { project, caller } = await setupProjectWith(
      "Editor",
      "tc-restore-index",
    );
    const created = await createGroceries(caller, project.id);
    const saved = await caller.table.save({
      projectId: project.id,
      tableId: created.id,
      baseCommitSha: created.headCommitSha,
      columns: created.columns,
      rows: [{ id: ROW_1, cells: { [TEXT_COL.id]: "changed" } }],
    });
    knowledgeQueue.jobs.length = 0;

    const restored = await caller.table.restore({
      projectId: project.id,
      tableId: created.id,
      sha: created.headCommitSha,
      expectedHeadCommitSha: (
        await caller.table.get({ projectId: project.id, tableId: created.id })
      ).baseCommitSha,
    });

    expect(restored.headCommitSha).not.toBe(saved.headCommitSha);
    expect(knowledgeQueue.jobs).toEqual([
      {
        name: "table.search-sync",
        data: {
          projectId: project.id,
          tableId: restored.id,
          sourceCommitSha: restored.headCommitSha,
          pathAtSha: restored.path,
        },
      },
    ]);
  });

  it("renames on title change via slug recompute + git mv in one commit", async () => {
    const { project, caller } = await setupProjectWith("Editor", "tc4");
    const created = await createGroceries(caller, project.id);
    const saved = await caller.table.save({
      projectId: project.id,
      tableId: created.id,
      baseCommitSha: created.headCommitSha,
      title: "Weekly Groceries",
      columns: [TEXT_COL, NUM_COL],
      rows: [],
    });
    expect(saved.path).toBe("tables/weekly-groceries.table");
    expect(saved.slug).toBe("weekly-groceries");
    expect(
      await worktreePathExists(
        project.id,
        "tables/weekly-groceries.table/schema.json",
      ),
    ).toBe(true);
    expect(await worktreePathExists(project.id, "tables/groceries.table")).toBe(
      false,
    );
  });

  it("reads committed Git state and repairs a stale projection after a rename", async () => {
    const { project, caller, actor } = await setupProjectWith("Editor", "tc4b");
    const created = await createGroceries(caller, project.id);
    const movedSha = await withProjectRepo(project.id, async (repo) => {
      await repo.mv("tables/groceries.table", "tables/renamed-groceries.table");
      return repo.commitAll("move table outside projection", {
        name: null,
        email: actor.email,
        userId: actor.id,
      });
    });

    const got = await caller.table.get({
      projectId: project.id,
      tableId: created.id,
    });
    expect(got).toMatchObject({
      path: "tables/renamed-groceries.table",
      slug: "renamed-groceries",
      baseCommitSha: movedSha,
    });
    await expect(
      getPrisma().dataTable.findUnique({ where: { id: created.id } }),
    ).resolves.toMatchObject({
      path: "tables/renamed-groceries.table",
      slug: "renamed-groceries",
      headCommitSha: movedSha,
    });
  });

  it("uses Git ancestry when schema and data commits have tied timestamps", async () => {
    const { project, caller, actor } = await setupProjectWith("Editor", "tc4c");
    const created = await createGroceries(caller, project.id);
    const fixedTime = "2035-01-02T03:04:05Z";
    const { schemaSha, dataSha } = await withProjectRepo(
      project.id,
      async (repo) => {
        const schemaPath = `${created.path}/schema.json`;
        const schema = JSON.parse(
          await repo.readFileFromWorktree(schemaPath),
        ) as { title: string; updated: string };
        schema.title = "Git ordered";
        schema.updated = fixedTime;
        await repo.writeFileAtomic(
          schemaPath,
          `${JSON.stringify(schema, null, 2)}\n`,
        );
        const schemaSha = await commitAt(
          repo,
          "external schema touch",
          actor,
          fixedTime,
        );

        await repo.writeFileAtomic(
          `${created.path}/data.jsonl`,
          `${JSON.stringify({ id: ROW_1, cells: { [TEXT_COL.id]: "newest" } })}\n`,
        );
        let dataSha = await commitAt(
          repo,
          "external data touch 0",
          actor,
          fixedTime,
        );
        for (
          let attempt = 1;
          dataSha.localeCompare(schemaSha) >= 0;
          attempt++
        ) {
          expect(attempt).toBeLessThan(64);
          dataSha = await commitAt(
            repo,
            `external data touch ${attempt}`,
            actor,
            fixedTime,
            true,
          );
        }
        expect(await repo.commitDate(schemaSha)).toEqual(
          await repo.commitDate(dataSha),
        );
        return { schemaSha, dataSha };
      },
    );

    expect(dataSha.localeCompare(schemaSha)).toBeLessThan(0);
    const got = await caller.table.get({
      projectId: project.id,
      tableId: created.id,
    });
    expect(got.baseCommitSha).toBe(dataSha);
    expect(got.rows[0]!.cells[TEXT_COL.id]).toBe("newest");
  });

  it("treats a missing committed data.jsonl as corrupt", async () => {
    const { project, caller, actor } = await setupProjectWith("Editor", "tc4d");
    const created = await createGroceries(caller, project.id);
    await withProjectRepo(project.id, async (repo) => {
      await repo.rm(`${created.path}/data.jsonl`);
      await repo.commitAll("external data deletion", {
        name: null,
        email: actor.email,
        userId: actor.id,
      });
    });

    await expect(
      caller.table.get({ projectId: project.id, tableId: created.id }),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });

  it("uses data.jsonl rename evidence when schema similarity is lost", async () => {
    const { project, caller, actor } = await setupProjectWith("Editor", "tc4e");
    const created = await createGroceries(caller, project.id);
    await withProjectRepo(project.id, async (repo) => {
      const nextDir = "tables/data-evidence.table";
      await repo.mv(created.path, nextDir);
      await repo.writeFileAtomic(
        `${nextDir}/schema.json`,
        `${JSON.stringify(
          {
            id: created.id,
            title: "Completely Rewritten Schema",
            sourceOfTruth: "git",
            columns: [
              TEXT_COL,
              NUM_COL,
              ...Array.from({ length: 80 }, (_, index) => ({
                id: randomUUID(),
                name: `Replacement ${index} ${"x".repeat(70)}`,
                type: "text",
              })),
            ],
            created: "2030-01-01T00:00:00.000Z",
            updated: "2030-01-02T00:00:00.000Z",
          },
          null,
          2,
        )}\n`,
      );
      await repo.commitAll("external rewrite and move", {
        name: null,
        email: actor.email,
        userId: actor.id,
      });
    });

    await expect(
      caller.table.get({ projectId: project.id, tableId: created.id }),
    ).resolves.toMatchObject({
      path: "tables/data-evidence.table",
      slug: "data-evidence",
      title: "Completely Rewritten Schema",
    });
  });

  it("discovers Git truth after a create projection failure", async () => {
    const { project, caller } = await setupProjectWith("Editor", "tc4f");
    const db = getPrisma();
    const projectionFailure = vi
      .spyOn(db, "$transaction")
      .mockRejectedValueOnce(new Error("injected create projection failure"));
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    let created: Awaited<ReturnType<typeof createGroceries>>;
    try {
      created = await createGroceries(caller, project.id);
    } finally {
      projectionFailure.mockRestore();
      errorLog.mockRestore();
    }
    await expect(
      db.dataTable.findUnique({ where: { id: created.id } }),
    ).resolves.toBeNull();

    const got = await caller.table.get({
      projectId: project.id,
      tableId: created.id,
    });
    expect(got).toMatchObject({
      id: created.id,
      path: "tables/groceries.table",
      baseCommitSha: created.headCommitSha,
    });
    await expect(
      db.dataTable.findUnique({ where: { id: created.id } }),
    ).resolves.toMatchObject({ headCommitSha: created.headCommitSha });
  });

  it("saves from the current Git directory after rename projection failure", async () => {
    const { project, caller } = await setupProjectWith("Editor", "tc4g");
    const db = getPrisma();
    const created = await createGroceries(caller, project.id);
    const projectionFailure = vi
      .spyOn(db, "$transaction")
      .mockRejectedValueOnce(new Error("injected rename projection failure"));
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    let renamed: Awaited<ReturnType<typeof caller.table.save>>;
    try {
      renamed = await caller.table.save({
        projectId: project.id,
        tableId: created.id,
        baseCommitSha: created.headCommitSha,
        title: "Renamed Once",
        columns: [TEXT_COL, NUM_COL],
        rows: [],
      });
    } finally {
      projectionFailure.mockRestore();
      errorLog.mockRestore();
    }
    await expect(
      db.dataTable.findUnique({ where: { id: created.id } }),
    ).resolves.toMatchObject({ path: created.path });

    const saved = await caller.table.save({
      projectId: project.id,
      tableId: created.id,
      baseCommitSha: renamed.headCommitSha,
      columns: [TEXT_COL, NUM_COL],
      rows: [{ id: ROW_1, cells: { [TEXT_COL.id]: "recovered" } }],
    });
    expect(saved.path).toBe("tables/renamed-once.table");
    expect(saved.rows[0]!.cells[TEXT_COL.id]).toBe("recovered");
  });

  it("runs committed get reads and projection repair under the repo mutex", async () => {
    const { project, caller } = await setupProjectWith("Editor", "tc4h");
    const created = await createGroceries(caller, project.id);
    const lockedRead = vi.spyOn(gitStore, "withExistingProjectRepoReader");
    try {
      await caller.table.get({
        projectId: project.id,
        tableId: created.id,
      });
      expect(lockedRead).toHaveBeenCalledWith(project.id, expect.any(Function));
    } finally {
      lockedRead.mockRestore();
    }
  });

  it("ignores dirty worktree table content and reads the committed snapshot", async () => {
    const { project, caller } = await setupProjectWith("Editor", "tc4i");
    const created = await createGroceries(caller, project.id);
    await withProjectRepo(project.id, async (repo) => {
      await repo.writeFileAtomic(`${created.path}/schema.json`, "not json\n");
      await repo.writeFileAtomic(
        `${created.path}/data.jsonl`,
        `${JSON.stringify({ id: ROW_1, cells: { [TEXT_COL.id]: "dirty" } })}\n`,
      );
    });

    const got = await caller.table.get({
      projectId: project.id,
      tableId: created.id,
    });
    expect(got.title).toBe("Groceries");
    expect(got.rows[0]!.cells[TEXT_COL.id]).toBe("milk");
    const reader = (await openProjectRepo(project.id))!;
    await expect(
      readCommittedText(reader, `${created.path}/schema.json`),
    ).resolves.toContain('"title": "Groceries"');
  });

  it("advances schema.updated even when the clock does not", async () => {
    const { project, caller } = await setupProjectWith("Editor", "tc4j");
    const created = await createGroceries(caller, project.id);
    const repo = (await openProjectRepo(project.id))!;
    const before = JSON.parse(
      await readCommittedText(repo, `${created.path}/schema.json`),
    ) as { updated: string };
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(new Date(before.updated).getTime());
    try {
      await caller.table.save({
        projectId: project.id,
        tableId: created.id,
        baseCommitSha: created.headCommitSha,
        columns: [TEXT_COL, NUM_COL],
        rows: [],
      });
    } finally {
      clock.mockRestore();
    }
    const after = JSON.parse(
      await readCommittedText(repo, `${created.path}/schema.json`),
    ) as { updated: string };
    expect(new Date(after.updated).getTime()).toBe(
      new Date(before.updated).getTime() + 1,
    );
  });

  it("allocates around a live unindexed worktree collision", async () => {
    const { project, caller, actor } = await setupProjectWith("Editor", "tc4k");
    await withProjectRepo(project.id, (repo) =>
      commitRawTable(
        repo,
        "tables/collision.table",
        randomUUID(),
        "External collision",
        actor,
      ),
    );

    await expect(
      caller.table.create({
        projectId: project.id,
        folderPath: [],
        title: "Collision",
      }),
    ).resolves.toMatchObject({
      slug: "collision-2",
      path: "tables/collision-2.table",
    });
  });

  it("does not reuse a deleted table directory from Git history", async () => {
    const { project, caller, actor } = await setupProjectWith("Editor", "tc4l");
    await withProjectRepo(project.id, async (repo) => {
      await commitRawTable(
        repo,
        "tables/archived.table",
        randomUUID(),
        "External archived",
        actor,
      );
      await repo.rmDir("tables/archived.table");
      await repo.commitAll("external raw table deletion", {
        name: null,
        email: actor.email,
        userId: actor.id,
      });
    });

    await expect(
      caller.table.create({
        projectId: project.id,
        folderPath: [],
        title: "Archived",
      }),
    ).resolves.toMatchObject({
      slug: "archived-2",
      path: "tables/archived-2.table",
    });
  });

  it("answers CONFLICT on a stale base with overlapping edits", async () => {
    const { project, caller } = await setupProjectWith("Editor", "tc5");
    const created = await createGroceries(caller, project.id);
    await caller.table.save({
      projectId: project.id,
      tableId: created.id,
      baseCommitSha: created.headCommitSha,
      columns: [TEXT_COL, NUM_COL],
      rows: [{ id: ROW_1, cells: { [TEXT_COL.id]: "first" } }],
    });
    await expect(
      caller.table.save({
        projectId: project.id,
        tableId: created.id,
        baseCommitSha: created.headCommitSha,
        columns: [TEXT_COL, NUM_COL],
        rows: [{ id: ROW_1, cells: { [TEXT_COL.id]: "second" } }],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects invalid cells and over-cap payloads with BAD_REQUEST", async () => {
    const { project, caller } = await setupProjectWith("Editor", "tc6");
    await expect(
      caller.table.create({
        projectId: project.id,
        folderPath: [],
        title: "Bad",
        columns: [NUM_COL],
        rows: [{ id: ROW_1, cells: { [NUM_COL.id]: "not-a-number" } }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.table.create({
        projectId: project.id,
        folderPath: [],
        title: "Bad2",
        columns: [TEXT_COL],
        rows: [{ id: ROW_1, cells: { [NUM_COL.id]: "unknown-col" } }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("enforces row, column, select-option, and string caps", async () => {
    const { project, caller } = await setupProjectWith("Editor", "tc6b");
    await expect(
      caller.table.create({
        projectId: project.id,
        folderPath: [],
        title: "Too many rows",
        columns: [TEXT_COL],
        rows: Array.from({ length: 10_001 }, () => ({
          id: randomUUID(),
          cells: {},
        })),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.table.create({
        projectId: project.id,
        folderPath: [],
        title: "Too many columns",
        columns: Array.from({ length: 101 }, (_, index) => ({
          id: randomUUID(),
          name: `Column ${index}`,
          type: "text" as const,
        })),
        rows: [],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.table.create({
        projectId: project.id,
        folderPath: [],
        title: "Too many options",
        columns: [
          {
            id: randomUUID(),
            name: "Choice",
            type: "select",
            options: Array.from({ length: 201 }, (_, index) => ({
              id: randomUUID(),
              label: `Option ${index}`,
            })),
          },
        ],
        rows: [],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.table.create({
        projectId: project.id,
        folderPath: [],
        title: "Text too long",
        columns: [TEXT_COL],
        rows: [
          {
            id: randomUUID(),
            cells: { [TEXT_COL.id]: "x".repeat(10_001) },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("enforces the serialized schema byte cap", async () => {
    const { project, caller } = await setupProjectWith("Editor", "tc6c");
    const columns = Array.from({ length: 20 }, (_, columnIndex) => ({
      id: randomUUID(),
      name: `Select ${columnIndex}`,
      type: "select" as const,
      options: Array.from({ length: 200 }, () => ({
        id: randomUUID(),
        label: "x".repeat(100),
      })),
    }));
    await expect(
      caller.table.create({
        projectId: project.id,
        folderPath: [],
        title: "Schema too large",
        columns,
        rows: [],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("enforces the serialized data byte cap", async () => {
    const { project, caller } = await setupProjectWith("Editor", "tc6d");
    const value = "x".repeat(10_000);
    await expect(
      caller.table.create({
        projectId: project.id,
        folderPath: [],
        title: "Data too large",
        columns: [TEXT_COL],
        rows: Array.from({ length: 500 }, () => ({
          id: randomUUID(),
          cells: { [TEXT_COL.id]: value },
        })),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects non-canonical UUIDs and byte-over-cap input before cell validation", async () => {
    const { project, caller } = await setupProjectWith("Editor", "tc6e");
    await expect(
      caller.table.create({
        projectId: project.id,
        folderPath: [],
        title: "Uppercase UUID",
        columns: [{ ...TEXT_COL, id: randomUUID().toUpperCase() }],
        rows: [],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const unknownColumnId = randomUUID();
    await expect(
      caller.table.create({
        projectId: project.id,
        folderPath: [],
        title: "Budget first",
        columns: [TEXT_COL],
        rows: Array.from({ length: 501 }, () => ({
          id: randomUUID(),
          cells: { [unknownColumnId]: "x".repeat(10_000) },
        })),
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("5 MB"),
    });
  });

  const DT_COL = {
    id: "99999999-9999-4999-8999-999999999991",
    name: "When",
    type: "datetime" as const,
  };
  const URL_COL = {
    id: "99999999-9999-4999-8999-999999999992",
    name: "Link",
    type: "url" as const,
  };
  const LONG_COL = {
    id: "99999999-9999-4999-8999-999999999993",
    name: "Notes",
    type: "longtext" as const,
  };
  const OPT_1 = "99999999-9999-4999-8999-999999999994";
  const OPT_2 = "99999999-9999-4999-8999-999999999995";
  const MULTI_COL = {
    id: "99999999-9999-4999-8999-999999999996",
    name: "Tags",
    type: "multiselect" as const,
    options: [
      { id: OPT_1, label: "One" },
      { id: OPT_2, label: "Two" },
    ],
  };
  const NEW_TYPES_ROW = "99999999-9999-4999-8999-999999999997";

  it("round-trips datetime, multiselect, url, and longtext cells", async () => {
    const { project, caller } = await setupProjectWith("Editor", "tc-newtypes");
    const created = await caller.table.create({
      projectId: project.id,
      folderPath: [],
      title: "New types",
      columns: [TEXT_COL, DT_COL, URL_COL, LONG_COL, MULTI_COL],
      rows: [
        {
          id: NEW_TYPES_ROW,
          cells: {
            [TEXT_COL.id]: "hello",
            [DT_COL.id]: "2026-09-18T14:30:00Z",
            [URL_COL.id]: "https://example.test/a?b=1",
            [LONG_COL.id]: "line1\nline2",
            [MULTI_COL.id]: [OPT_1, OPT_2],
          },
        },
      ],
    });
    const got = await caller.table.get({
      projectId: project.id,
      tableId: created.id,
    });
    expect(got.rows[0]!.cells).toEqual({
      [TEXT_COL.id]: "hello",
      [DT_COL.id]: "2026-09-18T14:30:00Z",
      [URL_COL.id]: "https://example.test/a?b=1",
      [LONG_COL.id]: "line1\nline2",
      [MULTI_COL.id]: [OPT_1, OPT_2],
    });
  });

  it("rejects a duplicate multiselect value and a zone-less datetime with BAD_REQUEST", async () => {
    const { project, caller } = await setupProjectWith(
      "Editor",
      "tc-newtypes-bad",
    );
    await expect(
      caller.table.create({
        projectId: project.id,
        folderPath: [],
        title: "Bad multiselect",
        columns: [MULTI_COL],
        rows: [{ id: randomUUID(), cells: { [MULTI_COL.id]: [OPT_1, OPT_1] } }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.table.create({
        projectId: project.id,
        folderPath: [],
        title: "Bad datetime",
        columns: [DT_COL],
        rows: [{ id: randomUUID(), cells: { [DT_COL.id]: "2026-09-18" } }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects an invalid url and an over-cap longtext value with BAD_REQUEST", async () => {
    const { project, caller } = await setupProjectWith(
      "Editor",
      "tc-newtypes-bad-url-long",
    );
    await expect(
      caller.table.create({
        projectId: project.id,
        folderPath: [],
        title: "Bad url",
        columns: [URL_COL],
        rows: [{ id: randomUUID(), cells: { [URL_COL.id]: "not a url" } }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.table.create({
        projectId: project.id,
        folderPath: [],
        title: "Bad longtext",
        columns: [LONG_COL],
        rows: [
          { id: randomUUID(), cells: { [LONG_COL.id]: "x".repeat(10_001) } },
        ],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects an array cell on a select column", async () => {
    const { project, caller } = await setupProjectWith(
      "Editor",
      "tc-select-array",
    );
    const selectColumn = {
      id: "99999999-9999-4999-8999-999999999998",
      name: "Choice",
      type: "select" as const,
      options: [
        { id: OPT_1, label: "One" },
        { id: OPT_2, label: "Two" },
      ],
    };
    await expect(
      caller.table.create({
        projectId: project.id,
        folderPath: [],
        title: "Select array",
        columns: [selectColumn],
        rows: [{ id: randomUUID(), cells: { [selectColumn.id]: [OPT_1] } }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("retypes select to multiselect through table.save, preserving values as single-element arrays", async () => {
    const { project, caller } = await setupProjectWith(
      "Editor",
      "tc-retype-multiselect",
    );
    const selectColumn = {
      id: "99999999-9999-4999-8999-999999999999",
      name: "Choice",
      type: "select" as const,
      options: [
        { id: OPT_1, label: "One" },
        { id: OPT_2, label: "Two" },
      ],
    };
    const created = await caller.table.create({
      projectId: project.id,
      folderPath: [],
      title: "Retype to multiselect",
      columns: [selectColumn],
      rows: [{ id: NEW_TYPES_ROW, cells: { [selectColumn.id]: OPT_1 } }],
    });
    const loaded = await caller.table.get({
      projectId: project.id,
      tableId: created.id,
    });
    const multiselectColumn = { ...selectColumn, type: "multiselect" as const };
    const retyped = retypeColumn(loaded.rows, selectColumn, multiselectColumn);
    expect(retyped.ok).toBe(true);
    if (!retyped.ok) throw new Error("expected retype to succeed");

    const saved = await caller.table.save({
      projectId: project.id,
      tableId: created.id,
      baseCommitSha: loaded.baseCommitSha,
      columns: [multiselectColumn],
      rows: retyped.rows,
    });
    const reloaded = await caller.table.get({
      projectId: project.id,
      tableId: saved.id,
    });
    expect(reloaded.rows[0]!.cells[selectColumn.id]).toEqual([OPT_1]);
  });

  it("lists tables paged with rowCount and attribution", async () => {
    const { project, caller } = await setupProjectWith("Editor", "tc7");
    await createGroceries(caller, project.id);
    await caller.table.create({
      projectId: project.id,
      folderPath: [],
      title: "Second",
    });
    const page = await caller.table.list({
      projectId: project.id,
      page: 1,
      pageSize: 10,
      sort: "title",
      dir: "asc",
    });
    expect(page.total).toBe(2);
    expect(page.items[0]).toMatchObject({ title: "Groceries", rowCount: 2 });
    expect(page.items[0]!.lastEditedBy).toMatchObject({
      id: expect.any(String),
    });
  });

  it("lists with real paging, filters, All mode, alternate sort, and stable ties", async () => {
    const { project, caller } = await setupProjectWith("Editor", "tc7b");
    await caller.tableFolder.create({
      projectId: project.id,
      parentPath: [],
      name: "Reports",
    });
    await caller.tableFolder.create({
      projectId: project.id,
      parentPath: ["reports"],
      name: "Archive",
    });
    const alpha = await caller.table.create({
      projectId: project.id,
      folderPath: [],
      title: "Alpha",
    });
    const beta = await caller.table.create({
      projectId: project.id,
      folderPath: ["reports"],
      title: "Beta",
    });
    const delta = await caller.table.create({
      projectId: project.id,
      folderPath: ["reports", "archive"],
      title: "Delta",
    });
    const echo = await caller.table.create({
      projectId: project.id,
      folderPath: [],
      title: "Echo",
    });

    const first = await caller.table.list({
      projectId: project.id,
      page: 1,
      pageSize: 2,
      sort: "title",
      dir: "asc",
    });
    const second = await caller.table.list({
      projectId: project.id,
      page: 2,
      pageSize: 2,
      sort: "title",
      dir: "asc",
    });
    expect(first).toMatchObject({ total: 4, pageCount: 2 });
    expect(first.items.map((item) => item.title)).toEqual(["Alpha", "Beta"]);
    expect(second.items.map((item) => item.title)).toEqual(["Delta", "Echo"]);

    const folder = await caller.table.list({
      projectId: project.id,
      page: 1,
      pageSize: 25,
      folderPath: ["reports"],
      sort: "title",
      dir: "asc",
    });
    expect(folder.items.map((item) => item.title)).toEqual(["Beta", "Delta"]);
    const search = await caller.table.list({
      projectId: project.id,
      page: 1,
      pageSize: 25,
      search: "TA",
      sort: "title",
      dir: "asc",
    });
    expect(search.items.map((item) => item.title)).toEqual(["Beta", "Delta"]);

    const all = await caller.table.list({
      projectId: project.id,
      page: 1,
      pageSize: -1,
      sort: "title",
      dir: "asc",
    });
    expect(all).toMatchObject({ total: 4, pageSize: 4, pageCount: 1 });
    expect(all.items).toHaveLength(4);

    const db = getPrisma();
    for (const [index, table] of [alpha, beta, delta, echo].entries()) {
      await db.dataTable.update({
        where: { id: table.id },
        data: { lastEditedAt: new Date(Date.UTC(2030, 0, index + 1)) },
      });
    }
    const alternate = await caller.table.list({
      projectId: project.id,
      page: 1,
      pageSize: -1,
      sort: "lastEditedAt",
      dir: "desc",
    });
    expect(alternate.items.map((item) => item.title)).toEqual([
      "Echo",
      "Delta",
      "Beta",
      "Alpha",
    ]);

    await db.dataTable.updateMany({
      where: { projectId: project.id },
      data: { lastEditedAt: new Date("2031-01-01T00:00:00.000Z") },
    });
    const tied = await caller.table.list({
      projectId: project.id,
      page: 1,
      pageSize: -1,
      sort: "lastEditedAt",
      dir: "asc",
    });
    const tiedIds = tied.items.map((item) => item.id);
    expect(tiedIds).toEqual([...tiedIds].sort());
  });

  it.each([
    ["Viewer", true],
    ["Maintainer", true],
    [null, false],
  ] as const)("table.get access for role %s", async (role, allowed) => {
    const owner = await makeUser("User", `tc8-owner-${role}`);
    const project = await makeProject(`T-tc8-${role}`);
    await addMembership(project.id, owner.id, "Owner");
    const created = await createGroceries(callerFor(owner), project.id);
    const reader = await makeUser("User", `tc8-reader-${role}`);
    if (role !== null) await addMembership(project.id, reader.id, role);
    const call = callerFor(reader).table.get({
      projectId: project.id,
      tableId: created.id,
    });
    if (allowed) {
      await expect(call).resolves.toMatchObject({ id: created.id });
    } else {
      await expect(call).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it("hides tables from non-members and blocks Viewer writes", async () => {
    const owner = await makeUser("User", "tc9-owner");
    const project = await makeProject("T-tc9");
    await addMembership(project.id, owner.id, "Owner");
    const created = await createGroceries(callerFor(owner), project.id);

    const outsider = await makeUser("User", "tc9-out");
    await expect(
      callerFor(outsider).table.get({
        projectId: project.id,
        tableId: created.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const viewer = await makeUser("User", "tc9-view");
    await addMembership(project.id, viewer.id, "Viewer");
    await expect(
      callerFor(viewer).table.create({
        projectId: project.id,
        folderPath: [],
        title: "Nope",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("table router — merge", () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function setupTwoEditors(suffix: string) {
    const owner = await makeUser("User", `tm-owner-${suffix}`);
    const project = await makeProject(`TM-${suffix}`);
    await addMembership(project.id, owner.id, "Owner");
    const second = await makeUser("User", `tm-second-${suffix}`);
    await addMembership(project.id, second.id, "Editor");
    return {
      project,
      callerA: callerFor(owner),
      callerB: callerFor(second),
    };
  }

  async function captureWriteState(
    projectId: string,
    tableId: string,
    path: string,
  ) {
    const repo = (await openProjectRepo(projectId))!;
    return {
      head: await repo.resolveHead(),
      schema: await readCommittedText(repo, `${path}/schema.json`),
      data: await readCommittedText(repo, `${path}/data.jsonl`),
      projection: await getPrisma().dataTable.findUniqueOrThrow({
        where: { id: tableId },
      }),
    };
  }

  it("auto-merges disjoint row edits from two editors", async () => {
    const { project, callerA, callerB } = await setupTwoEditors("1");
    const created = await createGroceries(callerA, project.id);
    const baseSha = created.headCommitSha;

    await callerA.table.save({
      projectId: project.id,
      tableId: created.id,
      baseCommitSha: baseSha,
      columns: [TEXT_COL, NUM_COL],
      rows: [
        { id: ROW_1, cells: { [TEXT_COL.id]: "oat milk", [NUM_COL.id]: 2 } },
        { id: ROW_2, cells: { [TEXT_COL.id]: "bread" } },
      ],
    });
    const repo = (await openProjectRepo(project.id))!;
    const beforeLog = await repo.logForPath(`${created.path}/data.jsonl`, {
      skip: 0,
      limit: 100,
    });
    const merged = await callerB.table.save({
      projectId: project.id,
      tableId: created.id,
      baseCommitSha: baseSha,
      columns: [TEXT_COL, NUM_COL],
      rows: [
        { id: ROW_1, cells: { [TEXT_COL.id]: "milk", [NUM_COL.id]: 2 } },
        { id: ROW_2, cells: { [TEXT_COL.id]: "sourdough", [NUM_COL.id]: 1 } },
      ],
    });
    expect(merged.rows).toEqual([
      { id: ROW_1, cells: { [TEXT_COL.id]: "oat milk", [NUM_COL.id]: 2 } },
      { id: ROW_2, cells: { [TEXT_COL.id]: "sourdough", [NUM_COL.id]: 1 } },
    ]);
    const afterLog = await repo.logForPath(`${merged.path}/data.jsonl`, {
      skip: 0,
      limit: 100,
    });
    expect(afterLog).toHaveLength(beforeLog.length + 1);
    expect(afterLog[0]!.message).toContain("(merged)");
  });

  it("auto-merges additive schema changes from both editors", async () => {
    const { project, callerA, callerB } = await setupTwoEditors("2");
    const created = await createGroceries(callerA, project.id);
    const DATE_COL = {
      id: "33333333-3333-4333-8333-333333333333",
      name: "Due",
      type: "date" as const,
    };
    const BOOL_COL = {
      id: "44444444-4444-4444-8444-444444444444",
      name: "Done",
      type: "boolean" as const,
    };

    await callerA.table.save({
      projectId: project.id,
      tableId: created.id,
      baseCommitSha: created.headCommitSha,
      columns: [TEXT_COL, NUM_COL, DATE_COL],
      rows: [],
    });
    const merged = await callerB.table.save({
      projectId: project.id,
      tableId: created.id,
      baseCommitSha: created.headCommitSha,
      columns: [TEXT_COL, NUM_COL, BOOL_COL],
      rows: [],
    });
    expect(merged.columns.map((column) => column.id)).toEqual([
      TEXT_COL.id,
      NUM_COL.id,
      DATE_COL.id,
      BOOL_COL.id,
    ]);
  });

  it("returns cell conflicts and the committed head without writing", async () => {
    const { project, callerA, callerB } = await setupTwoEditors("3");
    const created = await createGroceries(callerA, project.id);

    const current = await callerA.table.save({
      projectId: project.id,
      tableId: created.id,
      baseCommitSha: created.headCommitSha,
      columns: [TEXT_COL, NUM_COL],
      rows: [{ id: ROW_1, cells: { [TEXT_COL.id]: "oat milk" } }],
    });
    const before = await captureWriteState(
      project.id,
      created.id,
      current.path,
    );
    const error = await callerB.table
      .save({
        projectId: project.id,
        tableId: created.id,
        baseCommitSha: created.headCommitSha,
        columns: [TEXT_COL, NUM_COL],
        rows: [{ id: ROW_1, cells: { [TEXT_COL.id]: "soy milk" } }],
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "CONFLICT" });
    expect((error as { cause?: unknown }).cause).toMatchObject({
      conflicts: [{ kind: "cell", rowId: ROW_1, columnId: TEXT_COL.id }],
      headCommitSha: current.headCommitSha,
    });
    expect(
      await captureWriteState(project.id, created.id, current.path),
    ).toEqual(before);
  });

  it("escalates a their-retype vs our-unconvertible-cell merge to CONFLICT", async () => {
    const { project, callerA, callerB } = await setupTwoEditors("4");
    const created = await createGroceries(callerA, project.id);

    await callerA.table.save({
      projectId: project.id,
      tableId: created.id,
      baseCommitSha: created.headCommitSha,
      columns: [{ ...TEXT_COL, type: "number" as const }, NUM_COL],
      rows: [{ id: ROW_1, cells: { [TEXT_COL.id]: 1 } }],
    });
    const error = await callerB.table
      .save({
        projectId: project.id,
        tableId: created.id,
        baseCommitSha: created.headCommitSha,
        columns: [TEXT_COL, NUM_COL],
        rows: [
          { id: ROW_1, cells: { [TEXT_COL.id]: "milk", [NUM_COL.id]: 2 } },
          { id: ROW_2, cells: { [TEXT_COL.id]: "bread" } },
          {
            id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            cells: { [TEXT_COL.id]: "free text" },
          },
        ],
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "CONFLICT" });
    expect((error as { cause?: unknown }).cause).toMatchObject({
      conflicts: [{ kind: "column", columnId: TEXT_COL.id }],
      headCommitSha: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
  });

  it("finds the merge base across a table rename", async () => {
    const { project, callerA, callerB } = await setupTwoEditors("5");
    const created = await createGroceries(callerA, project.id);
    const renamed = await callerA.table.save({
      projectId: project.id,
      tableId: created.id,
      baseCommitSha: created.headCommitSha,
      title: "Weekly Groceries",
      columns: [TEXT_COL, NUM_COL],
      rows: [
        { id: ROW_1, cells: { [TEXT_COL.id]: "oat milk", [NUM_COL.id]: 2 } },
        { id: ROW_2, cells: { [TEXT_COL.id]: "bread" } },
      ],
    });

    const merged = await callerB.table.save({
      projectId: project.id,
      tableId: created.id,
      baseCommitSha: created.headCommitSha,
      columns: [TEXT_COL, NUM_COL],
      rows: [
        { id: ROW_1, cells: { [TEXT_COL.id]: "milk", [NUM_COL.id]: 2 } },
        { id: ROW_2, cells: { [TEXT_COL.id]: "rye bread" } },
      ],
    });
    expect(merged).toMatchObject({
      path: renamed.path,
      slug: renamed.slug,
      title: renamed.title,
    });
    expect(merged.rows).toEqual([
      { id: ROW_1, cells: { [TEXT_COL.id]: "oat milk", [NUM_COL.id]: 2 } },
      { id: ROW_2, cells: { [TEXT_COL.id]: "rye bread" } },
    ]);
  });

  it("answers CONFLICT without writing when the base version is missing", async () => {
    const { project, callerA } = await setupTwoEditors("6");
    const created = await createGroceries(callerA, project.id);
    const before = await captureWriteState(
      project.id,
      created.id,
      created.path,
    );

    const error = await callerA.table
      .save({
        projectId: project.id,
        tableId: created.id,
        baseCommitSha: "0".repeat(40),
        columns: [TEXT_COL, NUM_COL],
        rows: created.rows,
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "CONFLICT" });
    expect((error as { cause?: unknown }).cause).toMatchObject({
      headCommitSha: created.headCommitSha,
    });
    expect(
      await captureWriteState(project.id, created.id, created.path),
    ).toEqual(before);
  });

  it("returns write-nothing CONFLICT when merged columns exceed the cap", async () => {
    const { project, callerA, callerB } = await setupTwoEditors("7");
    const created = await createGroceries(callerA, project.id);
    const theirColumns = Array.from({ length: 50 }, (_, index) => ({
      id: randomUUID(),
      name: `Their ${index}`,
      type: "text" as const,
    }));
    const ourColumns = Array.from({ length: 50 }, (_, index) => ({
      id: randomUUID(),
      name: `Our ${index}`,
      type: "text" as const,
    }));
    const current = await callerA.table.save({
      projectId: project.id,
      tableId: created.id,
      baseCommitSha: created.headCommitSha,
      columns: [TEXT_COL, NUM_COL, ...theirColumns],
      rows: created.rows,
    });
    const before = await captureWriteState(
      project.id,
      created.id,
      current.path,
    );

    const error = await callerB.table
      .save({
        projectId: project.id,
        tableId: created.id,
        baseCommitSha: created.headCommitSha,
        columns: [TEXT_COL, NUM_COL, ...ourColumns],
        rows: created.rows,
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "CONFLICT" });
    expect((error as { cause?: unknown }).cause).toMatchObject({
      headCommitSha: current.headCommitSha,
    });
    expect(
      await captureWriteState(project.id, created.id, current.path),
    ).toEqual(before);
  });

  it("returns write-nothing CONFLICT when merged data exceeds its byte cap", async () => {
    const { project, callerA, callerB } = await setupTwoEditors("8");
    const created = await createGroceries(callerA, project.id);
    const value = "x".repeat(10_000);
    const theirRows = Array.from({ length: 250 }, () => ({
      id: randomUUID(),
      cells: { [TEXT_COL.id]: value },
    }));
    const ourRows = Array.from({ length: 250 }, () => ({
      id: randomUUID(),
      cells: { [TEXT_COL.id]: value },
    }));
    const current = await callerA.table.save({
      projectId: project.id,
      tableId: created.id,
      baseCommitSha: created.headCommitSha,
      columns: [TEXT_COL, NUM_COL],
      rows: [...created.rows, ...theirRows],
    });
    const before = await captureWriteState(
      project.id,
      created.id,
      current.path,
    );

    const error = await callerB.table
      .save({
        projectId: project.id,
        tableId: created.id,
        baseCommitSha: created.headCommitSha,
        columns: [TEXT_COL, NUM_COL],
        rows: [...created.rows, ...ourRows],
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "CONFLICT" });
    expect((error as { cause?: unknown }).cause).toMatchObject({
      headCommitSha: current.headCommitSha,
    });
    expect(
      await captureWriteState(project.id, created.id, current.path),
    ).toEqual(before);
  });

  it("returns write-nothing CONFLICT when merged schema exceeds its byte cap", async () => {
    const { project, callerA, callerB } = await setupTwoEditors("9");
    const created = await createGroceries(callerA, project.id);
    const selectColumns = (prefix: string) =>
      Array.from({ length: 4 }, (_, columnIndex) => ({
        id: randomUUID(),
        name: `${prefix} ${columnIndex}`,
        type: "select" as const,
        options: Array.from({ length: 200 }, () => ({
          id: randomUUID(),
          label: "x".repeat(100),
        })),
      }));
    const theirColumns = selectColumns("Their select");
    const ourColumns = selectColumns("Our select");
    const current = await callerA.table.save({
      projectId: project.id,
      tableId: created.id,
      baseCommitSha: created.headCommitSha,
      columns: [TEXT_COL, NUM_COL, ...theirColumns],
      rows: created.rows,
    });
    const before = await captureWriteState(
      project.id,
      created.id,
      current.path,
    );

    const error = await callerB.table
      .save({
        projectId: project.id,
        tableId: created.id,
        baseCommitSha: created.headCommitSha,
        columns: [TEXT_COL, NUM_COL, ...ourColumns],
        rows: created.rows,
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "CONFLICT" });
    expect((error as { cause?: unknown }).cause).toMatchObject({
      headCommitSha: current.headCommitSha,
    });
    expect(
      await captureWriteState(project.id, created.id, current.path),
    ).toEqual(before);
  });
});

describe("table router — move and delete", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("moves a table without rewriting schema.updated and rewrites the projection", async () => {
    const { project, caller, actor } = await setupProjectWith("Editor", "tmd1");
    await caller.tableFolder.create({
      projectId: project.id,
      parentPath: [],
      name: "Finance",
    });
    const created = await createGroceries(caller, project.id);
    const repo = (await openProjectRepo(project.id))!;
    const beforeSchema = JSON.parse(
      await readCommittedText(repo, `${created.path}/schema.json`),
    ) as { updated: string };

    const moved = await caller.table.move({
      projectId: project.id,
      tableId: created.id,
      folderPath: ["finance"],
    });

    expect(moved.path).toBe("tables/finance/groceries.table");
    expect(moved.slug).toBe("groceries");
    await expect(
      getPrisma().dataTable.findUnique({ where: { id: created.id } }),
    ).resolves.toMatchObject({
      path: moved.path,
      slug: moved.slug,
      headCommitSha: moved.headCommitSha,
      lastEditedById: actor.id,
    });
    const afterSchema = JSON.parse(
      await readCommittedText(repo, `${moved.path}/schema.json`),
    ) as { updated: string };
    expect(afterSchema.updated).toBe(beforeSchema.updated);
    const [entry] = await repo.logForPath(`${moved.path}/schema.json`, {
      skip: 0,
      limit: 1,
    });
    expect(entry).toMatchObject({
      sha: moved.headCommitSha,
      message:
        "move: tables/finance/groceries.table (was tables/groceries.table)",
      userId: actor.id,
    });
    await expect(
      caller.table.get({ projectId: project.id, tableId: created.id }),
    ).resolves.toMatchObject({ path: moved.path, rows: created.rows });
    expect(knowledgeQueue.jobs).toContainEqual({
      name: "table.search-sync",
      data: {
        projectId: project.id,
        tableId: moved.id,
        sourceCommitSha: moved.headCommitSha,
        pathAtSha: moved.path,
      },
    });
  });

  it("suffixes the slug around a live unindexed destination collision", async () => {
    const { project, caller, actor } = await setupProjectWith("Editor", "tmd2");
    await caller.tableFolder.create({
      projectId: project.id,
      parentPath: [],
      name: "Finance",
    });
    const created = await createGroceries(caller, project.id);
    await withProjectRepo(project.id, (repo) =>
      commitRawTable(
        repo,
        "tables/finance/groceries.table",
        randomUUID(),
        "Unindexed collision",
        actor,
      ),
    );

    const moved = await caller.table.move({
      projectId: project.id,
      tableId: created.id,
      folderPath: ["finance"],
    });

    expect(moved).toMatchObject({
      slug: "groceries-2",
      path: "tables/finance/groceries-2.table",
    });
    await expect(
      worktreePathExists(
        project.id,
        "tables/finance/groceries.table/schema.json",
      ),
    ).resolves.toBe(true);
  });

  it("rejects a tracked file as a table-folder destination", async () => {
    const { project, caller, actor } = await setupProjectWith("Editor", "tmd3");
    const created = await createGroceries(caller, project.id);
    await withProjectRepo(project.id, async (repo) => {
      await repo.writeFileAtomic("tables/not-a-folder", "tracked file\n");
      await repo.commitAll("external tracked file", {
        name: null,
        email: actor.email,
        userId: actor.id,
      });
    });
    const repo = (await openProjectRepo(project.id))!;
    const head = await repo.resolveHead();

    await expect(
      caller.table.move({
        projectId: project.id,
        tableId: created.id,
        folderPath: ["not-a-folder"],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repo.resolveHead()).resolves.toBe(head);
    await expect(worktreePathExists(project.id, created.path)).resolves.toBe(
      true,
    );
  });

  it("recovers the current Git path before moving a stale projection", async () => {
    const { project, caller, actor } = await setupProjectWith("Editor", "tmd4");
    await caller.tableFolder.create({
      projectId: project.id,
      parentPath: [],
      name: "Finance",
    });
    const created = await createGroceries(caller, project.id);
    await withProjectRepo(project.id, async (repo) => {
      await repo.mv(created.path, "tables/external-name.table");
      await repo.commitAll("external move before API move", {
        name: null,
        email: actor.email,
        userId: actor.id,
      });
    });

    const moved = await caller.table.move({
      projectId: project.id,
      tableId: created.id,
      folderPath: ["finance"],
    });

    expect(moved).toMatchObject({
      slug: "external-name",
      path: "tables/finance/external-name.table",
    });
    await expect(
      getPrisma().dataTable.findUnique({ where: { id: created.id } }),
    ).resolves.toMatchObject({
      path: moved.path,
      headCommitSha: moved.headCommitSha,
    });
    const repo = (await openProjectRepo(project.id))!;
    const [entry] = await repo.logForPath(`${moved.path}/schema.json`, {
      skip: 0,
      limit: 1,
    });
    expect(entry!.message).toBe(
      "move: tables/finance/external-name.table (was tables/external-name.table)",
    );
  });

  it("moves from Git truth after its projection row is removed", async () => {
    const { project, caller } = await setupProjectWith("Editor", "tmd4a");
    await caller.tableFolder.create({
      projectId: project.id,
      parentPath: [],
      name: "Finance",
    });
    const created = await createGroceries(caller, project.id);
    const db = getPrisma();
    await db.dataTable.delete({ where: { id: created.id } });

    const moved = await caller.table.move({
      projectId: project.id,
      tableId: created.id,
      folderPath: ["finance"],
    });

    expect(moved.path).toBe("tables/finance/groceries.table");
    await expect(
      db.dataTable.findUnique({ where: { id: created.id } }),
    ).resolves.toMatchObject({
      projectId: project.id,
      path: moved.path,
      headCommitSha: moved.headCommitSha,
    });
  });

  it("keeps a missing-projection no-op at its Git path despite a stale index collision", async () => {
    const { project, caller } = await setupProjectWith("Editor", "tmd4aa");
    const created = await createGroceries(caller, project.id);
    const blocker = await caller.table.create({
      projectId: project.id,
      folderPath: [],
      title: "Stale blocker",
    });
    const db = getPrisma();
    await db.dataTable.delete({ where: { id: created.id } });
    await db.dataTable.update({
      where: { id: blocker.id },
      data: { slug: created.slug, path: created.path },
    });
    const blockerBefore = await db.dataTable.findUniqueOrThrow({
      where: { id: blocker.id },
    });
    const repo = (await openProjectRepo(project.id))!;
    const repoHead = await repo.resolveHead();
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    let moved: Awaited<ReturnType<typeof caller.table.move>>;
    try {
      moved = await caller.table.move({
        projectId: project.id,
        tableId: created.id,
        folderPath: [],
      });
    } finally {
      errorLog.mockRestore();
    }

    expect(moved).toMatchObject({
      path: created.path,
      slug: created.slug,
      headCommitSha: created.headCommitSha,
    });
    await expect(repo.resolveHead()).resolves.toBe(repoHead);
    await expect(worktreePathExists(project.id, created.path)).resolves.toBe(
      true,
    );
    await expect(
      worktreePathExists(project.id, "tables/groceries-2.table"),
    ).resolves.toBe(false);
    await expect(
      db.dataTable.findUnique({ where: { id: created.id } }),
    ).resolves.toBeNull();
    await expect(
      db.dataTable.findUnique({ where: { id: blocker.id } }),
    ).resolves.toEqual(blockerBefore);
  });

  it("repairs all stale projection metadata on a no-op move without committing", async () => {
    const { project, caller } = await setupProjectWith("Editor", "tmd4b");
    const created = await createGroceries(caller, project.id);
    const db = getPrisma();
    const canonical = await db.dataTable.findUniqueOrThrow({
      where: { id: created.id },
    });
    await db.dataTable.update({
      where: { id: created.id },
      data: {
        title: "Stale title",
        rowCount: 99,
        headCommitSha: "0".repeat(40),
        lastEditedById: null,
        lastEditedAt: new Date("2000-01-01T00:00:00.000Z"),
        createdAt: new Date("2000-01-01T00:00:00.000Z"),
      },
    });
    const repo = (await openProjectRepo(project.id))!;
    const head = await repo.resolveHead();

    const moved = await caller.table.move({
      projectId: project.id,
      tableId: created.id,
      folderPath: [],
    });

    expect(moved.headCommitSha).toBe(head);
    await expect(repo.resolveHead()).resolves.toBe(head);
    await expect(
      db.dataTable.findUnique({ where: { id: created.id } }),
    ).resolves.toMatchObject({
      title: "Groceries",
      rowCount: 2,
      headCommitSha: canonical.headCommitSha,
      lastEditedById: canonical.lastEditedById,
      lastEditedAt: canonical.lastEditedAt,
      createdAt: canonical.createdAt,
    });
  });

  it("keeps a committed move successful when its projection transaction fails", async () => {
    const { project, caller } = await setupProjectWith("Editor", "tmd5");
    await caller.tableFolder.create({
      projectId: project.id,
      parentPath: [],
      name: "Finance",
    });
    const created = await createGroceries(caller, project.id);
    const db = getPrisma();
    // A running writer turns the logged reference into a stored event.
    startDiagnosticWriter({ db, runtime: "web", flushIntervalMs: 60_000 });
    await waitForDiagnosticWriterReady();
    const projectionFailure = vi
      .spyOn(db, "$transaction")
      .mockRejectedValueOnce(new Error("injected move projection failure"));
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    let moved: Awaited<ReturnType<typeof caller.table.move>>;
    try {
      moved = await caller.table.move({
        projectId: project.id,
        tableId: created.id,
        folderPath: ["finance"],
      });
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringMatching(
          /^DataTable projection failed after git commit \(ref [0-9a-f]{8}\)$/,
        ),
        { projectId: project.id, tableId: created.id },
      );
      await flushDiagnostics(true);
      const event = await db.diagnosticEvent.findFirstOrThrow({
        where: { event: "content.projection.failed", projectId: project.id },
      });
      expect(event.details).toMatchObject({
        kind: "table",
        tableId: created.id,
        headCommitSha: moved.headCommitSha,
        error: { message: "injected move projection failure" },
      });
    } finally {
      projectionFailure.mockRestore();
      errorLog.mockRestore();
      await stopDiagnosticWriter();
    }

    expect(moved.path).toBe("tables/finance/groceries.table");
    const repo = (await openProjectRepo(project.id))!;
    await expect(repo.resolveHead()).resolves.toBe(moved.headCommitSha);
    await expect(worktreePathExists(project.id, moved.path)).resolves.toBe(
      true,
    );
    await expect(
      db.dataTable.findUnique({ where: { id: created.id } }),
    ).resolves.toMatchObject({ path: created.path });
  });

  it("moves same-ID Git truth without mutating another project's projection", async () => {
    const owner = await makeUser("User", "tmd5x-owner");
    const foreignProject = await makeProject("T-tmd5x-foreign");
    await addMembership(foreignProject.id, owner.id, "Owner");
    const foreign = await createGroceries(callerFor(owner), foreignProject.id);
    const db = getPrisma();
    const foreignBefore = await db.dataTable.findUniqueOrThrow({
      where: { id: foreign.id },
    });

    const project = await makeProject("T-tmd5x-local");
    await addMembership(project.id, owner.id, "Owner");
    const caller = callerFor(owner);
    await caller.tableFolder.create({
      projectId: project.id,
      parentPath: [],
      name: "Finance",
    });
    await withProjectRepo(project.id, (repo) =>
      commitRawTable(
        repo,
        "tables/local-copy.table",
        foreign.id,
        "Local copy",
        owner,
      ),
    );
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    let moved: Awaited<ReturnType<typeof caller.table.move>>;
    let loaded: Awaited<ReturnType<typeof caller.table.get>>;
    try {
      moved = await caller.table.move({
        projectId: project.id,
        tableId: foreign.id,
        folderPath: ["finance"],
      });
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringMatching(
          /^DataTable projection failed after git commit \(ref (none|[0-9a-f]{8})\)$/,
        ),
        { projectId: project.id, tableId: foreign.id },
      );
      errorLog.mockClear();

      loaded = await caller.table.get({
        projectId: project.id,
        tableId: foreign.id,
      });
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringMatching(
          /^DataTable projection failed after git commit \(ref (none|[0-9a-f]{8})\)$/,
        ),
        { projectId: project.id, tableId: foreign.id },
      );
    } finally {
      errorLog.mockRestore();
    }

    expect(moved.path).toBe("tables/finance/local-copy.table");
    expect(loaded).toMatchObject({
      id: foreign.id,
      path: moved.path,
      slug: moved.slug,
      title: "Local copy",
      rows: [],
      baseCommitSha: moved.headCommitSha,
    });
    const repo = (await openProjectRepo(project.id))!;
    await expect(repo.resolveHead()).resolves.toBe(moved.headCommitSha);
    await expect(worktreePathExists(project.id, moved.path)).resolves.toBe(
      true,
    );
    await expect(
      worktreePathExists(project.id, "tables/local-copy.table"),
    ).resolves.toBe(false);
    await expect(
      db.dataTable.findUnique({ where: { id: foreign.id } }),
    ).resolves.toEqual(foreignBefore);
    await expect(
      db.dataTable.findFirst({
        where: { id: foreign.id, projectId: project.id },
      }),
    ).resolves.toBeNull();
  });

  it("deletes through Git and removes the projection row", async () => {
    const { project, caller, actor } = await setupProjectWith("Editor", "tmd6");
    const created = await createGroceries(caller, project.id);

    await caller.table.delete({
      projectId: project.id,
      tableId: created.id,
      expectedHeadCommitSha: created.headCommitSha,
    });

    await expect(
      getPrisma().dataTable.findUnique({ where: { id: created.id } }),
    ).resolves.toBeNull();
    const repo = (await openProjectRepo(project.id))!;
    await expect(worktreePathExists(project.id, created.path)).resolves.toBe(
      false,
    );
    const [entry] = await repo.logForPath(`${created.path}/schema.json`, {
      skip: 0,
      limit: 1,
    });
    expect(entry).toMatchObject({
      message: `delete: ${created.path}`,
      userId: actor.id,
    });
    await expect(
      caller.table.get({ projectId: project.id, tableId: created.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const deletionSha = await repo.resolveHead();
    expect(knowledgeQueue.jobs).toContainEqual({
      name: "content.delete",
      data: {
        projectId: project.id,
        sourceType: "table",
        sourceId: created.id,
        sourceCommitSha: deletionSha,
      },
    });
  });

  it("recovers the current Git path before deleting a stale projection", async () => {
    const { project, caller, actor } = await setupProjectWith("Editor", "tmd7");
    const created = await createGroceries(caller, project.id);
    const currentPath = "tables/current-before-delete.table";
    await withProjectRepo(project.id, async (repo) => {
      await repo.mv(created.path, currentPath);
      await repo.commitAll("external move before API delete", {
        name: null,
        email: actor.email,
        userId: actor.id,
      });
    });

    await caller.table.delete({
      projectId: project.id,
      tableId: created.id,
      expectedHeadCommitSha: await (await openProjectRepo(
        project.id,
      ))!.resolveHead(),
    });

    const repo = (await openProjectRepo(project.id))!;
    await expect(worktreePathExists(project.id, currentPath)).resolves.toBe(
      false,
    );
    const [entry] = await repo.logForPath(`${currentPath}/schema.json`, {
      skip: 0,
      limit: 1,
    });
    expect(entry!.message).toBe(`delete: ${currentPath}`);
    await expect(
      getPrisma().dataTable.findUnique({ where: { id: created.id } }),
    ).resolves.toBeNull();
  });

  it("deletes from Git truth after its projection row is removed", async () => {
    const { project, caller } = await setupProjectWith("Editor", "tmd7a");
    const created = await createGroceries(caller, project.id);
    const db = getPrisma();
    await db.dataTable.delete({ where: { id: created.id } });

    await caller.table.delete({
      projectId: project.id,
      tableId: created.id,
      expectedHeadCommitSha: created.headCommitSha,
    });

    const repo = (await openProjectRepo(project.id))!;
    await expect(worktreePathExists(project.id, created.path)).resolves.toBe(
      false,
    );
    await expect(
      db.dataTable.findUnique({ where: { id: created.id } }),
    ).resolves.toBeNull();
    const [entry] = await repo.logForPath(`${created.path}/schema.json`, {
      skip: 0,
      limit: 1,
    });
    expect(entry!.message).toBe(`delete: ${created.path}`);
  });

  it("keeps a committed delete successful when its projection transaction fails", async () => {
    const { project, caller } = await setupProjectWith("Editor", "tmd8");
    const created = await createGroceries(caller, project.id);
    const db = getPrisma();
    const projectionFailure = vi
      .spyOn(db, "$transaction")
      .mockRejectedValueOnce(new Error("injected delete projection failure"));
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const repo = (await openProjectRepo(project.id))!;
    try {
      await caller.table.delete({
        projectId: project.id,
        tableId: created.id,
        expectedHeadCommitSha: created.headCommitSha,
      });
      const headCommitSha = await repo.resolveHead();
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringMatching(
          /^DataTable projection failed after git commit \(ref (none|[0-9a-f]{8})\)$/,
        ),
        { projectId: project.id, tableId: created.id },
      );
      expect(headCommitSha).not.toBe(created.headCommitSha);
    } finally {
      projectionFailure.mockRestore();
      errorLog.mockRestore();
    }
    await expect(worktreePathExists(project.id, created.path)).resolves.toBe(
      false,
    );
    await expect(
      db.dataTable.findUnique({ where: { id: created.id } }),
    ).resolves.toMatchObject({ id: created.id });
  });

  it("blocks Viewers and hides missing or nonmember tables", async () => {
    const owner = await makeUser("User", "tmd9-owner");
    const project = await makeProject("T-tmd9");
    await addMembership(project.id, owner.id, "Owner");
    const created = await createGroceries(callerFor(owner), project.id);
    const viewer = await makeUser("User", "tmd9-view");
    await addMembership(project.id, viewer.id, "Viewer");
    await expect(
      callerFor(viewer).table.move({
        projectId: project.id,
        tableId: created.id,
        folderPath: [],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      callerFor(viewer).table.delete({
        expectedHeadCommitSha: "a".repeat(40),
        projectId: project.id,
        tableId: created.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const outsider = await makeUser("User", "tmd9-out");
    await expect(
      callerFor(outsider).table.move({
        projectId: project.id,
        tableId: created.id,
        folderPath: [],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      callerFor(outsider).table.delete({
        expectedHeadCommitSha: "a".repeat(40),
        projectId: project.id,
        tableId: created.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const missingId = randomUUID();
    await expect(
      callerFor(owner).table.move({
        projectId: project.id,
        tableId: missingId,
        folderPath: [],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      callerFor(owner).table.delete({
        expectedHeadCommitSha: "a".repeat(40),
        projectId: project.id,
        tableId: missingId,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("table router — rebuild index", () => {
  beforeEach(async () => {
    await resetDb();
  });

  const externalSchema = (
    id: string,
    title: string,
    columns: TableColumn[] = [],
  ): SchemaFile => ({
    id,
    title,
    sourceOfTruth: "git",
    columns,
    created: "2030-01-01T00:00:00.000Z",
    updated: "2030-01-01T00:00:00.000Z",
  });

  const schemaText = (schema: SchemaFile) =>
    `${JSON.stringify(schema, null, 2)}\n`;

  async function writeRawSnapshot(
    repo: ProjectRepoWriter,
    dir: string,
    schema: SchemaFile,
    data = "",
  ) {
    await repo.writeFileAtomic(`${dir}/schema.json`, schemaText(schema));
    await repo.writeFileAtomic(`${dir}/data.jsonl`, data);
  }

  it("rebuildIndex reproduces incremental projection state", async () => {
    const { project, caller } = await setupProjectWith("Maintainer", "trb1");
    const created = await createGroceries(caller, project.id);
    const doc = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Notes",
      contentJson: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "crossref",
                attrs: {
                  targetType: "table",
                  targetId: created.id,
                  label: null,
                },
              },
            ],
          },
        ],
      },
    });
    const before = await getPrisma().dataTable.findUnique({
      where: { id: created.id },
    });
    const linksBefore = await getPrisma().documentLink.findMany({
      where: { sourceDocumentId: doc.id },
    });

    const report = await caller.table.rebuildIndex({ projectId: project.id });

    expect(report).toEqual({ indexed: 1, skipped: [] });
    expect(knowledgeQueue.jobs).toContainEqual({
      name: "project.reconcile",
      data: { projectId: project.id },
    });
    const after = await getPrisma().dataTable.findUnique({
      where: { id: created.id },
    });
    expect(after).toEqual(before);
    await expect(
      getPrisma().documentLink.findMany({
        where: { sourceDocumentId: doc.id },
      }),
    ).resolves.toEqual(linksBefore);
  });

  it("skips invalid, incomplete, over-cap, duplicate, and foreign snapshots without touching Git", async () => {
    const { project, caller, actor } = await setupProjectWith(
      "Maintainer",
      "trb2",
    );
    const good = await createGroceries(caller, project.id);
    const source = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Source",
      contentJson: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "crossref",
                attrs: {
                  targetType: "table",
                  targetId: good.id,
                  label: null,
                },
              },
            ],
          },
        ],
      },
    });
    const foreignContext = await setupProjectWith("Editor", "trb2-foreign");
    const foreign = await createGroceries(
      foreignContext.caller,
      foreignContext.project.id,
    );
    const foreignBefore = await getPrisma().dataTable.findUniqueOrThrow({
      where: { id: foreign.id },
    });
    const ids = Array.from({ length: 13 }, () => randomUUID());
    const overColumns = Array.from({ length: 101 }, (_, index) => ({
      id: randomUUID(),
      name: `Column ${index}`,
      type: "text" as const,
    }));
    const selectColumn: TableColumn = {
      id: randomUUID(),
      name: "Choice",
      type: "select",
      options: Array.from({ length: 201 }, (_, index) => ({
        id: randomUUID(),
        label: `Option ${index}`,
      })),
    };
    const textColumn: TableColumn = {
      id: randomUUID(),
      name: "Text",
      type: "text",
    };
    const numberColumn: TableColumn = {
      id: randomUUID(),
      name: "Number",
      type: "number",
    };
    const rowId = randomUUID();
    const overRows = Array.from({ length: 10_001 }, () =>
      JSON.stringify({ id: randomUUID(), cells: {} }),
    ).join("\n");
    const deepDir = `tables/${Array.from({ length: 11 }, (_, index) => `d${index}`).join("/")}/deep.table`;

    await withProjectRepo(project.id, async (repo) => {
      await writeRawSnapshot(
        repo,
        "tables/Bad/upper.table",
        externalSchema(ids[0]!, "Upper path"),
      );
      await repo.writeFileAtomic(
        "tables/broken.table/schema.json",
        "{ broken json\n",
      );
      await repo.writeFileAtomic("tables/broken.table/data.jsonl", "");
      await writeRawSnapshot(
        repo,
        "tables/columns.table",
        externalSchema(ids[1]!, "Too many columns", overColumns),
      );
      await writeRawSnapshot(
        repo,
        "tables/data-too-large.table",
        externalSchema(ids[2]!, "Data too large"),
        "x".repeat(5_000_001),
      );
      await writeRawSnapshot(
        repo,
        deepDir,
        externalSchema(ids[3]!, "Too deep"),
      );
      await writeRawSnapshot(
        repo,
        "tables/duplicate-rows.table",
        externalSchema(ids[4]!, "Duplicate rows"),
        `${JSON.stringify({ id: rowId, cells: {} })}\n${JSON.stringify({ id: rowId, cells: {} })}\n`,
      );
      await writeRawSnapshot(
        repo,
        "tables/foreign.table",
        externalSchema(foreign.id, "Foreign copy"),
      );
      await repo.writeFileAtomic(
        "tables/incomplete.table/schema.json",
        schemaText(externalSchema(ids[5]!, "Incomplete")),
      );
      await repo.writeFileAtomic("tables/data-only.table/data.jsonl", "");
      await writeRawSnapshot(
        repo,
        "tables/extra.table",
        externalSchema(ids[12]!, "Extra file"),
      );
      await repo.writeFileAtomic("tables/extra.table/notes.md", "extra\n");
      await writeRawSnapshot(repo, "tables/invalid-id.table", {
        ...externalSchema(ids[6]!, "Invalid id"),
        id: "not-a-uuid",
      });
      await writeRawSnapshot(
        repo,
        "tables/options.table",
        externalSchema(ids[7]!, "Too many options", [selectColumn]),
      );
      await writeRawSnapshot(
        repo,
        "tables/rows.table",
        externalSchema(ids[8]!, "Too many rows"),
        `${overRows}\n`,
      );
      await repo.writeFileAtomic(
        "tables/schema-too-large.table/schema.json",
        "x".repeat(250_001),
      );
      await repo.writeFileAtomic(
        "tables/schema-too-large.table/data.jsonl",
        "",
      );
      await writeRawSnapshot(
        repo,
        "tables/string.table",
        externalSchema(ids[9]!, "String too long", [textColumn]),
        `${JSON.stringify({ id: randomUUID(), cells: { [textColumn.id]: "x".repeat(10_001) } })}\n`,
      );
      await writeRawSnapshot(
        repo,
        "tables/type.table",
        externalSchema(ids[10]!, "Wrong cell type", [numberColumn]),
        `${JSON.stringify({ id: randomUUID(), cells: { [numberColumn.id]: "wrong" } })}\n`,
      );
      await writeRawSnapshot(
        repo,
        "tables/z/groceries.table",
        externalSchema(ids[11]!, "Duplicate slug"),
      );
      await writeRawSnapshot(
        repo,
        "tables/z-duplicate.table",
        externalSchema(good.id, "Duplicate id"),
      );
      await repo.commitAll("external rebuild skip cases", {
        name: null,
        email: actor.email,
        userId: actor.id,
      });
    });

    const repo = (await openProjectRepo(project.id))!;
    const projectRepoDir = repoDir(project.id);
    await writeFile(
      `${projectRepoDir}/${good.path}/schema.json`,
      "dirty tracked bytes\n",
    );
    await writeFile(`${projectRepoDir}/untracked.tmp`, "untracked bytes\n");
    const gitStatus = async () =>
      (
        await execFileAsync("git", ["status", "--porcelain=v1"], {
          cwd: projectRepoDir,
        })
      ).stdout;
    const beforeGit = {
      head: await repo.resolveHead(),
      status: await gitStatus(),
      dirty: await readFile(
        `${projectRepoDir}/${good.path}/schema.json`,
        "utf8",
      ),
      untracked: await readFile(`${projectRepoDir}/untracked.tmp`, "utf8"),
    };
    const goodBefore = await getPrisma().dataTable.findUniqueOrThrow({
      where: { id: good.id },
    });
    const linksBefore = await getPrisma().documentLink.findMany({
      where: { sourceDocumentId: source.id },
    });

    const report = await caller.table.rebuildIndex({ projectId: project.id });

    expect(report.indexed).toBe(1);
    const skipped = new Map(
      report.skipped.map(({ path: tablePath, reason }) => [tablePath, reason]),
    );
    expect(skipped.get("tables/Bad/upper.table")).toContain(
      "invalid table path",
    );
    expect(skipped.get("tables/broken.table")).toContain("invalid JSON");
    expect(skipped.get("tables/columns.table")).toContain("too many columns");
    expect(skipped.get("tables/data-too-large.table")).toContain(
      "data.jsonl exceeds the size cap",
    );
    expect(skipped.get(deepDir)).toContain("invalid table path");
    expect(skipped.get("tables/duplicate-rows.table")).toContain(
      "duplicate row id",
    );
    expect(skipped.get("tables/foreign.table")).toContain(
      "belongs to another project",
    );
    expect(skipped.get("tables/incomplete.table")).toContain(
      "exactly schema.json and data.jsonl",
    );
    expect(skipped.get("tables/data-only.table")).toContain(
      "exactly schema.json and data.jsonl",
    );
    expect(skipped.get("tables/extra.table")).toContain(
      "exactly schema.json and data.jsonl",
    );
    expect(skipped.get("tables/invalid-id.table")).toContain(
      "invalid table id",
    );
    expect(skipped.get("tables/options.table")).toContain(
      "invalid select/multiselect options",
    );
    expect(skipped.get("tables/rows.table")).toContain("10,000 rows");
    expect(skipped.get("tables/schema-too-large.table")).toContain(
      "schema.json exceeds the size cap",
    );
    expect(skipped.get("tables/string.table")).toContain(
      "cell text exceeds 10000 characters",
    );
    expect(skipped.get("tables/type.table")).toContain(
      "invalid value for type number",
    );
    expect(skipped.get("tables/z/groceries.table")).toContain(
      "duplicate slug groceries",
    );
    expect(skipped.get("tables/z-duplicate.table")).toContain(
      `duplicate id ${good.id}`,
    );
    await expect(
      caller.table.get({ projectId: project.id, tableId: ids[12]! }),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    await expect(
      getPrisma().dataTable.findUnique({ where: { id: ids[12]! } }),
    ).resolves.toBeNull();
    await expect(
      getPrisma().dataTable.findMany({
        where: { projectId: project.id },
        orderBy: { path: "asc" },
      }),
    ).resolves.toEqual([goodBefore]);
    await expect(
      getPrisma().dataTable.findUnique({ where: { id: foreign.id } }),
    ).resolves.toEqual(foreignBefore);
    await expect(
      getPrisma().documentLink.findMany({
        where: { sourceDocumentId: source.id },
      }),
    ).resolves.toEqual(linksBefore);
    expect({
      head: await repo.resolveHead(),
      status: await gitStatus(),
      dirty: await readFile(
        `${projectRepoDir}/${good.path}/schema.json`,
        "utf8",
      ),
      untracked: await readFile(`${projectRepoDir}/untracked.tmp`, "utf8"),
    }).toEqual(beforeGit);
  });

  it("uses the last ancestry-ordered schema or data commit for rebuild metadata", async () => {
    const { project, caller } = await setupProjectWith("Maintainer", "trb3");
    const created = await createGroceries(caller, project.id);
    const dataAuthor = await makeUser("User", "trb3-data");
    const schemaAuthor = await makeUser("User", "trb3-schema");
    const timestamp = "2031-01-01T00:00:00.000Z";
    let schema!: SchemaFile;
    const schemaSha = await withProjectRepo(project.id, async (repo) => {
      await repo.writeFileAtomic(
        `${created.path}/data.jsonl`,
        `${JSON.stringify({ id: randomUUID(), cells: {} })}\n`,
      );
      await commitAt(repo, "external data update", dataAuthor, timestamp);
      schema = JSON.parse(
        await repo.showFileAt("HEAD", `${created.path}/schema.json`),
      ) as SchemaFile;
      schema.title = "Externally renamed";
      schema.updated = "2031-01-01T00:00:00.000Z";
      await repo.writeFileAtomic(
        `${created.path}/schema.json`,
        schemaText(schema),
      );
      return commitAt(repo, "external schema update", schemaAuthor, timestamp);
    });
    await getPrisma().dataTable.update({
      where: { id: created.id },
      data: {
        title: "Stale",
        rowCount: 999,
        headCommitSha: "0".repeat(40),
        lastEditedById: null,
        lastEditedAt: new Date(0),
      },
    });

    await expect(
      caller.table.rebuildIndex({ projectId: project.id }),
    ).resolves.toEqual({ indexed: 1, skipped: [] });
    await expect(
      getPrisma().dataTable.findUnique({ where: { id: created.id } }),
    ).resolves.toMatchObject({
      title: "Externally renamed",
      rowCount: 1,
      headCommitSha: schemaSha,
      lastEditedById: null,
      createdAt: new Date(schema.created),
    });
  });

  it("reports an id claimed by another project after the scan", async () => {
    const { project, caller, actor } = await setupProjectWith(
      "Maintainer",
      "trb-race",
    );
    const foreignContext = await setupProjectWith("Editor", "trb-race-foreign");
    const tableId = randomUUID();
    const tablePath = "tables/raced.table";
    await withProjectRepo(project.id, (repo) =>
      commitRawTable(repo, tablePath, tableId, "Raced", actor),
    );
    const db = getPrisma();
    const originalTransaction = db.$transaction.bind(db) as unknown as (
      ...args: unknown[]
    ) => Promise<unknown>;
    let foreignRow: Awaited<ReturnType<typeof db.dataTable.create>> | undefined;
    const transactionSpy = vi
      .spyOn(db, "$transaction")
      .mockImplementationOnce((async (...args: unknown[]) => {
        foreignRow = await db.dataTable.create({
          data: {
            id: tableId,
            projectId: foreignContext.project.id,
            path: "tables/foreign-owner.table",
            slug: "foreign-owner",
            title: "Foreign owner",
            rowCount: 0,
            headCommitSha: "2".repeat(40),
            lastEditedById: foreignContext.actor.id,
            lastEditedAt: new Date("2030-01-02T00:00:00.000Z"),
            createdAt: new Date("2030-01-02T00:00:00.000Z"),
          },
        });
        return originalTransaction(...args);
      }) as never);

    let report;
    try {
      report = await caller.table.rebuildIndex({ projectId: project.id });
    } finally {
      transactionSpy.mockRestore();
    }

    expect(report).toEqual({
      indexed: 0,
      skipped: [
        {
          path: tablePath,
          reason: `id ${tableId} belongs to another project`,
        },
      ],
    });
    await expect(
      db.dataTable.findUnique({ where: { id: tableId } }),
    ).resolves.toEqual(foreignRow);
    await expect(
      db.dataTable.findMany({ where: { projectId: project.id } }),
    ).resolves.toEqual([]);
  });

  it("pins one HEAD while scanning", async () => {
    const { project, caller, actor } = await setupProjectWith(
      "Maintainer",
      "trb4",
    );
    const created = await createGroceries(caller, project.id);
    const before = await getPrisma().dataTable.findMany({
      where: { projectId: project.id },
      orderBy: { path: "asc" },
    });
    const repo = (await openProjectRepo(project.id))!;
    const beforeHead = await repo.resolveHead();
    const addedId = randomUUID();
    const originalWithExistingProjectRepoReader =
      gitStore.withExistingProjectRepoReader;
    let advanced = false;
    const existingSpy = vi
      .spyOn(gitStore, "withExistingProjectRepoReader")
      .mockImplementation((projectId, fn) =>
        originalWithExistingProjectRepoReader(projectId, async (lockedRepo) => {
          if (projectId !== project.id) return fn(lockedRepo);
          return fn({
            ...lockedRepo,
            listTrackedFiles: async (commitish = "HEAD") => {
              const files = await lockedRepo.listTrackedFiles(commitish);
              if (!advanced) {
                advanced = true;
                const dir = pathForProject(
                  project.id,
                  "tables/added-during-rebuild.table",
                );
                await mkdir(dir, { recursive: true });
                await writeFile(
                  `${dir}/schema.json`,
                  schemaText(externalSchema(addedId, "Added during rebuild")),
                );
                await writeFile(`${dir}/data.jsonl`, "");
                const env = {
                  ...process.env,
                  GIT_AUTHOR_NAME: "Table Test",
                  GIT_AUTHOR_EMAIL: actor.email,
                  GIT_COMMITTER_NAME: "Weaver",
                  GIT_COMMITTER_EMAIL: "weaver@local",
                };
                const cwd = repoDir(project.id);
                await execFileAsync("git", ["add", "-A"], { cwd, env });
                await execFileAsync(
                  "git",
                  [
                    "commit",
                    "-m",
                    "external concurrent table",
                    "--trailer",
                    `Weaver-User-Id: ${actor.id}`,
                  ],
                  { cwd, env },
                );
              }
              return files;
            },
          });
        }),
      );

    try {
      await expect(
        caller.table.rebuildIndex({ projectId: project.id }),
      ).resolves.toEqual({ indexed: 1, skipped: [] });
    } finally {
      existingSpy.mockRestore();
    }
    expect(advanced).toBe(true);
    await expect(
      getPrisma().dataTable.findMany({
        where: { projectId: project.id },
        orderBy: { path: "asc" },
      }),
    ).resolves.toEqual(before);
    expect(await repo.resolveHead()).not.toBe(beforeHead);
    await expect(
      repo.blobShaAt("HEAD", "tables/added-during-rebuild.table/schema.json"),
    ).resolves.not.toBeNull();
    await expect(
      getPrisma().dataTable.findUnique({ where: { id: addedId } }),
    ).resolves.toBeNull();
    await expect(
      getPrisma().dataTable.findUnique({ where: { id: created.id } }),
    ).resolves.toEqual(before[0]);
  });

  it("serializes a writer behind the existing-project rebuild mutex", async () => {
    const { project, caller } = await setupProjectWith("Maintainer", "trb5");
    const created = await createGroceries(caller, project.id);
    const db = getPrisma();
    const originalTransaction = db.$transaction.bind(db) as unknown as (
      ...args: unknown[]
    ) => Promise<unknown>;
    let releaseRebuild!: () => void;
    const rebuildRelease = new Promise<void>((resolve) => {
      releaseRebuild = resolve;
    });
    let markRebuildPaused!: () => void;
    const rebuildPaused = new Promise<void>((resolve) => {
      markRebuildPaused = resolve;
    });
    let pauseNextTransaction = true;
    const transactionSpy = vi
      .spyOn(db, "$transaction")
      .mockImplementation((async (...args: unknown[]) => {
        if (pauseNextTransaction) {
          pauseNextTransaction = false;
          markRebuildPaused();
          await rebuildRelease;
        }
        return originalTransaction(...args);
      }) as never);
    const originalWithProjectRepo = gitStore.withProjectRepo;
    let markWriterRequested!: () => void;
    const writerRequested = new Promise<void>((resolve) => {
      markWriterRequested = resolve;
    });
    let markWriterEntered!: () => void;
    const writerEntry = new Promise<void>((resolve) => {
      markWriterEntered = resolve;
    });
    const writerSpy = vi
      .spyOn(gitStore, "withProjectRepo")
      .mockImplementation((projectId, fn) => {
        markWriterRequested();
        return originalWithProjectRepo(projectId, async (repo) => {
          markWriterEntered();
          return fn(repo);
        });
      });

    let rebuildPromise: ReturnType<typeof caller.table.rebuildIndex>;
    let writerPromise: ReturnType<typeof caller.table.save> | undefined;
    let writerEnteredBeforeRelease = true;
    let saved: Awaited<ReturnType<typeof caller.table.save>> | undefined;
    try {
      rebuildPromise = caller.table.rebuildIndex({ projectId: project.id });
      await Promise.race([
        rebuildPaused,
        rebuildPromise.then(() => {
          throw new Error("rebuild completed before entering its transaction");
        }),
      ]);
      writerPromise = caller.table.save({
        projectId: project.id,
        tableId: created.id,
        baseCommitSha: created.headCommitSha,
        columns: [TEXT_COL, NUM_COL],
        rows: [{ id: ROW_1, cells: { [TEXT_COL.id]: "new" } }],
      });
      await writerRequested;
      let entryTimeout: ReturnType<typeof setTimeout> | undefined;
      writerEnteredBeforeRelease = await Promise.race([
        writerEntry.then(() => true),
        new Promise<false>((resolve) => {
          entryTimeout = setTimeout(() => resolve(false), 1_000);
        }),
      ]);
      if (entryTimeout) clearTimeout(entryTimeout);
      releaseRebuild();
      [, saved] = await Promise.all([rebuildPromise, writerPromise]);
    } finally {
      releaseRebuild();
      const pending: Promise<unknown>[] = [rebuildPromise!];
      if (writerPromise) pending.push(writerPromise);
      await Promise.allSettled(pending);
      transactionSpy.mockRestore();
      writerSpy.mockRestore();
    }

    expect(writerEnteredBeforeRelease).toBe(false);
    await expect(
      db.dataTable.findUnique({ where: { id: created.id } }),
    ).resolves.toMatchObject({
      rowCount: 1,
      headCommitSha: saved!.headCommitSha,
    });
  });

  it("leaves the projection untouched when the project repository is absent", async () => {
    const { project, caller, actor } = await setupProjectWith(
      "Maintainer",
      "trb6",
    );
    const id = randomUUID();
    const row = await getPrisma().dataTable.create({
      data: {
        id,
        projectId: project.id,
        path: "tables/orphan.table",
        slug: "orphan",
        title: "Orphan",
        rowCount: 7,
        headCommitSha: "1".repeat(40),
        lastEditedById: actor.id,
        lastEditedAt: new Date("2026-08-29T12:34:56.000Z"),
        createdAt: new Date("2026-08-29T12:34:56.000Z"),
      },
    });

    await expect(
      caller.table.rebuildIndex({ projectId: project.id }),
    ).resolves.toEqual({
      indexed: 0,
      skipped: [{ path: "", reason: "project repository not found" }],
    });
    await expect(
      getPrisma().dataTable.findUnique({ where: { id } }),
    ).resolves.toEqual(row);
    await expect(openProjectRepo(project.id)).resolves.toBeNull();
  });

  it("rebuildIndex requires Maintainer+", async () => {
    const { project, caller } = await setupProjectWith("Editor", "trb7");
    await expect(
      caller.table.rebuildIndex({ projectId: project.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("table review regressions", () => {
  beforeEach(async () => {
    await resetDb();
  });
  it("rejects deletion when the confirmed table revision changed", async () => {
    const { project, caller } = await setupProjectWith(
      "Editor",
      "review-delete",
    );
    const created = await caller.table.create({
      projectId: project.id,
      folderPath: [],
      title: "Guarded",
    });
    const saved = await caller.table.save({
      projectId: project.id,
      tableId: created.id,
      baseCommitSha: created.headCommitSha,
      title: "Changed",
      columns: [],
      rows: [],
    });
    await expect(
      caller.table.delete({
        projectId: project.id,
        tableId: created.id,
        expectedHeadCommitSha: created.headCommitSha,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      (await caller.table.get({ projectId: project.id, tableId: created.id }))
        .baseCommitSha,
    ).toBe(saved.headCommitSha);
  });
});

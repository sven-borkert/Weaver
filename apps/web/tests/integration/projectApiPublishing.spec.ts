import type { ProjectRepoWriter } from "@weaver/git-store";
import * as projectRepos from "@weaver/core/services/projectRepo";
import { machineReceiptSchema } from "@weaver/core/projectApi/contracts";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import {
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  afterAll,
  vi,
} from "vitest";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import { publishProjectMachineContent } from "@weaver/core/services/projectApi";
import { closeProjectApiOperationPool } from "@weaver/core/projectApi/operationLock";
import { queryProjectMachineContent } from "@weaver/core/projectApi/queries";
import {
  makeMachineFixture,
  seedProjectMachineKey,
} from "./_projectApiHarness";
import { resetDb } from "./_harness";
import { withProjectRepo } from "@weaver/core/services/projectRepo";
import { loadFolderIdentityIndex } from "@weaver/core/projectApi/folderIdentity";
import { moveDocument } from "@weaver/core/services/documents";
async function failAfterCommit(operation: () => Promise<unknown>) {
  const original = projectRepos.withProjectRepo;
  const injected = vi
    .spyOn(projectRepos, "withProjectRepo")
    .mockImplementation(async function <T>(
      projectId: string,
      fn: (repo: ProjectRepoWriter) => Promise<T>,
    ): Promise<T> {
      return original(projectId, async (repo) => {
        const commit = repo.commitAll.bind(repo);
        return fn({
          ...repo,
          commitAll: async (...args: Parameters<typeof commit>) => {
            await commit(...args);
            throw new Error("Process failed after durable commit");
          },
        });
      });
    });
  try {
    await expect(operation()).rejects.toThrow(
      "Process failed after durable commit",
    );
  } finally {
    injected.mockRestore();
  }
}
describe("project machine publishing", () => {
  beforeEach(resetDb);
  afterAll(closeProjectApiOperationPool);
  afterEach(() => setJobQueueForTests(null));
  it.each([
    ["document", "none"],
    ["table", "none"],
    ["document", "update"],
    ["table", "update"],
    ["document", "delete"],
    ["table", "delete"],
  ] as const)(
    "repairs %s creation after a failure immediately after the Git commit and later %s",
    async (kind, later) => {
      const queue = new FakeJobQueue();
      setJobQueueForTests(queue);
      const f = await makeMachineFixture();
      const k = await seedProjectMachineKey(f, [
        {
          kind: kind === "document" ? "documentFolder" : "tableFolder",
          targetId: null,
          root: true,
          actions: ["create", "update", "delete"],
        },
      ]);
      const command =
        kind === "document"
          ? {
              kind: "document.create" as const,
              title: "Recovered report",
              markdown: "Accepted report",
              folder: { root: true as const },
            }
          : {
              kind: "table.create" as const,
              title: "Recovered report",
              columns: [],
              rows: [],
              folder: { root: true as const },
            };
      const meta = {
        requestId: randomUUID(),
        method: "POST" as const,
        idempotencyKey: randomUUID(),
        ifMatch: null,
      };
      await failAfterCommit(() =>
        publishProjectMachineContent(f.db, k.context, command, meta),
      );
      const reservation = await f.db.projectApiOperation.findFirstOrThrow({
        where: { keyId: k.keyId },
      });
      expect(reservation.state).toBe("reserved");
      const readProjection = () =>
        kind === "document"
          ? f.db.document.findUnique({ where: { id: reservation.resourceId! } })
          : f.db.dataTable.findUnique({
              where: { id: reservation.resourceId! },
            });
      expect(await readProjection()).toBeNull();
      let currentRevision = await withProjectRepo(f.project.id, (repo) =>
        repo.resolveHead(),
      );
      if (later !== "none") {
        const next =
          later === "delete"
            ? {
                kind:
                  kind === "document"
                    ? ("document.delete" as const)
                    : ("table.delete" as const),
                id: reservation.resourceId!,
              }
            : kind === "document"
              ? {
                  kind: "document.replace" as const,
                  id: reservation.resourceId!,
                  title: "Newer report",
                  markdown: "Newer body",
                }
              : {
                  kind: "table.replace" as const,
                  id: reservation.resourceId!,
                  title: "Newer report",
                  columns: [],
                  rows: [],
                };
        const receipt = await publishProjectMachineContent(
          f.db,
          k.context,
          next,
          {
            ...meta,
            method: later === "delete" ? "DELETE" : "PUT",
            idempotencyKey: randomUUID(),
            ifMatch: `"${currentRevision}"`,
          },
        );
        currentRevision = receipt.revision;
      }
      const head = await withProjectRepo(f.project.id, (repo) =>
        repo.resolveHead(),
      );
      queue.jobs.length = 0;
      const replay = await publishProjectMachineContent(
        f.db,
        k.context,
        command,
        meta,
      );
      expect(replay.replayed).toBe(true);
      if (later === "delete") expect(await readProjection()).toBeNull();
      else
        expect(await readProjection()).toMatchObject({
          title: later === "update" ? "Newer report" : "Recovered report",
          headCommitSha: currentRevision,
          lastEditedByProjectKeyId: k.keyId,
          lastEditedByMachineKind: "projectApiKey",
          lastEditedByMachineId: k.keyId,
        });
      expect(queue.jobs).toContainEqual(
        later === "delete"
          ? {
              name: "content.delete",
              data: {
                projectId: f.project.id,
                sourceType: kind,
                sourceId: replay.resourceId,
                sourceCommitSha: currentRevision,
              },
            }
          : {
              name: `${kind}.search-sync`,
              data: {
                projectId: f.project.id,
                [kind === "document" ? "documentId" : "tableId"]:
                  replay.resourceId,
                sourceCommitSha: currentRevision,
                pathAtSha:
                  later === "update"
                    ? kind === "document"
                      ? "newer-report.md"
                      : "tables/newer-report.table"
                    : replay.path,
              },
            },
      );
      expect(
        await withProjectRepo(f.project.id, (repo) => repo.resolveHead()),
      ).toBe(head);
    },
  );
  it.each(["document", "table"] as const)(
    "cleans up the %s projection after a committed deletion loses its response",
    async (kind) => {
      const queue = new FakeJobQueue();
      setJobQueueForTests(queue);
      const f = await makeMachineFixture();
      const resource = kind === "document" ? f.document : f.table;
      const k = await seedProjectMachineKey(f, [
        { kind, targetId: resource.id, root: false, actions: ["delete"] },
      ]);
      const command = {
        kind:
          kind === "document"
            ? ("document.delete" as const)
            : ("table.delete" as const),
        id: resource.id,
      };
      const meta = {
        requestId: randomUUID(),
        method: "DELETE" as const,
        idempotencyKey: randomUUID(),
        ifMatch: `"${resource.headCommitSha}"`,
      };
      await failAfterCommit(() =>
        publishProjectMachineContent(f.db, k.context, command, meta),
      );
      const readProjection = () =>
        kind === "document"
          ? f.db.document.findUnique({ where: { id: resource.id } })
          : f.db.dataTable.findUnique({ where: { id: resource.id } });
      expect(await readProjection()).not.toBeNull();
      const head = await withProjectRepo(f.project.id, (repo) =>
        repo.resolveHead(),
      );
      const replay = await publishProjectMachineContent(
        f.db,
        k.context,
        command,
        meta,
      );
      expect(replay.replayed).toBe(true);
      expect(await readProjection()).toBeNull();
      expect(queue.jobs).toContainEqual({
        name: "content.delete",
        data: {
          projectId: f.project.id,
          sourceType: kind,
          sourceId: resource.id,
          sourceCommitSha: head,
        },
      });
      expect(
        await withProjectRepo(f.project.id, (repo) => repo.resolveHead()),
      ).toBe(head);
    },
  );
  it("keeps a live document and its reservation when projection recovery cannot read Git", async () => {
    const f = await makeMachineFixture();
    const k = await seedProjectMachineKey(f, [
      {
        kind: "document",
        targetId: f.document.id,
        root: false,
        actions: ["update"],
      },
    ]);
    const command = {
      kind: "document.replace" as const,
      id: f.document.id,
      markdown: "Committed update",
    };
    const meta = {
      requestId: randomUUID(),
      method: "PUT" as const,
      idempotencyKey: randomUUID(),
      ifMatch: `"${f.document.headCommitSha}"`,
    };
    await failAfterCommit(() =>
      publishProjectMachineContent(f.db, k.context, command, meta),
    );
    const original = projectRepos.withProjectRepo;
    const injected = vi
      .spyOn(projectRepos, "withProjectRepo")
      .mockImplementation(async function <T>(
        projectId: string,
        fn: (repo: ProjectRepoWriter) => Promise<T>,
      ): Promise<T> {
        return original(projectId, (repo) =>
          fn({
            ...repo,
            blobSizeAt: async () => {
              throw new Error("Transient Git read failure");
            },
          }),
        );
      });
    try {
      await expect(
        publishProjectMachineContent(f.db, k.context, command, meta),
      ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
      expect(
        await f.db.document.findUnique({ where: { id: f.document.id } }),
      ).not.toBeNull();
      expect(
        await f.db.projectApiOperation.findFirst({ where: { keyId: k.keyId } }),
      ).toMatchObject({ state: "reserved" });
    } finally {
      injected.mockRestore();
    }
    const replay = await publishProjectMachineContent(
      f.db,
      k.context,
      command,
      meta,
    );
    expect(replay.replayed).toBe(true);
    expect(
      await f.db.document.findUnique({ where: { id: f.document.id } }),
    ).toMatchObject({ headCommitSha: replay.revision });
  });
  it("reauthorizes creation receipts against the resource's current folder", async () => {
    const f = await makeMachineFixture();
    const folderId = await withProjectRepo(
      f.project.id,
      async (repo) =>
        (
          await loadFolderIdentityIndex(
            repo,
            f.project.id,
            "documents",
            await repo.resolveHead(),
          )
        ).entries.find((e) => e.path.join("/") === f.documentFolder.join("/"))!
          .id,
    );
    const k = await seedProjectMachineKey(f, [
      {
        kind: "documentFolder",
        targetId: folderId,
        root: false,
        actions: ["create"],
      },
    ]);
    const command = {
      kind: "document.create" as const,
      folder: { id: folderId },
      title: "Dated audit",
      markdown: "Reviewed",
    };
    const meta = {
      requestId: randomUUID(),
      idempotencyKey: "moved-created-audit",
      method: "POST" as const,
      ifMatch: null,
    };
    const receipt = await publishProjectMachineContent(
      f.db,
      k.context,
      command,
      meta,
    );
    await moveDocument(
      f.db,
      {
        projectId: f.project.id,
        documentId: receipt.resourceId,
        folderPath: [],
      },
      f.actor,
    );
    await expect(
      publishProjectMachineContent(f.db, k.context, command, meta),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("lets a request cancelled before its commit be retried with the same key", async () => {
    const f = await makeMachineFixture();
    const k = await seedProjectMachineKey(f, [
      {
        kind: "documentFolder",
        targetId: null,
        root: true,
        actions: ["create"],
      },
    ]);
    const command = {
      kind: "document.create" as const,
      folder: { root: true as const },
      title: "Cancelled audit",
      markdown: "Reviewed",
    };
    let checks = 0;
    // Not aborted at admission; aborted by the time the commit guard runs.
    const disconnecting = {
      get aborted() {
        checks += 1;
        return checks > 1;
      },
    } as AbortSignal;
    const meta = {
      requestId: randomUUID(),
      idempotencyKey: "cancelled-audit-0001",
      method: "POST" as const,
      ifMatch: null,
    };
    const head = await withProjectRepo(f.project.id, (r) => r.resolveHead());
    await expect(
      publishProjectMachineContent(f.db, k.context, command, {
        ...meta,
        signal: disconnecting,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await withProjectRepo(f.project.id, (r) => r.resolveHead())).toBe(
      head,
    );
    expect(await f.db.projectApiOperation.count()).toBe(0);
    const retried = await publishProjectMachineContent(
      f.db,
      k.context,
      command,
      meta,
    );
    expect(retried.replayed).toBe(false);
    expect(
      await f.db.document.count({
        where: { projectId: f.project.id, title: "Cancelled audit" },
      }),
    ).toBe(1);
  });
  it("serializes retries from separate processes with each lock pool limited to one connection", async () => {
    const f = await makeMachineFixture();
    const k = await seedProjectMachineKey(f, [
      { kind: "table", targetId: f.table.id, root: false, actions: ["create"] },
    ]);
    const input = JSON.stringify({
      context: k.context,
      command: { kind: "rows.append", id: f.table.id, rows: [{ cells: {} }] },
      meta: {
        requestId: randomUUID(),
        idempotencyKey: "cross-process-append-key",
        method: "POST",
        ifMatch: `"${f.table.headCommitSha}"`,
      },
    });
    const worker = fileURLToPath(
      new URL("./fixtures/project-api-operation-worker.ts", import.meta.url),
    );
    const children = [0, 1].map(() =>
      execa(process.execPath, ["--import=tsx", worker, input], {
        cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
        timeout: 20_000,
        cleanup: true,
        env: {
          WEAVER_PROJECT_API_OPERATION_LOCK_POOL_MAX: "1",
          WEAVER_GIT_LOCK_POOL_MAX: "1",
          DATABASE_POOL_MAX: "1",
        },
      }),
    );
    try {
      const receipts = (await Promise.all(children)).map((r) =>
        machineReceiptSchema.parse(JSON.parse(r.stdout)),
      );
      expect(receipts[0]!.revision).toBe(receipts[1]!.revision);
      expect(receipts.map((r) => r.replayed).sort()).toEqual([false, true]);
      expect(
        (await f.db.dataTable.findUniqueOrThrow({ where: { id: f.table.id } }))
          .rowCount,
      ).toBe(f.table.rows.length + 1);
    } finally {
      await Promise.all(
        children.map(async (child) => {
          if (child.exitCode === null) child.kill("SIGKILL");
          await child.catch(() => undefined);
        }),
      );
    }
  }, 30_000);
  it("recovers a committed dated report after receipt settlement fails without creating it twice", async () => {
    const f = await makeMachineFixture();
    const k = await seedProjectMachineKey(f, [
      {
        kind: "documentFolder",
        targetId: null,
        root: true,
        actions: ["create"],
      },
    ]);
    const command = {
      kind: "document.create" as const,
      folder: { root: true as const },
      title: "Audit 2026-10-13",
      markdown: "Reviewed daily",
    };
    const meta = {
      requestId: randomUUID(),
      idempotencyKey: "dated-report-20261013",
      method: "POST" as const,
      ifMatch: null,
    };
    const spy = vi
      .spyOn(f.db.projectApiOperation, "update")
      .mockRejectedValueOnce(new Error("simulated acknowledgement failure"));
    await expect(
      publishProjectMachineContent(f.db, k.context, command, meta),
    ).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      details: { reason: "RECEIPT_PENDING" },
    });
    spy.mockRestore();
    const head = await withProjectRepo(f.project.id, (r) => r.resolveHead());
    const replay = await publishProjectMachineContent(
      f.db,
      k.context,
      command,
      meta,
    );
    expect(replay.replayed).toBe(true);
    expect(replay.path).toBe("audit-2026-10-13.md");
    expect(await withProjectRepo(f.project.id, (r) => r.resolveHead())).toBe(
      head,
    );
    expect(
      await f.db.document.count({
        where: { projectId: f.project.id, title: command.title },
      }),
    ).toBe(1);
  });
  it("requires Create and Delete for replacement deltas and checks typed references before reserving", async () => {
    const f = await makeMachineFixture();
    const k = await seedProjectMachineKey(f, [
      { kind: "table", targetId: f.table.id, root: false, actions: ["update"] },
    ]);
    const meta = {
      requestId: randomUUID(),
      idempotencyKey: "replacement-with-extra-row",
      method: "PUT" as const,
      ifMatch: `"${f.table.headCommitSha}"`,
    };
    await expect(
      publishProjectMachineContent(
        f.db,
        k.context,
        {
          kind: "table.replace",
          id: f.table.id,
          columns: f.table.columns,
          rows: [...f.table.rows, { id: randomUUID(), cells: {} }],
        },
        meta,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      publishProjectMachineContent(
        f.db,
        k.context,
        {
          kind: "table.replace",
          id: f.table.id,
          columns: f.table.columns,
          rows: [],
        },
        { ...meta, idempotencyKey: "replacement-deleting-row" },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const documentKey = await seedProjectMachineKey(f, [
      {
        kind: "document",
        targetId: f.document.id,
        root: false,
        actions: ["update"],
      },
    ]);
    await expect(
      publishProjectMachineContent(
        f.db,
        documentKey.context,
        {
          kind: "document.replace",
          id: f.document.id,
          markdown: `[Private table](weaver://table/${f.table.id})`,
        },
        {
          ...meta,
          ifMatch: `"${f.document.headCommitSha}"`,
          idempotencyKey: "forbidden-reference-key",
        },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await f.db.projectApiOperation.count()).toBe(0);
  });
  it("replaces a fixed document once, replays without Read, rejects changed requests and revoked replay", async () => {
    const f = await makeMachineFixture();
    const k = await seedProjectMachineKey(f, [
      {
        kind: "document",
        targetId: f.document.id,
        root: false,
        actions: ["update"],
      },
    ]);
    const command = {
      kind: "document.replace" as const,
      id: f.document.id,
      markdown: "Daily audit: all accounts reviewed",
    };
    const meta = {
      requestId: randomUUID(),
      idempotencyKey: "daily-audit-20261013",
      method: "PUT" as const,
      ifMatch: `"${f.document.headCommitSha}"`,
    };
    const [first, replay] = await Promise.all([
      publishProjectMachineContent(f.db, k.context, command, meta),
      publishProjectMachineContent(f.db, k.context, command, meta),
    ]);
    expect(first.revision).toBe(replay.revision);
    expect([first.replayed, replay.replayed].sort()).toEqual([false, true]);
    expect(JSON.stringify(first)).not.toContain(command.markdown);
    await expect(
      publishProjectMachineContent(
        f.db,
        k.context,
        { ...command, markdown: "Changed" },
        meta,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await f.db.projectApiKey.update({
      where: { id: k.keyId },
      data: { revokedAt: new Date() },
    });
    await expect(
      publishProjectMachineContent(f.db, k.context, command, meta),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
  it("appends rows with Create only, returns generated IDs without existing cells and checks revision", async () => {
    const f = await makeMachineFixture();
    const k = await seedProjectMachineKey(f, [
      { kind: "table", targetId: f.table.id, root: false, actions: ["create"] },
    ]);
    const command = {
      kind: "rows.append" as const,
      id: f.table.id,
      rows: [{ cells: { [f.table.columns[0]!.id]: "Reviewed account" } }],
    };
    const meta = {
      requestId: randomUUID(),
      idempotencyKey: "append-daily-results",
      method: "POST" as const,
      ifMatch: `"${f.table.headCommitSha}"`,
    };
    const receipt = await publishProjectMachineContent(
      f.db,
      k.context,
      command,
      meta,
    );
    expect(receipt.generatedIds?.rowIds).toHaveLength(1);
    expect(JSON.stringify(receipt)).not.toContain("original-private-account");
    await expect(
      queryProjectMachineContent(f.db, k.context, {
        kind: "table.get",
        id: f.table.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      publishProjectMachineContent(f.db, k.context, command, {
        ...meta,
        idempotencyKey: "different-audit-key",
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      details: { status: 412 },
    });
    await expect(
      publishProjectMachineContent(f.db, k.context, command, {
        ...meta,
        idempotencyKey: "missing-revision-key",
        ifMatch: null,
      }),
    ).rejects.toMatchObject({ details: { status: 428 } });
  });
});

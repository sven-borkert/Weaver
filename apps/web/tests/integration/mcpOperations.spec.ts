import {
  ASSISTANT_TOOLS,
  MCP_TOOLS,
  mcpToolsForActor,
} from "@weaver/assistant-tools/registry";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { openProjectRepo } from "@weaver/git-store";
import { execa } from "execa";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import {
  applyOperationInRepo,
  createdResourceId,
  recoverPriorOperation,
  checkOperationBase,
} from "@weaver/core/services/contentOperations";
import {
  createDocument,
  writeDocumentInRepo,
  deleteDocument,
  getDocument,
  listDocuments,
} from "@weaver/core/services/documents";
import {
  applyMcpOperation,
  mcpOperationId,
  pruneMcpRecords,
  recordMcpAudit,
  requestHash,
} from "@weaver/core/services/mcpOperations";
import { withProjectRepo } from "@weaver/core/services/projectRepo";
import { createTable, getTable } from "@weaver/core/services/tables";
import {
  createApiKeySecurityContext,
  type SecurityContext,
} from "@weaver/core/security/context";
import {
  addMembership,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  markdownContent,
} from "./_harness";

const COL_TASK = "11111111-1111-4111-8111-111111111111";
const ROW_PLAN = "33333333-3333-4333-8333-333333333333";
const CHILD_TIMEOUT_MS = 10_000;
const mcpOperationFixture = fileURLToPath(
  new URL("./fixtures/mcp-operation-worker.ts", import.meta.url),
);
const workspaceRoot = fileURLToPath(new URL("../../../../", import.meta.url));

function startMcpOperationWorker(input: {
  userId: string;
  email: string;
  projectId: string;
  idempotencyKey: string;
  title: string;
  summary: string;
}) {
  return execa(
    process.execPath,
    [
      "--import=tsx",
      mcpOperationFixture,
      input.userId,
      input.email,
      input.projectId,
      input.idempotencyKey,
      input.title,
      input.summary,
    ],
    {
      cleanup: true,
      cwd: workspaceRoot,
      killSignal: "SIGKILL",
      timeout: CHILD_TIMEOUT_MS,
    },
  );
}

type McpOperationWorker = ReturnType<typeof startMcpOperationWorker>;

async function terminateWorkers(workers: McpOperationWorker[]): Promise<void> {
  await Promise.all(
    workers.map(async (worker) => {
      if (worker.exitCode === null && worker.signalCode === null) {
        worker.kill("SIGKILL");
      }
      await worker.catch(() => undefined);
    }),
  );
}

function writer(user: { id: string; role: "Admin" | "User"; email: string }) {
  const security: SecurityContext = createApiKeySecurityContext({
    userId: user.id,
    globalRole: user.role,
    keyId: `key-${user.id}`,
    permissions: { mcp: ["use"], content: ["read", "write"] },
    projectIds: [],
  });
  return { ...security, name: "Writer", email: user.email };
}

async function fixture() {
  const db = getPrisma();
  const user = await makeUser("User", "mcp-ops");
  const project = await makeProject("Ops");
  await addMembership(project.id, user.id, "Editor");
  const actor = writer(user);
  const doc = await createDocument(
    db,
    {
      projectId: project.id,
      folderPath: [],
      title: "Notes",
      content: {
        kind: "markdown",
        contentJson: parseDocumentBody("# Notes\n\nFirst.\n"),
      },
    },
    actor,
  );
  const table = await createTable(
    db,
    {
      projectId: project.id,
      folderPath: [],
      title: "Tasks",
      columns: [{ id: COL_TASK, name: "Task", type: "text" }],
      rows: [{ id: ROW_PLAN, cells: { [COL_TASK]: "Plan" } }],
    },
    actor,
  );
  return { db, user, project, actor, doc, table };
}

describe("MCP direct writes (spec §16, §26.2 item 11)", () => {
  it.each(["document.create", "table.create"] as const)(
    "recovers %s after the success acknowledgement fails",
    async (kind) => {
      const { db, actor, project } = await fixture();
      const input = {
        idempotencyKey: "create-ack-failure",
        toolName:
          kind === "document.create" ? "create_document" : "create_table",
        summary: "Create once",
        operation:
          kind === "document.create"
            ? {
                kind,
                projectId: project.id,
                title: "Once",
                folderPath: [],
                markdown: "Original",
              }
            : {
                kind,
                projectId: project.id,
                title: "Once",
                folderPath: [],
                columns: [
                  { id: COL_TASK, name: "Task", type: "text" as const },
                ],
                rows: [],
              },
      };
      const spy = vi
        .spyOn(db.mcpOperation, "create")
        .mockRejectedValueOnce(new Error("ack failed"));
      await expect(applyMcpOperation(db, actor, input)).rejects.toThrow(
        "ack failed",
      );
      spy.mockRestore();
      const result = await applyMcpOperation(db, actor, input);
      expect((await applyMcpOperation(db, actor, input)).resourceId).toBe(
        result.resourceId,
      );
      expect(
        (await db.document.count({
          where: { projectId: project.id, title: "Once" },
        })) +
          (await db.dataTable.count({
            where: { projectId: project.id, title: "Once" },
          })),
      ).toBe(1);
    },
  );

  beforeEach(async () => {
    await resetDb();
  });

  it("replays a committed create after its resource was deleted before acknowledgement retry", async () => {
    const { db, actor, project } = await fixture();
    const input = {
      idempotencyKey: "deleted-create-retry",
      toolName: "create_document",
      summary: "Create once",
      operation: {
        kind: "document.create" as const,
        projectId: project.id,
        title: "Transient",
        folderPath: [],
        markdown: "Original",
      },
    };
    const spy = vi
      .spyOn(db.mcpOperation, "create")
      .mockRejectedValueOnce(new Error("ack failed"));
    await expect(applyMcpOperation(db, actor, input)).rejects.toThrow(
      "ack failed",
    );
    spy.mockRestore();
    const original = await db.document.findFirstOrThrow({
      where: { projectId: project.id, title: "Transient" },
    });
    await deleteDocument(
      db,
      { projectId: project.id, documentId: original.id },
      actor,
    );
    const replay = await applyMcpOperation(db, actor, input);
    expect(replay).toMatchObject({
      resourceId: original.id,
      commitSha: original.headCommitSha,
    });
    expect(await db.document.count({ where: { id: original.id } })).toBe(0);
  });

  it("recovers a create when its projection and acknowledgement were both lost", async () => {
    const { db, actor, project } = await fixture();
    const input = {
      idempotencyKey: "projection-create-retry",
      toolName: "create_document",
      summary: "Create once",
      operation: {
        kind: "document.create" as const,
        projectId: project.id,
        title: "Recoverable",
        folderPath: [],
        markdown: "Original",
      },
    };
    const spy = vi
      .spyOn(db.mcpOperation, "create")
      .mockRejectedValueOnce(new Error("ack failed"));
    await expect(applyMcpOperation(db, actor, input)).rejects.toThrow(
      "ack failed",
    );
    spy.mockRestore();
    const original = await db.document.findFirstOrThrow({
      where: { projectId: project.id, title: "Recoverable" },
    });
    await db.document.delete({ where: { id: original.id } });
    const replay = await applyMcpOperation(db, actor, input);
    expect(replay).toMatchObject({
      resourceId: original.id,
      commitSha: original.headCommitSha,
    });
    expect(
      await db.document.count({
        where: { projectId: project.id, title: "Recoverable" },
      }),
    ).toBe(1);
  });

  it("recovers the document identity when its asset sorts first in the create commit", async () => {
    const { db, actor, project } = await fixture();
    const operationId = "asset-create-recovery";
    const operation = {
      kind: "document.create" as const,
      projectId: project.id,
      folderPath: [],
      title: "Image note",
      markdown: "![pixel](image-note.assets/pixel.png)",
    };
    const id = createdResourceId(operationId);
    const created = await withProjectRepo(project.id, (repo) =>
      writeDocumentInRepo(
        db,
        repo,
        project.id,
        {
          kind: "create",
          id,
          folderPath: [],
          title: operation.title,
          createdAt: new Date().toISOString(),
          content: {
            kind: "markdown",
            contentJson: parseDocumentBody(operation.markdown),
          },
          assets: [{ name: "pixel.png", bytes: Buffer.from("image") }],
        },
        actor,
        { operation: "create", operationId },
      ),
    );
    await db.document.delete({ where: { id } });
    const recovered = await withProjectRepo(project.id, (repo) =>
      recoverPriorOperation(db, repo, operation, operationId),
    );
    expect(recovered).toEqual({
      resourceId: id,
      commitSha: created.headCommitSha,
      path: created.path,
    });
    expect((await db.document.findUniqueOrThrow({ where: { id } })).path).toBe(
      created.path,
    );
  });

  it("hashes canonically and derives a stable operation id", () => {
    expect(requestHash({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(
      requestHash({ a: [{ c: 3, d: 2 }], b: 1 }),
    );
    expect(requestHash({ a: 1 })).not.toBe(requestHash({ a: 2 }));
    expect(mcpOperationId("u1", "key-00000001")).toMatch(/^mcp:[0-9a-f]{32}$/);
    expect(mcpOperationId("u1", "key-00000001")).toBe(
      mcpOperationId("u1", "key-00000001"),
    );
    expect(mcpOperationId("u2", "key-00000001")).not.toBe(
      mcpOperationId("u1", "key-00000001"),
    );
  });

  it("creates a document once and replays the original result for the same key", async () => {
    const { db, project, actor } = await fixture();
    const input = {
      idempotencyKey: "create-0001",
      toolName: "create_document",
      operation: {
        kind: "document.create" as const,
        projectId: project.id,
        folderPath: [],
        title: "Decisions",
        markdown: "# Decisions\n\nShip it.\n",
      },
      summary: "Add the decisions page",
    };
    const first = await applyMcpOperation(db, actor, input);
    expect(first).toMatchObject({ projectId: project.id, replayed: false });
    expect(first.commitSha).toMatch(/^[0-9a-f]{40}$/);

    const second = await applyMcpOperation(db, actor, input);
    expect(second).toEqual({ ...first, replayed: true });

    const listed = await listDocuments(
      db,
      {
        projectId: project.id,
        page: 1,
        pageSize: 50,
        sort: "lastEditedAt",
        dir: "desc",
      },
      actor,
    );
    expect(listed.items.filter((d) => d.title === "Decisions")).toHaveLength(1);
    const row = await db.mcpOperation.findUniqueOrThrow({
      where: {
        userId_idempotencyKey: {
          userId: actor.userId,
          idempotencyKey: "create-0001",
        },
      },
    });
    expect(row.commitSha).toBe(first.commitSha);
    expect(row.credentialId).toBe(actor.credentialId);
    expect(row.toolName).toBe("create_document");
  });

  it("serializes one user key across projects before either content commit", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "mcp-cross-project");
    const firstProject = await makeProject("First operation project");
    const secondProject = await makeProject("Second operation project");
    await addMembership(firstProject.id, user.id, "Editor");
    await addMembership(secondProject.id, user.id, "Editor");
    const actor = writer(user);
    const idempotencyKey = "cross-project-0001";
    const operationId = mcpOperationId(actor.userId, idempotencyKey);
    const projectIds = [firstProject.id, secondProject.id];
    const workers: McpOperationWorker[] = [];

    let markTableLocked!: () => void;
    const tableLocked = new Promise<void>((resolve) => {
      markTableLocked = resolve;
    });
    let releaseTableLock!: () => void;
    const holdTableLock = new Promise<void>((resolve) => {
      releaseTableLock = resolve;
    });
    const blocker = db.$transaction(
      async (tx) => {
        // Hold INSERTs after the real Git write so the cross-project race is deterministic.
        await tx.$executeRawUnsafe('LOCK TABLE "McpOperation" IN SHARE MODE');
        markTableLocked();
        await holdTableLock;
      },
      { timeout: 10_000 },
    );
    await tableLocked;

    workers.push(
      startMcpOperationWorker({
        userId: actor.userId,
        email: actor.email,
        projectId: firstProject.id,
        idempotencyKey,
        title: "First race document",
        summary: "First cross-project request",
      }),
      startMcpOperationWorker({
        userId: actor.userId,
        email: actor.email,
        projectId: secondProject.id,
        idempotencyKey,
        title: "Second race document",
        summary: "Second cross-project request",
      }),
    );
    const pending = Promise.all(workers);
    const workerResults = await (async () => {
      try {
        try {
          await vi.waitFor(
            async () => {
              expect(
                await db.document.count({
                  where: {
                    projectId: { in: projectIds },
                    title: {
                      in: ["First race document", "Second race document"],
                    },
                  },
                }),
              ).toBeGreaterThanOrEqual(1);
            },
            { timeout: 5_000 },
          );
          // A second Git write during this window proves user/key serialization is absent.
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        } finally {
          releaseTableLock();
          await blocker;
        }
        return await pending;
      } finally {
        releaseTableLock();
        await blocker.catch(() => undefined);
        await terminateWorkers(workers);
      }
    })();

    const outcomes = workerResults.map((result) => {
      const lastLine = result.stdout.trim().split("\n").at(-1);
      if (!lastLine) throw new Error("MCP operation worker produced no output");
      return JSON.parse(lastLine) as {
        status: "fulfilled" | "rejected";
        code?: string | null;
        reason?: string | null;
      };
    });
    const fulfilled = outcomes.filter(
      (result) => result.status === "fulfilled",
    );
    const rejected = outcomes.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      code: "CONFLICT",
      reason: "IDEMPOTENCY_KEY_REUSED",
    });

    const operationCommits = [];
    for (const projectId of projectIds) {
      const repo = await openProjectRepo(projectId);
      if (!repo) continue;
      for (const path of await repo.listTrackedFiles()) {
        const entries = await repo.logForPath(path, { skip: 0, limit: 10 });
        operationCommits.push(
          ...entries.filter((entry) => entry.operationId === operationId),
        );
      }
    }
    expect(operationCommits).toHaveLength(1);
    expect(
      await db.document.count({
        where: {
          projectId: { in: projectIds },
          title: { in: ["First race document", "Second race document"] },
        },
      }),
    ).toBe(1);
    expect(
      await db.mcpOperation.count({
        where: { userId: actor.userId, idempotencyKey },
      }),
    ).toBe(1);
  });

  it("rejects a reused key with a different request", async () => {
    const { db, project, actor } = await fixture();
    const base = {
      idempotencyKey: "reuse-0001",
      toolName: "create_document",
      summary: "one",
    };
    await applyMcpOperation(db, actor, {
      ...base,
      operation: {
        kind: "document.create",
        projectId: project.id,
        folderPath: [],
        title: "One",
        markdown: "one",
      },
    });
    await expect(
      applyMcpOperation(db, actor, {
        ...base,
        operation: {
          kind: "document.create",
          projectId: project.id,
          folderPath: [],
          title: "Two",
          markdown: "two",
        },
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "IDEMPOTENCY_KEY_REUSED" },
    });
  });

  it("stores the title heading once when the body repeats it", async () => {
    const { db, project, actor } = await fixture();
    const headings = async (documentId: string) => {
      const read = await getDocument(
        db,
        { projectId: project.id, documentId },
        actor,
      );
      return {
        baseCommitSha: read.baseCommitSha,
        body: (markdownContent(read).content ?? []).filter(
          (node) => node.type === "heading",
        ).length,
      };
    };
    const created = await applyMcpOperation(db, actor, {
      idempotencyKey: "title-once-create",
      toolName: "create_document",
      summary: "Create with a repeated title heading",
      operation: {
        kind: "document.create",
        projectId: project.id,
        title: "Training Plan",
        folderPath: [],
        markdown: "# Training Plan\n\nIntro.\n",
      },
    });
    const documentId = created.resourceId!;
    const afterCreate = await headings(documentId);
    expect(afterCreate.body).toBe(0);

    // An edit that keeps the title strips against the stored one.
    await applyMcpOperation(db, actor, {
      idempotencyKey: "title-once-edit",
      toolName: "update_document",
      summary: "Edit with a repeated title heading",
      operation: {
        kind: "document.edit",
        projectId: project.id,
        documentId,
        baseCommitSha: afterCreate.baseCommitSha,
        markdown: "# Training Plan\n\n## Section\n\nChanged.\n",
      },
    });
    expect((await headings(documentId)).body).toBe(1);
  });

  it("updates a document against its base revision and conflicts on a stale one", async () => {
    const { db, project, actor, doc } = await fixture();
    const current = await getDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      actor,
    );
    const updated = await applyMcpOperation(db, actor, {
      idempotencyKey: "edit-0001",
      toolName: "update_document",
      operation: {
        kind: "document.edit",
        projectId: project.id,
        documentId: doc.id,
        baseCommitSha: current.baseCommitSha,
        markdown: "# Notes\n\nSecond.\n",
      },
      summary: "Replace the body",
    });
    expect(updated.resourceId).toBe(doc.id);
    await expect(
      applyMcpOperation(db, actor, {
        idempotencyKey: "edit-0002",
        toolName: "update_document",
        operation: {
          kind: "document.edit",
          projectId: project.id,
          documentId: doc.id,
          baseCommitSha: current.baseCommitSha,
          markdown: "# Notes\n\nThird.\n",
        },
        summary: "Stale",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "STALE_BASE" },
    });
  });

  it("recovers only a Git-only commit with the same durable request identity", async () => {
    const { db, project, actor, doc } = await fixture();
    const current = await getDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      actor,
    );
    const operation = {
      kind: "document.edit" as const,
      projectId: project.id,
      documentId: doc.id,
      baseCommitSha: current.baseCommitSha,
      markdown: "# Notes\n\nRecovered.\n",
    };
    const requestIdentity = {
      toolName: "update_document",
      operation,
      summary: "Recovered",
    };
    // Simulate the crash window: the commit exists with durable identity, no row.
    const committed = await withProjectRepo(project.id, async (repo) => {
      const base = await checkOperationBase(db, repo, operation);
      if (!base.ok) throw new Error("fixture base must be current");
      const metadata = {
        table: base.table,
        summary: "Recovered",
        operationId: mcpOperationId(actor.userId, "recover-0001"),
        mcpRequestHash: requestHash(requestIdentity),
        mcpToolName: "update_document",
      };
      return applyOperationInRepo(db, repo, operation, actor, metadata);
    });

    await expect(
      applyMcpOperation(db, actor, {
        idempotencyKey: "recover-0001",
        toolName: "update_document",
        operation: {
          ...operation,
          markdown:
            "# Notes\n\nA different request must not bind this commit.\n",
        },
        summary: "Recovered",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "IDEMPOTENCY_KEY_REUSED" },
    });

    const result = await applyMcpOperation(db, actor, {
      idempotencyKey: "recover-0001",
      toolName: "update_document",
      operation,
      summary: "Recovered",
    });
    expect(result.commitSha).toBe(committed.commitSha);
    expect(result.replayed).toBe(false);
    expect(
      await db.mcpOperation.count({
        where: { idempotencyKey: "recover-0001" },
      }),
    ).toBe(1);
  });

  it("applies table schema and row changes with the shared helper", async () => {
    const { db, project, actor, table } = await fixture();
    const schema = await applyMcpOperation(db, actor, {
      idempotencyKey: "schema-0001",
      toolName: "update_table_schema",
      operation: {
        kind: "table.schema",
        projectId: project.id,
        tableId: table.id,
        baseCommitSha: table.headCommitSha,
        changes: [{ op: "add", column: { name: "Done", type: "boolean" } }],
      },
      summary: "Add Done",
    });
    const afterSchema = await getTable(
      db,
      { projectId: project.id, tableId: table.id },
      actor,
    );
    expect(afterSchema.baseCommitSha).toBe(schema.commitSha);
    expect(afterSchema.columns.map((c) => c.name)).toEqual(["Task", "Done"]);
    const rows = await applyMcpOperation(db, actor, {
      idempotencyKey: "rows-0001",
      toolName: "update_table_rows",
      operation: {
        kind: "table.rows",
        projectId: project.id,
        tableId: table.id,
        baseCommitSha: afterSchema.baseCommitSha,
        inserts: [{ cells: { [COL_TASK]: "Build" } }],
        updates: [{ rowId: ROW_PLAN, cells: { [COL_TASK]: "Plan it" } }],
        deletes: [],
      },
      summary: "Edit rows",
    });
    const afterRows = await getTable(
      db,
      { projectId: project.id, tableId: table.id },
      actor,
    );
    expect(afterRows.baseCommitSha).toBe(rows.commitSha);
    expect(afterRows.rows.map((r) => r.cells[COL_TASK])).toEqual([
      "Plan it",
      "Build",
    ]);
  });

  it("refuses without content:write, without Editor, and for a hidden project", async () => {
    const { db, project, user } = await fixture();
    const readOnly = {
      ...createApiKeySecurityContext({
        userId: user.id,
        globalRole: user.role,
        keyId: "ro",
        permissions: { mcp: ["use"], content: ["read"] },
        projectIds: [],
      }),
      name: "RO",
      email: user.email,
    };
    const operation = {
      kind: "document.create" as const,
      projectId: project.id,
      folderPath: [],
      title: "Nope",
      markdown: "nope",
    };
    await expect(
      applyMcpOperation(db, readOnly, {
        idempotencyKey: "forbidden-01",
        toolName: "create_document",
        operation,
        summary: "x",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const viewer = await makeUser("User", "mcp-viewer");
    await addMembership(project.id, viewer.id, "Viewer");
    await expect(
      applyMcpOperation(db, writer(viewer), {
        idempotencyKey: "forbidden-02",
        toolName: "create_document",
        operation,
        summary: "x",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const stranger = await makeUser("User", "mcp-stranger");
    await expect(
      applyMcpOperation(db, writer(stranger), {
        idempotencyKey: "notfound-01",
        toolName: "create_document",
        operation,
        summary: "x",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      applyMcpOperation(db, writer(user), {
        idempotencyKey: "bad key",
        toolName: "create_document",
        operation,
        summary: "x",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("records audit rows and prunes old records", async () => {
    const { db, project, actor } = await fixture();
    await recordMcpAudit(db, {
      requestId: "req-1",
      userId: actor.userId,
      credentialId: actor.credentialId,
      authenticationMethod: "apiKey",
      clientId: null,
      method: "tools/call",
      name: "list_projects",
      projectId: project.id,
      outcome: "ok",
      errorCode: null,
      durationMs: 12,
      commitSha: null,
    });
    await applyMcpOperation(db, actor, {
      idempotencyKey: "prune-0001",
      toolName: "create_document",
      operation: {
        kind: "document.create",
        projectId: project.id,
        folderPath: [],
        title: "Old",
        markdown: "old",
      },
      summary: "old",
    });
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    await db.mcpOperation.updateMany({ data: { createdAt: old } });
    await db.mcpAuditEvent.updateMany({ data: { createdAt: old } });
    expect(await pruneMcpRecords(db)).toEqual({ operations: 1, audits: 1 });
    expect(await db.mcpOperation.count()).toBe(0);
    expect(await db.mcpAuditEvent.count()).toBe(0);
  });

  it("retains an audit row without project attachment when a guessed project does not exist", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "mcp-audit-missing-project");
    const projectId = randomUUID();

    await recordMcpAudit(db, {
      requestId: "req-missing-project",
      userId: user.id,
      credentialId: "credential-missing-project",
      authenticationMethod: "apiKey",
      clientId: null,
      method: "resources/read",
      name: `weaver://projects/${projectId}/documents/${randomUUID()}`,
      projectId,
      outcome: "error",
      errorCode: "NOT_FOUND",
      durationMs: 1,
      commitSha: null,
    });

    const audit = await db.mcpAuditEvent.findFirstOrThrow({
      where: { requestId: "req-missing-project" },
    });
    expect(audit.projectId).toBeNull();
    expect(audit.name).toContain(projectId);
  });
});

describe("bounded MCP history cleanup", () => {
  beforeEach(resetDb);

  it("removes at most 5000 oldest rows per table and preserves the retention boundary", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "mcp-retention-bounds");
    const project = await makeProject("MCP retention");
    const now = new Date("2026-09-17T12:00:00.000Z");
    const daysAgo = (days: number) => new Date(now.getTime() - days * 86400000);
    const ids = Array.from(
      { length: 5003 },
      (_, index) =>
        `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    await db.mcpOperation.createMany({
      data: ids.map((id, index) => ({
        id,
        userId: user.id,
        projectId: project.id,
        credentialId: "retention-fixture",
        idempotencyKey: `retention-${index}`,
        toolName: "create_document",
        requestHash: "a".repeat(64),
        commitSha: "b".repeat(40),
        result: {},
        createdAt: daysAgo(index < 5001 ? 31 : index === 5001 ? 30 : 1),
      })),
    });
    await db.mcpAuditEvent.createMany({
      data: ids.map((id, index) => ({
        id,
        userId: user.id,
        projectId: project.id,
        credentialId: "retention-fixture",
        requestId: `retention-${index}`,
        authenticationMethod: "apiKey",
        method: "tools/call",
        name: "list_projects",
        outcome: "ok" as const,
        durationMs: 1,
        createdAt: daysAgo(index < 5001 ? 91 : index === 5001 ? 90 : 1),
      })),
    });

    expect(await pruneMcpRecords(db, now)).toEqual({
      operations: 5000,
      audits: 5000,
    });
    const expected = ids.slice(5000).map((id) => ({ id }));
    expect(
      await db.mcpOperation.findMany({
        select: { id: true },
        orderBy: { id: "asc" },
      }),
    ).toEqual(expected);
    expect(
      await db.mcpAuditEvent.findMany({
        select: { id: true },
        orderBy: { id: "asc" },
      }),
    ).toEqual(expected);
    expect(await pruneMcpRecords(db, now)).toEqual({
      operations: 1,
      audits: 1,
    });
    expect(await db.mcpOperation.count()).toBe(2);
    expect(await db.mcpAuditEvent.count()).toBe(2);
  });

  it("skips a concurrent cleanup without deleting records", async () => {
    const db = getPrisma();
    await db.mcpAuditEvent.create({
      data: {
        requestId: "retention-lock",
        credentialId: "retention-fixture",
        authenticationMethod: "apiKey",
        method: "tools/call",
        name: "list_projects",
        outcome: "ok",
        durationMs: 1,
        createdAt: new Date("2020-01-01T00:00:00Z"),
      },
    });
    let locked!: () => void;
    let release!: () => void;
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('weaver:mcp-records-prune'))::text`;
      locked();
      await held;
    });
    await Promise.race([acquired, blocker]);
    try {
      expect(await pruneMcpRecords(db)).toEqual({ operations: 0, audits: 0 });
      expect(await db.mcpAuditEvent.count()).toBe(1);
    } finally {
      release();
      await blocker;
    }
  });
});

it("file inspection contracts are shared read operations for restricted MCP actors", () => {
  const actor = createApiKeySecurityContext({
    userId: randomUUID(),
    globalRole: "User",
    keyId: randomUUID(),
    permissions: null,
    projectIds: [],
  });
  for (const name of [
    "read_text_artifact",
    "read_csv_artifact",
    "inspect_structured_artifact",
  ]) {
    const contract = ASSISTANT_TOOLS.find((tool) => tool.name === name);
    expect(contract).toBeDefined();
    expect(MCP_TOOLS.find((tool) => tool.name === name)).toBe(contract);
    expect(mcpToolsForActor(actor)).toContain(contract);
    expect(contract).toMatchObject({
      kind: "read",
      capability: "content:read",
    });
  }
});

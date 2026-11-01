import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addMembership,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
  markdownContent,
} from "./_harness";
import {
  parseDocumentBody,
  serializeDocumentBody,
} from "@weaver/core/editor/markdown";
import {
  createDocument,
  deleteDocument,
  getDocument,
  saveDocument,
} from "@weaver/core/services/documents";
import {
  createTable,
  deleteTable,
  getTable,
} from "@weaver/core/services/tables";
import { listDeletedContent } from "@weaver/core/services/contentRecovery";
import {
  cursorQueryIdentity,
  encodeContentCursor,
} from "@weaver/core/services/contentCursors";
import {
  applyMcpOperation,
  mcpOperationId,
  requestHash,
} from "@weaver/core/services/mcpOperations";
import { storeDocumentImage } from "@weaver/core/services/documentImages";
import * as toolContract from "@weaver/assistant-tools/contract";
import * as projectRepo from "@weaver/core/services/projectRepo";
import { openProjectRepo } from "@weaver/git-store";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import { createProposal } from "@weaver/core/services/assistantProposals";
import { createConversation } from "@weaver/core/services/assistantConversations";
import {
  leaseRunAttempt,
  submitUserMessage,
} from "@weaver/core/services/assistantRuns";
import { resolveScopeSnapshot } from "@weaver/core/assistant/scope";

const AUTHOR = { name: "Editor", email: "editor@test.local" };

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

async function ownerProject(suffix: string) {
  const owner = await makeUser("User", `owner-${suffix}`);
  const viewer = await makeUser("User", `viewer-${suffix}`);
  const outsider = await makeUser("User", `out-${suffix}`);
  const project = await makeProject(`Recovery ${suffix}`);
  await addMembership(project.id, owner.id, "Owner");
  await addMembership(project.id, viewer.id, "Viewer");
  return {
    db: getPrisma(),
    project,
    actor: { ...securityContextFor(owner), ...AUTHOR, email: owner.email },
    viewerActor: {
      ...securityContextFor(viewer),
      ...AUTHOR,
      email: viewer.email,
    },
    outsiderActor: {
      ...securityContextFor(outsider),
      ...AUTHOR,
      email: outsider.email,
    },
  };
}

async function deleteTogether(
  ctx: Awaited<ReturnType<typeof ownerProject>>,
  documents: Array<{ id: string; path: string }>,
  tables: Array<{ id: string; path: string }> = [],
) {
  const sha = await projectRepo.withProjectRepo(
    ctx.project.id,
    async (repo) => {
      for (const document of documents) await repo.rm(document.path);
      for (const table of tables) await repo.rmDir(table.path);
      return repo.commitAll("delete: several resources", {
        ...AUTHOR,
        userId: ctx.actor.userId,
      });
    },
  );
  await ctx.db.document.deleteMany({
    where: {
      projectId: ctx.project.id,
      id: { in: documents.map((doc) => doc.id) },
    },
  });
  await ctx.db.dataTable.deleteMany({
    where: {
      projectId: ctx.project.id,
      id: { in: tables.map((table) => table.id) },
    },
  });
  return sha;
}

let queue: FakeJobQueue;

beforeEach(async () => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("WEAVER_JOBS_ENABLED", "true");
  queue = new FakeJobQueue();
  setJobQueueForTests(queue);
  await resetDb();
});

afterEach(() => {
  setJobQueueForTests(null);
  vi.unstubAllEnvs();
});

describe("listDeletedContent", () => {
  it("finds a deleted document and a deleted table with their identity and source revision", async () => {
    const { db, project, actor, viewerActor } = await ownerProject("basic");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Gone Guide",
        content: { kind: "markdown", contentJson: parseDocumentBody("body\n") },
      },
      actor,
    );
    const table = await createTable(
      db,
      { projectId: project.id, folderPath: [], title: "Gone Table" },
      actor,
    );
    await deleteDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      actor,
    );
    // deleteTable requires the table's current head as an expected revision.
    const tableHead = await getTable(
      db,
      { projectId: project.id, tableId: table.id },
      actor,
    );
    await deleteTable(
      db,
      {
        projectId: project.id,
        tableId: table.id,
        expectedHeadCommitSha: tableHead.baseCommitSha,
      },
      actor,
    );

    const page = await listDeletedContent(
      db,
      { projectId: project.id, limit: 20 },
      viewerActor,
    );

    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect(page.snapshotCommitSha).toMatch(/^[0-9a-f]{40}$/);
    const byId = new Map(page.items.map((item) => [item.id, item]));
    expect(byId.get(doc.id)).toMatchObject({
      resourceType: "document",
      title: "Gone Guide",
      path: "gone-guide.md",
    });
    expect(byId.get(table.id)).toMatchObject({
      resourceType: "table",
      title: "Gone Table",
      path: "tables/gone-table.table",
    });
    for (const item of page.items) {
      expect(item.deletedAtSha).toMatch(/^[0-9a-f]{40}$/);
      expect(item.sourceSha).toMatch(/^[0-9a-f]{40}$/);
      expect(item.sourceSha).not.toBe(item.deletedAtSha);
    }
  });

  it("omits a resource that still exists and one that was recreated", async () => {
    const { db, project, actor } = await ownerProject("live");
    const kept = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Kept",
        content: { kind: "markdown", contentJson: parseDocumentBody("a\n") },
      },
      actor,
    );
    const removed = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Removed",
        content: { kind: "markdown", contentJson: parseDocumentBody("b\n") },
      },
      actor,
    );
    await deleteDocument(
      db,
      { projectId: project.id, documentId: removed.id },
      actor,
    );
    // A new document reusing the freed path must not resurrect the entry.
    await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Removed",
        content: { kind: "markdown", contentJson: parseDocumentBody("c\n") },
      },
      actor,
    );

    const page = await listDeletedContent(
      db,
      { projectId: project.id, limit: 20 },
      actor,
    );
    const ids = page.items.map((item) => item.id);
    expect(ids).toContain(removed.id);
    expect(ids).not.toContain(kept.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("pages without repeating or skipping, and reports an unfinished traversal", async () => {
    const { db, project, actor } = await ownerProject("paging");
    const created = [];
    for (let i = 0; i < 5; i++) {
      created.push(
        await createDocument(
          db,
          {
            projectId: project.id,
            folderPath: [],
            title: `Doc ${i}`,
            content: {
              kind: "markdown",
              contentJson: parseDocumentBody("x\n"),
            },
          },
          actor,
        ),
      );
    }
    for (const doc of created) {
      await deleteDocument(
        db,
        { projectId: project.id, documentId: doc.id },
        actor,
      );
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await listDeletedContent(
        db,
        { projectId: project.id, limit: 2, cursor },
        actor,
      );
      expect(page.items.length).toBeGreaterThan(0);
      seen.push(...page.items.map((item) => item.id));
      if (!page.hasMore) {
        expect(page.nextCursor).toBeNull();
        break;
      }
      expect(page.nextCursor).toBeTruthy();
      cursor = page.nextCursor!;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual(created.map((doc) => doc.id).sort());
  });

  it("reports an accurate hasMore across the commit-scan boundary (scanLimit seam)", async () => {
    const { db, project, actor } = await ownerProject("scan-boundary");
    const created = [];
    for (let i = 0; i < 4; i++) {
      const doc = await createDocument(
        db,
        {
          projectId: project.id,
          folderPath: [],
          title: `Scan ${i}`,
          content: { kind: "markdown", contentJson: parseDocumentBody("x\n") },
        },
        actor,
      );
      await deleteDocument(
        db,
        { projectId: project.id, documentId: doc.id },
        actor,
      );
      created.push(doc);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let finished = false;
    for (let guard = 0; guard < 20; guard++) {
      const page = await listDeletedContent(
        db,
        { projectId: project.id, limit: 50, cursor, scanLimit: 2 },
        actor,
      );
      if (page.hasMore) {
        // A page must never look like a complete inventory while claiming
        // there is more history to scan.
        expect(page.items.length).toBeGreaterThan(0);
      }
      seen.push(...page.items.map((item) => item.id));
      if (!page.hasMore) {
        expect(page.nextCursor).toBeNull();
        finished = true;
        break;
      }
      expect(page.nextCursor).toBeTruthy();
      cursor = page.nextCursor!;
    }
    expect(finished).toBe(true);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual(created.map((doc) => doc.id).sort());
  });

  it("resumes every document and table deleted in one commit across scan boundaries", async () => {
    const ctx = await ownerProject("within-commit");
    const older = await createDocument(
      ctx.db,
      {
        projectId: ctx.project.id,
        folderPath: [],
        title: "Older",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("older\n"),
        },
      },
      ctx.actor,
    );
    await deleteDocument(
      ctx.db,
      { projectId: ctx.project.id, documentId: older.id },
      ctx.actor,
    );
    const documents = [];
    const tables = [];
    for (let i = 0; i < 2; i++) {
      documents.push(
        await createDocument(
          ctx.db,
          {
            projectId: ctx.project.id,
            folderPath: [],
            title: `Together ${i}`,
            content: {
              kind: "markdown",
              contentJson: parseDocumentBody("body\n"),
            },
          },
          ctx.actor,
        ),
      );
      tables.push(
        await createTable(
          ctx.db,
          {
            projectId: ctx.project.id,
            folderPath: [],
            title: `Together ${i}`,
          },
          ctx.actor,
        ),
      );
    }
    const deletionSha = await deleteTogether(ctx, documents, tables);
    const seen = [];
    let cursor: string | undefined;
    let finished = false;
    for (let guard = 0; guard < 20; guard++) {
      const page = await listDeletedContent(
        ctx.db,
        {
          projectId: ctx.project.id,
          limit: 1,
          scanLimit: 1,
          cursor,
        },
        ctx.actor,
      );
      expect(page.snapshotCommitSha).toBe(deletionSha);
      expect(page.items.length).toBeLessThanOrEqual(1);
      seen.push(...page.items);
      if (!page.hasMore) {
        expect(page.nextCursor).toBeNull();
        finished = true;
        break;
      }
      expect(page.nextCursor).toBeTruthy();
      expect(page.nextCursor).not.toBe(cursor);
      cursor = page.nextCursor!;
    }
    expect(finished).toBe(true);
    expect(seen.map((item) => item.id).sort()).toEqual(
      [older, ...documents, ...tables].map((item) => item.id).sort(),
    );
    expect(
      seen.filter((item) => item.deletedAtSha === deletionSha),
    ).toHaveLength(4);
    expect(seen.filter((item) => item.resourceType === "table")).toHaveLength(
      2,
    );
  });

  it("keeps legacy zero-position cursors after their completed commit", async () => {
    const ctx = await ownerProject("legacy-cursor");
    const removed = [];
    for (let i = 0; i < 2; i++) {
      const document = await createDocument(
        ctx.db,
        {
          projectId: ctx.project.id,
          folderPath: [],
          title: `Legacy ${i}`,
          content: {
            kind: "markdown",
            contentJson: parseDocumentBody("body\n"),
          },
        },
        ctx.actor,
      );
      const deletedAtSha = await deleteTogether(ctx, [document]);
      removed.push({ ...document, deletedAtSha });
    }
    const latest = removed[1]!;
    const cursor = encodeContentCursor({
      v: 1,
      kind: "deleted",
      projectId: ctx.project.id,
      resourceId: ctx.project.id,
      snapshotCommitSha: latest.deletedAtSha,
      query: cursorQueryIdentity({}),
      position: 0,
      after: latest.deletedAtSha,
    });
    const page = await listDeletedContent(
      ctx.db,
      {
        projectId: ctx.project.id,
        limit: 50,
        cursor,
      },
      ctx.actor,
    );
    expect(page.items.map((item) => item.id)).toEqual([removed[0]!.id]);
    expect(page.hasMore).toBe(false);
  });

  it("does not repeat an identity from the consumed part of a deletion commit", async () => {
    const ctx = await ownerProject("resumed-dedup");
    const documents = [];
    for (const title of ["Duplicate", "Other"]) {
      documents.push(
        await createDocument(
          ctx.db,
          {
            projectId: ctx.project.id,
            folderPath: [],
            title,
            content: {
              kind: "markdown",
              contentJson: parseDocumentBody("body\n"),
            },
          },
          ctx.actor,
        ),
      );
    }
    const original = documents[0]!;
    const duplicate = { ...original, path: "duplicate-copy.md" };
    await projectRepo.withProjectRepo(ctx.project.id, async (repo) => {
      await repo.writeFileAtomic(
        duplicate.path,
        await repo.readFileFromWorktree(original.path),
      );
      await repo.commitAll("external: copied document", {
        ...AUTHOR,
        userId: ctx.actor.userId,
      });
    });
    await deleteTogether(ctx, [...documents, duplicate]);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 5; guard++) {
      const page = await listDeletedContent(
        ctx.db,
        {
          projectId: ctx.project.id,
          limit: 1,
          cursor,
        },
        ctx.actor,
      );
      seen.push(...page.items.map((item) => item.id));
      if (!page.hasMore) break;
      cursor = page.nextCursor!;
    }
    expect(seen.sort()).toEqual(
      documents.map((document) => document.id).sort(),
    );
  });

  it("hides the listing from nonmembers and rejects a foreign cursor", async () => {
    const { db, project, actor, outsiderActor } = await ownerProject("deny");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Doc",
        content: { kind: "markdown", contentJson: parseDocumentBody("x\n") },
      },
      actor,
    );
    await deleteDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      actor,
    );

    await expect(
      listDeletedContent(
        db,
        { projectId: project.id, limit: 5 },
        outsiderActor,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      listDeletedContent(
        db,
        { projectId: project.id, limit: 5, cursor: "not-a-cursor" },
        actor,
      ),
    ).rejects.toMatchObject({ details: { reason: "INVALID_CURSOR" } });
  });
});

describe("content.restore", () => {
  it("rolls a live document back to an earlier revision", async () => {
    const { db, project, actor } = await ownerProject("restore-version");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Guide",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("first\n"),
        },
      },
      actor,
    );
    const v1 = await getDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      actor,
    );
    const v2 = await saveDocument(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        baseCommitSha: v1.baseCommitSha,
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("second\n"),
        },
        changeSummary: "",
      },
      actor,
    );

    await applyMcpOperation(db, actor, {
      idempotencyKey: "restore-version-1",
      toolName: "restore_content",
      summary: "Roll back",
      operation: {
        kind: "content.restore",
        projectId: project.id,
        resourceType: "document",
        resourceId: doc.id,
        mode: "version",
        sourceSha: v1.baseCommitSha,
        expectedHeadCommitSha: v2.headCommitSha,
      },
    });

    const after = await getDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      actor,
    );
    expect(serializeDocumentBody(markdownContent(after))).toContain("first");
    expect(after.id).toBe(doc.id);
    expect(after.baseCommitSha).not.toBe(v2.headCommitSha);
  });

  it("refuses a version restore whose expected head moved", async () => {
    const { db, project, actor } = await ownerProject("restore-stale");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Guide",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("first\n"),
        },
      },
      actor,
    );
    const v1 = await getDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      actor,
    );
    await expect(
      applyMcpOperation(db, actor, {
        idempotencyKey: "restore-stale-1",
        toolName: "restore_content",
        summary: "no",
        operation: {
          kind: "content.restore",
          projectId: project.id,
          resourceType: "document",
          resourceId: doc.id,
          mode: "version",
          sourceSha: v1.baseCommitSha,
          expectedHeadCommitSha: "0".repeat(40),
        },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("recovers a deleted document with its original id", async () => {
    const { db, project, actor } = await ownerProject("recover-doc");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Gone",
        content: { kind: "markdown", contentJson: parseDocumentBody("body\n") },
      },
      actor,
    );
    await deleteDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      actor,
    );
    const [item] = (
      await listDeletedContent(db, { projectId: project.id, limit: 5 }, actor)
    ).items;
    expect(item?.id).toBe(doc.id);

    await applyMcpOperation(db, actor, {
      idempotencyKey: "recover-doc-1",
      toolName: "restore_content",
      summary: "Recover",
      operation: {
        kind: "content.restore",
        projectId: project.id,
        resourceType: "document",
        resourceId: doc.id,
        mode: "deleted",
        sourceSha: item!.sourceSha,
        deletedAtSha: item!.deletedAtSha,
      },
    });

    const back = await getDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      actor,
    );
    expect(back.id).toBe(doc.id);
    expect(back.title).toBe("Gone");
    expect(serializeDocumentBody(markdownContent(back))).toContain("body");
    expect(
      (
        await listDeletedContent(db, { projectId: project.id, limit: 5 }, actor)
      ).items.map((entry) => entry.id),
    ).not.toContain(doc.id);
  });

  it("recovers a deleted table with its original id", async () => {
    const { db, project, actor } = await ownerProject("recover-table");
    const table = await createTable(
      db,
      { projectId: project.id, folderPath: [], title: "Roster" },
      actor,
    );
    const head = await getTable(
      db,
      { projectId: project.id, tableId: table.id },
      actor,
    );
    await deleteTable(
      db,
      {
        projectId: project.id,
        tableId: table.id,
        expectedHeadCommitSha: head.baseCommitSha,
      },
      actor,
    );
    const [item] = (
      await listDeletedContent(db, { projectId: project.id, limit: 5 }, actor)
    ).items;

    await applyMcpOperation(db, actor, {
      idempotencyKey: "recover-table-1",
      toolName: "restore_content",
      summary: "Recover",
      operation: {
        kind: "content.restore",
        projectId: project.id,
        resourceType: "table",
        resourceId: table.id,
        mode: "deleted",
        sourceSha: item!.sourceSha,
        deletedAtSha: item!.deletedAtSha,
      },
    });

    const back = await getTable(
      db,
      { projectId: project.id, tableId: table.id },
      actor,
    );
    expect(back.id).toBe(table.id);
    expect(back.title).toBe("Roster");
  });

  it("refuses to recover an identity that is already live", async () => {
    const { db, project, actor } = await ownerProject("recover-live");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Live",
        content: { kind: "markdown", contentJson: parseDocumentBody("x\n") },
      },
      actor,
    );
    const head = await getDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      actor,
    );
    await expect(
      applyMcpOperation(db, actor, {
        idempotencyKey: "recover-live-1",
        toolName: "restore_content",
        summary: "no",
        operation: {
          kind: "content.restore",
          projectId: project.id,
          resourceType: "document",
          resourceId: doc.id,
          mode: "deleted",
          sourceSha: head.baseCommitSha,
          deletedAtSha: head.baseCommitSha,
        },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("requires Editor and rejects a foreign project", async () => {
    const { db, project, actor, viewerActor } =
      await ownerProject("restore-perm");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Guide",
        content: { kind: "markdown", contentJson: parseDocumentBody("x\n") },
      },
      actor,
    );
    const head = await getDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      actor,
    );
    await expect(
      applyMcpOperation(db, viewerActor, {
        idempotencyKey: "restore-perm-1",
        toolName: "restore_content",
        summary: "no",
        operation: {
          kind: "content.restore",
          projectId: project.id,
          resourceType: "document",
          resourceId: doc.id,
          mode: "version",
          sourceSha: head.baseCommitSha,
          expectedHeadCommitSha: head.baseCommitSha,
        },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("stamps the MCP audit trailers on a version-restore commit", async () => {
    const { db, project, actor } = await ownerProject("restore-trailer");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Guide",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("first\n"),
        },
      },
      actor,
    );
    const v1 = await getDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      actor,
    );
    const v2 = await saveDocument(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        baseCommitSha: v1.baseCommitSha,
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("second\n"),
        },
        changeSummary: "",
      },
      actor,
    );
    const operation = {
      kind: "content.restore",
      projectId: project.id,
      resourceType: "document",
      resourceId: doc.id,
      mode: "version",
      sourceSha: v1.baseCommitSha,
      expectedHeadCommitSha: v2.headCommitSha,
    } as const;

    const result = await applyMcpOperation(db, actor, {
      idempotencyKey: "restore-trailer-1",
      toolName: "restore_content",
      summary: "Roll back",
      operation,
    });

    const repo = await openProjectRepo(project.id);
    const [entry] = await repo!.logForPath(result.path, { skip: 0, limit: 1 });
    // Without the trailer, MCP recovery cannot recognise its own restore.
    expect(entry?.sha).toBe(result.commitSha);
    expect(entry?.operationId).toBe(
      mcpOperationId(actor.userId, "restore-trailer-1"),
    );
    expect(entry?.mcpToolName).toBe("restore_content");
    expect(entry?.mcpRequestHash).toBe(
      requestHash({
        toolName: "restore_content",
        operation,
        summary: "Roll back",
      }),
    );
  });

  it("replays a version restore under the same idempotency key without a second commit", async () => {
    const { db, project, actor } = await ownerProject("restore-replay");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Guide",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("first\n"),
        },
      },
      actor,
    );
    const v1 = await getDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      actor,
    );
    const v2 = await saveDocument(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        baseCommitSha: v1.baseCommitSha,
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("second\n"),
        },
        changeSummary: "",
      },
      actor,
    );
    const request = {
      idempotencyKey: "restore-replay-1",
      toolName: "restore_content",
      summary: "Roll back",
      operation: {
        kind: "content.restore",
        projectId: project.id,
        resourceType: "document",
        resourceId: doc.id,
        mode: "version",
        sourceSha: v1.baseCommitSha,
        expectedHeadCommitSha: v2.headCommitSha,
      },
    } as const;

    const first = await applyMcpOperation(db, actor, request);
    const repo = await openProjectRepo(project.id);
    const headAfterFirst = await repo!.resolveHead();
    const second = await applyMcpOperation(db, actor, request);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.commitSha).toBe(first.commitSha);
    expect(second.resourceId).toBe(doc.id);
    expect(await repo!.resolveHead()).toBe(headAfterFirst);
  });

  it("recovers its own restore commit after a lost acknowledgement", async () => {
    const { db, project, actor } = await ownerProject("restore-lost-ack");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Guide",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("first\n"),
        },
      },
      actor,
    );
    const v1 = await getDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      actor,
    );
    const v2 = await saveDocument(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        baseCommitSha: v1.baseCommitSha,
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("second\n"),
        },
        changeSummary: "",
      },
      actor,
    );
    const request = {
      idempotencyKey: "restore-lost-ack-1",
      toolName: "restore_content",
      summary: "Roll back",
      operation: {
        kind: "content.restore",
        projectId: project.id,
        resourceType: "document",
        resourceId: doc.id,
        mode: "version",
        sourceSha: v1.baseCommitSha,
        expectedHeadCommitSha: v2.headCommitSha,
      },
    } as const;

    const first = await applyMcpOperation(db, actor, request);
    // The commit landed but the acknowledgement never did.
    await db.mcpOperation.deleteMany({ where: { userId: actor.userId } });
    const repo = await openProjectRepo(project.id);
    const headAfterFirst = await repo!.resolveHead();

    const second = await applyMcpOperation(db, actor, request);

    expect(second.commitSha).toBe(first.commitSha);
    expect(second.path).toBe(first.path);
    expect(second.resourceId).toBe(doc.id);
    expect(await repo!.resolveHead()).toBe(headAfterFirst);
  });

  it("recovers its own deleted-document recovery after a lost acknowledgement, without a second copy of the id", async () => {
    const { db, project, actor } = await ownerProject("recover-deleted-ack");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Gone",
        content: { kind: "markdown", contentJson: parseDocumentBody("body\n") },
      },
      actor,
    );
    await deleteDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      actor,
    );
    const [item] = (
      await listDeletedContent(db, { projectId: project.id, limit: 5 }, actor)
    ).items;
    const request = {
      idempotencyKey: "recover-deleted-ack-1",
      toolName: "restore_content",
      summary: "Recover",
      operation: {
        kind: "content.restore",
        projectId: project.id,
        resourceType: "document",
        resourceId: doc.id,
        mode: "deleted",
        sourceSha: item!.sourceSha,
        deletedAtSha: item!.deletedAtSha,
      },
    } as const;

    const first = await applyMcpOperation(db, actor, request);
    // The commit landed but the acknowledgement never did.
    await db.mcpOperation.deleteMany({ where: { userId: actor.userId } });
    const repo = await openProjectRepo(project.id);
    const headAfterFirst = await repo!.resolveHead();

    const second = await applyMcpOperation(db, actor, request);

    expect(second.commitSha).toBe(first.commitSha);
    expect(second.path).toBe(first.path);
    expect(second.resourceId).toBe(doc.id);
    expect(await repo!.resolveHead()).toBe(headAfterFirst);
    // A recovery brings its own UUID, so a replayed write would put that id in
    // a second file no reader could disambiguate.
    const carriers: string[] = [];
    for (const file of await repo!.listTrackedFiles(headAfterFirst)) {
      if (!file.endsWith(".md")) continue;
      if ((await repo!.showFileAt(headAfterFirst, file)).includes(doc.id))
        carriers.push(file);
    }
    expect(carriers).toEqual([first.path]);
  });

  it("refuses a second recovery of an id whose projection is missing but whose file is committed", async () => {
    const { db, project, actor } = await ownerProject("recover-no-row");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Gone",
        content: { kind: "markdown", contentJson: parseDocumentBody("body\n") },
      },
      actor,
    );
    await deleteDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      actor,
    );
    const [item] = (
      await listDeletedContent(db, { projectId: project.id, limit: 5 }, actor)
    ).items;
    const operation = {
      kind: "content.restore",
      projectId: project.id,
      resourceType: "document",
      resourceId: doc.id,
      mode: "deleted",
      sourceSha: item!.sourceSha,
      deletedAtSha: item!.deletedAtSha,
    } as const;

    const first = await applyMcpOperation(db, actor, {
      idempotencyKey: "recover-no-row-1",
      toolName: "restore_content",
      summary: "Recover",
      operation,
    });
    // updateProjection swallows a failure after commitAll, so a recovered
    // document can exist in Git with no row — and would be re-offered as
    // recoverable.
    await db.document.delete({ where: { id: doc.id } });
    const repo = await openProjectRepo(project.id);
    const headAfterFirst = await repo!.resolveHead();

    await expect(
      applyMcpOperation(db, actor, {
        idempotencyKey: "recover-no-row-2",
        toolName: "restore_content",
        summary: "Recover again",
        operation,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(await repo!.resolveHead()).toBe(headAfterFirst);
    // Refusing also repaired the projection, so the identity stops looking
    // absent to the deleted listing.
    const back = await getDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      actor,
    );
    expect(back.path).toBe(first.path);
    expect(
      (
        await listDeletedContent(db, { projectId: project.id, limit: 5 }, actor)
      ).items.map((entry) => entry.id),
    ).not.toContain(doc.id);
  });

  it("refuses to recover a document whose image blob cannot be read", async () => {
    const { db, project, actor } = await ownerProject("recover-dead-image");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Shots",
        content: { kind: "markdown", contentJson: parseDocumentBody("body\n") },
      },
      actor,
    );
    const stored = await storeDocumentImage(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        fileName: "shot.png",
        bytes: PNG_1X1,
      },
      actor,
    );
    const withImage = await getDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      actor,
    );
    await saveDocument(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        baseCommitSha: withImage.baseCommitSha,
        content: {
          kind: "markdown",
          contentJson: {
            type: "doc",
            content: [
              { type: "image", attrs: { src: stored.src, alt: "Shot" } },
            ],
          },
        },
        changeSummary: "",
      },
      actor,
    );
    await deleteDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      actor,
    );
    const [item] = (
      await listDeletedContent(db, { projectId: project.id, limit: 5 }, actor)
    ).items;
    const repo = await openProjectRepo(project.id);
    const headBefore = await repo!.resolveHead();

    // readCommittedBlobAt returns null for a blob past MAX_SERVED_BLOB_BYTES;
    // this reproduces that return without committing a 50 MB fixture.
    const realWithProjectRepo = projectRepo.withProjectRepo;
    const unreadableAssets: typeof projectRepo.withProjectRepo = (
      projectId,
      fn,
    ) =>
      realWithProjectRepo(projectId, (handle) =>
        fn({
          ...handle,
          readCommittedBlobAt: async (commitish, relPath, maxBytes) =>
            relPath.endsWith(".png")
              ? null
              : handle.readCommittedBlobAt(commitish, relPath, maxBytes),
        }),
      );
    const spy = vi
      .spyOn(projectRepo, "withProjectRepo")
      .mockImplementation(unreadableAssets);
    try {
      await expect(
        applyMcpOperation(db, actor, {
          idempotencyKey: "recover-dead-image-1",
          toolName: "restore_content",
          summary: "Recover",
          operation: {
            kind: "content.restore",
            projectId: project.id,
            resourceType: "document",
            resourceId: doc.id,
            mode: "deleted",
            sourceSha: item!.sourceSha,
            deletedAtSha: item!.deletedAtSha,
          },
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    } finally {
      spy.mockRestore();
    }
    // Nothing was written, so the item stays recoverable rather than coming
    // back as a document with a link to a file that was never committed.
    expect(await repo!.resolveHead()).toBe(headBefore);
    expect(
      (
        await listDeletedContent(db, { projectId: project.id, limit: 5 }, actor)
      ).items.map((entry) => entry.id),
    ).toContain(doc.id);
  });

  it("recovers a deleted document's images at its new asset prefix", async () => {
    const { db, project, actor } = await ownerProject("recover-images");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Shots",
        content: { kind: "markdown", contentJson: parseDocumentBody("body\n") },
      },
      actor,
    );
    const stored = await storeDocumentImage(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        fileName: "shot.png",
        bytes: PNG_1X1,
      },
      actor,
    );
    const fileName = stored.path.split("/").pop()!;
    const withImage = await getDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      actor,
    );
    await saveDocument(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        baseCommitSha: withImage.baseCommitSha,
        content: {
          kind: "markdown",
          contentJson: {
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Intro" }] },
              { type: "image", attrs: { src: stored.src, alt: "Shot" } },
            ],
          },
        },
        changeSummary: "",
      },
      actor,
    );
    await deleteDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      actor,
    );
    const [item] = (
      await listDeletedContent(db, { projectId: project.id, limit: 5 }, actor)
    ).items;

    const applied = await applyMcpOperation(db, actor, {
      idempotencyKey: "recover-images-1",
      toolName: "restore_content",
      summary: "Recover",
      operation: {
        kind: "content.restore",
        projectId: project.id,
        resourceType: "document",
        resourceId: doc.id,
        mode: "deleted",
        sourceSha: item!.sourceSha,
        deletedAtSha: item!.deletedAtSha,
      },
    });

    const back = await getDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      actor,
    );
    const repo = await openProjectRepo(project.id);
    const head = await repo!.resolveHead();
    const restoredAsset = `${back.slug}.assets/${fileName}`;
    // The blob comes back beside the recovered document, and its own link
    // points at the recovered slug — not the dead original one.
    expect(await repo!.listTrackedFiles()).toContain(restoredAsset);
    expect(serializeDocumentBody(markdownContent(back))).toContain(
      restoredAsset,
    );
    expect(await repo!.blobShaAt(head, stored.path)).toBeNull();
    // Byte identity, not just presence.
    expect(await repo!.blobShaAt(head, restoredAsset)).toBe(
      await repo!.blobShaAt(item!.sourceSha, stored.path),
    );
    // One operation, one commit: the returned sha IS the document's head, so a
    // client can use it as its next baseCommitSha.
    expect(applied.commitSha).toBe(head);
    expect(back.baseCommitSha).toBe(applied.commitSha);
  });
});

describe("restore approval policy", () => {
  it("never auto-applies a restore, but still auto-applies an ordinary edit", async () => {
    const { db, project, actor } = await ownerProject("approval");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Guide",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("first\n"),
        },
      },
      actor,
    );
    const v1 = await getDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      actor,
    );
    const conversation = await createConversation(db, actor, {});
    await db.assistantConversation.update({
      where: { id: conversation.id },
      data: { autoApproveChanges: true },
    });
    const { run } = await submitUserMessage(db, actor, {
      conversationId: conversation.id,
      text: "go",
      scope: { kind: "project", projectId: project.id },
    });
    // createProposal only auto-applies for a leased, running attempt.
    const leased = (await leaseRunAttempt(db, {
      runId: run.id,
      workerId: "approval-test",
    }))!;

    const edit = await createProposal(db, actor, {
      conversationId: conversation.id,
      runId: run.id,
      attemptId: leased.attempt.id,
      summary: "Ordinary edit",
      operation: {
        kind: "document.patch",
        projectId: project.id,
        documentId: doc.id,
        baseCommitSha: v1.baseCommitSha,
        actions: [{ action: "replace_text", find: "first", replace: "second" }],
      },
    });
    expect(edit.status).toBe("accepted");

    const head = await getDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      actor,
    );
    const restore = await createProposal(db, actor, {
      conversationId: conversation.id,
      runId: run.id,
      attemptId: leased.attempt.id,
      summary: "Roll back",
      operation: {
        kind: "content.restore",
        projectId: project.id,
        resourceType: "document",
        resourceId: doc.id,
        mode: "version",
        sourceSha: v1.baseCommitSha,
        expectedHeadCommitSha: head.baseCommitSha,
      },
    });
    expect(restore.status).toBe("pending");
    // The view's kind carries the resource type, so the card can link a
    // restore to the right area.
    expect(restore.kind).toBe("content.restore.document");

    // And the document is untouched until someone approves it.
    const after = await getDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      actor,
    );
    expect(after.baseCommitSha).toBe(head.baseCommitSha);
  });

  it("names the resource type on a table restore proposal", async () => {
    const { db, project, actor } = await ownerProject("approval-table");
    const table = await createTable(
      db,
      { projectId: project.id, folderPath: [], title: "Roster" },
      actor,
    );
    const head = await getTable(
      db,
      { projectId: project.id, tableId: table.id },
      actor,
    );
    const conversation = await createConversation(db, actor, {});
    const { run } = await submitUserMessage(db, actor, {
      conversationId: conversation.id,
      text: "go",
      scope: { kind: "project", projectId: project.id },
    });

    const restore = await createProposal(db, actor, {
      conversationId: conversation.id,
      runId: run.id,
      summary: "Roll the table back",
      operation: {
        kind: "content.restore",
        projectId: project.id,
        resourceType: "table",
        resourceId: table.id,
        mode: "version",
        sourceSha: head.baseCommitSha,
        expectedHeadCommitSha: head.baseCommitSha,
      },
    });
    expect(restore.kind).toBe("content.restore.table");
  });
});

describe("content_history", () => {
  async function run(
    input: Record<string, unknown>,
    ctx: Awaited<ReturnType<typeof ownerProject>>,
  ) {
    const { contentHistoryTool } =
      await import("@weaver/assistant-tools/tools/history");
    const scope = await resolveScopeSnapshot(ctx.db, ctx.actor, {
      kind: "project",
      projectId: ctx.project.id,
    });
    return contentHistoryTool.execute(
      input as never,
      {
        db: ctx.db,
        actor: ctx.actor,
        scope,
        profile: { name: AUTHOR.name, email: ctx.actor.email },
        run: null,
      } as never,
    );
  }

  it("lists a document's versions and diffs two of them", async () => {
    const ctx = await ownerProject("tool-versions");
    const doc = await createDocument(
      ctx.db,
      {
        projectId: ctx.project.id,
        folderPath: [],
        title: "Guide",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("first\n"),
        },
      },
      ctx.actor,
    );
    const v1 = await getDocument(
      ctx.db,
      { projectId: ctx.project.id, documentId: doc.id },
      ctx.actor,
    );
    const v2 = await saveDocument(
      ctx.db,
      {
        projectId: ctx.project.id,
        documentId: doc.id,
        baseCommitSha: v1.baseCommitSha,
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("second\n"),
        },
        changeSummary: "",
      },
      ctx.actor,
    );

    const versions = (await run(
      {
        projectId: ctx.project.id,
        mode: "versions",
        resourceType: "document",
        resourceId: doc.id,
      },
      ctx,
    )) as { output: { entries: { sha: string }[] } };
    expect(versions.output.entries.length).toBeGreaterThanOrEqual(2);

    const diff = (await run(
      {
        projectId: ctx.project.id,
        mode: "diff",
        resourceType: "document",
        resourceId: doc.id,
        fromSha: v1.baseCommitSha,
        toSha: v2.headCommitSha,
      },
      ctx,
    )) as { output: { lines?: { type: string; text: string }[] } };
    expect(
      diff.output.lines?.some(
        (line) => line.type === "add" && line.text.includes("second"),
      ),
    ).toBe(true);
  });

  it("includes stored change summaries in document versions", async () => {
    const ctx = await ownerProject("tool-summary");
    const doc = await createDocument(
      ctx.db,
      {
        projectId: ctx.project.id,
        folderPath: [],
        title: "Guide",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("first\n"),
        },
      },
      ctx.actor,
    );
    const v2 = await saveDocument(
      ctx.db,
      {
        projectId: ctx.project.id,
        documentId: doc.id,
        baseCommitSha: doc.headCommitSha,
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("second\n"),
        },
        changeSummary: "",
      },
      ctx.actor,
    );
    const now = new Date();
    await ctx.db.documentChangeSummary.create({
      data: {
        projectId: ctx.project.id,
        commitSha: v2.headCommitSha,
        documentId: doc.id,
        pathAtSha: v2.path,
        baseCommitSha: doc.headCommitSha,
        status: "pending",
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      },
    });
    const versions = (await run(
      {
        projectId: ctx.project.id,
        mode: "versions",
        resourceType: "document",
        resourceId: doc.id,
      },
      ctx,
    )) as {
      output: {
        entries: { sha: string; message: string; changeSummary: unknown }[];
      };
    };
    expect(versions.output.entries[0]).toMatchObject({
      sha: v2.headCommitSha,
      message: "update: guide.md",
      changeSummary: { status: "pending", summary: null },
    });
    expect(versions.output.entries[1]?.changeSummary).toBeNull();
  });

  it("lists deleted items and rejects a resourceId in deleted mode", async () => {
    const ctx = await ownerProject("tool-deleted");
    const doc = await createDocument(
      ctx.db,
      {
        projectId: ctx.project.id,
        folderPath: [],
        title: "Gone",
        content: { kind: "markdown", contentJson: parseDocumentBody("x\n") },
      },
      ctx.actor,
    );
    await deleteDocument(
      ctx.db,
      { projectId: ctx.project.id, documentId: doc.id },
      ctx.actor,
    );

    const deleted = (await run(
      { projectId: ctx.project.id, mode: "deleted" },
      ctx,
    )) as { output: { items: { id: string }[] } };
    expect(deleted.output.items.map((item) => item.id)).toContain(doc.id);

    await expect(
      run(
        { projectId: ctx.project.id, mode: "deleted", resourceId: doc.id },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("keeps every deleted item reachable when the page budget truncates one", async () => {
    const ctx = await ownerProject("tool-deleted-budget");
    const created = [];
    for (let i = 0; i < 3; i++) {
      const doc = await createDocument(
        ctx.db,
        {
          projectId: ctx.project.id,
          folderPath: [],
          title: `Budget ${i}`,
          content: { kind: "markdown", contentJson: parseDocumentBody("x\n") },
        },
        ctx.actor,
      );
      created.push(doc);
    }
    await deleteTogether(ctx, created);
    // A real deleted item is a few hundred bytes, so the aggregate backstop
    // only fires on a page far larger than this one — shrink the budget
    // instead of committing dozens of documents to reach it.
    const budget = vi
      .spyOn(toolContract, "newPageBudget")
      .mockImplementation(() => ({ remaining: 300 }));
    try {
      const seen: string[] = [];
      let cursor: string | undefined;
      let firstPageCount: number | undefined;
      let finished = false;
      for (let guard = 0; guard < 10; guard++) {
        const page = (await run(
          { projectId: ctx.project.id, mode: "deleted", limit: 50, cursor },
          ctx,
        )) as {
          output: {
            items: { id: string }[];
            hasMore: boolean;
            nextCursor: string | null;
          };
        };
        firstPageCount ??= page.output.items.length;
        seen.push(...page.output.items.map((item) => item.id));
        if (!page.output.hasMore) {
          expect(page.output.nextCursor).toBeNull();
          finished = true;
          break;
        }
        // A page that dropped items must still hand back a way to reach them.
        expect(page.output.items.length).toBeGreaterThan(0);
        expect(page.output.nextCursor).toBeTruthy();
        cursor = page.output.nextCursor!;
      }
      expect(finished).toBe(true);
      // Truncation really happened: the inventory did not fit in one page.
      expect(firstPageCount).toBeLessThan(created.length);
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.sort()).toEqual(created.map((doc) => doc.id).sort());
    } finally {
      budget.mockRestore();
    }
  });

  it("requires the fields each mode needs", async () => {
    const ctx = await ownerProject("tool-modes");
    await expect(
      run({ projectId: ctx.project.id, mode: "versions" }, ctx),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      run(
        {
          projectId: ctx.project.id,
          mode: "diff",
          resourceType: "document",
          resourceId: "00000000-0000-4000-8000-000000000000",
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

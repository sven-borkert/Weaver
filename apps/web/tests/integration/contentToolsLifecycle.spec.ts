import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addMembership,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
} from "./_harness";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import {
  createDocument,
  deleteDocument,
  deleteDocumentInRepo,
  getDocument,
  moveDocumentInRepo,
} from "@weaver/core/services/documents";
import {
  createTable,
  deleteTable,
  deleteTableInRepo,
  getTable,
  moveTableInRepo,
} from "@weaver/core/services/tables";
import { listContentFolders } from "@weaver/core/services/folders";
import * as folders from "@weaver/core/services/folders";
import * as tableFolders from "@weaver/core/services/tableFolders";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import { withProjectRepo } from "@weaver/core/services/projectRepo";
import { openProjectRepo } from "@weaver/git-store";
import { applyMcpOperation } from "@weaver/core/services/mcpOperations";
import type { ContentOperation } from "@weaver/core/services/contentOperations";
import { storeDocumentImage } from "@weaver/core/services/documentImages";
import { listDeletedContent } from "@weaver/core/services/contentRecovery";
import {
  createProposal,
  getProposal,
} from "@weaver/core/services/assistantProposals";
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
  const project = await makeProject(`Lifecycle ${suffix}`);
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

describe("listContentFolders", () => {
  it("returns both scopes under one pinned project revision", async () => {
    const f = await ownerProject("folders-both");
    await folders.createFolder(
      f.db,
      { projectId: f.project.id, parentPath: [], name: "Archive" },
      f.actor,
    );
    await tableFolders.createFolder(
      f.db,
      { projectId: f.project.id, parentPath: [], name: "Metrics" },
      f.actor,
    );

    const listing = await listContentFolders(
      f.db,
      { projectId: f.project.id },
      f.actor,
    );

    expect(listing.baseProjectCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(listing.folders).toContainEqual({
      resourceType: "document",
      path: ["archive"],
    });
    expect(listing.folders).toContainEqual({
      resourceType: "table",
      path: ["metrics"],
    });
    // The tables root is a scope boundary, not a document folder.
    expect(
      listing.folders.some(
        (entry) =>
          entry.resourceType === "document" && entry.path[0] === "tables",
      ),
    ).toBe(false);
  });

  it("filters to one resource type when asked", async () => {
    const f = await ownerProject("folders-filter");
    await folders.createFolder(
      f.db,
      { projectId: f.project.id, parentPath: [], name: "Archive" },
      f.actor,
    );
    await tableFolders.createFolder(
      f.db,
      { projectId: f.project.id, parentPath: [], name: "Metrics" },
      f.actor,
    );

    const listing = await listContentFolders(
      f.db,
      { projectId: f.project.id, resourceType: "table" },
      f.actor,
    );

    expect(listing.folders).toEqual([
      { resourceType: "table", path: ["metrics"] },
    ]);
  });

  it("pins a revision for a project that has no repository yet", async () => {
    const f = await ownerProject("folders-fresh");

    const listing = await listContentFolders(
      f.db,
      { projectId: f.project.id },
      f.actor,
    );

    expect(listing.folders).toEqual([]);
    expect(listing.baseProjectCommitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reports nested folders as segment arrays", async () => {
    const f = await ownerProject("folders-nested");
    await folders.createFolder(
      f.db,
      { projectId: f.project.id, parentPath: [], name: "Archive" },
      f.actor,
    );
    await folders.createFolder(
      f.db,
      { projectId: f.project.id, parentPath: ["archive"], name: "2024" },
      f.actor,
    );

    const listing = await listContentFolders(
      f.db,
      { projectId: f.project.id, resourceType: "document" },
      f.actor,
    );

    expect(listing.folders).toContainEqual({
      resourceType: "document",
      path: ["archive", "2024"],
    });
  });

  it("allows a Viewer and refuses a non-member", async () => {
    const f = await ownerProject("folders-access");
    await createDocument(
      f.db,
      {
        projectId: f.project.id,
        title: "Doc",
        folderPath: [],
        content: { kind: "markdown", contentJson: parseDocumentBody("body\n") },
      },
      f.actor,
    );

    await expect(
      listContentFolders(f.db, { projectId: f.project.id }, f.viewerActor),
    ).resolves.toMatchObject({ folders: [] });
    await expect(
      listContentFolders(f.db, { projectId: f.project.id }, f.outsiderActor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("does not report a table's own directory as a folder", async () => {
    const f = await ownerProject("folders-tabledir");
    await createTable(
      f.db,
      {
        projectId: f.project.id,
        title: "Roster",
        folderPath: [],
      },
      f.actor,
    );

    const listing = await listContentFolders(
      f.db,
      { projectId: f.project.id, resourceType: "table" },
      f.actor,
    );

    expect(listing.folders).toEqual([]);
  });
});

const OPERATION_ID = "proposal:33333333-3333-4333-8333-333333333333";

async function trailerCommits(projectId: string, operationId: string) {
  const repo = await openProjectRepo(projectId);
  if (!repo) throw new Error("project has no repository");
  const entries = await repo.logForPath(".", {
    skip: 0,
    limit: 20,
    operationId,
  });
  return entries.filter((entry) => entry.operationId === operationId);
}

describe("lock-free item writers", () => {
  it("moves a document inside a caller-held lock and records the trailer", async () => {
    const f = await ownerProject("doc-move");
    const doc = await createDocument(
      f.db,
      {
        projectId: f.project.id,
        title: "Guide",
        folderPath: [],
        content: { kind: "markdown", contentJson: parseDocumentBody("body\n") },
      },
      f.actor,
    );
    await folders.createFolder(
      f.db,
      { projectId: f.project.id, parentPath: [], name: "Archive" },
      f.actor,
    );

    const moved = await withProjectRepo(f.project.id, (repo) =>
      moveDocumentInRepo(
        f.db,
        repo,
        {
          projectId: f.project.id,
          documentId: doc.id,
          folderPath: ["archive"],
        },
        f.actor,
        { operationId: OPERATION_ID },
      ),
    );

    expect(moved.path).toBe("archive/guide.md");
    const row = await f.db.document.findUniqueOrThrow({
      where: { id: doc.id },
    });
    expect(row.path).toBe("archive/guide.md");
    expect(await trailerCommits(f.project.id, OPERATION_ID)).toHaveLength(1);
  });

  it("deletes a document inside a caller-held lock and reports the commit", async () => {
    const f = await ownerProject("doc-delete");
    const doc = await createDocument(
      f.db,
      {
        projectId: f.project.id,
        title: "Guide",
        folderPath: [],
        content: { kind: "markdown", contentJson: parseDocumentBody("body\n") },
      },
      f.actor,
    );

    const deleted = await withProjectRepo(f.project.id, (repo) =>
      deleteDocumentInRepo(
        f.db,
        repo,
        { projectId: f.project.id, documentId: doc.id },
        f.actor,
        { operationId: OPERATION_ID },
      ),
    );

    expect(deleted).toMatchObject({ id: doc.id, path: "guide.md" });
    expect(deleted.headCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(
      await f.db.document.findUnique({ where: { id: doc.id } }),
    ).toBeNull();
    expect(await trailerCommits(f.project.id, OPERATION_ID)).toHaveLength(1);
  });

  it("moves a table inside a caller-held lock and records the trailer", async () => {
    const f = await ownerProject("table-move");
    const table = await createTable(
      f.db,
      {
        projectId: f.project.id,
        title: "Roster",
        folderPath: [],
      },
      f.actor,
    );
    await tableFolders.createFolder(
      f.db,
      { projectId: f.project.id, parentPath: [], name: "Metrics" },
      f.actor,
    );

    const moved = await withProjectRepo(f.project.id, (repo) =>
      moveTableInRepo(
        f.db,
        repo,
        {
          projectId: f.project.id,
          tableId: table.id,
          folderPath: ["metrics"],
        },
        f.actor,
        { operationId: OPERATION_ID },
      ),
    );

    expect(moved.path).toBe("tables/metrics/roster.table");
    expect(await trailerCommits(f.project.id, OPERATION_ID)).toHaveLength(1);
  });

  it("deletes a table inside a caller-held lock and still refuses a stale head", async () => {
    const f = await ownerProject("table-delete");
    const table = await createTable(
      f.db,
      {
        projectId: f.project.id,
        title: "Roster",
        folderPath: [],
      },
      f.actor,
    );

    await expect(
      withProjectRepo(f.project.id, (repo) =>
        deleteTableInRepo(
          f.db,
          repo,
          {
            projectId: f.project.id,
            tableId: table.id,
            expectedHeadCommitSha: "b".repeat(40),
          },
          f.actor,
        ),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const deleted = await withProjectRepo(f.project.id, (repo) =>
      deleteTableInRepo(
        f.db,
        repo,
        {
          projectId: f.project.id,
          tableId: table.id,
          expectedHeadCommitSha: table.headCommitSha,
        },
        f.actor,
        { operationId: OPERATION_ID },
      ),
    );

    expect(deleted).toMatchObject({
      id: table.id,
      path: "tables/roster.table",
    });
    expect(
      await f.db.dataTable.findUnique({ where: { id: table.id } }),
    ).toBeNull();
    expect(await trailerCommits(f.project.id, OPERATION_ID)).toHaveLength(1);
  });
});

let keySeq = 0;
const nextKey = () =>
  `lifecycle-key-${(keySeq += 1).toString().padStart(4, "0")}`;

function applyLifecycle(
  f: Awaited<ReturnType<typeof ownerProject>>,
  operation: ContentOperation,
) {
  return applyMcpOperation(f.db, f.actor, {
    idempotencyKey: nextKey(),
    toolName: "apply_content_lifecycle",
    operation,
    summary: "organize",
  });
}

describe("content.lifecycle operation", () => {
  it("creates a folder and reports the commit with no resource id", async () => {
    const f = await ownerProject("op-folder-create");
    const listing = await listContentFolders(
      f.db,
      { projectId: f.project.id },
      f.actor,
    );

    const result = await applyLifecycle(f, {
      kind: "content.lifecycle",
      projectId: f.project.id,
      action: "folder_create",
      resourceType: "document",
      baseProjectCommitSha: listing.baseProjectCommitSha,
      parentPath: [],
      name: "Archive",
    });

    expect(result.resourceId).toBeNull();
    expect(result.path).toBe("archive");
    const after = await listContentFolders(
      f.db,
      { projectId: f.project.id, resourceType: "document" },
      f.actor,
    );
    expect(after.folders).toContainEqual({
      resourceType: "document",
      path: ["archive"],
    });
  });

  it("creates a table folder under the tables root", async () => {
    const f = await ownerProject("op-table-folder");
    const listing = await listContentFolders(
      f.db,
      { projectId: f.project.id },
      f.actor,
    );

    const result = await applyLifecycle(f, {
      kind: "content.lifecycle",
      projectId: f.project.id,
      action: "folder_create",
      resourceType: "table",
      baseProjectCommitSha: listing.baseProjectCommitSha,
      parentPath: [],
      name: "Metrics",
    });

    expect(result.path).toBe("tables/metrics");
  });

  it("renames a folder and repoints the documents inside it", async () => {
    const f = await ownerProject("op-folder-rename");
    await folders.createFolder(
      f.db,
      { projectId: f.project.id, parentPath: [], name: "Archive" },
      f.actor,
    );
    const doc = await createDocument(
      f.db,
      {
        projectId: f.project.id,
        title: "Guide",
        folderPath: ["archive"],
        content: { kind: "markdown", contentJson: parseDocumentBody("body\n") },
      },
      f.actor,
    );
    const listing = await listContentFolders(
      f.db,
      { projectId: f.project.id },
      f.actor,
    );

    await applyLifecycle(f, {
      kind: "content.lifecycle",
      projectId: f.project.id,
      action: "folder_rename",
      resourceType: "document",
      baseProjectCommitSha: listing.baseProjectCommitSha,
      path: ["archive"],
      name: "Attic",
    });

    const row = await f.db.document.findUniqueOrThrow({
      where: { id: doc.id },
    });
    expect(row.path).toBe("attic/guide.md");
    const repo = await openProjectRepo(f.project.id);
    expect(
      await folders.readFolderNamesAt(
        repo!,
        "documents",
        await repo!.resolveHead(),
        ["attic"],
      ),
    ).toEqual({ attic: "Attic" });
  });

  it("commits a capitalization-only folder rename once and replays it", async () => {
    const f = await ownerProject("op-folder-rename-case");
    await folders.createFolder(
      f.db,
      { projectId: f.project.id, parentPath: [], name: "archive" },
      f.actor,
    );
    const listing = await listContentFolders(
      f.db,
      { projectId: f.project.id },
      f.actor,
    );
    const request: {
      idempotencyKey: string;
      toolName: string;
      summary: string;
      operation: ContentOperation;
    } = {
      idempotencyKey: "rename-case-only-1",
      toolName: "apply_content_lifecycle",
      summary: "Capitalize the folder",
      operation: {
        kind: "content.lifecycle",
        projectId: f.project.id,
        action: "folder_rename",
        resourceType: "document",
        baseProjectCommitSha: listing.baseProjectCommitSha,
        path: ["archive"],
        name: "Archive",
      },
    };

    const first = await applyMcpOperation(f.db, f.actor, request);

    expect(first.path).toBe("archive");
    expect(first.commitSha).not.toBe(listing.baseProjectCommitSha);
    const repo = await openProjectRepo(f.project.id);
    expect(await repo!.resolveHead()).toBe(first.commitSha);
    const log = await repo!.logForPath(".", { skip: 0, limit: 20 });
    const entry = log.find((candidate) => candidate.sha === first.commitSha);
    expect(entry?.message).toContain("update: archive/");
    expect(entry?.operationId).toBeTruthy();
    expect(
      await trailerCommits(f.project.id, entry!.operationId!),
    ).toHaveLength(1);
    expect(log[1]?.sha).toBe(listing.baseProjectCommitSha);
    expect(
      await folders.readFolderNamesAt(repo!, "documents", first.commitSha, [
        "archive",
      ]),
    ).toEqual({ archive: "Archive" });

    // The commit landed but the acknowledgement never did.
    await f.db.mcpOperation.deleteMany({ where: { userId: f.actor.userId } });
    const second = await applyMcpOperation(f.db, f.actor, request);

    expect(second.commitSha).toBe(first.commitSha);
    expect(second.path).toBe("archive");
    expect(await repo!.resolveHead()).toBe(first.commitSha);
  });

  it("renames a table folder and stores its display name under the tables root", async () => {
    const f = await ownerProject("op-table-folder-rename");
    await tableFolders.createFolder(
      f.db,
      { projectId: f.project.id, parentPath: [], name: "Metrics" },
      f.actor,
    );
    const listing = await listContentFolders(
      f.db,
      { projectId: f.project.id },
      f.actor,
    );

    const result = await applyLifecycle(f, {
      kind: "content.lifecycle",
      projectId: f.project.id,
      action: "folder_rename",
      resourceType: "table",
      baseProjectCommitSha: listing.baseProjectCommitSha,
      path: ["metrics"],
      name: "Key Figures",
    });

    expect(result.path).toBe("tables/key-figures");
    const repo = await openProjectRepo(f.project.id);
    expect(
      await folders.readFolderNamesAt(repo!, "tables", result.commitSha, [
        "key-figures",
      ]),
    ).toEqual({ "key-figures": "Key Figures" });
    expect(await repo!.listTrackedFiles(result.commitSha)).not.toContain(
      "tables/metrics/.folder.json",
    );
  });

  it("leaves the worktree clean when a rename collides with a sibling", async () => {
    const f = await ownerProject("op-folder-rename-conflict");
    for (const name of ["Archive", "Attic"])
      await folders.createFolder(
        f.db,
        { projectId: f.project.id, parentPath: [], name },
        f.actor,
      );
    const listing = await listContentFolders(
      f.db,
      { projectId: f.project.id },
      f.actor,
    );

    await expect(
      applyLifecycle(f, {
        kind: "content.lifecycle",
        projectId: f.project.id,
        action: "folder_rename",
        resourceType: "document",
        baseProjectCommitSha: listing.baseProjectCommitSha,
        path: ["archive"],
        name: "Attic",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const repo = await openProjectRepo(f.project.id);
    expect(await repo!.resolveHead()).toBe(listing.baseProjectCommitSha);
    expect(
      await folders.readFolderNamesAt(
        repo!,
        "documents",
        listing.baseProjectCommitSha,
        ["archive"],
      ),
    ).toEqual({ archive: "Archive" });
  });

  it("moves a folder into another folder and repoints the documents inside it", async () => {
    const f = await ownerProject("op-folder-move");
    await folders.createFolder(
      f.db,
      { projectId: f.project.id, parentPath: [], name: "Archive" },
      f.actor,
    );
    await folders.createFolder(
      f.db,
      { projectId: f.project.id, parentPath: [], name: "Store" },
      f.actor,
    );
    const doc = await createDocument(
      f.db,
      {
        projectId: f.project.id,
        title: "Guide",
        folderPath: ["archive"],
        content: { kind: "markdown", contentJson: parseDocumentBody("body\n") },
      },
      f.actor,
    );
    const listing = await listContentFolders(
      f.db,
      { projectId: f.project.id },
      f.actor,
    );

    const result = await applyLifecycle(f, {
      kind: "content.lifecycle",
      projectId: f.project.id,
      action: "folder_move",
      resourceType: "document",
      baseProjectCommitSha: listing.baseProjectCommitSha,
      path: ["archive"],
      newParentPath: ["store"],
    });

    expect(result.path).toBe("store/archive");
    const row = await f.db.document.findUniqueOrThrow({
      where: { id: doc.id },
    });
    expect(row.path).toBe("store/archive/guide.md");
  });

  it("refuses a folder action whose project revision moved", async () => {
    const f = await ownerProject("op-folder-stale");
    const listing = await listContentFolders(
      f.db,
      { projectId: f.project.id },
      f.actor,
    );
    // Any unrelated commit invalidates the conservative project-wide guard.
    await createDocument(
      f.db,
      {
        projectId: f.project.id,
        title: "Unrelated",
        folderPath: [],
        content: { kind: "markdown", contentJson: parseDocumentBody("body\n") },
      },
      f.actor,
    );

    await expect(
      applyLifecycle(f, {
        kind: "content.lifecycle",
        projectId: f.project.id,
        action: "folder_create",
        resourceType: "document",
        baseProjectCommitSha: listing.baseProjectCommitSha,
        parentPath: [],
        name: "Archive",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "STALE_BASE" },
    });
  });

  it("refuses to delete a folder that still has content", async () => {
    const f = await ownerProject("op-folder-nonempty");
    await folders.createFolder(
      f.db,
      { projectId: f.project.id, parentPath: [], name: "Archive" },
      f.actor,
    );
    await createDocument(
      f.db,
      {
        projectId: f.project.id,
        title: "Guide",
        folderPath: ["archive"],
        content: { kind: "markdown", contentJson: parseDocumentBody("body\n") },
      },
      f.actor,
    );
    const listing = await listContentFolders(
      f.db,
      { projectId: f.project.id },
      f.actor,
    );

    await expect(
      applyLifecycle(f, {
        kind: "content.lifecycle",
        projectId: f.project.id,
        action: "folder_delete",
        resourceType: "document",
        baseProjectCommitSha: listing.baseProjectCommitSha,
        path: ["archive"],
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("deletes an empty folder", async () => {
    const f = await ownerProject("op-folder-delete");
    await folders.createFolder(
      f.db,
      { projectId: f.project.id, parentPath: [], name: "Archive" },
      f.actor,
    );
    const listing = await listContentFolders(
      f.db,
      { projectId: f.project.id },
      f.actor,
    );

    await applyLifecycle(f, {
      kind: "content.lifecycle",
      projectId: f.project.id,
      action: "folder_delete",
      resourceType: "document",
      baseProjectCommitSha: listing.baseProjectCommitSha,
      path: ["archive"],
    });

    const after = await listContentFolders(
      f.db,
      { projectId: f.project.id, resourceType: "document" },
      f.actor,
    );
    expect(after.folders).toEqual([]);
  });

  it("moves a document and refuses a stale item base", async () => {
    const f = await ownerProject("op-item-move");
    const doc = await createDocument(
      f.db,
      {
        projectId: f.project.id,
        title: "Guide",
        folderPath: [],
        content: { kind: "markdown", contentJson: parseDocumentBody("body\n") },
      },
      f.actor,
    );
    await folders.createFolder(
      f.db,
      { projectId: f.project.id, parentPath: [], name: "Archive" },
      f.actor,
    );

    await expect(
      applyLifecycle(f, {
        kind: "content.lifecycle",
        projectId: f.project.id,
        action: "item_move",
        resourceType: "document",
        resourceId: doc.id,
        expectedHeadCommitSha: "c".repeat(40),
        folderPath: ["archive"],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const current = await getDocument(
      f.db,
      { projectId: f.project.id, documentId: doc.id },
      f.actor,
    );
    const before = queue.jobs.length;
    const result = await applyLifecycle(f, {
      kind: "content.lifecycle",
      projectId: f.project.id,
      action: "item_move",
      resourceType: "document",
      resourceId: doc.id,
      expectedHeadCommitSha: current.baseCommitSha,
      folderPath: ["archive"],
    });

    expect(result).toMatchObject({
      resourceId: doc.id,
      path: "archive/guide.md",
    });
    expect(queue.jobs.slice(before).map((job) => job.name)).toEqual([
      "document.search-sync",
    ]);
  });

  it("moves a table into a table folder", async () => {
    const f = await ownerProject("op-table-move");
    const table = await createTable(
      f.db,
      {
        projectId: f.project.id,
        title: "Roster",
        folderPath: [],
      },
      f.actor,
    );
    await tableFolders.createFolder(
      f.db,
      { projectId: f.project.id, parentPath: [], name: "Metrics" },
      f.actor,
    );
    const current = await getTable(
      f.db,
      { projectId: f.project.id, tableId: table.id },
      f.actor,
    );

    const before = queue.jobs.length;
    const result = await applyLifecycle(f, {
      kind: "content.lifecycle",
      projectId: f.project.id,
      action: "item_move",
      resourceType: "table",
      resourceId: table.id,
      expectedHeadCommitSha: current.baseCommitSha,
      folderPath: ["metrics"],
    });

    expect(result.path).toBe("tables/metrics/roster.table");
    expect(queue.jobs.slice(before).map((job) => job.name)).toEqual([
      "table.search-sync",
    ]);
  });

  it("deletes a document and a table", async () => {
    const f = await ownerProject("op-item-delete");
    const doc = await createDocument(
      f.db,
      {
        projectId: f.project.id,
        title: "Guide",
        folderPath: [],
        content: { kind: "markdown", contentJson: parseDocumentBody("body\n") },
      },
      f.actor,
    );
    const table = await createTable(
      f.db,
      {
        projectId: f.project.id,
        title: "Roster",
        folderPath: [],
      },
      f.actor,
    );
    const currentDoc = await getDocument(
      f.db,
      { projectId: f.project.id, documentId: doc.id },
      f.actor,
    );
    const currentTable = await getTable(
      f.db,
      { projectId: f.project.id, tableId: table.id },
      f.actor,
    );

    const before = queue.jobs.length;
    await applyLifecycle(f, {
      kind: "content.lifecycle",
      projectId: f.project.id,
      action: "item_delete",
      resourceType: "document",
      resourceId: doc.id,
      expectedHeadCommitSha: currentDoc.baseCommitSha,
    });
    await applyLifecycle(f, {
      kind: "content.lifecycle",
      projectId: f.project.id,
      action: "item_delete",
      resourceType: "table",
      resourceId: table.id,
      expectedHeadCommitSha: currentTable.baseCommitSha,
    });

    expect(
      await f.db.document.findUnique({ where: { id: doc.id } }),
    ).toBeNull();
    expect(
      await f.db.dataTable.findUnique({ where: { id: table.id } }),
    ).toBeNull();
    expect(
      queue.jobs.slice(before).filter((job) => job.name === "content.delete"),
    ).toHaveLength(2);
  });

  it("rejects a field that does not belong to the action", async () => {
    const f = await ownerProject("op-bad-field");
    const listing = await listContentFolders(
      f.db,
      { projectId: f.project.id },
      f.actor,
    );

    await expect(
      applyLifecycle(f, {
        kind: "content.lifecycle",
        projectId: f.project.id,
        action: "folder_create",
        resourceType: "document",
        baseProjectCommitSha: listing.baseProjectCommitSha,
        parentPath: [],
        name: "Archive",
        resourceId: "44444444-4444-4444-8444-444444444444",
      } as ContentOperation),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "resourceId" },
    });
  });
});

describe("lifecycle recovery after a lost acknowledgement", () => {
  it("replays its own folder create instead of colliding with it", async () => {
    const f = await ownerProject("ack-folder-create");
    const listing = await listContentFolders(
      f.db,
      { projectId: f.project.id },
      f.actor,
    );
    // Not `as const`: parentPath/name are arrays typed mutable in
    // ContentOperation, and a readonly tuple isn't assignable to string[].
    const request: {
      idempotencyKey: string;
      toolName: string;
      summary: string;
      operation: ContentOperation;
    } = {
      idempotencyKey: "ack-folder-create-1",
      toolName: "apply_content_lifecycle",
      summary: "Add a folder",
      operation: {
        kind: "content.lifecycle",
        projectId: f.project.id,
        action: "folder_create",
        resourceType: "document",
        baseProjectCommitSha: listing.baseProjectCommitSha,
        parentPath: [],
        name: "Archive",
      },
    };

    const first = await applyMcpOperation(f.db, f.actor, request);
    // The commit landed but the acknowledgement never did.
    await f.db.mcpOperation.deleteMany({ where: { userId: f.actor.userId } });
    const repo = await openProjectRepo(f.project.id);
    const headAfterFirst = await repo!.resolveHead();

    const second = await applyMcpOperation(f.db, f.actor, request);

    expect(second.commitSha).toBe(first.commitSha);
    expect(second.path).toBe("archive");
    expect(second.resourceId).toBeNull();
    expect(await repo!.resolveHead()).toBe(headAfterFirst);
  });

  it("replays its own item delete instead of reporting the target missing", async () => {
    const f = await ownerProject("ack-item-delete");
    const doc = await createDocument(
      f.db,
      {
        projectId: f.project.id,
        title: "Guide",
        folderPath: [],
        content: { kind: "markdown", contentJson: parseDocumentBody("body\n") },
      },
      f.actor,
    );
    const current = await getDocument(
      f.db,
      { projectId: f.project.id, documentId: doc.id },
      f.actor,
    );
    const request = {
      idempotencyKey: "ack-item-delete-1",
      toolName: "apply_content_lifecycle",
      summary: "Remove it",
      operation: {
        kind: "content.lifecycle",
        projectId: f.project.id,
        action: "item_delete",
        resourceType: "document",
        resourceId: doc.id,
        expectedHeadCommitSha: current.baseCommitSha,
      },
    } as const;

    const first = await applyMcpOperation(f.db, f.actor, request);
    await f.db.mcpOperation.deleteMany({ where: { userId: f.actor.userId } });
    const repo = await openProjectRepo(f.project.id);
    const headAfterFirst = await repo!.resolveHead();

    const second = await applyMcpOperation(f.db, f.actor, request);

    expect(second.commitSha).toBe(first.commitSha);
    expect(second.resourceId).toBe(doc.id);
    expect(second.path).toBe(current.path);
    expect(await repo!.resolveHead()).toBe(headAfterFirst);
  });

  it("replays its own item move without moving it twice", async () => {
    const f = await ownerProject("ack-item-move");
    const doc = await createDocument(
      f.db,
      {
        projectId: f.project.id,
        title: "Guide",
        folderPath: [],
        content: { kind: "markdown", contentJson: parseDocumentBody("body\n") },
      },
      f.actor,
    );
    await folders.createFolder(
      f.db,
      { projectId: f.project.id, parentPath: [], name: "Archive" },
      f.actor,
    );
    const current = await getDocument(
      f.db,
      { projectId: f.project.id, documentId: doc.id },
      f.actor,
    );
    // Not `as const`: folderPath is typed mutable in ContentOperation, and a
    // readonly tuple isn't assignable to string[].
    const request: {
      idempotencyKey: string;
      toolName: string;
      summary: string;
      operation: ContentOperation;
    } = {
      idempotencyKey: "ack-item-move-1",
      toolName: "apply_content_lifecycle",
      summary: "File it",
      operation: {
        kind: "content.lifecycle",
        projectId: f.project.id,
        action: "item_move",
        resourceType: "document",
        resourceId: doc.id,
        expectedHeadCommitSha: current.baseCommitSha,
        folderPath: ["archive"],
      },
    };

    const first = await applyMcpOperation(f.db, f.actor, request);
    await f.db.mcpOperation.deleteMany({ where: { userId: f.actor.userId } });
    const repo = await openProjectRepo(f.project.id);
    const headAfterFirst = await repo!.resolveHead();

    const second = await applyMcpOperation(f.db, f.actor, request);

    expect(second.commitSha).toBe(first.commitSha);
    expect(second.path).toBe("archive/guide.md");
    expect(await repo!.resolveHead()).toBe(headAfterFirst);
  });

  it("replays a reslugged item move as its destination, not the path it left", async () => {
    const f = await ownerProject("ack-item-move-reslug");
    for (const name of ["Archive", "Backup"])
      await folders.createFolder(
        f.db,
        { projectId: f.project.id, parentPath: [], name },
        f.actor,
      );
    // Image-dense and short on purpose: the reslug rewrites every own-asset
    // link, dropping similarity under git's 50% rename threshold, so the move
    // commit reports `D archive/guide.md` and `A backup/guide-2.md` as two
    // entries — and git sorts the deletion first.
    const doc = await createDocument(
      f.db,
      {
        projectId: f.project.id,
        title: "Guide",
        folderPath: ["archive"],
        content: {
          kind: "markdown",
          contentJson: {
            type: "doc",
            content: Array.from({ length: 40 }, (_, i) => ({
              type: "image",
              attrs: { src: `guide.assets/a${i}.png`, alt: null, title: null },
            })),
          },
        },
      },
      f.actor,
    );
    // Slugs are unique per repository, so a second "Guide" created through the
    // API would already be guide-2. An externally added file takes the target.
    await withProjectRepo(f.project.id, async (repo) => {
      await repo.writeFileAtomic(
        "backup/guide.md",
        '---\nid: 4b1b2c1e-3333-4333-8333-333333333333\ntitle: "Guide"\ncreated: 2026-09-12T00:00:00.000Z\nupdated: 2026-09-12T00:00:00.000Z\n---\n\nexternal\n',
      );
      await repo.commitAll("external: backup/guide.md", {
        ...AUTHOR,
        userId: f.actor.userId,
      });
    });
    const current = await getDocument(
      f.db,
      { projectId: f.project.id, documentId: doc.id },
      f.actor,
    );
    expect(current.path).toBe("archive/guide.md");
    const request: {
      idempotencyKey: string;
      toolName: string;
      summary: string;
      operation: ContentOperation;
    } = {
      idempotencyKey: "ack-item-move-reslug-1",
      toolName: "apply_content_lifecycle",
      summary: "File it",
      operation: {
        kind: "content.lifecycle",
        projectId: f.project.id,
        action: "item_move",
        resourceType: "document",
        resourceId: doc.id,
        expectedHeadCommitSha: current.baseCommitSha,
        folderPath: ["backup"],
      },
    };

    const first = await applyMcpOperation(f.db, f.actor, request);
    expect(first.path).toBe("backup/guide-2.md");
    const repo = (await openProjectRepo(f.project.id))!;
    const headAfterFirst = await repo.resolveHead();
    // The premise: rename detection missed it, so the source is a `D` entry
    // that sorts before the destination. If git ever pairs them the test stops
    // discriminating, so assert the shape rather than trust it.
    const [entry] = await repo.logChangesBefore(first.commitSha, { limit: 1 });
    expect(entry?.changes).toContainEqual({
      status: "D",
      path: "archive/guide.md",
      oldPath: null,
    });
    await f.db.mcpOperation.deleteMany({ where: { userId: f.actor.userId } });

    const second = await applyMcpOperation(f.db, f.actor, request);

    expect(second.commitSha).toBe(first.commitSha);
    expect(second.path).toBe("backup/guide-2.md");
    expect(await repo.resolveHead()).toBe(headAfterFirst);
  });

  it("replays a delete of a document with an image, reporting the document's own path", async () => {
    const f = await ownerProject("ack-item-delete-image");
    const doc = await createDocument(
      f.db,
      {
        projectId: f.project.id,
        title: "Guide",
        folderPath: [],
        content: { kind: "markdown", contentJson: parseDocumentBody("body\n") },
      },
      f.actor,
    );
    await storeDocumentImage(
      f.db,
      {
        projectId: f.project.id,
        documentId: doc.id,
        fileName: "shot.png",
        bytes: PNG_1X1,
      },
      f.actor,
    );
    const current = await getDocument(
      f.db,
      { projectId: f.project.id, documentId: doc.id },
      f.actor,
    );
    const request = {
      idempotencyKey: "ack-item-delete-image-1",
      toolName: "apply_content_lifecycle",
      summary: "Remove it",
      operation: {
        kind: "content.lifecycle",
        projectId: f.project.id,
        action: "item_delete",
        resourceType: "document",
        resourceId: doc.id,
        expectedHeadCommitSha: current.baseCommitSha,
      },
    } as const;

    const first = await applyMcpOperation(f.db, f.actor, request);
    // The commit landed (deleting both guide.md and guide.assets/ in one
    // commit — git's diff orders guide.assets/... before guide.md) but the
    // acknowledgement never did.
    await f.db.mcpOperation.deleteMany({ where: { userId: f.actor.userId } });
    const repo = await openProjectRepo(f.project.id);
    const headAfterFirst = await repo!.resolveHead();

    const second = await applyMcpOperation(f.db, f.actor, request);

    expect(second.commitSha).toBe(first.commitSha);
    expect(second.resourceId).toBe(doc.id);
    expect(second.path).toBe(current.path);
    expect(await repo!.resolveHead()).toBe(headAfterFirst);
  });

  it("refuses to replay when the same key carries a different request", async () => {
    const f = await ownerProject("ack-key-reuse");
    const listing = await listContentFolders(
      f.db,
      { projectId: f.project.id },
      f.actor,
    );
    const base = {
      idempotencyKey: "ack-key-reuse-1",
      toolName: "apply_content_lifecycle",
      summary: "Add a folder",
    };

    await applyMcpOperation(f.db, f.actor, {
      ...base,
      operation: {
        kind: "content.lifecycle",
        projectId: f.project.id,
        action: "folder_create",
        resourceType: "document",
        baseProjectCommitSha: listing.baseProjectCommitSha,
        parentPath: [],
        name: "Archive",
      },
    });
    await f.db.mcpOperation.deleteMany({ where: { userId: f.actor.userId } });

    await expect(
      applyMcpOperation(f.db, f.actor, {
        ...base,
        operation: {
          kind: "content.lifecycle",
          projectId: f.project.id,
          action: "folder_create",
          resourceType: "document",
          baseProjectCommitSha: listing.baseProjectCommitSha,
          parentPath: [],
          name: "Attic",
        },
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "IDEMPOTENCY_KEY_REUSED" },
    });
  });
});

describe("recovering an item whose folder was deleted too", () => {
  it("recreates the document's folder in the same commit", async () => {
    const f = await ownerProject("recover-folder-doc");
    await folders.createFolder(
      f.db,
      { projectId: f.project.id, parentPath: [], name: "Archive" },
      f.actor,
    );
    const doc = await createDocument(
      f.db,
      {
        projectId: f.project.id,
        title: "Guide",
        folderPath: ["archive"],
        content: { kind: "markdown", contentJson: parseDocumentBody("body\n") },
      },
      f.actor,
    );
    await deleteDocument(
      f.db,
      { projectId: f.project.id, documentId: doc.id },
      f.actor,
    );
    await folders.deleteFolder(
      f.db,
      { projectId: f.project.id, path: ["archive"] },
      f.actor,
    );
    const item = (
      await listDeletedContent(
        f.db,
        { projectId: f.project.id, limit: 10 },
        f.actor,
      )
    ).items.find((candidate) => candidate.id === doc.id);
    expect(item).toBeDefined();

    const result = await applyMcpOperation(f.db, f.actor, {
      idempotencyKey: "recover-folder-doc-1",
      toolName: "restore_content",
      summary: "Bring it back",
      operation: {
        kind: "content.restore",
        projectId: f.project.id,
        resourceType: "document",
        resourceId: doc.id,
        mode: "deleted",
        sourceSha: item!.sourceSha,
        deletedAtSha: item!.deletedAtSha,
      },
    });

    // Recovery preserves identity, not the exact slug: nextAvailableSlug
    // treats the item's own pre-deletion path as historically taken.
    expect(result.path).toBe("archive/guide-2.md");
    const listing = await listContentFolders(
      f.db,
      { projectId: f.project.id, resourceType: "document" },
      f.actor,
    );
    expect(listing.folders).toContainEqual({
      resourceType: "document",
      path: ["archive"],
    });
  });

  it("recreates the table's folder in the same commit", async () => {
    const f = await ownerProject("recover-folder-table");
    await tableFolders.createFolder(
      f.db,
      { projectId: f.project.id, parentPath: [], name: "Metrics" },
      f.actor,
    );
    const table = await createTable(
      f.db,
      {
        projectId: f.project.id,
        title: "Roster",
        folderPath: ["metrics"],
      },
      f.actor,
    );
    const current = await getTable(
      f.db,
      { projectId: f.project.id, tableId: table.id },
      f.actor,
    );
    await deleteTable(
      f.db,
      {
        projectId: f.project.id,
        tableId: table.id,
        expectedHeadCommitSha: current.baseCommitSha,
      },
      f.actor,
    );
    await tableFolders.deleteFolder(
      f.db,
      { projectId: f.project.id, path: ["metrics"] },
      f.actor,
    );
    const item = (
      await listDeletedContent(
        f.db,
        { projectId: f.project.id, limit: 10 },
        f.actor,
      )
    ).items.find((candidate) => candidate.id === table.id);
    expect(item).toBeDefined();

    const result = await applyMcpOperation(f.db, f.actor, {
      idempotencyKey: "recover-folder-table-1",
      toolName: "restore_content",
      summary: "Bring it back",
      operation: {
        kind: "content.restore",
        projectId: f.project.id,
        resourceType: "table",
        resourceId: table.id,
        mode: "deleted",
        sourceSha: item!.sourceSha,
        deletedAtSha: item!.deletedAtSha,
      },
    });

    // Same pre-existing slug-bump behavior as the document case above.
    expect(result.path).toBe("tables/metrics/roster-2.table");
  });
});

async function autoApprovingRun(f: Awaited<ReturnType<typeof ownerProject>>) {
  const conversation = await createConversation(f.db, f.actor, {});
  await f.db.assistantConversation.update({
    where: { id: conversation.id },
    data: { autoApproveChanges: true },
  });
  const { run } = await submitUserMessage(f.db, f.actor, {
    conversationId: conversation.id,
    text: "go",
    scope: { kind: "project", projectId: f.project.id },
  });
  // createProposal only auto-applies for a leased, running attempt.
  const leased = (await leaseRunAttempt(f.db, {
    runId: run.id,
    workerId: "lifecycle-test",
  }))!;
  return {
    conversationId: conversation.id,
    runId: run.id,
    attemptId: leased.attempt.id,
  };
}

describe("lifecycle proposals", () => {
  it("never auto-applies, even in an auto-approving conversation", async () => {
    const f = await ownerProject("proposal-auto");
    const doc = await createDocument(
      f.db,
      {
        projectId: f.project.id,
        title: "Guide",
        folderPath: [],
        content: { kind: "markdown", contentJson: parseDocumentBody("body\n") },
      },
      f.actor,
    );
    const current = await getDocument(
      f.db,
      { projectId: f.project.id, documentId: doc.id },
      f.actor,
    );
    const run = await autoApprovingRun(f);

    const proposal = await createProposal(f.db, f.actor, {
      ...run,
      summary: "Remove it",
      operation: {
        kind: "content.lifecycle",
        projectId: f.project.id,
        action: "item_delete",
        resourceType: "document",
        resourceId: doc.id,
        expectedHeadCommitSha: current.baseCommitSha,
      },
    });

    expect(proposal.status).toBe("pending");
    expect(proposal.kind).toBe("content.lifecycle.item_delete.document");
    expect(proposal.preview).toMatchObject({
      kind: "lifecycle",
      action: "item_delete",
      resourceType: "document",
      from: "guide.md",
      to: null,
      title: "Guide",
      affected: { documents: 1, tables: 0 },
    });
    expect(
      await f.db.document.findUnique({ where: { id: doc.id } }),
    ).not.toBeNull();
  });

  it("previews a folder move with the documents it carries", async () => {
    const f = await ownerProject("proposal-folder-preview");
    await folders.createFolder(
      f.db,
      { projectId: f.project.id, parentPath: [], name: "Archive" },
      f.actor,
    );
    await folders.createFolder(
      f.db,
      { projectId: f.project.id, parentPath: [], name: "Store" },
      f.actor,
    );
    await createDocument(
      f.db,
      {
        projectId: f.project.id,
        title: "Guide",
        folderPath: ["archive"],
        content: { kind: "markdown", contentJson: parseDocumentBody("body\n") },
      },
      f.actor,
    );
    const listing = await listContentFolders(
      f.db,
      { projectId: f.project.id },
      f.actor,
    );
    const run = await autoApprovingRun(f);

    const proposal = await createProposal(f.db, f.actor, {
      ...run,
      summary: "File it away",
      operation: {
        kind: "content.lifecycle",
        projectId: f.project.id,
        action: "folder_move",
        resourceType: "document",
        baseProjectCommitSha: listing.baseProjectCommitSha,
        path: ["archive"],
        newParentPath: ["store"],
      },
    });

    const detail = await getProposal(f.db, f.actor, proposal.id);
    expect(detail.kind).toBe("content.lifecycle.folder_move");
    expect(detail.resourceId).toBeNull();
    expect(detail.preview).toMatchObject({
      kind: "lifecycle",
      action: "folder_move",
      resourceType: "document",
      from: "archive",
      to: "store/archive",
      affected: { documents: 1, tables: 0 },
    });
  });

  it("previews an item move with its title, source and destination", async () => {
    const f = await ownerProject("proposal-item-preview");
    const table = await createTable(
      f.db,
      {
        projectId: f.project.id,
        title: "Roster",
        folderPath: [],
      },
      f.actor,
    );
    await tableFolders.createFolder(
      f.db,
      { projectId: f.project.id, parentPath: [], name: "Metrics" },
      f.actor,
    );
    const current = await getTable(
      f.db,
      { projectId: f.project.id, tableId: table.id },
      f.actor,
    );
    const run = await autoApprovingRun(f);

    const proposal = await createProposal(f.db, f.actor, {
      ...run,
      summary: "File it",
      operation: {
        kind: "content.lifecycle",
        projectId: f.project.id,
        action: "item_move",
        resourceType: "table",
        resourceId: table.id,
        expectedHeadCommitSha: current.baseCommitSha,
        folderPath: ["metrics"],
      },
    });

    const detail = await getProposal(f.db, f.actor, proposal.id);
    expect(detail.resourceId).toBe(table.id);
    expect(detail.preview).toMatchObject({
      kind: "lifecycle",
      action: "item_move",
      resourceType: "table",
      from: "tables/roster.table",
      to: "tables/metrics",
      title: "Roster",
      affected: { documents: 0, tables: 1 },
    });
  });

  it("previews a folder create in the tables scope, slugged and TABLES_ROOT-prefixed", async () => {
    const f = await ownerProject("proposal-folder-create-preview");
    const listing = await listContentFolders(
      f.db,
      { projectId: f.project.id },
      f.actor,
    );
    const run = await autoApprovingRun(f);

    const proposal = await createProposal(f.db, f.actor, {
      ...run,
      summary: "Add a folder",
      operation: {
        kind: "content.lifecycle",
        projectId: f.project.id,
        action: "folder_create",
        resourceType: "table",
        baseProjectCommitSha: listing.baseProjectCommitSha,
        parentPath: [],
        name: "Cold Storage",
      },
    });

    const detail = await getProposal(f.db, f.actor, proposal.id);
    expect(detail.kind).toBe("content.lifecycle.folder_create");
    expect(detail.preview).toMatchObject({
      kind: "lifecycle",
      action: "folder_create",
      resourceType: "table",
      from: null,
      to: "tables/cold-storage",
      affected: { documents: 0, tables: 0 },
    });
  });

  it("previews a folder rename with the documents it carries", async () => {
    const f = await ownerProject("proposal-folder-rename-preview");
    await folders.createFolder(
      f.db,
      { projectId: f.project.id, parentPath: [], name: "Archive" },
      f.actor,
    );
    await createDocument(
      f.db,
      {
        projectId: f.project.id,
        title: "Notes",
        folderPath: ["archive"],
        content: { kind: "markdown", contentJson: parseDocumentBody("body\n") },
      },
      f.actor,
    );
    const listing = await listContentFolders(
      f.db,
      { projectId: f.project.id },
      f.actor,
    );
    const run = await autoApprovingRun(f);

    const proposal = await createProposal(f.db, f.actor, {
      ...run,
      summary: "Rename it",
      operation: {
        kind: "content.lifecycle",
        projectId: f.project.id,
        action: "folder_rename",
        resourceType: "document",
        baseProjectCommitSha: listing.baseProjectCommitSha,
        path: ["archive"],
        name: "Attic",
      },
    });

    const detail = await getProposal(f.db, f.actor, proposal.id);
    expect(detail.kind).toBe("content.lifecycle.folder_rename");
    expect(detail.preview).toMatchObject({
      kind: "lifecycle",
      action: "folder_rename",
      resourceType: "document",
      from: "archive",
      to: "attic",
      affected: { documents: 1, tables: 0 },
    });
  });

  it("previews a folder delete", async () => {
    const f = await ownerProject("proposal-folder-delete-preview");
    await folders.createFolder(
      f.db,
      { projectId: f.project.id, parentPath: [], name: "Trash" },
      f.actor,
    );
    const listing = await listContentFolders(
      f.db,
      { projectId: f.project.id },
      f.actor,
    );
    const run = await autoApprovingRun(f);

    const proposal = await createProposal(f.db, f.actor, {
      ...run,
      summary: "Remove it",
      operation: {
        kind: "content.lifecycle",
        projectId: f.project.id,
        action: "folder_delete",
        resourceType: "document",
        baseProjectCommitSha: listing.baseProjectCommitSha,
        path: ["trash"],
      },
    });

    const detail = await getProposal(f.db, f.actor, proposal.id);
    expect(detail.kind).toBe("content.lifecycle.folder_delete");
    expect(detail.preview).toMatchObject({
      kind: "lifecycle",
      action: "folder_delete",
      resourceType: "document",
      from: "trash",
      to: null,
      affected: { documents: 0, tables: 0 },
    });
  });
});

describe("lifecycle tools", () => {
  async function toolContext(f: Awaited<ReturnType<typeof ownerProject>>) {
    const scope = await resolveScopeSnapshot(f.db, f.actor, {
      kind: "project",
      projectId: f.project.id,
    });
    return {
      db: f.db,
      actor: f.actor,
      scope,
      profile: { name: AUTHOR.name, email: f.actor.email },
      run: null,
    };
  }

  it("list_content_folders returns the guard the write tools require", async () => {
    const f = await ownerProject("tool-list-folders");
    await folders.createFolder(
      f.db,
      { projectId: f.project.id, parentPath: [], name: "Archive" },
      f.actor,
    );
    const { listContentFoldersTool } =
      await import("@weaver/assistant-tools/tools/folders");

    const result = (await listContentFoldersTool.execute(
      { projectId: f.project.id, resourceType: "document" } as never,
      (await toolContext(f)) as never,
    )) as {
      output: {
        baseProjectCommitSha: string;
        folders: { resourceType: string; path: string[] }[];
        truncated: boolean;
      };
    };

    expect(result.output.baseProjectCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.output.folders).toEqual([
      { resourceType: "document", path: ["archive"] },
    ]);
    expect(result.output.truncated).toBe(false);
  });

  it("apply_content_lifecycle commits a folder create directly", async () => {
    const f = await ownerProject("tool-apply");
    const listing = await listContentFolders(
      f.db,
      { projectId: f.project.id },
      f.actor,
    );
    const { applyContentLifecycleTool } =
      await import("@weaver/assistant-tools/tools/writes");

    const result = (await applyContentLifecycleTool.execute(
      {
        projectId: f.project.id,
        action: "folder_create",
        resourceType: "document",
        baseProjectCommitSha: listing.baseProjectCommitSha,
        parentPath: [],
        name: "Archive",
        idempotencyKey: "tool-apply-key-1",
        summary: "Add a folder",
      } as never,
      (await toolContext(f)) as never,
    )) as { output: { path: string; resourceId: string | null } };

    expect(result.output).toMatchObject({ path: "archive", resourceId: null });
  });

  it("propose_content_lifecycle raises a proposal that awaits review", async () => {
    const f = await ownerProject("tool-propose");
    const doc = await createDocument(
      f.db,
      {
        projectId: f.project.id,
        title: "Guide",
        folderPath: [],
        content: { kind: "markdown", contentJson: parseDocumentBody("body\n") },
      },
      f.actor,
    );
    const current = await getDocument(
      f.db,
      { projectId: f.project.id, documentId: doc.id },
      f.actor,
    );
    const run = await autoApprovingRun(f);
    const { proposeContentLifecycleTool } =
      await import("@weaver/assistant-tools/tools/proposals");

    const result = (await proposeContentLifecycleTool.execute(
      {
        projectId: f.project.id,
        action: "item_delete",
        resourceType: "document",
        resourceId: doc.id,
        expectedHeadCommitSha: current.baseCommitSha,
        summary: "Remove it",
      } as never,
      {
        ...(await toolContext(f)),
        run: {
          conversationId: run.conversationId,
          runId: run.runId,
          attemptId: run.attemptId,
        },
      } as never,
    )) as { output: { status: string; kind: string } };

    expect(result.output).toMatchObject({
      status: "pending",
      kind: "content.lifecycle.item_delete.document",
    });
  });
});

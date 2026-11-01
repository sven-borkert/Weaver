import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import { MAX_EVENT_PAYLOAD_CHARS } from "@weaver/core/assistant/events";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import { toOrganizationRole } from "@weaver/core/roles";
import { createConversation } from "@weaver/core/services/assistantConversations";
import {
  acceptProposal,
  createProposal,
  expireProposals,
  getProposal,
  listProposals,
  MAX_PREVIEW_LINES,
  rejectProposal,
} from "@weaver/core/services/assistantProposals";
import {
  reconcileAssistantRuns,
  submitUserMessage,
} from "@weaver/core/services/assistantRuns";
import {
  createDocument,
  getDocument,
  getHistory,
  saveDocument,
} from "@weaver/core/services/documents";
import type { ContentOperation } from "@weaver/core/services/contentOperations";
import {
  createFolder,
  deleteFolder,
  listContentFolders,
} from "@weaver/core/services/folders";
import { createTable, getTable, saveTable } from "@weaver/core/services/tables";
import { openProjectRepo } from "@weaver/git-store";
import {
  addMembership,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
  markdownContent,
} from "./_harness";

const COL_TASK = "11111111-1111-4111-8111-111111111111";
const COL_DONE = "22222222-2222-4222-8222-222222222222";
const ROW_ONE = "33333333-3333-4333-8333-333333333333";

async function setup(suffix: string, role: "Editor" | "Viewer" = "Editor") {
  const db = getPrisma();
  const user = await makeUser("User", suffix);
  const project = await makeProject(`Proposals ${suffix}`);
  await addMembership(project.id, user.id, role);
  const actor = {
    ...securityContextFor(user),
    name: `User ${suffix}`,
    email: user.email,
  };
  const conversation = await createConversation(db, actor, {});
  const { run } = await submitUserMessage(db, actor, {
    conversationId: conversation.id,
    text: "propose",
    scope: { kind: "project", projectId: project.id },
  });
  return { db, user, project, actor, conversation, run };
}

/** Reads what Git actually stored for the commits touching `path`, newest first. */
async function logFor(projectId: string, path: string, limit = 20) {
  const repo = await openProjectRepo(projectId);
  if (!repo) throw new Error("repository missing");
  return repo.logForPath(path, { skip: 0, limit });
}

/** Reads the trailers Git actually stored for the newest commit touching `path`. */
async function headEntry(projectId: string, path: string) {
  return (await logFor(projectId, path, 1))[0];
}

type PreviewLine = { type: string; text: string };
type DocumentPreview = {
  kind: string;
  lines: PreviewLine[];
  truncated: boolean;
};

/** `n` single-line Markdown paragraphs. */
function paragraphs(prefix: string, n: number): string {
  return `${Array.from({ length: n }, (_, i) => `${prefix}-${i}`).join("\n\n")}\n`;
}

type Lifecycle = Extract<ContentOperation, { kind: "content.lifecycle" }>;
type LifecycleFolderCase = {
  action: Lifecycle["action"];
  resourceType: Lifecycle["resourceType"];
  field: "folderPath" | "parentPath" | "newParentPath" | "path";
  fields: Pick<
    Lifecycle,
    "path" | "parentPath" | "newParentPath" | "folderPath" | "name"
  >;
};

/** Every folder a lifecycle writer requires at acceptance; "specs" exists only in the documents scope. */
const lifecycleFolderCases: LifecycleFolderCase[] = [
  {
    action: "item_move",
    resourceType: "document",
    field: "folderPath",
    fields: { folderPath: ["missing"] },
  },
  {
    action: "item_move",
    resourceType: "table",
    field: "folderPath",
    fields: { folderPath: ["specs"] },
  },
  {
    action: "folder_create",
    resourceType: "document",
    field: "parentPath",
    fields: { parentPath: ["missing"], name: "Child" },
  },
  {
    action: "folder_move",
    resourceType: "document",
    field: "path",
    fields: { path: ["missing"], newParentPath: [] },
  },
  {
    action: "folder_move",
    resourceType: "document",
    field: "newParentPath",
    fields: { path: ["specs"], newParentPath: ["missing"] },
  },
  {
    action: "folder_rename",
    resourceType: "table",
    field: "path",
    fields: { path: ["specs"], name: "Renamed" },
  },
  {
    action: "folder_delete",
    resourceType: "document",
    field: "path",
    fields: { path: ["missing"] },
  },
];

/** A root-level item to move, with the guard an item action carries. */
async function movableItemGuard(
  db: ReturnType<typeof getPrisma>,
  actor: Parameters<typeof createDocument>[2],
  projectId: string,
  resourceType: Lifecycle["resourceType"],
) {
  const item =
    resourceType === "document"
      ? await createDocument(
          db,
          {
            projectId,
            folderPath: [],
            title: "Movable",
            content: {
              kind: "markdown",
              contentJson: parseDocumentBody("body\n"),
            },
          },
          actor,
        )
      : await createTable(
          db,
          { projectId, folderPath: [], title: "Movable" },
          actor,
        );
  return { resourceId: item.id, expectedHeadCommitSha: item.headCommitSha };
}

describe("assistant proposals", () => {
  it.each(["membership", "deleted"])(
    "hides proposal payloads after %s access loss",
    async (kind) => {
      const { db, actor, user, project, conversation, run } = await setup(
        `lost-${kind}`,
      );
      const proposal = await createProposal(db, actor, {
        conversationId: conversation.id,
        runId: run.id,
        summary: "Private summary",
        operation: {
          kind: "document.create",
          projectId: project.id,
          title: "Private",
          markdown: "Private body",
          folderPath: [],
        },
      });
      if (kind === "deleted")
        await db.project.update({
          where: { id: project.id },
          data: { deletedAt: new Date() },
        });
      else await db.member.deleteMany({ where: { userId: user.id } });
      await expect(getProposal(db, actor, proposal.id)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(
        await listProposals(db, actor, { conversationId: conversation.id }),
      ).toEqual([]);
    },
  );
  it("allows rejection of a crashed acceptance only after checking Git under its project lock", async () => {
    const { db, actor, project, conversation, run } =
      await setup("crashed-reject");
    const proposal = await createProposal(db, actor, {
      conversationId: conversation.id,
      runId: run.id,
      summary: "Create",
      operation: {
        kind: "document.create",
        projectId: project.id,
        title: "Uncommitted",
        markdown: "Content",
        folderPath: [],
      },
    });
    await db.assistantProposal.update({
      where: { id: proposal.id },
      data: { status: "accepting" },
    });
    expect((await rejectProposal(db, actor, proposal.id)).status).toBe(
      "rejected",
    );
  });
  it("releases acceptance after a verified pre-commit failure so the user can reject", async () => {
    const { db, actor, project, conversation, run } =
      await setup("precommit-release");
    await createFolder(
      db,
      { projectId: project.id, parentPath: [], name: "Absent" },
      actor,
    );
    const proposal = await createProposal(db, actor, {
      conversationId: conversation.id,
      runId: run.id,
      summary: "Create",
      operation: {
        kind: "document.create",
        projectId: project.id,
        title: "Missing folder",
        folderPath: ["absent"],
        markdown: "Content",
      },
    });
    // The folder existed when the change was proposed and is gone at approval.
    await deleteFolder(db, { projectId: project.id, path: ["absent"] }, actor);
    await expect(acceptProposal(db, actor, proposal.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await rejectProposal(db, actor, proposal.id)).status).toBe(
      "rejected",
    );
  });

  it.each(["document.create", "table.create"] as const)(
    "recovers %s after acknowledgement failure and prevents rejection",
    async (kind) => {
      const { db, actor, project, conversation, run } = await setup(
        `ack-${kind}`,
      );
      const proposal = await createProposal(db, actor, {
        conversationId: conversation.id,
        runId: run.id,
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
                columns: [{ id: COL_TASK, name: "Task", type: "text" }],
                rows: [],
              },
      });
      const spy = vi
        .spyOn(db.assistantProposal, "update")
        .mockRejectedValueOnce(new Error("ack failed"));
      await expect(acceptProposal(db, actor, proposal.id)).rejects.toThrow(
        "ack failed",
      );
      spy.mockRestore();
      await expect(
        rejectProposal(db, actor, proposal.id),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(
        await expireProposals(db, new Date(Date.now() + 8 * 86400000)),
      ).toBe(0);
      const result = await acceptProposal(db, actor, proposal.id);
      expect(result.status).toBe("accepted");
      expect(
        (await db.document.count({ where: { projectId: project.id } })) +
          (await db.dataTable.count({ where: { projectId: project.id } })),
      ).toBe(1);
    },
  );

  beforeEach(async () => {
    vi.stubEnv("NODE_ENV", "test");
    await resetDb();
    setJobQueueForTests(new FakeJobQueue());
  });

  afterEach(() => {
    setJobQueueForTests(null);
    vi.unstubAllEnvs();
  });

  it("creates a document edit proposal with a diff preview and applies it as one attributed commit", async () => {
    const { db, project, actor, conversation, run } = await setup("docedit");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Notes",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("# Notes\n\nold\n"),
        },
      },
      actor,
    );
    const proposal = await createProposal(db, actor, {
      conversationId: conversation.id,
      runId: run.id,
      summary: "Replace old with new",
      operation: {
        kind: "document.edit",
        projectId: project.id,
        documentId: doc.id,
        baseCommitSha: doc.headCommitSha,
        markdown: "# Notes\n\nnew\n",
      },
    });
    expect(proposal.status).toBe("pending");
    expect(proposal.resourceId).toBe(doc.id);
    expect(
      (proposal.preview as { lines: Array<{ type: string; text: string }> })
        .lines,
    ).toEqual(
      expect.arrayContaining([
        { type: "del", text: "old" },
        { type: "add", text: "new" },
      ]),
    );
    expect(
      (await listProposals(db, actor, { conversationId: conversation.id })).map(
        (entry) => entry.id,
      ),
    ).toEqual([proposal.id]);

    const accepted = await acceptProposal(db, actor, proposal.id);
    expect(accepted.status).toBe("accepted");
    // An edit keeps the resourceId it was created with.
    expect(accepted.resourceId).toBe(doc.id);
    const updated = await getDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      actor,
    );
    expect(updated.baseCommitSha).toBe(accepted.resolution?.commitSha);
    expect(JSON.stringify(markdownContent(updated))).toContain("new");

    const history = await getHistory(
      db,
      { projectId: project.id, documentId: doc.id, offset: 0, limit: 5 },
      actor,
    );
    expect(history.entries[0]).toMatchObject({
      authorName: "Assistant on behalf of User docedit",
      userId: actor.userId,
    });
    expect(await headEntry(project.id, updated.path)).toMatchObject({
      sha: accepted.resolution?.commitSha,
      operationId: `proposal:${proposal.id}`,
      runId: run.id,
      userId: actor.userId,
    });

    await expect(acceptProposal(db, actor, proposal.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    // A second accept must not append another commit.
    expect(
      (
        await getHistory(
          db,
          { projectId: project.id, documentId: doc.id, offset: 0, limit: 10 },
          actor,
        )
      ).entries.length,
    ).toBe(history.entries.length);
  });

  it.each(["document.create", "table.create"] as const)(
    "refuses a %s proposal whose folder does not exist instead of creating one that can never be accepted",
    async (kind) => {
      const { db, actor, project, conversation, run } = await setup(
        `nofolder-${kind}`,
      );
      // A documents folder is not a tables folder: the scopes are separate trees.
      await createFolder(
        db,
        { projectId: project.id, parentPath: [], name: "Specs" },
        actor,
      );
      const base = { projectId: project.id, title: "Lost" };
      const operationIn = (folderPath: string[]) =>
        kind === "document.create"
          ? { kind, ...base, folderPath, markdown: "Body" }
          : {
              kind,
              ...base,
              folderPath,
              columns: [{ id: COL_TASK, name: "Task", type: "text" as const }],
              rows: [],
            };
      const missing = kind === "document.create" ? ["missing"] : ["specs"];
      await expect(
        createProposal(db, actor, {
          conversationId: conversation.id,
          runId: run.id,
          summary: "Create in a folder that is not there",
          operation: operationIn(missing),
        }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringContaining("list_content_folders"),
        details: { field: "folderPath" },
      });
      expect(await db.assistantProposal.count()).toBe(0);
    },
  );

  it.each(lifecycleFolderCases)(
    "refuses a content.lifecycle $action ($resourceType) proposal whose $field folder does not exist",
    async ({ action, resourceType, field, fields }) => {
      const { db, actor, project, conversation, run } = await setup(
        `nofolder-${action}-${field}-${resourceType}`,
      );
      // A documents folder is not a tables folder: the scopes are separate trees.
      await createFolder(
        db,
        { projectId: project.id, parentPath: [], name: "Specs" },
        actor,
      );
      const listing = await listContentFolders(
        db,
        { projectId: project.id, resourceType },
        actor,
      );
      const guard =
        action === "item_move"
          ? await movableItemGuard(db, actor, project.id, resourceType)
          : { baseProjectCommitSha: listing.baseProjectCommitSha };
      await expect(
        createProposal(db, actor, {
          conversationId: conversation.id,
          runId: run.id,
          summary: "Lifecycle through a folder that is not there",
          operation: {
            kind: "content.lifecycle",
            projectId: project.id,
            action,
            resourceType,
            ...guard,
            ...fields,
          },
        }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringContaining("list_content_folders"),
        details: { field },
      });
      expect(await db.assistantProposal.count()).toBe(0);
    },
  );

  it("applies a document.create proposal as one attributed commit in the proposed folder", async () => {
    const { db, project, actor, conversation, run } = await setup("doccreate");
    await createFolder(
      db,
      { projectId: project.id, parentPath: [], name: "Specs" },
      actor,
    );
    const proposal = await createProposal(db, actor, {
      conversationId: conversation.id,
      runId: run.id,
      summary: "Draft the spec",
      operation: {
        kind: "document.create",
        projectId: project.id,
        folderPath: ["specs"],
        title: "Draft Spec",
        markdown: "# Draft Spec\n\nfirst body line\n",
      },
    });
    expect(proposal.resourceId).toBeNull();
    expect(proposal.baseCommitSha).toBeNull();
    expect((proposal.preview as DocumentPreview).lines).toEqual(
      expect.arrayContaining([{ type: "add", text: "first body line" }]),
    );

    const accepted = await acceptProposal(db, actor, proposal.id);
    expect(accepted.status).toBe("accepted");

    const created = await db.document.findFirstOrThrow({
      where: { projectId: project.id },
    });
    expect(created.path).toBe("specs/draft-spec.md");
    // An accepted create records what it created, so the panel can offer
    // "Open document".
    expect(accepted.resourceId).toBe(created.id);
    const doc = await getDocument(
      db,
      { projectId: project.id, documentId: created.id },
      actor,
    );
    expect(doc.title).toBe("Draft Spec");
    expect(JSON.stringify(markdownContent(doc))).toContain("first body line");
    expect(doc.baseCommitSha).toBe(accepted.resolution?.commitSha);

    // Exactly one commit created the file, carrying the full audit trailer set.
    const log = await logFor(project.id, created.path);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      sha: accepted.resolution?.commitSha,
      authorName: "Assistant on behalf of User doccreate",
      userId: actor.userId,
      operationId: `proposal:${proposal.id}`,
      runId: run.id,
      message: "create: specs/draft-spec.md",
    });
  });

  it("bounds document previews by lines, not by the event payload budget", async () => {
    const { db, project, actor, conversation, run } = await setup("preview");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Big",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody(paragraphs("old", 300)),
        },
      },
      actor,
    );

    const modest = await createProposal(db, actor, {
      conversationId: conversation.id,
      runId: run.id,
      summary: "rewrite every line",
      operation: {
        kind: "document.edit",
        projectId: project.id,
        documentId: doc.id,
        baseCommitSha: doc.headCommitSha,
        markdown: paragraphs("new", 300),
      },
    });
    const preview = modest.preview as DocumentPreview;
    expect(preview.kind).toBe("document");
    expect(preview.truncated).toBe(false);
    expect(preview.lines.length).toBeLessThanOrEqual(MAX_PREVIEW_LINES);
    // Every changed line the user approves is visible, first to last.
    expect(preview.lines).toEqual(
      expect.arrayContaining([
        { type: "del", text: "old-0" },
        { type: "add", text: "new-0" },
        { type: "del", text: "old-299" },
        { type: "add", text: "new-299" },
      ]),
    );
    // ...on a payload far past the SSE event budget the preview used to borrow.
    expect(JSON.stringify(preview).length).toBeGreaterThan(
      MAX_EVENT_PAYLOAD_CHARS,
    );

    // Past the line cap, truncation is by lines and stays visible.
    const huge = await createProposal(db, actor, {
      conversationId: conversation.id,
      runId: run.id,
      summary: "rewrite much more",
      operation: {
        kind: "document.edit",
        projectId: project.id,
        documentId: doc.id,
        baseCommitSha: doc.headCommitSha,
        markdown: paragraphs("huge", 2_500),
      },
    });
    const hugePreview = huge.preview as DocumentPreview;
    expect(hugePreview.kind).toBe("document");
    expect(hugePreview.lines).toHaveLength(MAX_PREVIEW_LINES);
    expect(hugePreview.truncated).toBe(true);
  });

  it("marks a proposal conflicted when the base revision moved and never overwrites", async () => {
    const { db, project, actor, conversation, run } = await setup("conflict");
    const doc = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Doc",
        content: { kind: "markdown", contentJson: parseDocumentBody("a\n") },
      },
      actor,
    );
    const proposal = await createProposal(db, actor, {
      conversationId: conversation.id,
      runId: run.id,
      summary: "edit",
      operation: {
        kind: "document.edit",
        projectId: project.id,
        documentId: doc.id,
        baseCommitSha: doc.headCommitSha,
        markdown: "b\n",
      },
    });
    await saveDocument(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        baseCommitSha: doc.headCommitSha,
        content: { kind: "markdown", contentJson: parseDocumentBody("c\n") },
        changeSummary: "human edit",
      },
      actor,
    );
    const result = await acceptProposal(db, actor, proposal.id);
    expect(result.status).toBe("conflicted");
    expect(result.resolution).toEqual({ reason: "base revision changed" });
    const current = await getDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      actor,
    );
    expect(JSON.stringify(markdownContent(current))).toContain("c");
    expect(JSON.stringify(markdownContent(current))).not.toContain('"b"');
    const humanCommit = await headEntry(project.id, current.path);
    expect(humanCommit?.operationId).toBeNull();
    expect(humanCommit?.runId).toBeNull();
  });

  it("creates tables and applies schema and row proposals", async () => {
    const { db, project, actor, conversation, run } = await setup("tables");
    const create = await createProposal(db, actor, {
      conversationId: conversation.id,
      runId: run.id,
      summary: "new table",
      operation: {
        kind: "table.create",
        projectId: project.id,
        folderPath: [],
        title: "Tasks",
        columns: [{ id: COL_TASK, name: "Task", type: "text" }],
        rows: [{ id: ROW_ONE, cells: { [COL_TASK]: "Write plan" } }],
      },
    });
    const accepted = await acceptProposal(db, actor, create.id);
    expect(accepted.status).toBe("accepted");
    const tableRow = await db.dataTable.findFirstOrThrow({
      where: { projectId: project.id },
    });
    expect(create.resourceId).toBeNull();
    expect(accepted.resourceId).toBe(tableRow.id);
    const table = await getTable(
      db,
      { projectId: project.id, tableId: tableRow.id },
      actor,
    );

    const schema = await createProposal(db, actor, {
      conversationId: conversation.id,
      runId: run.id,
      summary: "add Done",
      operation: {
        kind: "table.schema",
        projectId: project.id,
        tableId: table.id,
        baseCommitSha: table.baseCommitSha,
        changes: [
          {
            op: "add",
            column: { id: COL_DONE, name: "Done", type: "boolean" },
          },
        ],
      },
    });
    expect((await acceptProposal(db, actor, schema.id)).status).toBe(
      "accepted",
    );
    const after = await getTable(
      db,
      { projectId: project.id, tableId: table.id },
      actor,
    );
    expect(after.columns.map((c) => c.name)).toEqual(["Task", "Done"]);

    const rows = await createProposal(db, actor, {
      conversationId: conversation.id,
      runId: run.id,
      summary: "rows",
      operation: {
        kind: "table.rows",
        projectId: project.id,
        tableId: table.id,
        baseCommitSha: after.baseCommitSha,
        inserts: [{ cells: { [COL_TASK]: "Ship", [COL_DONE]: false } }],
        updates: [{ rowId: ROW_ONE, cells: { [COL_DONE]: true } }],
        deletes: [],
      },
    });
    const applied = await acceptProposal(db, actor, rows.id);
    expect(applied.status).toBe("accepted");
    const final = await getTable(
      db,
      { projectId: project.id, tableId: table.id },
      actor,
    );
    expect(final.rows.map((r) => r.cells)).toEqual([
      { [COL_TASK]: "Write plan", [COL_DONE]: true },
      { [COL_TASK]: "Ship", [COL_DONE]: false },
    ]);
    expect(await headEntry(project.id, final.path)).toMatchObject({
      operationId: `proposal:${rows.id}`,
      runId: run.id,
      authorName: "Assistant on behalf of User tables",
    });

    // A stale table base conflicts instead of clobbering the committed rows.
    const staleProposal = await createProposal(db, actor, {
      conversationId: conversation.id,
      runId: run.id,
      summary: "stale",
      operation: {
        kind: "table.rows",
        projectId: project.id,
        tableId: table.id,
        baseCommitSha: final.baseCommitSha,
        inserts: [],
        updates: [{ rowId: ROW_ONE, cells: { [COL_TASK]: "Overwritten" } }],
        deletes: [],
      },
    });
    await saveTable(
      db,
      {
        projectId: project.id,
        tableId: table.id,
        baseCommitSha: final.baseCommitSha,
        columns: final.columns,
        rows: final.rows.map((row) =>
          row.id === ROW_ONE
            ? { ...row, cells: { ...row.cells, [COL_TASK]: "Human" } }
            : row,
        ),
      },
      actor,
    );
    expect((await acceptProposal(db, actor, staleProposal.id)).status).toBe(
      "conflicted",
    );
    const unchanged = await getTable(
      db,
      { projectId: project.id, tableId: table.id },
      actor,
    );
    expect(unchanged.rows[0]!.cells[COL_TASK]).toBe("Human");
  });

  it("requires content:propose + Editor to create and Editor to accept; rejects and expires", async () => {
    const viewer = await setup("viewer", "Viewer");
    await expect(
      createProposal(viewer.db, viewer.actor, {
        conversationId: viewer.conversation.id,
        runId: viewer.run.id,
        summary: "x",
        operation: {
          kind: "document.create",
          projectId: viewer.project.id,
          folderPath: [],
          title: "T",
          markdown: "x",
        },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const { db, user, project, actor, conversation, run } =
      await setup("reject");
    const proposal = await createProposal(db, actor, {
      conversationId: conversation.id,
      runId: run.id,
      summary: "x",
      operation: {
        kind: "document.create",
        projectId: project.id,
        folderPath: [],
        title: "T",
        markdown: "x",
      },
    });
    expect((await rejectProposal(db, actor, proposal.id)).status).toBe(
      "rejected",
    );
    expect(await db.document.count({ where: { projectId: project.id } })).toBe(
      0,
    );
    await expect(acceptProposal(db, actor, proposal.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });

    const stale = await createProposal(db, actor, {
      conversationId: conversation.id,
      runId: run.id,
      summary: "y",
      operation: {
        kind: "document.create",
        projectId: project.id,
        folderPath: [],
        title: "U",
        markdown: "y",
      },
    });
    await db.assistantProposal.update({
      where: { id: stale.id },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    // Expiry runs from the reconciler, and is idempotent afterwards.
    expect((await reconcileAssistantRuns(db)).expiredProposals).toBe(1);
    expect(await expireProposals(db)).toBe(0);
    expect((await getProposal(db, actor, stale.id)).status).toBe("expired");
    await expect(acceptProposal(db, actor, stale.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });

    // Losing Editor between proposal and acceptance blocks the write.
    const demoted = await createProposal(db, actor, {
      conversationId: conversation.id,
      runId: run.id,
      summary: "z",
      operation: {
        kind: "document.create",
        projectId: project.id,
        folderPath: [],
        title: "V",
        markdown: "z",
      },
    });
    await db.member.updateMany({
      where: { userId: user.id },
      data: { role: toOrganizationRole("Viewer") },
    });
    await expect(acceptProposal(db, actor, demoted.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await db.document.count({ where: { projectId: project.id } })).toBe(
      0,
    );

    const stranger = {
      ...securityContextFor(await makeUser("User", "stranger")),
      name: null,
      email: "s@test.local",
    };
    await expect(getProposal(db, stranger, proposal.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      acceptProposal(db, stranger, proposal.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

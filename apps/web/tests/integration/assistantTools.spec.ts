import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { simpleGit } from "simple-git";
import { repoDir } from "@weaver/git-store";
import { openUploadSink } from "@weaver/core/ingestion/blobStore";
import { finalizeArtifactUpload } from "@weaver/core/services/artifacts";
import { composeRootFolderMetadata } from "@weaver/core/documents/folderMetadata";
import { parseDocumentFile } from "@weaver/core/documents/frontmatter";
import { withProjectRepo } from "@weaver/core/services/projectRepo";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateSourceLocators } from "@weaver/core/assistant/citations";
import { resolveScopeSnapshot } from "@weaver/core/assistant/scope";
import {
  parseDocumentBody,
  serializeDocumentBody,
} from "@weaver/core/editor/markdown";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import { knowledgeSystemContextForTests } from "@weaver/core/jobs/systemContext";
import { createConversation } from "@weaver/core/services/assistantConversations";
import {
  acceptProposal,
  getProposal,
} from "@weaver/core/services/assistantProposals";
import { submitUserMessage } from "@weaver/core/services/assistantRuns";
import {
  createDocument,
  getDocument,
  listDocuments,
  saveDocument,
} from "@weaver/core/services/documents";
import { setDocumentReview } from "@weaver/core/services/documentReview";
import { syncDocumentKeywordIndex } from "@weaver/core/services/keywordIndex";
import {
  createTable,
  listTables,
  saveTable,
} from "@weaver/core/services/tables";
import {
  inspectLinks,
  listRecentChanges,
} from "@weaver/core/services/wikiReads";
import { createApiKeySecurityContext } from "@weaver/core/security/context";
import type { McpWriteResult } from "@weaver/core/services/mcpOperations";
import {
  MAX_TOOL_OUTPUT_CHARS,
  type ToolContext,
} from "@weaver/assistant-tools/contract";
import {
  mcpToolByName,
  mcpToolsForActor,
  toolByName,
  toolsForActor,
} from "@weaver/assistant-tools/registry";
import { toAiToolSet, type ToolCollector } from "@weaver/ai/tools";
import {
  addMembership,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
  markdownContent,
} from "./_harness";

// Table column/row ids must be canonical lowercase UUIDs (packages/core's
// tables validation rejects short ids like "c1"), unlike the brief's draft.
const COL_TASK = "11111111-1111-4111-8111-111111111111";
const COL_DONE = "22222222-2222-4222-8222-222222222222";
const ROW_PLAN = "33333333-3333-4333-8333-333333333333";
const ROW_BUILD = "44444444-4444-4444-8444-444444444444";

async function fixture() {
  const db = getPrisma();
  const user = await makeUser("User", "tools");
  const project = await makeProject("Tools");
  const hidden = await makeProject("Hidden");
  await addMembership(project.id, user.id, "Editor");
  await addMembership(hidden.id, user.id, "Editor");
  const actor = {
    ...securityContextFor(user),
    name: "Tool User",
    email: user.email,
  };
  const doc = await createDocument(
    db,
    {
      projectId: project.id,
      folderPath: [],
      title: "Roadmap",
      content: {
        kind: "markdown",
        contentJson: parseDocumentBody(
          "# Roadmap\n\nShip the assistant in Q4.\n",
        ),
      },
    },
    actor,
  );
  await syncDocumentKeywordIndex(knowledgeSystemContextForTests(), db, {
    projectId: project.id,
    documentId: doc.id,
    sourceCommitSha: doc.headCommitSha,
    pathAtSha: doc.path,
  });
  const table = await createTable(
    db,
    {
      projectId: project.id,
      folderPath: [],
      title: "Tasks",
      columns: [
        { id: COL_TASK, name: "Task", type: "text" },
        { id: COL_DONE, name: "Done", type: "boolean" },
      ],
      rows: [
        { id: ROW_PLAN, cells: { [COL_TASK]: "Plan", [COL_DONE]: true } },
        { id: ROW_BUILD, cells: { [COL_TASK]: "Build", [COL_DONE]: false } },
      ],
    },
    actor,
  );
  const conversation = await createConversation(db, actor, {});
  const { run } = await submitUserMessage(db, actor, {
    conversationId: conversation.id,
    text: "go",
    scope: { kind: "project", projectId: project.id },
  });
  const scope = await resolveScopeSnapshot(db, actor, {
    kind: "project",
    projectId: project.id,
  });
  const ctx: ToolContext = {
    db,
    actor,
    scope,
    profile: { name: "Tool User", email: user.email },
    run: { conversationId: conversation.id, runId: run.id },
  };
  return { db, user, project, hidden, actor, doc, table, ctx };
}

describe("assistant tools", () => {
  it("executes the three shared file contracts through the assistant adapter", async () => {
    const { project, actor, ctx, db } = await fixture();
    const dataDir = process.env.WEAVER_DATA_DIR!;
    for (const [filename, source] of [
      ["lines.txt", "hello\nworld"],
      ["rows.csv", "name\nAda"],
      ["shape.yaml", "name: Ada"],
    ]) {
      const uploadId = randomUUID();
      const sink = await openUploadSink(dataDir, project.id, uploadId, {
        minFreeBytes: 0,
      });
      await sink.write(Buffer.from(source!));
      const { digest, byteSize } = await sink.finish();
      await finalizeArtifactUpload(
        db,
        actor,
        {
          projectId: project.id,
          files: [
            {
              filename: filename!,
              uploadId,
              contentDigest: digest,
              byteSize,
              replace: false,
            },
          ],
        },
        { dataDir },
      );
    }
    for (const [name, filename, field] of [
      ["read_text_artifact", "lines.txt", "text"],
      ["read_csv_artifact", "rows.csv", "rows"],
      ["inspect_structured_artifact", "shape.yaml", "nodes"],
    ]) {
      const input = { projectId: project.id, filename };
      const contract = toolByName(name!)!;
      const tools = toAiToolSet([contract], {
        context: async () => ctx,
        onEvent: async () => undefined,
        collector: { citations: [], proposals: [] },
      });
      const result = (await tools[name!]!.execute!(
        contract.inputSchema.parse(input),
        { toolCallId: "file-read", messages: [], context: {} },
      )) as { result: Record<string, unknown> };
      expect(result.result[field!]).toBeDefined();
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
        16000,
      );
    }
  });
  beforeEach(async () => {
    vi.stubEnv("NODE_ENV", "test");
    await resetDb();
    setJobQueueForTests(new FakeJobQueue());
  });

  afterEach(() => {
    setJobQueueForTests(null);
    vi.unstubAllEnvs();
  });

  it("reads documents in chunks with a document citation", async () => {
    const { ctx, project, doc } = await fixture();
    const tool = toolByName("read_document")!;
    const outcome = await tool.execute(
      tool.inputSchema.parse({
        projectId: project.id,
        documentId: doc.id,
        maxChars: 500,
      }),
      ctx,
    );
    expect(outcome.output).toMatchObject({
      id: doc.id,
      commitSha: doc.headCommitSha,
      nextOffset: null,
    });
    expect((outcome.output as { markdown: string }).markdown).toContain(
      "Ship the assistant",
    );
    expect(outcome.citations).toEqual([
      {
        kind: "document",
        projectId: project.id,
        documentId: doc.id,
        commitSha: doc.headCommitSha,
        headingPath: [],
        excerpt: null,
      },
    ]);
  });

  it("exposes review status on document reads and lists", async () => {
    const { ctx, project, doc, db } = await fixture();
    const owner = await makeUser("User", "tools-owner");
    await addMembership(project.id, owner.id, "Owner");
    await setDocumentReview(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        expectedHeadCommitSha: doc.headCommitSha,
        reviewers: [{ type: "user", id: owner.id }],
      },
      { ...securityContextFor(owner), name: "Owner", email: owner.email },
    );
    const read = toolByName("read_document")!;
    const out = (
      await read.execute(
        read.inputSchema.parse({ projectId: project.id, documentId: doc.id }),
        ctx,
      )
    ).output as { review: Record<string, unknown> };
    expect(out.review).toMatchObject({
      reviewers: [{ type: "user", id: owner.id }],
      everyMonths: 12,
      lastReviewed: null,
      reviewedBy: null,
    });
    const row = await db.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(out.review.dueAt).toEqual(row.reviewDueAt);
    expect(row.reviewDueAt).not.toBeNull();

    const list = toolByName("list_documents")!;
    const listed = (
      await list.execute(list.inputSchema.parse({ projectId: project.id }), ctx)
    ).output as { documents: { id: string; reviewDueAt: unknown }[] };
    expect(listed.documents.find((d) => d.id === doc.id)?.reviewDueAt).toEqual(
      row.reviewDueAt,
    );
  });

  it("continues a document read at the original snapshot after an edit", async () => {
    const { ctx, project, doc, table, actor, db } = await fixture();
    const tool = toolByName("read_document")!;
    const first = (
      await tool.execute(
        tool.inputSchema.parse({
          projectId: project.id,
          documentId: doc.id,
          maxChars: 500,
        }),
        ctx,
      )
    ).output as {
      snapshotCommitSha: string;
      baseCommitSha: string;
      commitSha: string;
      nextCursor: string | null;
      hasMore: boolean;
      markdown: string;
    };
    expect(first.commitSha).toBe(first.baseCommitSha);
    // fixture() commits a table after the document, so the unpinned
    // snapshot is the project's later HEAD (the table's commit), not the
    // document's own last-touch commit.
    expect(first.snapshotCommitSha).toBe(table.headCommitSha);
    expect(first.baseCommitSha).toBe(doc.headCommitSha);
    expect(first.hasMore).toBe(false);
    expect(first.nextCursor).toBeNull();

    const long = `# Roadmap\n\n${"Line of prose. ".repeat(200)}\n`;
    await saveDocument(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        baseCommitSha: doc.headCommitSha,
        content: { kind: "markdown", contentJson: parseDocumentBody(long) },
        changeSummary: "grow",
      },
      actor,
    );
    const page1 = (
      await tool.execute(
        tool.inputSchema.parse({
          projectId: project.id,
          documentId: doc.id,
          maxChars: 500,
        }),
        ctx,
      )
    ).output as {
      snapshotCommitSha: string;
      nextCursor: string;
      hasMore: boolean;
      markdown: string;
    };
    expect(page1.hasMore).toBe(true);
    expect(page1.snapshotCommitSha).not.toBe(doc.headCommitSha);

    await saveDocument(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        baseCommitSha: page1.snapshotCommitSha,
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("# Roadmap\n\nreplaced\n"),
        },
        changeSummary: "shrink",
      },
      actor,
    );
    const page2 = (
      await tool.execute(
        tool.inputSchema.parse({
          projectId: project.id,
          documentId: doc.id,
          maxChars: 500,
          cursor: page1.nextCursor,
        }),
        ctx,
      )
    ).output as { snapshotCommitSha: string; offset: number; markdown: string };
    expect(page2.snapshotCommitSha).toBe(page1.snapshotCommitSha);
    expect(page2.offset).toBe(500);
    expect(page2.markdown).toContain("Line of prose.");
    expect(page2.markdown).not.toContain("replaced");
  });

  it("rejects foreign, malformed, and mismatched document cursors without restarting", async () => {
    const { ctx, project, doc } = await fixture();
    const tool = toolByName("read_document")!;
    const bad = ["not-a-cursor", ROW_PLAN];
    for (const cursor of bad) {
      await expect(
        tool.execute(
          tool.inputSchema.parse({
            projectId: project.id,
            documentId: doc.id,
            cursor,
          }),
          ctx,
        ),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        details: { reason: "INVALID_CURSOR" },
      });
    }
    await expect(
      tool.execute(
        tool.inputSchema.parse({
          projectId: project.id,
          documentId: doc.id,
          atCommitSha: "0".repeat(40),
        }),
        ctx,
      ),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      details: { reason: "SNAPSHOT_UNAVAILABLE" },
    });
  });

  it("refuses out-of-scope projects even when the user is a member", async () => {
    const { ctx, hidden } = await fixture();
    const tool = toolByName("list_documents")!;
    await expect(
      tool.execute(tool.inputSchema.parse({ projectId: hidden.id }), ctx),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { reason: "SCOPE_VIOLATION" },
    });
  });

  it("queries table rows with typed filters and cites row ids", async () => {
    const { ctx, project, table } = await fixture();
    const tool = toolByName("query_table_rows")!;
    const outcome = await tool.execute(
      tool.inputSchema.parse({
        projectId: project.id,
        tableId: table.id,
        filters: [{ columnId: COL_DONE, op: "eq", value: false }],
      }),
      ctx,
    );
    expect(outcome.output).toMatchObject({
      matched: 1,
      rows: [{ id: ROW_BUILD }],
    });
    expect(outcome.citations?.[0]).toMatchObject({
      kind: "table",
      tableId: table.id,
      rowIds: [ROW_BUILD],
    });
  });

  it("filters by contains on a multiselect column, reads a cell as a list, and pages its options like select", async () => {
    const { ctx, project, actor, db } = await fixture();
    const COL_TAGS = "55555555-5555-4555-8555-555555555555";
    const OPT_URGENT = "66666666-6666-4666-8666-666666666666";
    const OPT_BLOCKED = "77777777-7777-4777-8777-777777777777";
    const ROW_ONE = "88888888-8888-4888-8888-888888888888";
    const ROW_TWO = "99999999-9999-4999-8999-999999999999";
    const COL_UPDATED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    // ROW_ONE's instant (08:00 UTC) is earlier than ROW_TWO's (09:00 UTC),
    // but the opposite is true by plain string comparison ("09" < "10" in
    // the hour position) — proving the tool sorts/filters by parsed instant.
    const ROW_ONE_UPDATED = "2026-01-01T10:00:00+02:00";
    const ROW_TWO_UPDATED = "2026-01-01T09:00:00Z";
    const tagged = await createTable(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Tagged",
        columns: [
          { id: COL_TASK, name: "Task", type: "text" },
          {
            id: COL_TAGS,
            name: "Tags",
            type: "multiselect",
            options: [
              { id: OPT_URGENT, label: "Urgent" },
              { id: OPT_BLOCKED, label: "Blocked" },
            ],
          },
          { id: COL_UPDATED, name: "Updated", type: "datetime" },
        ],
        rows: [
          {
            id: ROW_ONE,
            cells: {
              [COL_TASK]: "One",
              [COL_TAGS]: [OPT_URGENT],
              [COL_UPDATED]: ROW_ONE_UPDATED,
            },
          },
          {
            id: ROW_TWO,
            cells: {
              [COL_TASK]: "Two",
              [COL_TAGS]: [OPT_URGENT, OPT_BLOCKED],
              [COL_UPDATED]: ROW_TWO_UPDATED,
            },
          },
        ],
      },
      actor,
    );
    const rowsTool = toolByName("query_table_rows")!;
    const filtered = await rowsTool.execute(
      rowsTool.inputSchema.parse({
        projectId: project.id,
        tableId: tagged.id,
        filters: [{ columnId: COL_TAGS, op: "contains", value: OPT_BLOCKED }],
      }),
      ctx,
    );
    expect(filtered.output).toMatchObject({
      matched: 1,
      rows: [{ id: ROW_TWO }],
    });

    const optionsTool = toolByName("list_table_column_options")!;
    const options = (
      await optionsTool.execute(
        optionsTool.inputSchema.parse({
          projectId: project.id,
          tableId: tagged.id,
          columnId: COL_TAGS,
        }),
        ctx,
      )
    ).output as { optionCount: number; options: Array<{ id: string }> };
    expect(options.optionCount).toBe(2);
    expect(options.options.map((o) => o.id)).toEqual([OPT_URGENT, OPT_BLOCKED]);

    const cellTool = toolByName("read_table_cell")!;
    const cell = (
      await cellTool.execute(
        cellTool.inputSchema.parse({
          projectId: project.id,
          tableId: tagged.id,
          rowId: ROW_TWO,
          columnId: COL_TAGS,
        }),
        ctx,
      )
    ).output as {
      value: {
        kind: string;
        values?: string[];
        labels?: string[];
        nextCursor?: string | null;
        hasMore?: boolean;
      };
    };
    expect(cell.value).toEqual({
      kind: "list",
      values: [OPT_URGENT, OPT_BLOCKED],
      labels: ["Urgent", "Blocked"],
      nextCursor: null,
      hasMore: false,
    });

    const sorted = await rowsTool.execute(
      rowsTool.inputSchema.parse({
        projectId: project.id,
        tableId: tagged.id,
        sort: { columnId: COL_UPDATED, dir: "asc" },
      }),
      ctx,
    );
    expect(sorted.output).toMatchObject({
      rows: [{ id: ROW_ONE }, { id: ROW_TWO }],
    });

    const afterEight = await rowsTool.execute(
      rowsTool.inputSchema.parse({
        projectId: project.id,
        tableId: tagged.id,
        filters: [
          { columnId: COL_UPDATED, op: "gt", value: "2026-01-01T08:30:00Z" },
        ],
      }),
      ctx,
    );
    expect(afterEight.output).toMatchObject({
      matched: 1,
      rows: [{ id: ROW_TWO }],
    });
  });

  it("pages table rows with signed cursors pinned to the snapshot and rejects legacy row-id cursors", async () => {
    const { ctx, project, table, actor, db } = await fixture();
    const tool = toolByName("query_table_rows")!;
    const page1 = (
      await tool.execute(
        tool.inputSchema.parse({
          projectId: project.id,
          tableId: table.id,
          sort: { columnId: COL_TASK, dir: "asc" },
          limit: 1,
        }),
        ctx,
      )
    ).output as {
      snapshotCommitSha: string;
      baseCommitSha: string;
      commitSha: string;
      rows: Array<{ id: string }>;
      nextCursor: string | null;
      hasMore: boolean;
    };
    expect(page1.rows.map((r) => r.id)).toEqual([ROW_BUILD]);
    expect(page1.hasMore).toBe(true);
    expect(page1.commitSha).toBe(page1.baseCommitSha);
    expect(page1.baseCommitSha).toBe(table.headCommitSha);

    // The cursor binds the logical query, not the page size: a continuation
    // with a different limit must still be accepted at the same snapshot.
    const differentLimit = (
      await tool.execute(
        tool.inputSchema.parse({
          projectId: project.id,
          tableId: table.id,
          sort: { columnId: COL_TASK, dir: "asc" },
          limit: 5,
          cursor: page1.nextCursor,
        }),
        ctx,
      )
    ).output as { snapshotCommitSha: string; rows: Array<{ id: string }> };
    expect(differentLimit.snapshotCommitSha).toBe(page1.snapshotCommitSha);
    expect(differentLimit.rows.map((r) => r.id)).toEqual([ROW_PLAN]);

    await saveTable(
      db,
      {
        projectId: project.id,
        tableId: table.id,
        baseCommitSha: table.headCommitSha,
        columns: table.columns,
        rows: [
          { id: ROW_BUILD, cells: { [COL_TASK]: "Build", [COL_DONE]: true } },
        ],
      },
      actor,
    );
    const page2 = (
      await tool.execute(
        tool.inputSchema.parse({
          projectId: project.id,
          tableId: table.id,
          sort: { columnId: COL_TASK, dir: "asc" },
          limit: 1,
          cursor: page1.nextCursor,
        }),
        ctx,
      )
    ).output as {
      snapshotCommitSha: string;
      rows: Array<{ id: string }>;
      nextCursor: string | null;
      hasMore: boolean;
    };
    expect(page2.snapshotCommitSha).toBe(page1.snapshotCommitSha);
    expect(page2.rows.map((r) => r.id)).toEqual([ROW_PLAN]);
    expect(page2).toMatchObject({ hasMore: false, nextCursor: null });

    await expect(
      tool.execute(
        tool.inputSchema.parse({
          projectId: project.id,
          tableId: table.id,
          sort: { columnId: COL_TASK, dir: "desc" },
          cursor: page1.nextCursor,
        }),
        ctx,
      ),
    ).rejects.toMatchObject({ details: { reason: "INVALID_CURSOR" } });
    await expect(
      tool.execute(
        tool.inputSchema.parse({
          projectId: project.id,
          tableId: table.id,
          cursor: ROW_PLAN,
        }),
        ctx,
      ),
    ).rejects.toMatchObject({ details: { reason: "INVALID_CURSOR" } });
  });

  it("continues a wide-select query_table_rows page whose old raw-query-JSON cursor would have exceeded the incoming-cursor length cap (C2)", async () => {
    const { ctx, project, actor, db } = await fixture();
    const ORDER_COL = "b0000000-0000-4000-8000-000000000000";
    // 41 more text columns plus ORDER_COL = 42 select ids, comfortably past
    // the 31-id threshold at which the pre-fix raw-query-JSON cursor (bound
    // by cursorQueryIdentity) produced a nextCursor rejected by cursorInput's
    // own 2,000-char cap.
    const fillerColumns = Array.from({ length: 41 }, (_, i) => ({
      id: `b${(i + 1).toString(16).padStart(7, "0")}-0000-4000-8000-000000000000`,
      name: `Col ${i}`,
      type: "text" as const,
    }));
    const columns = [
      { id: ORDER_COL, name: "Order", type: "text" as const },
      ...fillerColumns,
    ];
    const select = columns.map((c) => c.id);
    expect(select.length).toBeGreaterThanOrEqual(40);
    const ROW_A = "c0000000-0000-4000-8000-000000000000";
    const ROW_B = "c0000001-0000-4000-8000-000000000000";
    const wide = await createTable(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Wide select",
        columns,
        rows: [
          { id: ROW_A, cells: { [ORDER_COL]: "1" } },
          { id: ROW_B, cells: { [ORDER_COL]: "2" } },
        ],
      },
      actor,
    );
    const tool = toolByName("query_table_rows")!;
    const page1 = (
      await tool.execute(
        tool.inputSchema.parse({
          projectId: project.id,
          tableId: wide.id,
          select,
          sort: { columnId: ORDER_COL, dir: "asc" },
          limit: 1,
        }),
        ctx,
      )
    ).output as {
      rows: Array<{ id: string }>;
      hasMore: boolean;
      nextCursor: string | null;
    };
    expect(page1.rows.map((r) => r.id)).toEqual([ROW_A]);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).not.toBeNull();
    // The regression: a wide select must still emit a cursor the tool's own
    // input schema accepts back (cursorInput caps incoming cursors at 2,000).
    expect(page1.nextCursor!.length).toBeLessThanOrEqual(2_000);

    const page2 = (
      await tool.execute(
        tool.inputSchema.parse({
          projectId: project.id,
          tableId: wide.id,
          select,
          sort: { columnId: ORDER_COL, dir: "asc" },
          limit: 1,
          cursor: page1.nextCursor,
        }),
        ctx,
      )
    ).output as {
      rows: Array<{ id: string }>;
      hasMore: boolean;
      nextCursor: string | null;
    };
    expect(page2.rows.map((r) => r.id)).toEqual([ROW_B]);
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();
  });

  it("keeps nextCursor intact after the ai transport serializes and clamps a page filled to the reserved page budget (I1)", async () => {
    const { ctx, project, actor, db } = await fixture();
    const ORDER_COL = "b0000000-0000-4000-8000-000000000000";
    const FILLER_COL = "b0000001-0000-4000-8000-000000000000";
    // Each row's filler cell is sized so the new 14,500-char page budget
    // keeps only 7 of these 20 rows; the pre-fix 16,000-char budget (no
    // envelope reserve) would have kept 8, and 8 rows plus the response
    // envelope exceed the transports' 16,000-char clamp, discarding
    // nextCursor entirely instead of just trimming rows.
    const filler = "x".repeat(1_800);
    const rows = Array.from({ length: 20 }, (_, i) => ({
      id: `c${i.toString(16).padStart(7, "0")}-0000-4000-8000-000000000000`,
      cells: { [ORDER_COL]: String(i).padStart(2, "0"), [FILLER_COL]: filler },
    }));
    const wide = await createTable(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Filled",
        columns: [
          { id: ORDER_COL, name: "Order", type: "text" },
          { id: FILLER_COL, name: "Filler", type: "text" },
        ],
        rows,
      },
      actor,
    );
    const tool = toolByName("query_table_rows")!;
    const input = tool.inputSchema.parse({
      projectId: project.id,
      tableId: wide.id,
      sort: { columnId: ORDER_COL, dir: "asc" },
      limit: 20,
    });

    // First prove the raw tool output already fits the transport's clamp on
    // its own (the point of the fix): the page budget, not the transport,
    // is what keeps the envelope safe.
    const raw = (await tool.execute(input, ctx)).output as {
      truncated: boolean;
      hasMore: boolean;
      nextCursor: string | null;
    };
    expect(raw.truncated).toBe(true);
    expect(raw.hasMore).toBe(true);
    expect(raw.nextCursor).toEqual(expect.any(String));
    expect(JSON.stringify(raw).length).toBeLessThanOrEqual(
      MAX_TOOL_OUTPUT_CHARS,
    );

    // Then assert on the actual serialized-and-clamped transport result, not
    // just the raw output.
    const collector: ToolCollector = { citations: [], proposals: [] };
    const tools = toAiToolSet([tool], {
      context: async () => ctx,
      onEvent: async () => undefined,
      collector,
    });
    const result = (await tools.query_table_rows!.execute!(input, {
      toolCallId: "t1",
      messages: [],
      context: {},
    })) as { tableId?: string; nextCursor?: string | null };
    // A real page must never come back as the transport's own
    // {truncated:true, partialJson} clamp wrapper: tableId only survives on
    // the genuine payload.
    expect(result.tableId).toBe(wide.id);
    expect(result.nextCursor).toEqual(expect.any(String));
  });

  it("summarizes select columns by option count and flags oversized cells", async () => {
    const { ctx, project, actor, db } = await fixture();
    const COL_STATUS = "55555555-5555-4555-8555-555555555555";
    const COL_BODY = "66666666-6666-4666-8666-666666666666";
    const ROW_BIG = "77777777-7777-4777-8777-777777777777";
    const OPT_A = "88888888-8888-4888-8888-888888888888";
    const OPT_B = "99999999-9999-4999-8999-999999999999";
    const wide = await createTable(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Wide",
        columns: [
          {
            id: COL_STATUS,
            name: "Status",
            type: "select",
            options: [
              { id: OPT_A, label: "A" },
              { id: OPT_B, label: "B" },
            ],
          },
          { id: COL_BODY, name: "Body", type: "text" },
        ],
        rows: [
          {
            id: ROW_BIG,
            cells: { [COL_STATUS]: OPT_A, [COL_BODY]: "y".repeat(5_000) },
          },
        ],
      },
      actor,
    );
    const summary = (
      await toolByName("get_table")!.execute(
        toolByName("get_table")!.inputSchema.parse({
          projectId: project.id,
          tableId: wide.id,
        }),
        ctx,
      )
    ).output as {
      columnCount: number;
      columns: Array<{ id: string; optionCount?: number; options?: unknown }>;
      sampleRows: Array<{
        cells: Record<string, unknown>;
        oversizedCells?: unknown;
      }>;
      baseCommitSha: string;
      snapshotCommitSha: string;
    };
    expect(summary.columnCount).toBe(2);
    expect(summary.columns[0]).toEqual({
      id: COL_STATUS,
      name: "Status",
      type: "select",
      optionCount: 2,
    });
    expect(summary.columns[0]).not.toHaveProperty("options");
    expect(summary.sampleRows[0]).toEqual({
      id: ROW_BIG,
      cells: { [COL_STATUS]: OPT_A },
      oversizedCells: [{ columnId: COL_BODY, chars: 5_000 }],
    });
    expect(summary.baseCommitSha).toBe(wide.headCommitSha);
  });

  it("lists columns and options in pages and reads a long cell in chunks at one snapshot", async () => {
    const { ctx, project, actor, db } = await fixture();
    const COL_STATUS = "55555555-5555-4555-8555-555555555555";
    const COL_BODY = "66666666-6666-4666-8666-666666666666";
    const ROW_BIG = "77777777-7777-4777-8777-777777777777";
    const options = Array.from({ length: 5 }, (_, i) => ({
      id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`,
      label: `Option ${i}`,
    }));
    const wide = await createTable(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Wide",
        columns: [
          { id: COL_STATUS, name: "Status", type: "select", options },
          { id: COL_BODY, name: "Body", type: "text" },
          { id: COL_DONE, name: "Done", type: "boolean" },
        ],
        rows: [
          {
            id: ROW_BIG,
            cells: {
              [COL_STATUS]: options[0]!.id,
              [COL_BODY]: "abcdefghij".repeat(120),
              [COL_DONE]: true,
            },
          },
        ],
      },
      actor,
    );
    const columnsTool = toolByName("list_table_columns")!;
    const c1 = (
      await columnsTool.execute(
        columnsTool.inputSchema.parse({
          projectId: project.id,
          tableId: wide.id,
          limit: 2,
        }),
        ctx,
      )
    ).output as {
      columnCount: number;
      columns: Array<{ id: string }>;
      nextCursor: string;
      hasMore: boolean;
      snapshotCommitSha: string;
    };
    expect(c1.columnCount).toBe(3);
    expect(c1.columns.map((c) => c.id)).toEqual([COL_STATUS, COL_BODY]);
    expect(c1.hasMore).toBe(true);
    const c2 = (
      await columnsTool.execute(
        columnsTool.inputSchema.parse({
          projectId: project.id,
          tableId: wide.id,
          limit: 2,
          cursor: c1.nextCursor,
        }),
        ctx,
      )
    ).output as {
      columns: Array<{ id: string }>;
      nextCursor: string | null;
      hasMore: boolean;
    };
    expect(c2.columns.map((c) => c.id)).toEqual([COL_DONE]);
    expect(c2).toMatchObject({ hasMore: false, nextCursor: null });
    const selected = (
      await columnsTool.execute(
        columnsTool.inputSchema.parse({
          projectId: project.id,
          tableId: wide.id,
          columnIds: [COL_DONE, COL_STATUS],
        }),
        ctx,
      )
    ).output as { columns: Array<{ id: string; optionCount?: number }> };
    expect(selected.columns.map((c) => c.id)).toEqual([COL_DONE, COL_STATUS]);
    expect(selected.columns[1]?.optionCount).toBe(5);

    const optionsTool = toolByName("list_table_column_options")!;
    const o1 = (
      await optionsTool.execute(
        optionsTool.inputSchema.parse({
          projectId: project.id,
          tableId: wide.id,
          columnId: COL_STATUS,
          limit: 3,
        }),
        ctx,
      )
    ).output as {
      optionCount: number;
      options: Array<{ id: string; label: string }>;
      nextCursor: string;
      hasMore: boolean;
    };
    expect(o1.optionCount).toBe(5);
    expect(o1.options).toEqual(options.slice(0, 3));
    const o2 = (
      await optionsTool.execute(
        optionsTool.inputSchema.parse({
          projectId: project.id,
          tableId: wide.id,
          columnId: COL_STATUS,
          limit: 3,
          cursor: o1.nextCursor,
        }),
        ctx,
      )
    ).output as {
      options: Array<{ id: string }>;
      hasMore: boolean;
      nextCursor: string | null;
    };
    expect(o2.options).toEqual(options.slice(3));
    expect(o2).toMatchObject({ hasMore: false, nextCursor: null });
    await expect(
      optionsTool.execute(
        optionsTool.inputSchema.parse({
          projectId: project.id,
          tableId: wide.id,
          columnId: COL_BODY,
        }),
        ctx,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const cellTool = toolByName("read_table_cell")!;
    const t1 = (
      await cellTool.execute(
        cellTool.inputSchema.parse({
          projectId: project.id,
          tableId: wide.id,
          rowId: ROW_BIG,
          columnId: COL_BODY,
          maxChars: 500,
        }),
        ctx,
      )
    ).output as {
      value: {
        kind: string;
        text: string;
        offset: number;
        totalChars: number;
        nextCursor: string;
        hasMore: boolean;
      };
    };
    expect(t1.value).toMatchObject({
      kind: "text",
      offset: 0,
      totalChars: 1_200,
      hasMore: true,
    });
    expect(t1.value.text).toHaveLength(500);
    const t2 = (
      await cellTool.execute(
        cellTool.inputSchema.parse({
          projectId: project.id,
          tableId: wide.id,
          rowId: ROW_BIG,
          columnId: COL_BODY,
          maxChars: 500,
          cursor: t1.value.nextCursor,
        }),
        ctx,
      )
    ).output as { value: { text: string; offset: number; nextCursor: string } };
    expect(t2.value.offset).toBe(500);
    const t3 = (
      await cellTool.execute(
        cellTool.inputSchema.parse({
          projectId: project.id,
          tableId: wide.id,
          rowId: ROW_BIG,
          columnId: COL_BODY,
          maxChars: 500,
          cursor: t2.value.nextCursor,
        }),
        ctx,
      )
    ).output as {
      value: { text: string; hasMore: boolean; nextCursor: string | null };
    };
    expect(t1.value.text + t2.value.text + t3.value.text).toBe(
      "abcdefghij".repeat(120),
    );
    expect(t3.value).toMatchObject({ hasMore: false, nextCursor: null });

    const scalar = (
      await cellTool.execute(
        cellTool.inputSchema.parse({
          projectId: project.id,
          tableId: wide.id,
          rowId: ROW_BIG,
          columnId: COL_DONE,
        }),
        ctx,
      )
    ).output as { value: unknown };
    expect(scalar.value).toEqual({ kind: "scalar", value: true });
    // Select cells store the chosen option id as a string, so
    // read_table_cell classifies them as "text", not "scalar".
    const selectCell = (
      await cellTool.execute(
        cellTool.inputSchema.parse({
          projectId: project.id,
          tableId: wide.id,
          rowId: ROW_BIG,
          columnId: COL_STATUS,
          atCommitSha: c1.snapshotCommitSha,
        }),
        ctx,
      )
    ).output as { value: { kind: string } };
    expect(selectCell.value.kind).toBe("text");
    await expect(
      cellTool.execute(
        cellTool.inputSchema.parse({
          projectId: project.id,
          tableId: wide.id,
          rowId: ROW_PLAN,
          columnId: COL_BODY,
        }),
        ctx,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("chunks a cell without splitting a surrogate pair across the boundary", async () => {
    const { ctx, project, actor, db } = await fixture();
    const COL_EMOJI = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const ROW_EMOJI = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    // U+1F600 is a surrogate pair in UTF-16 (high 0xD83D, low 0xDE00).
    // Place it right after 499 filler chars so a maxChars=500 boundary
    // (computed, not guessed) falls exactly between the two halves.
    const emoji = "\u{1f600}";
    const before = "a".repeat(499);
    const after = "b".repeat(10);
    const content = before + emoji + after;
    expect(content.length).toBe(511);
    const table = await createTable(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Emoji",
        columns: [{ id: COL_EMOJI, name: "Body", type: "text" }],
        rows: [{ id: ROW_EMOJI, cells: { [COL_EMOJI]: content } }],
      },
      actor,
    );
    const lonelySurrogate =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const cellTool = toolByName("read_table_cell")!;
    const first = (
      await cellTool.execute(
        cellTool.inputSchema.parse({
          projectId: project.id,
          tableId: table.id,
          rowId: ROW_EMOJI,
          columnId: COL_EMOJI,
          maxChars: 500,
        }),
        ctx,
      )
    ).output as {
      value: {
        text: string;
        offset: number;
        totalChars: number;
        hasMore: boolean;
        nextCursor: string;
      };
    };
    // The naive slice(0, 500) would cut the surrogate pair in half; the fix
    // must back the boundary off to 499 so the pair stays whole together.
    expect(first.value.text).toBe(before);
    expect(first.value.text).toHaveLength(499);
    expect(first.value).toMatchObject({
      offset: 0,
      totalChars: 511,
      hasMore: true,
    });
    expect(lonelySurrogate.test(first.value.text)).toBe(false);
    const second = (
      await cellTool.execute(
        cellTool.inputSchema.parse({
          projectId: project.id,
          tableId: table.id,
          rowId: ROW_EMOJI,
          columnId: COL_EMOJI,
          maxChars: 500,
          cursor: first.value.nextCursor,
        }),
        ctx,
      )
    ).output as {
      value: {
        text: string;
        offset: number;
        hasMore: boolean;
        nextCursor: string | null;
      };
    };
    expect(second.value.text).toBe(emoji + after);
    expect(second.value).toMatchObject({
      offset: 499,
      hasMore: false,
      nextCursor: null,
    });
    expect(lonelySurrogate.test(second.value.text)).toBe(false);
    expect(first.value.text + second.value.text).toBe(content);
  });

  it("reads a document without splitting a surrogate pair across a chunk boundary (I2)", async () => {
    const { ctx, project, doc, actor, db } = await fixture();
    // U+1F600 is a surrogate pair in UTF-16 (high 0xD83D, low 0xDE00). 500
    // filler chars push its index past maxChars's 500-char minimum, so the
    // boundary below can be computed from the real stored content instead
    // of assumed.
    const emoji = "\u{1f600}";
    const markdown = `# Roadmap\n\n${"a".repeat(500)}${emoji}${"b".repeat(10)}\n`;
    await saveDocument(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        baseCommitSha: doc.headCommitSha,
        content: { kind: "markdown", contentJson: parseDocumentBody(markdown) },
        changeSummary: "surrogate boundary",
      },
      actor,
    );
    const tool = toolByName("read_document")!;
    const full = (
      await tool.execute(
        tool.inputSchema.parse({ projectId: project.id, documentId: doc.id }),
        ctx,
      )
    ).output as { markdown: string };
    const emojiIndex = full.markdown.indexOf(emoji);
    expect(emojiIndex).toBeGreaterThanOrEqual(500);
    // Computed, not guessed: cutting at emojiIndex + 1 code units lands
    // exactly between the emoji's high and low surrogate halves.
    const boundary = emojiIndex + 1;

    const lonelySurrogate =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const first = (
      await tool.execute(
        tool.inputSchema.parse({
          projectId: project.id,
          documentId: doc.id,
          maxChars: boundary,
        }),
        ctx,
      )
    ).output as {
      markdown: string;
      hasMore: boolean;
      nextCursor: string;
    };
    // The naive slice(0, boundary) would cut the surrogate pair in half; the
    // fix must back the boundary off by one so the pair stays whole together.
    expect(first.markdown).toBe(full.markdown.slice(0, boundary - 1));
    expect(first.markdown).toHaveLength(boundary - 1);
    expect(first.hasMore).toBe(true);
    expect(lonelySurrogate.test(first.markdown)).toBe(false);

    const second = (
      await tool.execute(
        tool.inputSchema.parse({
          projectId: project.id,
          documentId: doc.id,
          cursor: first.nextCursor,
        }),
        ctx,
      )
    ).output as { markdown: string; hasMore: boolean };
    expect(lonelySurrogate.test(second.markdown)).toBe(false);
    expect(first.markdown + second.markdown).toBe(full.markdown);
    expect(second.hasMore).toBe(false);
  });

  it("skips a row that cannot fit the output budget alone and advances the cursor past it", async () => {
    const { ctx, project, actor, db } = await fixture();
    const COL_ORDER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const ROW_HUGE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const ROW_SMALL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    // 10 text columns just under MAX_INLINE_CELL_CHARS (2000) each, so no
    // single cell is stripped by inlineRow, but the row's combined JSON
    // (~19.5k chars) exceeds MAX_TOOL_OUTPUT_CHARS (16000) once inlined.
    const fillerColumns = Array.from({ length: 10 }, (_, i) => ({
      id: `d0000000-0000-4000-8000-00000000000${i}`,
      name: `Filler ${i}`,
      type: "text" as const,
    }));
    const filler = "x".repeat(1_900);
    const huge = await createTable(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Huge",
        columns: [
          { id: COL_ORDER, name: "Order", type: "text" },
          ...fillerColumns,
        ],
        rows: [
          {
            id: ROW_HUGE,
            cells: {
              [COL_ORDER]: "1",
              ...Object.fromEntries(fillerColumns.map((c) => [c.id, filler])),
            },
          },
          { id: ROW_SMALL, cells: { [COL_ORDER]: "2" } },
        ],
      },
      actor,
    );
    const tool = toolByName("query_table_rows")!;
    const page1 = (
      await tool.execute(
        tool.inputSchema.parse({
          projectId: project.id,
          tableId: huge.id,
          sort: { columnId: COL_ORDER, dir: "asc" },
        }),
        ctx,
      )
    ).output as {
      snapshotCommitSha: string;
      rows: Array<{ id: string }>;
      matched: number;
      truncated: boolean;
      skipped?: { rowId: string; reason: string };
      nextCursor: string | null;
      hasMore: boolean;
    };
    expect(page1.rows).toEqual([]);
    expect(page1.matched).toBe(2);
    expect(page1.truncated).toBe(true);
    expect(page1.skipped).toEqual({ rowId: ROW_HUGE, reason: "ROW_TOO_LARGE" });
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.snapshotCommitSha).toBe(huge.headCommitSha);

    const page2 = (
      await tool.execute(
        tool.inputSchema.parse({
          projectId: project.id,
          tableId: huge.id,
          sort: { columnId: COL_ORDER, dir: "asc" },
          cursor: page1.nextCursor,
        }),
        ctx,
      )
    ).output as {
      snapshotCommitSha: string;
      rows: Array<{ id: string }>;
      matched: number;
      truncated: boolean;
      skipped?: unknown;
      nextCursor: string | null;
      hasMore: boolean;
    };
    expect(page2.snapshotCommitSha).toBe(page1.snapshotCommitSha);
    expect(page2.rows.map((r) => r.id)).toEqual([ROW_SMALL]);
    expect(page2.matched).toBe(2);
    expect(page2.truncated).toBe(false);
    expect(page2.skipped).toBeUndefined();
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();
  });

  it("searches knowledge (keyword mode without an embedding route) and emits search citations", async () => {
    const { ctx, doc } = await fixture();
    const tool = toolByName("search_knowledge")!;
    const outcome = await tool.execute(
      tool.inputSchema.parse({ query: "assistant" }),
      ctx,
    );
    expect(
      (
        outcome.output as { documents: Array<{ documentId: string }> }
      ).documents.map((d) => d.documentId),
    ).toContain(doc.id);
    expect(outcome.citations?.some((c) => c.kind === "search")).toBe(true);
  });

  it("validates locators: drops unknown revisions and inaccessible projects", async () => {
    const { db, actor, project, hidden, doc } = await fixture();
    const stranger = securityContextFor(await makeUser("User", "stranger"));
    const good = {
      kind: "document",
      projectId: project.id,
      documentId: doc.id,
      commitSha: doc.headCommitSha,
      headingPath: ["Roadmap"],
      excerpt: "Ship",
    };
    const validated = await validateSourceLocators(db, actor, [
      good,
      { ...good, commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
      { ...good, projectId: hidden.id },
      { kind: "bogus" },
    ]);
    expect(validated.map((c) => c.label)).toEqual(["Roadmap"]);
    expect(await validateSourceLocators(db, stranger, [good])).toEqual([]);
  });

  it("binds citations to the resource at its revision and derives excerpts from Git", async () => {
    const { db, actor, project, doc, table } = await fixture();
    const later = await createDocument(
      db,
      {
        projectId: project.id,
        title: "Later",
        folderPath: [],
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("Actual source text"),
        },
      },
      actor,
    );
    expect(
      await validateSourceLocators(db, actor, [
        {
          kind: "document",
          projectId: project.id,
          documentId: later.id,
          commitSha: doc.headCommitSha,
          excerpt: "forged private marker",
        },
      ]),
    ).toEqual([]);
    const unrelated = await createDocument(
      db,
      {
        projectId: project.id,
        title: "Unrelated",
        folderPath: [],
        content: { kind: "markdown", contentJson: parseDocumentBody("Other") },
      },
      actor,
    );
    expect(
      await validateSourceLocators(db, actor, [
        {
          kind: "document",
          projectId: project.id,
          documentId: later.id,
          commitSha: unrelated.headCommitSha.slice(0, 12),
        },
      ]),
    ).toHaveLength(1);
    expect(
      await validateSourceLocators(db, actor, [
        {
          kind: "table",
          projectId: project.id,
          tableId: table.id,
          commitSha: unrelated.headCommitSha.slice(0, 12),
          rowIds: [ROW_PLAN],
          columnIds: [COL_TASK],
        },
      ]),
    ).toHaveLength(1);
    const [citation] = await validateSourceLocators(db, actor, [
      {
        kind: "document",
        projectId: project.id,
        documentId: later.id,
        commitSha: later.headCommitSha,
        excerpt: "forged private marker",
        headingPath: ["Invented heading"],
      },
    ]);
    expect(citation?.excerpt).toContain("Actual source text");
    expect(JSON.stringify(citation)).not.toMatch(
      /forged private marker|Invented heading/,
    );
  });

  it("materializes current folder reviewers when a create proposal is accepted and through MCP", async () => {
    const { ctx, db, actor, user, project } = await fixture();
    const reviewer = await makeUser("User", "tools-folder-reviewer");
    await addMembership(project.id, reviewer.id, "Viewer");
    const tool = toolByName("propose_document_create")!;
    const proposal = await tool.execute(
      tool.inputSchema.parse({
        projectId: project.id,
        folderPath: [],
        title: "Proposal defaults",
        markdown: "new",
        summary: "Create",
      }),
      ctx,
    );
    const reviewers = [
      {
        type: "user" as const,
        id: reviewer.id,
        name: "User tools-folder-reviewer",
      },
    ];
    await withProjectRepo(project.id, async (repo) => {
      await repo.writeFileAtomic(
        ".folder.json",
        composeRootFolderMetadata({ reviewDefaults: { reviewers } }),
      );
      await repo.commitAll("test: change defaults after proposal", {
        name: "Tool User",
        email: user.email,
        userId: user.id,
      });
    });
    const accepted = await acceptProposal(
      db,
      actor,
      (proposal.output as { proposalId: string }).proposalId,
    );
    const created = await getDocument(
      db,
      { projectId: project.id, documentId: accepted.resourceId! },
      actor,
    );
    expect(created.review!.reviewers).toEqual(
      reviewers.map((ref) => ({ ...ref, resolved: true })),
    );
    const credential = createApiKeySecurityContext({
      userId: user.id,
      globalRole: user.role,
      keyId: "key-folder-write",
      permissions: { mcp: ["use"], content: ["read", "write"] },
      projectIds: [project.id],
    });
    const mcpContext: ToolContext = { ...ctx, actor: credential, run: null };
    const outcome = await mcpToolByName("create_document")!.execute(
      {
        projectId: project.id,
        folderPath: [],
        title: "MCP defaults",
        markdown: "mcp",
        summary: "Create",
        idempotencyKey: "tools-folder-defaults",
      },
      mcpContext,
    );
    const result = outcome.output as McpWriteResult;
    await withProjectRepo(project.id, async (repo) =>
      expect(
        parseDocumentFile(
          await repo.readFileFromWorktree(result.path!),
          "markdown",
        ).meta.review!.reviewers,
      ).toEqual(reviewers),
    );
  });

  it("propose tools create pending proposals bound to the run and require content:propose", async () => {
    const { ctx, db, actor, project, table, doc } = await fixture();
    const tool = toolByName("propose_document_edit")!;
    const outcome = await tool.execute(
      tool.inputSchema.parse({
        projectId: project.id,
        documentId: doc.id,
        baseCommitSha: doc.headCommitSha,
        markdown: "# Roadmap\n\nShipped.\n",
        summary: "Mark shipped",
      }),
      ctx,
    );
    expect(outcome.output).toMatchObject({
      kind: "document.edit",
      status: "pending",
      summary: "Mark shipped",
    });
    const { proposalId } = outcome.output as { proposalId: string };
    expect(await getProposal(db, actor, proposalId)).toMatchObject({
      status: "pending",
      runId: ctx.run!.runId,
      conversationId: ctx.run!.conversationId,
      projectId: project.id,
      kind: "document.edit",
      resourceId: doc.id,
      baseCommitSha: doc.headCommitSha,
    });
    // The proposal is a row, not a write: the document body and the total
    // document/table counts in the project are unchanged.
    const stillCurrent = await getDocument(
      db,
      { projectId: project.id, documentId: doc.id },
      actor,
    );
    expect(serializeDocumentBody(markdownContent(stillCurrent))).toContain(
      "Ship the assistant in Q4",
    );
    expect(serializeDocumentBody(markdownContent(stillCurrent))).not.toContain(
      "Shipped",
    );
    const documentsAfter = await listDocuments(
      db,
      {
        projectId: project.id,
        page: 1,
        pageSize: 50,
        sort: "title",
        dir: "asc",
      },
      actor,
    );
    expect(documentsAfter.total).toBe(1);
    const tablesAfter = await listTables(
      db,
      {
        projectId: project.id,
        page: 1,
        pageSize: 50,
        sort: "title",
        dir: "asc",
      },
      actor,
    );
    expect(tablesAfter.total).toBe(1);
    expect(tablesAfter.items[0]?.id).toBe(table.id);

    const readOnly = {
      ...ctx,
      actor: Object.freeze({
        ...ctx.actor,
        capabilities: new Set(["assistant:use", "content:read"] as const),
      }),
    };
    const readOnlyToolNames = toolsForActor(readOnly.actor).map((t) => t.name);
    expect(readOnlyToolNames.some((name) => name.startsWith("propose_"))).toBe(
      false,
    );
    await expect(
      tool.execute(
        tool.inputSchema.parse({
          projectId: project.id,
          documentId: doc.id,
          baseCommitSha: doc.headCommitSha,
          markdown: "x",
          summary: "s",
        }),
        readOnly,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      tool.execute(
        tool.inputSchema.parse({
          projectId: project.id,
          documentId: doc.id,
          baseCommitSha: doc.headCommitSha,
          markdown: "x",
          summary: "s",
        }),
        { ...ctx, run: null },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("executes a write contract for a content:write credential and replays on retry", async () => {
    const { db, user, project, doc } = await fixture();
    const actor = createApiKeySecurityContext({
      userId: user.id,
      globalRole: user.role,
      keyId: "key-write",
      permissions: { mcp: ["use"], content: ["read", "write"] },
      projectIds: [],
    });
    const scope = await resolveScopeSnapshot(db, actor, { kind: "all" });
    const ctx: ToolContext = {
      db,
      actor,
      scope,
      profile: { name: "Tool User", email: user.email },
      run: null,
    };
    const tool = mcpToolByName("update_document")!;
    const read = (await toolByName("read_document")!.execute(
      { projectId: project.id, documentId: doc.id, offset: 0, maxChars: 8000 },
      ctx,
    )) as { output: { commitSha: string } };
    const input = {
      projectId: project.id,
      documentId: doc.id,
      baseCommitSha: read.output.commitSha,
      markdown: "# Roadmap\n\nShip the MCP runtime in 4F.\n",
      idempotencyKey: "tools-spec-0001",
      summary: "Update the roadmap",
    };
    const first = (await tool.execute(input, ctx)) as {
      output: McpWriteResult;
    };
    expect(first.output).toMatchObject({
      projectId: project.id,
      resourceId: doc.id,
      replayed: false,
    });
    const again = (await tool.execute(input, ctx)) as {
      output: McpWriteResult;
    };
    expect(again.output).toEqual({ ...first.output, replayed: true });
  });

  it("hides and refuses write contracts for read-only credentials", async () => {
    const { db, user, project } = await fixture();
    const readOnly = createApiKeySecurityContext({
      userId: user.id,
      globalRole: user.role,
      keyId: "key-read",
      permissions: { mcp: ["use"], content: ["read"] },
      projectIds: [],
    });
    expect(mcpToolsForActor(readOnly).map((t) => t.name)).not.toContain(
      "create_document",
    );
    const ctx: ToolContext = {
      db,
      actor: readOnly,
      scope: await resolveScopeSnapshot(db, readOnly, { kind: "all" }),
      profile: { name: "Tool User", email: user.email },
      run: null,
    };
    await expect(
      mcpToolByName("create_document")!.execute(
        {
          projectId: project.id,
          folderPath: [],
          title: "Nope",
          markdown: "nope",
          idempotencyKey: "tools-spec-0002",
          summary: "nope",
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("keeps the original bounded diagnostic page when a concurrent insert arrives", async () => {
    const db = getPrisma();
    const admin = await makeUser("Admin", "tools-admin-cursor");
    const actor = securityContextFor(admin);
    const originalIds = [
      "71000000-0000-4000-8000-000000000003",
      "71000000-0000-4000-8000-000000000002",
      "71000000-0000-4000-8000-000000000001",
    ];
    await db.diagnosticEvent.createMany({
      data: originalIds.map((id, index) => ({
        id,
        createdAt: new Date(Date.UTC(2026, 8, 4, 12, 0, 3 - index)),
        runtime: "mcp" as const,
        severity: "info" as const,
        category: "admin",
        event: "admin.tool.called",
        message: `original ${index}`,
        details: { padding: "x".repeat(8_000) },
      })),
    });
    const concurrentId = "71000000-0000-4000-8000-000000000004";
    let inserted = false;
    const movingDb = db.$extends({
      query: {
        diagnosticEvent: {
          async findMany({ args, query }) {
            const rows = await query(args);
            if (!inserted) {
              inserted = true;
              await db.diagnosticEvent.create({
                data: {
                  id: concurrentId,
                  createdAt: new Date("2026-09-04T12:00:04.000Z"),
                  runtime: "mcp",
                  severity: "info",
                  category: "admin",
                  event: "admin.tool.called",
                  message: "concurrent",
                  details: { padding: "x".repeat(8_000) },
                },
              });
            }
            return rows;
          },
        },
      },
    });
    const context = (contextDb: ToolContext["db"]): ToolContext => ({
      db: contextDb,
      actor,
      scope: {
        kind: "all",
        projectIds: [],
        documentId: null,
        tableId: null,
        resolvedAt: "2026-09-04T12:00:00.000Z",
        truncated: false,
      },
      profile: { name: "Admin", email: admin.email },
      run: null,
    });
    const tool = mcpToolByName("list_diagnostic_events")!;
    const first = (await tool.execute(
      { limit: 3 },
      context(movingDb as unknown as ToolContext["db"]),
    )) as {
      output: {
        items: Array<{ id: string }>;
        nextCursor: string | null;
      };
    };

    expect(inserted).toBe(true);
    expect(first.output.items.map((item) => item.id)).toEqual([originalIds[0]]);
    expect(first.output.nextCursor).not.toBeNull();

    const seenOriginal = first.output.items.map((item) => item.id);
    let cursor = first.output.nextCursor;
    const cursors = new Set<string>();
    while (cursor && cursors.size < 10) {
      expect(cursors.has(cursor)).toBe(false);
      cursors.add(cursor);
      const next = (await tool.execute(
        { limit: 3, cursor },
        context(db),
      )) as typeof first;
      seenOriginal.push(
        ...next.output.items
          .map((item) => item.id)
          .filter((id) => originalIds.includes(id)),
      );
      cursor = next.output.nextCursor;
    }
    expect(cursor).toBeNull();
    expect(seenOriginal).toEqual(originalIds);
  });
});

describe("wiki read tools", () => {
  beforeEach(async () => {
    vi.stubEnv("NODE_ENV", "test");
    await resetDb();
    setJobQueueForTests(new FakeJobQueue());
  });
  afterEach(() => {
    setJobQueueForTests(null);
    vi.unstubAllEnvs();
  });

  type WikiOut = {
    pages: Array<{
      id: string;
      title: string;
      path: string;
      type: string | null;
      summary: string | null;
      link: string;
    }>;
    links: Array<{
      from: { id: string };
      targetType: string;
      targetId: string;
    }>;
    changes: Array<{
      sha: string;
      kind: string;
      author: string | null;
      subject: string;
      changes: Array<{
        status: string;
        path: string;
        documentId: string | null;
      }>;
    }>;
    nextCursor: string | null;
  };
  const run = async (
    ctx: ToolContext,
    name: string,
    input: Record<string, unknown>,
  ) => {
    const tool = mcpToolByName(name)!;
    return (await tool.execute(tool.inputSchema.parse(input), ctx))
      .output as WikiOut;
  };
  const addPage = (
    f: Awaited<ReturnType<typeof fixture>>,
    title: string,
    markdown: string,
  ) =>
    createDocument(
      f.db,
      {
        projectId: f.project.id,
        folderPath: [],
        title,
        content: { kind: "markdown", contentJson: parseDocumentBody(markdown) },
      },
      f.actor,
    );

  it("keeps the wiki tools out of the assistant registry and inside the wiki toolset only", async () => {
    for (const name of ["find_page", "inspect_links", "list_recent_changes"]) {
      expect(toolByName(name)).toBeUndefined();
      expect(mcpToolByName(name)?.kind).toBe("read");
    }
  });

  it("refuses a project outside the scope and one the user is not a member of", async () => {
    const f = await fixture();
    const stranger = await makeProject("Stranger");
    for (const projectId of [f.hidden.id, stranger.id])
      for (const [name, input] of [
        ["find_page", { title: "Roadmap" }],
        ["inspect_links", { mode: "orphans" }],
        ["list_recent_changes", {}],
      ] as const)
        await expect(
          run(f.ctx, name, { projectId, ...input }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const outsideScope = {
      ...f.ctx,
      scope: { ...f.ctx.scope, projectIds: [] },
    };
    await expect(
      run(outsideScope, "find_page", { projectId: f.project.id, slug: "x" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("finds pages with paste-ready links and hides source pages unless asked", async () => {
    const f = await fixture();
    const page = await addPage(f, "A [odd] title", "# Body\n\ntext\n");
    const source = await addPage(f, "Imported note", "raw\n");
    await f.db.document.update({
      where: { id: source.id },
      data: { wikiSourceItemId: randomUUID() },
    });
    await f.db.document.update({
      where: { id: page.id },
      data: { wikiType: "concept", wikiSummary: "Short summary" },
    });
    const found = await run(f.ctx, "find_page", {
      projectId: f.project.id,
      title: "  a [ODD]   title ",
    });
    expect(found.pages).toEqual([
      {
        id: page.id,
        title: "A [odd] title",
        path: page.path,
        type: "concept",
        summary: "Short summary",
        link: `[A \\[odd\\] title](weaver://document/${page.id})`,
      },
    ]);
    expect(
      (
        await run(f.ctx, "find_page", {
          projectId: f.project.id,
          slug: source.slug,
        })
      ).pages,
    ).toEqual([]);
    expect(
      (
        await run(f.ctx, "find_page", {
          projectId: f.project.id,
          path: source.path,
          includeSources: true,
        })
      ).pages.map((p: { id: string }) => p.id),
    ).toEqual([source.id]);
    await expect(
      run(f.ctx, "find_page", { projectId: f.project.id }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("reports orphans, dangling links and backlinks", async () => {
    const f = await fixture();
    const b = await addPage(f, "Target", "target\n");
    const missing = randomUUID();
    const missingTable = randomUUID();
    const a = await addPage(
      f,
      "Linker",
      `See [Target](weaver://document/${b.id}), [Gone](weaver://document/${missing}) and [Grid](weaver://table/${missingTable}).\n`,
    );
    const source = await addPage(f, "Source page", "src\n");
    await f.db.document.update({
      where: { id: source.id },
      data: { wikiSourceItemId: randomUUID() },
    });
    const orphans = await run(f.ctx, "inspect_links", {
      projectId: f.project.id,
      mode: "orphans",
    });
    expect(orphans.pages.map((p: { id: string }) => p.id).sort()).toEqual(
      [f.doc.id, a.id].sort(),
    );
    const dangling = await run(f.ctx, "inspect_links", {
      projectId: f.project.id,
      mode: "dangling",
    });
    expect(
      dangling.links
        .map(
          (l: {
            from: { id: string };
            targetType: string;
            targetId: string;
          }) => [l.from.id, l.targetType, l.targetId],
        )
        .sort(),
    ).toEqual(
      [
        [a.id, "document", missing],
        [a.id, "table", missingTable],
      ].sort(),
    );
    const backlinks = await run(f.ctx, "inspect_links", {
      projectId: f.project.id,
      mode: "backlinks",
      documentId: b.id,
    });
    expect(backlinks.pages.map((p: { id: string }) => p.id)).toEqual([a.id]);
    await expect(
      run(f.ctx, "inspect_links", {
        projectId: f.project.id,
        mode: "backlinks",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      run(f.ctx, "inspect_links", {
        projectId: f.project.id,
        mode: "orphans",
        cursor: "nope",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("pages orphans and dangling links with stable cursors", async () => {
    const f = await fixture();
    for (let i = 0; i < 3; i++)
      await addPage(f, `Page ${i}`, `[x](weaver://document/${randomUUID()})\n`);
    for (const mode of ["orphans", "dangling"] as const) {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 10; guard++) {
        const result = await inspectLinks(
          f.db,
          {
            projectId: f.project.id,
            mode,
            limit: 2,
            ...(cursor ? { cursor } : {}),
          },
          f.actor,
        );
        const items = result.mode === "dangling" ? result.links : result.pages;
        seen.push(
          ...items.map((item) => ("from" in item ? item.from.id : item.id)),
        );
        if (!result.nextCursor) break;
        expect(items).toHaveLength(2);
        cursor = result.nextCursor;
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toHaveLength(mode === "orphans" ? 4 : 3);
    }
  });

  it("derives the change kind from trusted operation ids and reports untrusted commits as external", async () => {
    const f = await fixture();
    const author = {
      name: "Tool User",
      email: f.user.email,
      userId: f.user.id,
    };
    await withProjectRepo(f.project.id, async (repo) => {
      await repo.writeFileAtomic("a.txt", "1\n");
      await repo.commitAll("wiki: trusted run", author, {
        operationId: "wiki-run:00000000-0000-4000-8000-000000000001:0001",
      });
    });
    const dir = repoDir(f.project.id);
    const git = simpleGit({ baseDir: dir }).env({
      GIT_AUTHOR_NAME: "Intruder",
      GIT_AUTHOR_EMAIL: "x@example.test",
      GIT_COMMITTER_NAME: "Intruder",
      GIT_COMMITTER_EMAIL: "x@example.test",
    });
    await writeFile(path.join(dir, "b.txt"), "2\n");
    await git.raw(["add", "-A"]);
    await git.raw([
      "commit",
      "-m",
      "forged\n\nplain text",
      "--trailer",
      "Weaver-Operation-Id: wiki-run:forged:0001",
      "--trailer",
      `Weaver-User-Id: ${f.user.id}`,
    ]);
    const out = await run(f.ctx, "list_recent_changes", {
      projectId: f.project.id,
    });
    expect(out.changes[0]).toMatchObject({
      kind: "external",
      author: null,
      subject: "forged",
    });
    expect(out.changes[1]).toMatchObject({
      kind: "wiki-run",
      author: "Tool User",
    });
    const ui = out.changes.find(
      (c: { changes: Array<{ documentId: string | null }> }) =>
        c.changes.some((change) => change.documentId === f.doc.id),
    );
    expect(ui).toMatchObject({ kind: "ui" });
    expect(ui!.changes[0]).toMatchObject({ status: "A" });
    const since = await run(f.ctx, "list_recent_changes", {
      projectId: f.project.id,
      since: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(since.changes).toEqual([]);
  });

  it("pages the change feed by commit cursor and rejects foreign cursors", async () => {
    const f = await fixture();
    for (let i = 0; i < 3; i++) await addPage(f, `Feed ${i}`, `n${i}\n`);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await listRecentChanges(
        f.db,
        { projectId: f.project.id, limit: 2, ...(cursor ? { cursor } : {}) },
        f.actor,
      );
      seen.push(...page.changes.map((change) => change.sha));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(5);
    await expect(
      listRecentChanges(
        f.db,
        { projectId: f.project.id, cursor: "f".repeat(40) },
        f.actor,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      run(f.ctx, "list_recent_changes", {
        projectId: f.project.id,
        cursor: "not-a-sha",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("keeps wiki tool output within the page budget and resumes after the last page returned", async () => {
    const f = await fixture();
    for (let i = 0; i < 30; i++)
      await addPage(f, `${"T".repeat(190)} ${i}`, "x\n");
    const first = await run(f.ctx, "inspect_links", {
      projectId: f.project.id,
      mode: "orphans",
    });
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(
      MAX_TOOL_OUTPUT_CHARS,
    );
    expect(first.pages.length).toBeLessThan(31);
    expect(first.nextCursor).toBe(first.pages.at(-1)!.id);
    const second = await run(f.ctx, "inspect_links", {
      projectId: f.project.id,
      mode: "orphans",
      cursor: first.nextCursor,
    });
    const ids = [...first.pages, ...second.pages].map(
      (page: { id: string }) => page.id,
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id: string) => id > "")).toBe(true);
  });
});

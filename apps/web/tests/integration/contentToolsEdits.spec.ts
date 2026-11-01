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
import { validateSourceLocators } from "@weaver/core/assistant/citations";
import { resolveScopeSnapshot } from "@weaver/core/assistant/scope";
import { MAX_MARKDOWN_CHARS } from "@weaver/core/documents/limits";
import { createConversation } from "@weaver/core/services/assistantConversations";
import {
  acceptProposal,
  createProposal,
} from "@weaver/core/services/assistantProposals";
import { submitUserMessage } from "@weaver/core/services/assistantRuns";
import { createDocument, getDocument } from "@weaver/core/services/documents";
import { createTable, getTable } from "@weaver/core/services/tables";
import { applyMcpOperation } from "@weaver/core/services/mcpOperations";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import {
  parseDocumentBody,
  serializeDocumentBody,
} from "@weaver/core/editor/markdown";

const AUTHOR = { name: "Editor", email: "editor@test.local" };

async function editorProject(suffix: string) {
  const editor = await makeUser("User", `editor-${suffix}`);
  const project = await makeProject(`Edits ${suffix}`);
  await addMembership(project.id, editor.id, "Owner");
  return {
    db: getPrisma(),
    project,
    actor: { ...securityContextFor(editor), ...AUTHOR, email: editor.email },
  };
}

const MD = [
  "# Alpha",
  "",
  "Alpha body with token here.",
  "",
  "## Beta",
  "",
  "Beta body.",
  "",
].join("\n");

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

describe("document.patch", () => {
  async function seedDocument(suffix: string) {
    const ctx = await editorProject(suffix);
    const created = await createDocument(
      ctx.db,
      {
        projectId: ctx.project.id,
        folderPath: [],
        title: "Guide",
        content: { kind: "markdown", contentJson: parseDocumentBody(MD) },
      },
      ctx.actor,
    );
    const head = await getDocument(
      ctx.db,
      { projectId: ctx.project.id, documentId: created.id },
      ctx.actor,
    );
    return { ...ctx, document: created, base: head.baseCommitSha };
  }

  it("applies an exact replacement and leaves the rest of the body intact", async () => {
    const { db, project, actor, document, base } = await seedDocument("patch");
    const result = await applyMcpOperation(db, actor, {
      idempotencyKey: "patch-001",
      toolName: "patch_document",
      summary: "Rename the token",
      operation: {
        kind: "document.patch",
        projectId: project.id,
        documentId: document.id,
        baseCommitSha: base,
        actions: [{ action: "replace_text", find: "token", replace: "WORD" }],
      },
    });
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
    const after = await getDocument(
      db,
      { projectId: project.id, documentId: document.id },
      actor,
    );
    const markdown = serializeDocumentBody(markdownContent(after));
    expect(markdown).toContain("Alpha body with WORD here.");
    expect(markdown).toContain("## Beta");
    expect(markdown).toContain("Beta body.");
  });

  it("changes the title without resubmitting the body", async () => {
    const { db, project, actor, document, base } = await seedDocument("title");
    await applyMcpOperation(db, actor, {
      idempotencyKey: "patch-title",
      toolName: "patch_document",
      summary: "Rename",
      operation: {
        kind: "document.patch",
        projectId: project.id,
        documentId: document.id,
        baseCommitSha: base,
        title: "Handbook",
        actions: [],
      },
    });
    const after = await getDocument(
      db,
      { projectId: project.id, documentId: document.id },
      actor,
    );
    expect(after.title).toBe("Handbook");
    expect(serializeDocumentBody(markdownContent(after))).toContain(
      "Alpha body with token here.",
    );
  });

  it("rejects an ambiguous match and a stale base without writing", async () => {
    const { db, project, actor, document, base } = await seedDocument("deny");
    await expect(
      applyMcpOperation(db, actor, {
        idempotencyKey: "patch-ambiguous",
        toolName: "patch_document",
        summary: "no",
        operation: {
          kind: "document.patch",
          projectId: project.id,
          documentId: document.id,
          baseCommitSha: base,
          actions: [{ action: "replace_text", find: "body", replace: "x" }],
        },
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { reason: "AMBIGUOUS_MATCH" },
    });
    await expect(
      applyMcpOperation(db, actor, {
        idempotencyKey: "patch-stale",
        toolName: "patch_document",
        summary: "no",
        operation: {
          kind: "document.patch",
          projectId: project.id,
          documentId: document.id,
          baseCommitSha: "0".repeat(40),
          actions: [{ action: "replace_text", find: "token", replace: "x" }],
        },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const after = await getDocument(
      db,
      { projectId: project.id, documentId: document.id },
      actor,
    );
    expect(after.baseCommitSha).toBe(base);
  });

  it("recovers the document id when the write acknowledgement is lost", async () => {
    const { db, project, actor, document, base } = await seedDocument("replay");
    const input = {
      idempotencyKey: "patch-replay-0001",
      toolName: "patch_document",
      summary: "Rename the token once",
      operation: {
        kind: "document.patch" as const,
        projectId: project.id,
        documentId: document.id,
        baseCommitSha: base,
        actions: [
          { action: "replace_text" as const, find: "token", replace: "WORD" },
        ],
      },
    };
    const spy = vi
      .spyOn(db.mcpOperation, "create")
      .mockRejectedValueOnce(new Error("ack failed"));
    await expect(applyMcpOperation(db, actor, input)).rejects.toThrow(
      "ack failed",
    );
    spy.mockRestore();
    const replay = await applyMcpOperation(db, actor, input);
    expect(replay.resourceId).toBe(document.id);
    expect(replay.commitSha).toMatch(/^[0-9a-f]{40}$/);
    const after = await getDocument(
      db,
      { projectId: project.id, documentId: document.id },
      actor,
    );
    expect(after.baseCommitSha).toBe(replay.commitSha);
    expect(
      serializeDocumentBody(markdownContent(after)).match(/WORD/g)?.length,
    ).toBe(1);
  });

  it("refuses a patch whose result exceeds the markdown limit", async () => {
    const { db, project, actor, document, base } = await seedDocument("huge");
    await expect(
      applyMcpOperation(db, actor, {
        idempotencyKey: "patch-too-large",
        toolName: "patch_document",
        summary: "no",
        operation: {
          kind: "document.patch",
          projectId: project.id,
          documentId: document.id,
          baseCommitSha: base,
          actions: [{ action: "append", text: "z".repeat(MAX_MARKDOWN_CHARS) }],
        },
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { reason: "PAYLOAD_TOO_LARGE" },
    });
    const after = await getDocument(
      db,
      { projectId: project.id, documentId: document.id },
      actor,
    );
    expect(after.baseCommitSha).toBe(base);
  });

  it("rejects a patch that changes nothing", async () => {
    const { db, project, actor, document, base } = await seedDocument("empty");
    await expect(
      applyMcpOperation(db, actor, {
        idempotencyKey: "patch-empty",
        toolName: "patch_document",
        summary: "no",
        operation: {
          kind: "document.patch",
          projectId: project.id,
          documentId: document.id,
          baseCommitSha: base,
          actions: [],
        },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("table.change", () => {
  const NAME = "11111111-1111-4111-8111-111111111111";
  const STAGE = "22222222-2222-4222-8222-222222222222";
  const OPT_NEW = "33333333-3333-4333-8333-333333333333";
  const OPT_DONE = "44444444-4444-4444-8444-444444444444";
  const ROW_ANN = "55555555-5555-4555-8555-555555555555";
  const ROW_BO = "66666666-6666-4666-8666-666666666666";

  async function seedTable(suffix: string) {
    const ctx = await editorProject(suffix);
    const created = await createTable(
      ctx.db,
      {
        projectId: ctx.project.id,
        folderPath: [],
        title: "Backlog",
        columns: [
          { id: NAME, name: "Name", type: "text" },
          {
            id: STAGE,
            name: "Stage",
            type: "select",
            options: [
              { id: OPT_NEW, label: "New" },
              { id: OPT_DONE, label: "Done" },
            ],
          },
        ],
        rows: [
          { id: ROW_ANN, cells: { [NAME]: "Ann", [STAGE]: OPT_NEW } },
          { id: ROW_BO, cells: { [NAME]: "Bo", [STAGE]: OPT_DONE } },
        ],
      },
      ctx.actor,
    );
    const head = await getTable(
      ctx.db,
      { projectId: ctx.project.id, tableId: created.id },
      ctx.actor,
    );
    return { ...ctx, table: created, base: head.baseCommitSha };
  }

  it("commits a title change, a retype and its conversions as one revision", async () => {
    const { db, project, actor, table, base } = await seedTable("combined");
    const result = await applyMcpOperation(db, actor, {
      idempotencyKey: "change-1",
      toolName: "change_table",
      summary: "Rework the backlog",
      operation: {
        kind: "table.change",
        projectId: project.id,
        tableId: table.id,
        baseCommitSha: base,
        title: "Roadmap",
        columns: [{ op: "retype", columnId: NAME, type: "number" }],
        rows: {
          inserts: [],
          updates: [
            { rowId: ROW_ANN, set: { [NAME]: 1 } },
            { rowId: ROW_BO, set: { [NAME]: 2 } },
          ],
          deletes: [],
        },
      },
    });
    const after = await getTable(
      db,
      { projectId: project.id, tableId: table.id },
      actor,
    );
    expect(after.title).toBe("Roadmap");
    expect(after.columns[0]!.type).toBe("number");
    expect(after.rows.map((row) => row.cells[NAME])).toEqual([1, 2]);
    expect(after.baseCommitSha).toBe(result.commitSha);
  });

  it("clears only the named cells", async () => {
    const { db, project, actor, table, base } = await seedTable("clear");
    await applyMcpOperation(db, actor, {
      idempotencyKey: "change-clear",
      toolName: "change_table",
      summary: "Unset the stage",
      operation: {
        kind: "table.change",
        projectId: project.id,
        tableId: table.id,
        baseCommitSha: base,
        columns: [],
        rows: {
          inserts: [],
          updates: [{ rowId: ROW_ANN, clear: [STAGE] }],
          deletes: [],
        },
      },
    });
    const after = await getTable(
      db,
      { projectId: project.id, tableId: table.id },
      actor,
    );
    expect(after.rows[0]!.cells).toEqual({ [NAME]: "Ann" });
    expect(after.rows[1]!.cells).toEqual({ [NAME]: "Bo", [STAGE]: OPT_DONE });
  });

  it("writes nothing when the final state is invalid", async () => {
    const { db, project, actor, table, base } = await seedTable("invalid");
    await expect(
      applyMcpOperation(db, actor, {
        idempotencyKey: "change-invalid",
        toolName: "change_table",
        summary: "no",
        operation: {
          kind: "table.change",
          projectId: project.id,
          tableId: table.id,
          baseCommitSha: base,
          columns: [{ op: "retype", columnId: NAME, type: "number" }],
          rows: { inserts: [], updates: [], deletes: [] },
        },
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { reason: "INVALID_FINAL_STATE" },
    });
    const after = await getTable(
      db,
      { projectId: project.id, tableId: table.id },
      actor,
    );
    expect(after.baseCommitSha).toBe(base);
    expect(after.columns[0]!.type).toBe("text");
  });

  it("rejects a change that does nothing", async () => {
    const { db, project, actor, table, base } = await seedTable("nowork");
    await expect(
      applyMcpOperation(db, actor, {
        idempotencyKey: "change-nowork",
        toolName: "change_table",
        summary: "no",
        operation: {
          kind: "table.change",
          projectId: project.id,
          tableId: table.id,
          baseCommitSha: base,
          columns: [],
          rows: { inserts: [], updates: [], deletes: [] },
        },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const after = await getTable(
      db,
      { projectId: project.id, tableId: table.id },
      actor,
    );
    expect(after.baseCommitSha).toBe(base);
  });

  it("refuses a retype to select that leaves the column without options", async () => {
    const { db, project, actor, table, base } = await seedTable("shape");
    await expect(
      applyMcpOperation(db, actor, {
        idempotencyKey: "change-shape",
        toolName: "change_table",
        summary: "no",
        operation: {
          kind: "table.change",
          projectId: project.id,
          tableId: table.id,
          baseCommitSha: base,
          columns: [{ op: "retype", columnId: NAME, type: "select" }],
          rows: {
            inserts: [],
            updates: [
              { rowId: ROW_ANN, clear: [NAME] },
              { rowId: ROW_BO, clear: [NAME] },
            ],
            deletes: [],
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { reason: "INVALID_FINAL_STATE" },
    });
    const after = await getTable(
      db,
      { projectId: project.id, tableId: table.id },
      actor,
    );
    expect(after.baseCommitSha).toBe(base);
    expect(after.columns[0]!.type).toBe("text");
  });

  it("refuses a stale base", async () => {
    const { db, project, actor, table } = await seedTable("stale");
    await expect(
      applyMcpOperation(db, actor, {
        idempotencyKey: "change-stale",
        toolName: "change_table",
        summary: "no",
        operation: {
          kind: "table.change",
          projectId: project.id,
          tableId: table.id,
          baseCommitSha: "0".repeat(40),
          columns: [],
          rows: {
            inserts: [],
            updates: [{ rowId: ROW_ANN, set: { [NAME]: "x" } }],
            deletes: [],
          },
        },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("adds a multiselect column with options and inserts a row using several of them", async () => {
    const { db, project, actor, table, base } =
      await seedTable("multiselect-add");
    const TAGS = "77777777-7777-4777-8777-777777777777";
    const OPT_A = "88888888-8888-4888-8888-888888888888";
    const OPT_B = "99999999-9999-4999-8999-999999999999";
    const ROW_CY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await applyMcpOperation(db, actor, {
      idempotencyKey: "change-multiselect-add",
      toolName: "change_table",
      summary: "Add tags",
      operation: {
        kind: "table.change",
        projectId: project.id,
        tableId: table.id,
        baseCommitSha: base,
        columns: [
          {
            op: "add",
            column: {
              id: TAGS,
              name: "Tags",
              type: "multiselect",
              options: [
                { id: OPT_A, label: "Urgent" },
                { id: OPT_B, label: "Blocked" },
              ],
            },
          },
        ],
        rows: {
          inserts: [
            {
              id: ROW_CY,
              cells: { [NAME]: "Cy", [TAGS]: [OPT_A, OPT_B] },
            },
          ],
          updates: [],
          deletes: [],
        },
      },
    });
    const after = await getTable(
      db,
      { projectId: project.id, tableId: table.id },
      actor,
    );
    expect(after.columns.find((c) => c.id === TAGS)).toMatchObject({
      type: "multiselect",
      options: [
        { id: OPT_A, label: "Urgent" },
        { id: OPT_B, label: "Blocked" },
      ],
    });
    const row = after.rows.find((r) => r.id === ROW_CY);
    expect(row?.cells[TAGS]).toEqual([OPT_A, OPT_B]);
  });

  it("retypes select to multiselect with explicit cell updates, keeping the options", async () => {
    const { db, project, actor, table, base } =
      await seedTable("select-to-multi");
    await applyMcpOperation(db, actor, {
      idempotencyKey: "change-retype-multiselect",
      toolName: "change_table",
      summary: "Allow several stages",
      operation: {
        kind: "table.change",
        projectId: project.id,
        tableId: table.id,
        baseCommitSha: base,
        columns: [{ op: "retype", columnId: STAGE, type: "multiselect" }],
        rows: {
          inserts: [],
          updates: [
            { rowId: ROW_ANN, set: { [STAGE]: [OPT_NEW] } },
            { rowId: ROW_BO, set: { [STAGE]: [OPT_DONE] } },
          ],
          deletes: [],
        },
      },
    });
    const after = await getTable(
      db,
      { projectId: project.id, tableId: table.id },
      actor,
    );
    const stageColumn = after.columns.find((c) => c.id === STAGE);
    expect(stageColumn?.type).toBe("multiselect");
    expect(stageColumn?.options).toEqual([
      { id: OPT_NEW, label: "New" },
      { id: OPT_DONE, label: "Done" },
    ]);
    expect(after.rows.find((r) => r.id === ROW_ANN)?.cells[STAGE]).toEqual([
      OPT_NEW,
    ]);
    expect(after.rows.find((r) => r.id === ROW_BO)?.cells[STAGE]).toEqual([
      OPT_DONE,
    ]);
  });
});

describe("navigate_document", () => {
  async function run(
    input: Record<string, unknown>,
    ctx: Awaited<ReturnType<typeof editorProject>>,
  ) {
    const { navigateDocumentTool } =
      await import("@weaver/assistant-tools/tools/navigate");
    const scope = await resolveScopeSnapshot(ctx.db, ctx.actor, {
      kind: "project",
      projectId: ctx.project.id,
    });
    return navigateDocumentTool.execute(
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

  async function seed(suffix: string, markdown: string = MD) {
    const ctx = await editorProject(suffix);
    const created = await createDocument(
      ctx.db,
      {
        projectId: ctx.project.id,
        folderPath: [],
        title: "Guide",
        content: {
          kind: "markdown",
          contentJson: (
            await import("@weaver/core/editor/markdown")
          ).parseDocumentBody(markdown),
        },
      },
      ctx.actor,
    );
    return { ctx, documentId: created.id };
  }

  it("lists headings with ids, depths and revisions", async () => {
    const { ctx, documentId } = await seed("outline");
    const { output } = (await run(
      { projectId: ctx.project.id, documentId, mode: "outline" },
      ctx,
    )) as { output: Record<string, unknown> };
    expect(output.sections).toEqual([
      { id: "section-alpha", heading: "Alpha", depth: 1 },
      { id: "section-alpha--beta", heading: "Beta", depth: 2 },
    ]);
    expect(output.snapshotCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(output.baseCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(output.hasMore).toBe(false);
    expect(output.nextCursor).toBeNull();
  });

  it("reads one section including its descendants", async () => {
    const { ctx, documentId } = await seed("section");
    const { output } = (await run(
      {
        projectId: ctx.project.id,
        documentId,
        mode: "section",
        sectionId: "section-alpha",
      },
      ctx,
    )) as { output: Record<string, unknown> };
    expect(output.heading).toBe("Alpha");
    expect(String(output.text)).toContain("## Beta");
    expect(String(output.text)).toContain("Beta body.");
  });

  it("finds literal text and reports the containing section", async () => {
    const { ctx, documentId } = await seed("find");
    const { output } = (await run(
      { projectId: ctx.project.id, documentId, mode: "find", find: "token" },
      ctx,
    )) as { output: Record<string, unknown> };
    expect(output.total).toBe(1);
    expect(
      (output.matches as { sectionId: string | null }[])[0]!.sectionId,
    ).toBe("section-alpha");
  });

  it("cites the section it read, with the ancestor heading path as the label", async () => {
    const { ctx, documentId } = await seed("cite-section");
    const outcome = await run(
      {
        projectId: ctx.project.id,
        documentId,
        mode: "section",
        sectionId: "section-alpha--beta",
      },
      ctx,
    );
    const { baseCommitSha } = outcome.output as { baseCommitSha: string };
    expect(outcome.citations).toEqual([
      {
        kind: "document",
        projectId: ctx.project.id,
        documentId,
        commitSha: baseCommitSha,
        headingPath: ["Alpha", "Beta"],
        excerpt: null,
      },
    ]);
    const validated = await validateSourceLocators(
      ctx.db,
      ctx.actor,
      outcome.citations!,
    );
    expect(validated).toHaveLength(1);
    expect(validated[0]).toMatchObject({
      kind: "document",
      resourceId: documentId,
      commitSha: baseCommitSha,
      label: "Guide › Alpha › Beta",
    });
  });

  it("cites each distinct section a find matched, and nothing for an outline", async () => {
    const { ctx, documentId } = await seed(
      "cite-find",
      `${MD}\nBeta token again, and one more token.\n`,
    );
    const outcome = await run(
      { projectId: ctx.project.id, documentId, mode: "find", find: "token" },
      ctx,
    );
    const output = outcome.output as {
      baseCommitSha: string;
      matches: { sectionId: string | null; excerpt: string }[];
    };
    expect(output.matches.map((match) => match.sectionId)).toEqual([
      "section-alpha",
      "section-alpha--beta",
      "section-alpha--beta",
    ]);
    expect(outcome.citations).toEqual([
      {
        kind: "document",
        projectId: ctx.project.id,
        documentId,
        commitSha: output.baseCommitSha,
        headingPath: ["Alpha"],
        excerpt: output.matches[0]!.excerpt,
      },
      {
        kind: "document",
        projectId: ctx.project.id,
        documentId,
        commitSha: output.baseCommitSha,
        headingPath: ["Alpha", "Beta"],
        excerpt: output.matches[1]!.excerpt,
      },
    ]);
    const validated = await validateSourceLocators(
      ctx.db,
      ctx.actor,
      outcome.citations!,
    );
    expect(validated.map((citation) => citation.label)).toEqual([
      "Guide › Alpha",
      "Guide › Alpha › Beta",
    ]);

    const outline = await run(
      { projectId: ctx.project.id, documentId, mode: "outline" },
      ctx,
    );
    expect(outline.citations).toBeUndefined();
  });

  const BIG_SECTION_BODY = Array.from(
    { length: 60 },
    (_, i) => `Filler paragraph ${i} ${"y".repeat(140)}`,
  ).join("\n\n");
  const ITEM_COUNT = 150;
  const TOKEN_HITS = 25;
  const PAGED_MD = [
    "# Paged",
    "",
    "## Big",
    "",
    BIG_SECTION_BODY,
    "",
    ...Array.from(
      { length: ITEM_COUNT },
      (_, i) =>
        `## Item ${String(i).padStart(3, "0")}\n\nBody ${i} with ${
          i < TOKEN_HITS ? "needle" : "plain"
        } text.\n`,
    ),
  ].join("\n");
  const PAGED_SECTIONS = ITEM_COUNT + 2;

  /** Walks every page of one navigate mode, proving each nonterminal page
   * advances (non-empty and a strictly different cursor) and that it ends. */
  async function walk(
    ctx: Awaited<ReturnType<typeof editorProject>>,
    input: Record<string, unknown>,
    itemsOf: (output: Record<string, unknown>) => unknown[],
  ) {
    let cursor: string | undefined;
    const pages: unknown[][] = [];
    for (let guard = 0; guard <= 20; guard++) {
      expect(guard).toBeLessThan(20);
      const { output } = (await run(
        cursor === undefined ? input : { ...input, cursor },
        ctx,
      )) as { output: Record<string, unknown> };
      const items = itemsOf(output);
      pages.push(items);
      if (!output.hasMore) {
        expect(output.nextCursor).toBeNull();
        break;
      }
      // The defect this guards: a page that keeps nothing while hasMore is
      // true hands back the cursor it was given and the reader never moves.
      expect(items.length).toBeGreaterThan(0);
      expect(typeof output.nextCursor).toBe("string");
      expect(output.nextCursor).not.toBe(cursor ?? null);
      cursor = output.nextCursor as string;
    }
    expect(pages.length).toBeGreaterThan(1);
    return pages;
  }

  it("advances the outline cursor across every page", async () => {
    const { ctx, documentId } = await seed("outline-pages", PAGED_MD);
    const pages = await walk(
      ctx,
      { projectId: ctx.project.id, documentId, mode: "outline" },
      (output) => output.sections as unknown[],
    );
    const ids = pages.flat().map((section) => (section as { id: string }).id);
    expect(ids).toHaveLength(PAGED_SECTIONS);
    expect(new Set(ids).size).toBe(PAGED_SECTIONS);
  });

  it("advances the section cursor across every chunk", async () => {
    const { ctx, documentId } = await seed("section-pages", PAGED_MD);
    const pages = await walk(
      ctx,
      {
        projectId: ctx.project.id,
        documentId,
        mode: "section",
        sectionId: "section-paged--big",
      },
      (output) => (output.text ? [output.text as string] : []),
    );
    const text = pages.flat().join("");
    expect(text.startsWith("## Big")).toBe(true);
    expect(text).toContain("Filler paragraph 59");
    expect(text).not.toContain("## Item 000");
  });

  it("advances the find cursor across every page", async () => {
    const { ctx, documentId } = await seed("find-pages", PAGED_MD);
    const pages = await walk(
      ctx,
      { projectId: ctx.project.id, documentId, mode: "find", find: "needle" },
      (output) => output.matches as unknown[],
    );
    expect(pages.flat()).toHaveLength(TOKEN_HITS);
  });

  it("rejects an unknown section id", async () => {
    const { ctx, documentId } = await seed("missing");
    await expect(
      run(
        {
          projectId: ctx.project.id,
          documentId,
          mode: "section",
          sectionId: "section-nope",
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("precise-edit proposals", () => {
  const NAME = "11111111-1111-4111-8111-111111111111";
  const STAGE = "22222222-2222-4222-8222-222222222222";
  const OPT_NEW = "33333333-3333-4333-8333-333333333333";
  const ROW_ANN = "55555555-5555-4555-8555-555555555555";
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  type PreviewLine = { type: string; text: string };

  async function proposalCtx(suffix: string) {
    const ctx = await editorProject(suffix);
    const conversation = await createConversation(ctx.db, ctx.actor, {});
    const { run } = await submitUserMessage(ctx.db, ctx.actor, {
      conversationId: conversation.id,
      text: "propose",
      scope: { kind: "project", projectId: ctx.project.id },
    });
    return { ...ctx, conversation, run };
  }

  async function withDocument(suffix: string) {
    const ctx = await proposalCtx(suffix);
    const created = await createDocument(
      ctx.db,
      {
        projectId: ctx.project.id,
        folderPath: [],
        title: "Guide",
        content: { kind: "markdown", contentJson: parseDocumentBody(MD) },
      },
      ctx.actor,
    );
    const head = await getDocument(
      ctx.db,
      { projectId: ctx.project.id, documentId: created.id },
      ctx.actor,
    );
    return { ...ctx, document: created, base: head.baseCommitSha };
  }

  async function withTable(suffix: string) {
    const ctx = await proposalCtx(suffix);
    const created = await createTable(
      ctx.db,
      {
        projectId: ctx.project.id,
        folderPath: [],
        title: "Backlog",
        columns: [
          { id: NAME, name: "Name", type: "text" },
          {
            id: STAGE,
            name: "Stage",
            type: "select",
            options: [{ id: OPT_NEW, label: "New" }],
          },
        ],
        rows: [{ id: ROW_ANN, cells: { [NAME]: "Ann", [STAGE]: OPT_NEW } }],
      },
      ctx.actor,
    );
    const head = await getTable(
      ctx.db,
      { projectId: ctx.project.id, tableId: created.id },
      ctx.actor,
    );
    return { ...ctx, table: created, base: head.baseCommitSha };
  }

  it("commits exactly the generated table ids the preview showed", async () => {
    const ctx = await withTable("normalize");
    const proposal = await createProposal(ctx.db, ctx.actor, {
      conversationId: ctx.conversation.id,
      runId: ctx.run.id,
      summary: "Extend the backlog",
      operation: {
        kind: "table.change",
        projectId: ctx.project.id,
        tableId: ctx.table.id,
        baseCommitSha: ctx.base,
        columns: [
          { op: "add", column: { name: "Owner", type: "text" } },
          { op: "option_add", columnId: STAGE, option: { label: "Blocked" } },
        ],
        rows: {
          inserts: [{ cells: { [NAME]: "Cy" } }],
          updates: [],
          deletes: [],
        },
      },
    });
    const stored = (
      await ctx.db.assistantProposal.findUniqueOrThrow({
        where: { id: proposal.id },
        select: { operation: true },
      })
    ).operation as {
      columns: (
        | { op: "add"; column: { id: string; name: string } }
        | { op: "option_add"; option: { id: string; label: string } }
      )[];
      rows: { inserts: { id: string }[] };
    };
    const added = stored.columns[0] as { column: { id: string } };
    const optionAdd = stored.columns[1] as { option: { id: string } };
    const ownerId = added.column.id;
    const optionId = optionAdd.option.id;
    const rowId = stored.rows.inserts[0]!.id;
    for (const id of [ownerId, optionId, rowId]) expect(id).toMatch(UUID_RE);

    const preview = proposal.preview as {
      columns: { id: string; name: string; options?: { id: string }[] }[];
    };
    expect(preview.columns.find((c) => c.name === "Owner")!.id).toBe(ownerId);
    expect(
      preview.columns.find((c) => c.id === STAGE)!.options!.map((o) => o.id),
    ).toContain(optionId);

    await acceptProposal(ctx.db, ctx.actor, proposal.id);
    const after = await getTable(
      ctx.db,
      { projectId: ctx.project.id, tableId: ctx.table.id },
      ctx.actor,
    );
    expect(after.columns.map((c) => c.id)).toContain(ownerId);
    expect(
      after.columns.find((c) => c.id === STAGE)!.options!.map((o) => o.id),
    ).toContain(optionId);
    expect(after.rows.map((r) => r.id)).toContain(rowId);
    // Re-normalising the persisted operation must be a no-op.
    const reread = (
      await ctx.db.assistantProposal.findUniqueOrThrow({
        where: { id: proposal.id },
        select: { operation: true },
      })
    ).operation;
    expect(reread).toEqual(stored);
  });

  it("rejects a table change that does nothing at proposal time", async () => {
    const ctx = await withTable("nowork");
    await expect(
      createProposal(ctx.db, ctx.actor, {
        conversationId: ctx.conversation.id,
        runId: ctx.run.id,
        summary: "no",
        operation: {
          kind: "table.change",
          projectId: ctx.project.id,
          tableId: ctx.table.id,
          baseCommitSha: ctx.base,
          columns: [],
          rows: { inserts: [], updates: [], deletes: [] },
        },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(
      await ctx.db.assistantProposal.count({ where: { runId: ctx.run.id } }),
    ).toBe(0);
  });

  it("rejects an unshapeable final column state at proposal time", async () => {
    const ctx = await withTable("shape");
    await expect(
      createProposal(ctx.db, ctx.actor, {
        conversationId: ctx.conversation.id,
        runId: ctx.run.id,
        summary: "no",
        operation: {
          kind: "table.change",
          projectId: ctx.project.id,
          tableId: ctx.table.id,
          baseCommitSha: ctx.base,
          columns: [{ op: "retype", columnId: NAME, type: "select" }],
          rows: {
            inserts: [],
            updates: [{ rowId: ROW_ANN, clear: [NAME] }],
            deletes: [],
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { reason: "INVALID_FINAL_STATE" },
    });
  });

  it("rejects an oversized patch at proposal time", async () => {
    const ctx = await withDocument("huge");
    await expect(
      createProposal(ctx.db, ctx.actor, {
        conversationId: ctx.conversation.id,
        runId: ctx.run.id,
        summary: "no",
        operation: {
          kind: "document.patch",
          projectId: ctx.project.id,
          documentId: ctx.document.id,
          baseCommitSha: ctx.base,
          actions: [{ action: "append", text: "z".repeat(MAX_MARKDOWN_CHARS) }],
        },
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { reason: "PAYLOAD_TOO_LARGE" },
    });
    expect(
      await ctx.db.assistantProposal.count({ where: { runId: ctx.run.id } }),
    ).toBe(0);
  });

  it("shows a title-only patch as a title change", async () => {
    const ctx = await withDocument("title-preview");
    const proposal = await createProposal(ctx.db, ctx.actor, {
      conversationId: ctx.conversation.id,
      runId: ctx.run.id,
      summary: "Rename",
      operation: {
        kind: "document.patch",
        projectId: ctx.project.id,
        documentId: ctx.document.id,
        baseCommitSha: ctx.base,
        title: "Handbook",
        actions: [],
      },
    });
    const preview = proposal.preview as {
      kind: string;
      lines: PreviewLine[];
    };
    expect(preview.kind).toBe("document");
    expect(preview.lines.length).toBeGreaterThan(0);
    expect(preview.lines).toEqual(
      expect.arrayContaining([
        { type: "del", text: "Title: Guide" },
        { type: "add", text: "Title: Handbook" },
      ]),
    );
    await acceptProposal(ctx.db, ctx.actor, proposal.id);
    const after = await getDocument(
      ctx.db,
      { projectId: ctx.project.id, documentId: ctx.document.id },
      ctx.actor,
    );
    expect(after.title).toBe("Handbook");
  });

  it("previews the canonical representation the commit will store", async () => {
    const ctx = await withDocument("canonical");
    const proposal = await createProposal(ctx.db, ctx.actor, {
      conversationId: ctx.conversation.id,
      runId: ctx.run.id,
      summary: "Add a loose bullet",
      operation: {
        kind: "document.patch",
        projectId: ctx.project.id,
        documentId: ctx.document.id,
        baseCommitSha: ctx.base,
        actions: [{ action: "append", text: "\n*   Loose item\n" }],
      },
    });
    const preview = proposal.preview as { lines: PreviewLine[] };
    const added = preview.lines
      .filter((line) => line.type === "add")
      .map((line) => line.text);
    expect(added).toContain("- Loose item");
    expect(added).not.toContain("*   Loose item");
    await acceptProposal(ctx.db, ctx.actor, proposal.id);
    const after = await getDocument(
      ctx.db,
      { projectId: ctx.project.id, documentId: ctx.document.id },
      ctx.actor,
    );
    const markdown = serializeDocumentBody(markdownContent(after));
    expect(markdown).toContain("- Loose item");
    expect(markdown).not.toContain("*   Loose item");
  });
});

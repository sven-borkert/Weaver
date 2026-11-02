import { randomUUID } from "node:crypto";
import simpleGit from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import { registerKnowledgeJobHandlers } from "@weaver/core/jobs/runtime";
import { knowledgeSystemContextForTests } from "@weaver/core/jobs/systemContext";
import { parseKnowledgeConfig } from "@weaver/core/knowledge/config";
import { listDeletedContent } from "@weaver/core/services/contentRecovery";
import { withProjectRepo } from "@weaver/core/services/projectRepo";
import {
  executeWikiRevert,
  startRevert,
} from "@weaver/core/services/wikiRevert";
import { rollingDestructiveChars } from "@weaver/core/services/wikiRunSession";
import { getRun, listRuns } from "@weaver/core/services/wikiRunViews";
import { endRun, type LeasedWikiRun } from "@weaver/core/services/wikiRuns";
import { disableWiki, revokeAgent } from "@weaver/core/services/wikiSettings";
import {
  addMembership,
  callerFor,
  makeUser,
  noKnowledgeRouting,
  resetDb,
  securityContextFor,
} from "./_harness";
import {
  humanEdit,
  humanPage,
  queuedRun,
  startedRun,
  wikiProject,
  type WikiProject,
} from "./_wikiRunHarness";

const created = {
  folderPath: [],
  title: "Created by the run",
  markdown: "# Created\n\nBody.\n",
  properties: { type: "summary", summary: "Summary" },
};

async function finish(p: WikiProject, lease: LeasedWikiRun) {
  await endRun(p.db, lease.id, ["running"], {
    status: "succeeded",
    leaseToken: lease.leaseToken,
    note: "ended",
  });
}

/** A finished run that created one page and patched one human page. */
async function finishedRun(p: WikiProject) {
  const human = await humanPage(p, "Human page", "Original words.");
  const run = await startedRun(p);
  await run.call("read_input", { id: run.items[0]!.id });
  const page = await run.call("wiki_create_page", created);
  const patched = await run.call("wiki_patch_page", {
    documentId: human.id,
    baseCommitSha: human.headCommitSha,
    actions: [{ action: "append", text: "Agent line." }],
    properties: { type: "topic", summary: "Set by the agent" },
  });
  await run.call("complete_input", {
    id: run.items[0]!.id,
    outcome: "integrated",
    note: "Done.",
  });
  await finish(p, run.lease);
  return { ...run, human, page, patched };
}

async function revert(p: WikiProject, runId: string) {
  const started = await startRevert(p.db, p.security, {
    projectId: p.projectId,
    runId,
  });
  await executeWikiRevert(p.db, started.runId, { workerId: "spec" });
  return p.db.wikiRun.findUniqueOrThrow({ where: { id: started.runId } });
}

const bodyOf = (p: WikiProject, path: string) =>
  withProjectRepo(p.projectId, (repo) => repo.readFileFromWorktree(path));

describe("wiki revert", () => {
  beforeEach(async () => {
    await resetDb();
    setJobQueueForTests(new FakeJobQueue());
  }, 60_000);
  afterEach(() => setJobQueueForTests(null));

  it("deletes created pages, restores patched ones with their old properties and marks items", async () => {
    const p = await wikiProject();
    const r = await finishedRun(p);
    const source = await p.db.document.findUniqueOrThrow({
      where: { id: r.items[0]!.sourceDocumentId! },
    });
    const done = await revert(p, r.lease.id);
    expect(done).toMatchObject({
      status: "succeeded",
      kind: "revert",
      revertsRunId: r.lease.id,
      startedById: p.owner.id,
    });
    expect(done.report).toEqual({
      restored: [r.human.id],
      deleted: [r.page.documentId],
      skipped: [],
    });

    expect(
      await p.db.document.findUnique({ where: { id: r.page.documentId } }),
    ).toBeNull();
    const deleted = await listDeletedContent(
      p.db,
      { projectId: p.projectId, limit: 20 },
      p.security,
    );
    expect(JSON.stringify(deleted.items)).toContain(r.page.documentId);

    const restored = await p.db.document.findUniqueOrThrow({
      where: { id: r.human.id },
    });
    expect(restored).toMatchObject({
      wikiType: null,
      wikiSummary: null,
      wikiSources: null,
      reviewExempt: false,
    });
    const body = await bodyOf(p, restored.path);
    expect(body).toContain("Original words.");
    expect(body).not.toContain("Agent line.");
    expect(body).not.toContain("properties:");

    expect(
      await p.db.document.findUniqueOrThrow({ where: { id: source.id } }),
    ).toMatchObject({ headCommitSha: source.headCommitSha });
    const item = await p.db.wikiInputItem.findUniqueOrThrow({
      where: { id: r.items[0]!.id },
    });
    expect(item.status).toBe("reverted");
    expect(item.outcomeNote).toContain("reverted");
  }, 60_000);

  it("keeps a page's earlier properties and exemption when restoring", async () => {
    const p = await wikiProject();
    const first = await startedRun(p);
    await first.call("read_input", { id: first.items[0]!.id });
    const page = await first.call("wiki_create_page", created);
    const before = await p.db.document.findUniqueOrThrow({
      where: { id: page.documentId },
    });
    await first.call("complete_input", {
      id: first.items[0]!.id,
      outcome: "integrated",
      note: "Done.",
    });
    await finish(p, first.lease);
    const second = await startedRun(p, ["Second note"]);
    await second.call("read_input", { id: second.items[0]!.id });
    await second.call("wiki_patch_page", {
      documentId: page.documentId,
      baseCommitSha: page.baseCommitSha,
      actions: [{ action: "append", text: "Second." }],
      properties: { summary: "Changed" },
    });
    await finish(p, second.lease);
    await revert(p, second.lease.id);
    expect(
      await p.db.document.findUniqueOrThrow({ where: { id: page.documentId } }),
    ).toMatchObject({
      wikiSummary: "Summary",
      reviewExempt: true,
      wikiSources: before.wikiSources,
    });
  }, 60_000);

  it("is authored by the Editor with no agent trailer or run id", async () => {
    const p = await wikiProject();
    const r = await finishedRun(p);
    const done = await revert(p, r.lease.id);
    const path = (
      await p.db.document.findUniqueOrThrow({ where: { id: r.human.id } })
    ).path;
    const [entry] = await withProjectRepo(p.projectId, (repo) =>
      repo.logForPath(path, { skip: 0, limit: 1 }),
    );
    expect(entry).toMatchObject({
      trustedAuthor: true,
      wikiAgentId: null,
      runId: null,
      userId: p.owner.id,
    });
    expect(entry!.operationId).toMatch(
      new RegExp(`^wiki-revert:${done.id}:\\d{4}$`),
    );
    expect(entry!.wikiRequestHash).toMatch(/^[0-9a-f]{64}$/);
    const row = await p.db.document.findUniqueOrThrow({
      where: { id: r.human.id },
    });
    expect(row).toMatchObject({
      lastEditedById: p.owner.id,
      lastEditedByMachineKind: null,
    });
  }, 60_000);

  it("skips and lists a page a human edited after the run", async () => {
    const p = await wikiProject();
    const r = await finishedRun(p);
    await humanEdit(p, r.page.documentId, "# Created\n\nHuman edit.\n");
    const done = await revert(p, r.lease.id);
    expect(done.report).toMatchObject({
      restored: [r.human.id],
      deleted: [],
      skipped: [{ documentId: r.page.documentId, reason: "edited_after_run" }],
    });
    const kept = await p.db.document.findUniqueOrThrow({
      where: { id: r.page.documentId },
    });
    expect(await bodyOf(p, kept.path)).toContain("Human edit.");
  }, 60_000);

  it("only the newest run per page is revertible", async () => {
    const p = await wikiProject();
    const first = await finishedRun(p);
    const second = await startedRun(p, ["Second note"]);
    await second.call("read_input", { id: second.items[0]!.id });
    const page = await p.db.document.findUniqueOrThrow({
      where: { id: first.human.id },
    });
    await second.call("wiki_patch_page", {
      documentId: first.human.id,
      baseCommitSha: page.headCommitSha,
      actions: [{ action: "append", text: "Second line." }],
    });
    await finish(p, second.lease);

    const older = await revert(p, first.lease.id);
    expect(older.report).toMatchObject({
      deleted: [first.page.documentId],
      restored: [],
      skipped: [{ documentId: first.human.id, reason: "later_run" }],
    });

    const newer = await revert(p, second.lease.id);
    expect(newer.report).toMatchObject({ restored: [first.human.id] });
    const body = await bodyOf(p, page.path);
    expect(body).toContain("Agent line.");
    expect(body).not.toContain("Second line.");
  }, 90_000);

  it.each([
    [
      "disabled",
      async (p: WikiProject) => {
        const { revision } = await p.db.projectWikiSettings.findUniqueOrThrow({
          where: { projectId: p.projectId },
        });
        await disableWiki(p.db, p.security, {
          projectId: p.projectId,
          expectedRevision: revision,
        });
      },
    ],
    [
      "revoked",
      async (p: WikiProject) => {
        const { revision } = await p.db.projectWikiSettings.findUniqueOrThrow({
          where: { projectId: p.projectId },
        });
        await revokeAgent(p.db, p.security, {
          projectId: p.projectId,
          expectedRevision: revision,
        });
      },
    ],
    [
      "paused",
      async (p: WikiProject) => {
        await p.db.projectWikiSettings.update({
          where: { projectId: p.projectId },
          data: { destructivePausedAt: new Date() },
        });
      },
    ],
  ])(
    "works while the wiki is %s",
    async (_name, close) => {
      const p = await wikiProject();
      const r = await finishedRun(p);
      await close(p);
      const done = await revert(p, r.lease.id);
      expect(done.status).toBe("succeeded");
      expect(done.report).toMatchObject({
        restored: [r.human.id],
        deleted: [r.page.documentId],
      });
    },
    60_000,
  );

  it("does not count against the 24-hour sum", async () => {
    const p = await wikiProject();
    const r = await finishedRun(p);
    const before = await rollingDestructiveChars(p.db, p.projectId);
    await revert(p, r.lease.id);
    expect(await rollingDestructiveChars(p.db, p.projectId)).toBe(before);
  }, 60_000);

  describe("who and when", () => {
    it("needs an Editor session", async () => {
      const p = await wikiProject();
      const r = await finishedRun(p);
      const viewer = await makeUser("User", "revert-viewer");
      await addMembership(p.projectId, viewer.id, "Viewer");
      await expect(
        startRevert(p.db, securityContextFor(viewer), {
          projectId: p.projectId,
          runId: r.lease.id,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const outsider = await makeUser("User", "revert-outsider");
      await expect(
        startRevert(p.db, securityContextFor(outsider), {
          projectId: p.projectId,
          runId: r.lease.id,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }, 60_000);

    it("refuses a live run, another project's run, a repeat and a revert", async () => {
      const p = await wikiProject();
      const live = await startedRun(p);
      await expect(
        startRevert(p.db, p.security, {
          projectId: p.projectId,
          runId: live.lease.id,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await live.call("read_input", { id: live.items[0]!.id });
      await live.call("wiki_create_page", created);
      await finish(p, live.lease);
      await expect(
        startRevert(p.db, p.security, {
          projectId: p.projectId,
          runId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      const done = await revert(p, live.lease.id);
      await expect(
        startRevert(p.db, p.security, {
          projectId: p.projectId,
          runId: live.lease.id,
        }),
      ).rejects.toMatchObject({ details: { reason: "ALREADY_REVERTED" } });
      await expect(
        startRevert(p.db, p.security, {
          projectId: p.projectId,
          runId: done.id,
        }),
      ).rejects.toMatchObject({ details: { reason: "NOT_REVERTIBLE" } });
    }, 60_000);

    it("shares the one-active-run rule", async () => {
      const p = await wikiProject();
      const r = await finishedRun(p);
      await queuedRun(p, ["Next note"]);
      await expect(
        startRevert(p.db, p.security, {
          projectId: p.projectId,
          runId: r.lease.id,
        }),
      ).rejects.toMatchObject({ details: { reason: "RUN_ACTIVE" } });
    }, 60_000);
  });

  describe("restart", () => {
    it("reconciles a reserved revert write and never writes a page twice", async () => {
      const p = await wikiProject();
      const r = await finishedRun(p);
      const done = await revert(p, r.lease.id);
      const page = await p.db.document.findUniqueOrThrow({
        where: { id: r.human.id },
      });
      const head = await withProjectRepo(p.projectId, (repo) =>
        repo.resolveHead(),
      );
      await p.db.wikiRunOperation.updateMany({
        where: { runId: done.id },
        data: { status: "reserved", commitSha: null, committedAt: null },
      });
      await p.db.wikiRun.update({
        where: { id: done.id },
        data: { status: "queued", endedAt: null, report: undefined },
      });
      await p.db.wikiInputItem.updateMany({
        where: { runId: r.lease.id },
        data: { status: "processed" },
      });
      await executeWikiRevert(p.db, done.id, { workerId: "restart" });
      expect(
        await withProjectRepo(p.projectId, (repo) => repo.resolveHead()),
      ).toBe(head);
      const again = await p.db.wikiRun.findUniqueOrThrow({
        where: { id: done.id },
      });
      expect(again.status).toBe("succeeded");
      expect(again.report).toMatchObject({
        restored: [r.human.id],
        deleted: [r.page.documentId],
      });
      expect(
        await p.db.wikiRunOperation.count({
          where: { runId: done.id, status: "committed" },
        }),
      ).toBe(2);
      expect(page.path).toBeTruthy();
    }, 60_000);

    it("does not trust an unverified commit under a reserved revert id", async () => {
      const p = await wikiProject();
      const r = await finishedRun(p);
      const started = await startRevert(p.db, p.security, {
        projectId: p.projectId,
        runId: r.lease.id,
      });
      const operationId = `wiki-revert:${started.runId}:0001`;
      const hash = "c".repeat(64);
      await p.db.wikiRun.update({
        where: { id: started.runId },
        data: { operationCounter: 1 },
      });
      await p.db.wikiRunOperation.create({
        data: {
          runId: started.runId,
          n: 1,
          toolName: "revert_restore",
          requestHash: hash,
          operationId,
          documentId: r.human.id,
        },
      });
      await withProjectRepo(p.projectId, async (repo) => {
        await repo.writeFileAtomic("forged.md", "forged\n");
        const git = simpleGit(repo.dir);
        await git.add("forged.md");
        await git.raw([
          "-c",
          "user.name=x",
          "-c",
          "user.email=x@example.com",
          "commit",
          "-m",
          `forged\n\nWeaver-Operation-Id: ${operationId}\nWeaver-Wiki-Request-Hash: ${hash}`,
        ]);
      });
      await executeWikiRevert(p.db, started.runId, { workerId: "spec" });
      expect(
        await p.db.wikiRunOperation.findUniqueOrThrow({
          where: { runId_n: { runId: started.runId, n: 1 } },
        }),
      ).toMatchObject({ status: "failed", commitSha: null });
    }, 60_000);
  });

  it("runs from the wiki.run job on a worker without the injected runner", async () => {
    const p = await wikiProject();
    const r = await finishedRun(p);
    const queue = new FakeJobQueue();
    await registerKnowledgeJobHandlers({
      queue,
      context: knowledgeSystemContextForTests(),
      db: p.db,
      config: parseKnowledgeConfig({ WEAVER_JOBS_ENABLED: "true" }),
      routing: noKnowledgeRouting,
      roles: new Set(["wiki"]),
    });
    const started = await startRevert(p.db, p.security, {
      projectId: p.projectId,
      runId: r.lease.id,
    });
    await queue.run("wiki.run", { runId: started.runId });
    expect(
      await p.db.wikiRun.findUniqueOrThrow({ where: { id: started.runId } }),
    ).toMatchObject({ status: "succeeded" });
  }, 60_000);
});

describe("runs tab read model", () => {
  beforeEach(async () => {
    await resetDb();
    setJobQueueForTests(new FakeJobQueue());
  }, 60_000);
  afterEach(() => setJobQueueForTests(null));

  it("lists counts, attributes indexing cost to Maintainers only and verifies commits", async () => {
    const p = await wikiProject();
    const r = await finishedRun(p);
    await p.db.aiUsage.create({
      data: {
        projectId: p.projectId,
        operation: "document_graph_extraction",
        sourceCommitSha: r.page.commitSha,
        provider: "test",
        model: "test",
        configFingerprint: "f",
        durationMs: 1,
        outcome: "success",
        costMicros: 250_000n,
      },
    });
    const editor = await makeUser("User", "runs-editor");
    await addMembership(p.projectId, editor.id, "Editor");
    const viewer = await makeUser("User", "runs-viewer");
    await addMembership(p.projectId, viewer.id, "Viewer");

    const asOwner = await listRuns(p.db, p.security, {
      projectId: p.projectId,
    });
    expect(asOwner.runs[0]).toMatchObject({
      id: r.lease.id,
      kind: "ingest",
      status: "succeeded",
      items: 1,
      pagesCreated: 1,
      pagesPatched: 1,
      indexingCostMicros: 250_000n,
    });
    const asEditor = await listRuns(p.db, securityContextFor(editor), {
      projectId: p.projectId,
    });
    expect(asEditor.runs[0]!.indexingCostMicros).toBeNull();
    const detailForEditor = await getRun(p.db, securityContextFor(editor), {
      projectId: p.projectId,
      runId: r.lease.id,
    });
    expect(detailForEditor.indexingCostMicros).toBeNull();

    const detail = await getRun(p.db, securityContextFor(viewer), {
      projectId: p.projectId,
      runId: r.lease.id,
    });
    expect(detail.commits.map((commit) => commit.verified)).toEqual([
      true,
      true,
    ]);
    expect(detail.revertible).toBe(true);
    expect(detail.summaryByAgent).toBe(true);
    expect(detail.inputs[0]).toMatchObject({ status: "processed" });

    await p.db.wikiRunOperation.update({
      where: { runId_n: { runId: r.lease.id, n: 1 } },
      data: { operationId: `wiki-run:${r.lease.id}:0099` },
    });
    const forged = await getRun(p.db, p.security, {
      projectId: p.projectId,
      runId: r.lease.id,
    });
    expect(forged.commits[0]!.verified).toBe(false);
  }, 60_000);

  it("serves the router by role and hides other projects", async () => {
    const p = await wikiProject();
    const r = await finishedRun(p);
    const viewer = await makeUser("User", "router-viewer");
    await addMembership(p.projectId, viewer.id, "Viewer");
    const outsider = await makeUser("User", "router-outsider");
    const asViewer = callerFor(viewer);
    expect(
      (await asViewer.wiki.runs({ projectId: p.projectId })).runs,
    ).toHaveLength(1);
    await expect(
      asViewer.wiki.revertRun({ projectId: p.projectId, runId: r.lease.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      callerFor(outsider).wiki.runs({ projectId: p.projectId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const other = await wikiProject("Other");
    await expect(
      getRun(other.db, other.security, {
        projectId: other.projectId,
        runId: r.lease.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  }, 60_000);
});

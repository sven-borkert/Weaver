import { randomUUID } from "node:crypto";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeWikiRun } from "@weaver/ai/wikiRunner";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import { classifyPlanDigest } from "@weaver/core/wiki/classifyPlan";
import {
  acceptClassifyPlan,
  executeWikiClassify,
  loadClassifyCandidates,
  readClassifyPlan,
  rejectClassifyPlan,
  startClassify,
} from "@weaver/core/services/wikiClassify";
import {
  cancelRun,
  failRunWithoutRunner,
  leaseWikiRun,
} from "@weaver/core/services/wikiRuns";
import { getRun } from "@weaver/core/services/wikiRunViews";
import {
  expireWikiRunLeases,
  runWikiTick,
} from "@weaver/core/services/wikiTick";
import { startMaintenance } from "@weaver/core/services/wikiLint";
import {
  addMembership,
  makeUser,
  resetDb,
  securityContextFor,
} from "./_harness";
import { deps, seedWikiRoute } from "./_wikiScript";
import {
  humanEdit,
  humanPage,
  wikiProject,
  type WikiProject,
} from "./_wikiRunHarness";
import { createTaskRun } from "./_dashboardFixtures";
import { makeWikiInputItem } from "./_harness";

const USAGE = {
  inputTokens: {
    total: 120,
    noCache: 120,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 40, text: 40, reasoning: undefined },
};

/** A tool-less model call answering with `reply`; records what it was given. */
function replying(reply: (prompt: string) => string) {
  const seen: Array<{ prompt: string; tools: number }> = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      const prompt = JSON.stringify(options.prompt);
      seen.push({ prompt, tools: options.tools?.length ?? 0 });
      return {
        content: [{ type: "text", text: reply(prompt) }],
        finishReason: { unified: "stop", raw: undefined },
        usage: USAGE,
        warnings: [],
      } as never;
    },
  });
  return { model, seen };
}

const proposal = (pages: Array<Record<string, string>>) =>
  JSON.stringify({ pages });

async function pageProps(p: WikiProject, id: string) {
  return p.db.document.findUniqueOrThrow({
    where: { id },
    select: {
      wikiType: true,
      wikiSummary: true,
      headCommitSha: true,
      reviewExempt: true,
    },
  });
}

const row = (p: WikiProject, id: string) =>
  p.db.wikiRun.findUniqueOrThrow({ where: { id } });

describe("classify existing pages", () => {
  beforeEach(async () => {
    await resetDb();
    setJobQueueForTests(new FakeJobQueue());
  }, 60_000);
  afterEach(() => setJobQueueForTests(null));

  it("starts for an Owner only and holds the run in preparing", async () => {
    const p = await wikiProject();
    const maintainer = await makeUser("User", "classify-maint");
    await addMembership(p.projectId, maintainer.id, "Maintainer");
    await expect(
      startClassify(p.db, securityContextFor(maintainer), {
        projectId: p.projectId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const { runId } = await startClassify(p.db, p.security, {
      projectId: p.projectId,
    });
    expect(await row(p, runId)).toMatchObject({
      kind: "classify",
      status: "preparing",
      trigger: "manual",
      startedById: p.owner.id,
      plan: null,
    });
    await expect(
      startClassify(p.db, p.security, { projectId: p.projectId }),
    ).rejects.toMatchObject({ details: { reason: "RUN_ACTIVE" } });
    await expect(
      startMaintenance(p.db, p.security, { projectId: p.projectId }),
    ).rejects.toMatchObject({ details: { reason: "RUN_ACTIVE" } });
    // Only an Owner may cancel a classify run.
    await expect(
      cancelRun(p.db, securityContextFor(maintainer), {
        projectId: p.projectId,
        runId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  }, 60_000);

  it("selects only pages that lack a type or summary and may be classified", async () => {
    const p = await wikiProject();
    const plain = await humanPage(p, "Plain", "text");
    const typed = await humanPage(p, "Typed", "text");
    const full = await humanPage(p, "Full", "text");
    const source = await humanPage(p, "Source page", "text");
    const exempt = await humanPage(p, "Exempt", "text");
    const python = await humanPage(p, "Script", "text");
    const output = await humanPage(p, "Task output", "text");
    await p.db.document.update({
      where: { id: typed.id },
      data: { wikiType: "topic" },
    });
    await p.db.document.update({
      where: { id: full.id },
      data: { wikiType: "topic", wikiSummary: "s" },
    });
    await p.db.document.update({
      where: { id: source.id },
      data: { wikiSourceItemId: await makeWikiInputItem(p.projectId) },
    });
    await p.db.document.update({
      where: { id: exempt.id },
      data: { reviewExempt: true },
    });
    await p.db.document.update({
      where: { id: python.id },
      data: { kind: "python" },
    });
    const run = await createTaskRun({
      owner: p.owner,
      projectId: p.projectId,
      name: "Nightly",
    });
    await p.db.scheduledTaskRun.update({
      where: { id: run.id },
      data: { outputDocumentId: output.id },
    });
    const candidates = await loadClassifyCandidates(p.db, p.projectId);
    const titles = candidates.map((c) => c.title).sort();
    expect(titles).toEqual(["Plain", "Typed"]);
    expect(candidates.find((c) => c.documentId === typed.id)).toMatchObject({
      hasType: true,
      hasSummary: false,
    });
    expect(candidates.find((c) => c.documentId === plain.id)).toMatchObject({
      hasType: false,
    });
  }, 120_000);

  it("previews with one tool-less call, stores the plan and records usage", async () => {
    await seedWikiRoute();
    const p = await wikiProject();
    const page = await humanPage(
      p,
      "Vendor notes",
      "Contract term is three years.",
    );
    const { runId } = await startClassify(p.db, p.security, {
      projectId: p.projectId,
    });
    const { model, seen } = replying(() =>
      proposal([
        { id: page.id, type: "topic", summary: "Vendor contract terms." },
        { id: randomUUID(), type: "topic", summary: "Not a candidate." },
      ]),
    );
    await executeWikiRun(deps(model), runId);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.tools).toBe(0);
    expect(seen[0]!.prompt).toContain("BEGIN PAGES");
    expect(seen[0]!.prompt).toContain("Vendor notes");
    const stored = await row(p, runId);
    expect(stored).toMatchObject({
      status: "preparing",
      leaseToken: null,
      usageTokens: 160,
    });
    expect(stored.planDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await p.db.aiUsage.count({ where: { runId, operation: "wiki.run" } }),
    ).toBe(1);
    const reviewed = await readClassifyPlan(p.db, p.security, {
      projectId: p.projectId,
      runId,
    });
    expect(reviewed!.plan.entries).toMatchObject([
      {
        documentId: page.id,
        type: "topic",
        summary: "Vendor contract terms.",
      },
    ]);
    expect(reviewed!.digest).toBe(stored.planDigest);
    // A second delivery of the same job finds nothing to preview.
    await executeWikiRun(deps(model), runId);
    expect(seen).toHaveLength(1);
    // The page itself is untouched until the Owner accepts.
    expect((await pageProps(p, page.id)).wikiType).toBeNull();
  }, 120_000);

  it("fails visibly without a suitable route and stops when nothing is classifiable", async () => {
    const p = await wikiProject();
    const first = await startClassify(p.db, p.security, {
      projectId: p.projectId,
    });
    await executeWikiRun(deps(null), first.runId);
    expect(await row(p, first.runId)).toMatchObject({
      status: "failed",
      errorCode: "ROUTE_UNSUITABLE",
    });
    await seedWikiRoute();
    const second = await startClassify(p.db, p.security, {
      projectId: p.projectId,
    });
    const { model, seen } = replying(() => proposal([]));
    await executeWikiRun(deps(model), second.runId);
    expect(seen).toHaveLength(0);
    expect(await row(p, second.runId)).toMatchObject({
      status: "stopped",
      stopReason: "no_candidates",
    });
  }, 120_000);

  async function planned(
    p: WikiProject,
    pages: Array<{ id: string; type?: string; summary?: string }>,
  ) {
    const { runId } = await startClassify(p.db, p.security, {
      projectId: p.projectId,
    });
    const { model } = replying(() =>
      proposal(pages.map((page) => ({ ...page }))),
    );
    await executeWikiRun(deps(model), runId);
    const stored = await row(p, runId);
    return { runId, digest: stored.planDigest! };
  }

  it("shows the plan in run detail to Owners only, while it waits", async () => {
    await seedWikiRoute();
    const p = await wikiProject();
    const maintainer = await makeUser("User", "classify-view");
    await addMembership(p.projectId, maintainer.id, "Maintainer");
    const page = await humanPage(p, "Page", "text");
    const { runId, digest } = await planned(p, [
      { id: page.id, type: "topic", summary: "Summary." },
    ]);
    const owner = await getRun(p.db, p.security, {
      projectId: p.projectId,
      runId,
    });
    expect(owner.plan).toMatchObject({
      digest,
      entries: [{ documentId: page.id, type: "topic" }],
    });
    const other = await getRun(p.db, securityContextFor(maintainer), {
      projectId: p.projectId,
      runId,
    });
    expect(other.plan).toBeNull();
    await rejectClassifyPlan(p.db, p.security, {
      projectId: p.projectId,
      runId,
    });
    expect(
      (await getRun(p.db, p.security, { projectId: p.projectId, runId })).plan,
    ).toBeNull();
  }, 120_000);

  it("applies exactly the accepted plan as property-only patches with no gross charge", async () => {
    await seedWikiRoute();
    const p = await wikiProject();
    const one = await humanPage(p, "One", "Alpha text");
    const two = await humanPage(p, "Two", "Beta text");
    const { runId, digest } = await planned(p, [
      { id: one.id, type: "topic", summary: "About alpha." },
      { id: two.id, type: "entity", summary: "About beta." },
    ]);
    await expect(
      acceptClassifyPlan(p.db, p.security, {
        projectId: p.projectId,
        runId,
        expectedPlanDigest: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ details: { reason: "PLAN_CHANGED" } });
    expect((await row(p, runId)).status).toBe("preparing");

    await acceptClassifyPlan(p.db, p.security, {
      projectId: p.projectId,
      runId,
      expectedPlanDigest: digest,
    });
    expect((await row(p, runId)).status).toBe("queued");
    await executeWikiClassify(p.db, runId, { workerId: "spec" });

    expect(await row(p, runId)).toMatchObject({
      status: "succeeded",
      grossCharsChanged: 0,
      summary: expect.stringContaining("2 pages"),
    });
    expect(await pageProps(p, one.id)).toMatchObject({
      wikiType: "topic",
      wikiSummary: "About alpha.",
    });
    expect(await pageProps(p, two.id)).toMatchObject({
      wikiType: "entity",
      wikiSummary: "About beta.",
    });
    const ops = await p.db.wikiRunOperation.findMany({
      where: { runId },
      orderBy: { n: "asc" },
    });
    expect(ops).toHaveLength(2);
    expect(ops.every((op) => op.status === "committed")).toBe(true);
    expect(ops.every((op) => op.grossCharsChanged === 0)).toBe(true);
    expect(ops.every((op) => op.charsAdded === 0)).toBe(true);
    // Writes are counted: each non-owned page counts one per property it changed.
    expect((await row(p, runId)).writes).toBe(4);
    // No page body changed.
    const doc = await p.db.document.findUniqueOrThrow({
      where: { id: one.id },
    });
    expect(doc.excerpt).toContain("Alpha text");
  }, 180_000);

  it("skips a page that changed after the preview and a page that became ineligible", async () => {
    await seedWikiRoute();
    const p = await wikiProject();
    const changed = await humanPage(p, "Changed", "before");
    const guide = await p.db.projectWikiSettings.findUniqueOrThrow({
      where: { projectId: p.projectId },
    });
    const fine = await humanPage(p, "Fine", "stays");
    const { runId, digest } = await planned(p, [
      { id: changed.id, type: "topic", summary: "Was before." },
      { id: fine.id, type: "note", summary: "Stays." },
    ]);
    await humanEdit(p, changed.id, "after the preview");
    await acceptClassifyPlan(p.db, p.security, {
      projectId: p.projectId,
      runId,
      expectedPlanDigest: digest,
    });
    await executeWikiClassify(p.db, runId, { workerId: "spec" });
    expect(await row(p, runId)).toMatchObject({
      status: "succeeded",
      summary: expect.stringContaining("skipped 1"),
    });
    expect((await pageProps(p, changed.id)).wikiType).toBeNull();
    expect((await pageProps(p, fine.id)).wikiType).toBe("note");
    expect(guide.guideDocumentId).not.toBeNull();
  }, 180_000);

  it("never writes the guide, a source page or a task output even from a stored plan", async () => {
    const p = await wikiProject();
    const settings = await p.db.projectWikiSettings.findUniqueOrThrow({
      where: { projectId: p.projectId },
    });
    const source = await humanPage(p, "Source page", "text");
    await p.db.document.update({
      where: { id: source.id },
      data: { wikiSourceItemId: await makeWikiInputItem(p.projectId) },
    });
    const output = await humanPage(p, "Task output", "text");
    const task = await createTaskRun({
      owner: p.owner,
      projectId: p.projectId,
      name: "Nightly",
    });
    await p.db.scheduledTaskRun.update({
      where: { id: task.id },
      data: { outputDocumentId: output.id },
    });
    const guide = await p.db.document.findUniqueOrThrow({
      where: { id: settings.guideDocumentId! },
    });
    const python = await humanPage(p, "Script", "text");
    await p.db.document.update({
      where: { id: python.id },
      data: { kind: "python" },
    });
    const targets = [guide, source, output, python];
    const plan = {
      version: 1 as const,
      entries: await Promise.all(
        targets.map(async (doc) => {
          const fresh = await p.db.document.findUniqueOrThrow({
            where: { id: doc.id },
          });
          return {
            documentId: fresh.id,
            path: fresh.path,
            title: fresh.title,
            headCommitSha: fresh.headCommitSha,
            type: "topic",
            summary: "Forged proposal.",
          };
        }),
      ),
    };
    const { runId } = await startClassify(p.db, p.security, {
      projectId: p.projectId,
    });
    await p.db.wikiRun.update({
      where: { id: runId },
      data: {
        plan,
        planDigest: classifyPlanDigest(plan),
        status: "queued",
        queuedAt: new Date(),
      },
    });
    await executeWikiClassify(p.db, runId, { workerId: "spec" });
    expect(await row(p, runId)).toMatchObject({
      status: "succeeded",
      summary: expect.stringContaining("Set properties on 0 pages"),
    });
    for (const entry of plan.entries)
      expect(
        (
          await p.db.document.findUniqueOrThrow({
            where: { id: entry.documentId },
          })
        ).headCommitSha,
      ).toBe(entry.headCommitSha);
    expect(await p.db.wikiRunOperation.count({ where: { runId } })).toBe(0);
  }, 180_000);

  it("refuses a stored plan whose digest or values no longer validate", async () => {
    const p = await wikiProject();
    const page = await humanPage(p, "Page", "text");
    const entry = {
      documentId: page.id,
      path: page.path,
      title: "Page",
      headCommitSha: page.headCommitSha,
      type: "topic",
      summary: "ok",
    };
    const make = async (plan: unknown, digest: string) => {
      const { runId } = await startClassify(p.db, p.security, {
        projectId: p.projectId,
      });
      await p.db.wikiRun.update({
        where: { id: runId },
        data: {
          plan: plan as never,
          planDigest: digest,
          status: "queued",
          queuedAt: new Date(),
        },
      });
      await executeWikiClassify(p.db, runId, { workerId: "spec" });
      return row(p, runId);
    };
    const good = { version: 1 as const, entries: [entry] };
    expect(await make(good, "f".repeat(64))).toMatchObject({
      status: "failed",
      errorCode: "PLAN_INVALID",
    });
    const reserved = {
      version: 1 as const,
      entries: [{ ...entry, type: "source" }],
    };
    expect(await make(reserved, classifyPlanDigest(reserved))).toMatchObject({
      status: "failed",
      errorCode: "PLAN_INVALID",
    });
    const tooMany = {
      version: 1 as const,
      entries: Array.from({ length: 101 }, () => entry),
    };
    expect(await make(tooMany, classifyPlanDigest(tooMany))).toMatchObject({
      status: "failed",
      errorCode: "PLAN_INVALID",
    });
    expect((await pageProps(p, page.id)).wikiType).toBeNull();
  }, 180_000);

  it("rejecting a plan cancels the run, and an unanswered plan expires", async () => {
    await seedWikiRoute();
    const p = await wikiProject();
    const page = await humanPage(p, "Page", "text");
    const first = await planned(p, [
      { id: page.id, type: "topic", summary: "Summary." },
    ]);
    await rejectClassifyPlan(p.db, p.security, {
      projectId: p.projectId,
      runId: first.runId,
    });
    expect(await row(p, first.runId)).toMatchObject({
      status: "cancelled",
      stopReason: "plan_rejected",
    });
    expect((await pageProps(p, page.id)).wikiType).toBeNull();
    await expect(
      acceptClassifyPlan(p.db, p.security, {
        projectId: p.projectId,
        runId: first.runId,
        expectedPlanDigest: first.digest,
      }),
    ).rejects.toMatchObject({ details: { reason: "PLAN_NOT_READY" } });

    const second = await planned(p, [
      { id: page.id, type: "topic", summary: "Summary." },
    ]);
    await runWikiTick(p.db, {
      hasActiveRunJob: async () => true,
      now: new Date(Date.now() + 25 * 60 * 60_000),
    });
    expect(await row(p, second.runId)).toMatchObject({
      status: "cancelled",
      stopReason: "plan_expired",
    });
  }, 180_000);

  it("the tick dispatches a waiting preview and releases a lost claim", async () => {
    const p = await wikiProject();
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    const { runId } = await startClassify(p.db, p.security, {
      projectId: p.projectId,
    });
    await runWikiTick(p.db, { hasActiveRunJob: async () => true });
    expect(queue.jobs).toContainEqual({ name: "wiki.run", data: { runId } });
    await p.db.wikiRun.update({
      where: { id: runId },
      data: {
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() - 1_000),
        attempts: 1,
      },
    });
    await runWikiTick(p.db, { hasActiveRunJob: async () => true });
    expect(await row(p, runId)).toMatchObject({
      status: "preparing",
      leaseToken: null,
    });
    await p.db.wikiRun.update({
      where: { id: runId },
      data: {
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() - 1_000),
        attempts: 3,
      },
    });
    await runWikiTick(p.db, { hasActiveRunJob: async () => true });
    expect(await row(p, runId)).toMatchObject({
      status: "failed",
      errorCode: "LEASE_LOST",
    });
  }, 120_000);

  it("counts the plan's 24 hours from when it was stored, not from the start", async () => {
    await seedWikiRoute();
    const p = await wikiProject();
    const page = await humanPage(p, "Page", "text");
    const { runId } = await planned(p, [
      { id: page.id, type: "topic", summary: "Summary." },
    ]);
    expect((await row(p, runId)).queuedAt).not.toBeNull();
    await p.db.wikiRun.update({
      where: { id: runId },
      data: { startedAt: new Date(Date.now() - 30 * 60 * 60_000) },
    });
    await runWikiTick(p.db, { hasActiveRunJob: async () => true });
    expect((await row(p, runId)).status).toBe("preparing");
    await runWikiTick(p.db, {
      hasActiveRunJob: async () => true,
      now: new Date(Date.now() + 25 * 60 * 60_000),
    });
    expect(await row(p, runId)).toMatchObject({
      status: "cancelled",
      stopReason: "plan_expired",
    });
  }, 180_000);

  it("gives the apply its own attempts, and a lost apply lease restarts instead of stopping", async () => {
    await seedWikiRoute();
    const p = await wikiProject();
    const one = await humanPage(p, "One", "Alpha text");
    const two = await humanPage(p, "Two", "Beta text");
    const { runId, digest } = await planned(p, [
      { id: one.id, type: "topic", summary: "About alpha." },
      { id: two.id, type: "entity", summary: "About beta." },
    ]);
    await p.db.wikiRun.update({ where: { id: runId }, data: { attempts: 2 } });
    await acceptClassifyPlan(p.db, p.security, {
      projectId: p.projectId,
      runId,
      expectedPlanDigest: digest,
    });
    expect((await row(p, runId)).attempts).toBe(0);

    // The worker dies holding the lease; the sweep requeues the run for its code-only apply.
    expect(
      await leaseWikiRun(p.db, { runId, workerId: "dead" }),
    ).not.toBeNull();
    const later = new Date(Date.now() + 5 * 60_000);
    expect(await expireWikiRunLeases(p.db, later)).toMatchObject({
      restarted: 1,
      failed: 0,
    });
    expect(await row(p, runId)).toMatchObject({
      status: "queued",
      leaseToken: null,
    });
    await executeWikiClassify(p.db, runId, { workerId: "spec" });
    expect(await row(p, runId)).toMatchObject({ status: "succeeded" });
    expect((await pageProps(p, two.id)).wikiType).toBe("entity");

    // Changed pages are skipped on a restart, so a re-run never writes twice.
    const again = await p.db.wikiRun.findUniqueOrThrow({
      where: { id: runId },
    });
    expect(again.writes).toBe(4);
  }, 180_000);

  it("a runner-less delivery ends only a waiting preview, never a plan awaiting its Owner", async () => {
    await seedWikiRoute();
    const p = await wikiProject();
    const page = await humanPage(p, "Page", "text");
    const { runId } = await planned(p, [
      { id: page.id, type: "topic", summary: "Summary." },
    ]);
    expect(await failRunWithoutRunner(p.db, runId)).toBe(false);
    expect((await row(p, runId)).status).toBe("preparing");
    await rejectClassifyPlan(p.db, p.security, {
      projectId: p.projectId,
      runId,
    });
    const fresh = await startClassify(p.db, p.security, {
      projectId: p.projectId,
    });
    expect(await failRunWithoutRunner(p.db, fresh.runId)).toBe(true);
    expect(await row(p, fresh.runId)).toMatchObject({
      status: "failed",
      errorCode: "RUNNER_UNAVAILABLE",
    });
  }, 180_000);
});

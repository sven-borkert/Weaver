import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { simpleGit } from "simple-git";
import { randomUUID } from "node:crypto";
import { executeWikiRun } from "@weaver/ai/wikiRunner";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import { endRun, leaseWikiRun } from "@weaver/core/services/wikiRuns";
import { lintStartContext } from "@weaver/core/services/wikiRunStart";
import {
  claimDueLintRuns,
  startMaintenance,
} from "@weaver/core/services/wikiLint";
import {
  clearLintPause,
  disableWiki,
  getWikiSettings,
  updateWikiSettings,
} from "@weaver/core/services/wikiSettings";
import {
  expireWikiRunLeases,
  runWikiTick,
} from "@weaver/core/services/wikiTick";
import {
  listMissingEntityPages,
  listPagesWithNewerSources,
  listRecentChanges,
} from "@weaver/core/services/wikiReads";
import { withProjectRepo } from "@weaver/git-store";
import {
  addMembership,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
} from "./_harness";
import { deps, scripted, seedWikiRoute, type Step } from "./_wikiScript";
import {
  humanEdit,
  humanPage,
  wikiProject,
  type WikiProject,
} from "./_wikiRunHarness";

const AUTHOR = {
  name: "Alice",
  email: "alice@test.local",
  userId: "11111111-1111-4111-8111-111111111111",
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function base(suffix: string) {
  const db = getPrisma();
  const owner = await makeUser("User", `lint-${suffix}`);
  const project = await makeProject(`Lint-${suffix}`);
  await addMembership(project.id, owner.id, "Owner");
  return { db, owner, project, security: securityContextFor(owner) };
}

describe("list_recent_changes ancestry boundary", () => {
  beforeEach(resetDb);

  it("lists a backdated untrusted commit on a merged side branch for any since", async () => {
    const f = await base("anc");
    let since = new Date();
    const shas = await withProjectRepo(f.project.id, async (repo) => {
      await repo.writeFileAtomic("old.md", "old\n");
      const t0 = await repo.commitAll("create: old.md", AUTHOR);
      const git = simpleGit(repo.dir);
      const main = (
        await git.raw(["rev-parse", "--abbrev-ref", "HEAD"])
      ).trim();
      await wait(1200);
      since = new Date();
      await wait(1200);
      await git.raw(["checkout", "-b", "side"]);
      await repo.writeFileAtomic("side.md", "side\n");
      await git.add("side.md");
      execFileSync(
        "git",
        [
          "-c",
          "user.name=X",
          "-c",
          "user.email=x@x.test",
          "commit",
          "-m",
          "side",
        ],
        {
          cwd: repo.dir,
          env: {
            ...process.env,
            GIT_AUTHOR_DATE: "2001-01-01T00:00:00Z",
            GIT_COMMITTER_DATE: "2001-01-01T00:00:00Z",
          },
        },
      );
      const side = (await git.revparse(["HEAD"])).trim();
      await git.raw(["checkout", main]);
      await repo.writeFileAtomic("new.md", "new\n");
      const t1 = await repo.commitAll("create: new.md", AUTHOR);
      await git.raw([
        "-c",
        "user.name=X",
        "-c",
        "user.email=x@x.test",
        "merge",
        "--no-ff",
        "-m",
        "merge side",
        "side",
      ]);
      const merge = (await git.revparse(["HEAD"])).trim();
      return { t0, t1, side, merge };
    });

    const result = await listRecentChanges(
      f.db,
      { projectId: f.project.id, since },
      f.security,
    );
    const seen = result.changes.map((c) => c.sha);
    expect(seen).toEqual(
      expect.arrayContaining([shas.t1, shas.side, shas.merge]),
    );
    expect(seen).not.toContain(shas.t0);
    const side = result.changes.find((c) => c.sha === shas.side)!;
    expect(side).toMatchObject({
      kind: "external",
      author: null,
      subject: null,
    });
    const merge = result.changes.find((c) => c.sha === shas.merge)!;
    expect(merge.changes.map((c) => c.path)).toEqual(["side.md"]);
    expect(result.nextCursor).toBeNull();

    // Paging across the new walk is stable and loses nothing.
    const collected: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await listRecentChanges(
        f.db,
        { projectId: f.project.id, since, cursor, limit: 1 },
        f.security,
      );
      collected.push(...page.changes.map((c) => c.sha));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(collected.sort()).toEqual([...seen].sort());
  }, 30_000);
});

const DAY = 24 * 60 * 60_000;

async function setSchedule(
  p: WikiProject,
  schedule: unknown,
  timezone = "UTC",
) {
  const settings = await p.db.projectWikiSettings.findUniqueOrThrow({
    where: { projectId: p.projectId },
  });
  return updateWikiSettings(p.db, p.security, {
    projectId: p.projectId,
    expectedRevision: settings.revision,
    lintSchedule: schedule,
    lintTimezone: timezone,
  });
}

const lintRuns = (p: WikiProject) =>
  p.db.wikiRun.findMany({
    where: { projectId: p.projectId, kind: "lint" },
    orderBy: { startedAt: "asc" },
  });

describe("lint schedule", () => {
  beforeEach(async () => {
    await resetDb();
    setJobQueueForTests(new FakeJobQueue());
  }, 60_000);

  it("stores the preset with its derived cron and timezone, and null turns it off", async () => {
    const p = await wikiProject();
    const view = await setSchedule(
      p,
      { kind: "daily", hour: 3, minute: 30 },
      "Europe/Berlin",
    );
    expect(view.lintSchedule).toEqual({ kind: "daily", hour: 3, minute: 30 });
    const row = await p.db.projectWikiSettings.findUniqueOrThrow({
      where: { projectId: p.projectId },
    });
    expect(row).toMatchObject({
      lintCron: "30 3 * * *",
      lintTimezone: "Europe/Berlin",
    });
    expect(row.lintNextRunAt!.getTime()).toBeGreaterThan(Date.now());
    await expect(
      setSchedule(p, { kind: "daily", hour: 99, minute: 0 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      setSchedule(p, { kind: "hourly", minute: 0 }, "Mars/Base"),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const off = await setSchedule(p, null);
    expect(off).toMatchObject({ lintSchedule: null, lintNextRunAt: null });
    expect(
      (
        await p.db.projectWikiSettings.findUniqueOrThrow({
          where: { projectId: p.projectId },
        })
      ).lintCron,
    ).toBeNull();
  }, 60_000);

  it("is Owner only", async () => {
    const p = await wikiProject();
    const editor = await makeUser("User", "lint-editor");
    await addMembership(p.projectId, editor.id, "Maintainer");
    await expect(
      updateWikiSettings(p.db, securityContextFor(editor), {
        projectId: p.projectId,
        expectedRevision: 1,
        lintSchedule: { kind: "hourly", minute: 5 },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  }, 60_000);

  async function due(p: WikiProject, at: Date) {
    await setSchedule(p, { kind: "daily", hour: 3, minute: 0 });
    await p.db.projectWikiSettings.update({
      where: { projectId: p.projectId },
      data: { lintNextRunAt: at },
    });
  }

  it("claims a due slot once even when two ticks race", async () => {
    const p = await wikiProject();
    const now = new Date();
    await due(p, new Date(now.getTime() - 60_000));
    const results = await Promise.all([
      claimDueLintRuns(p.db, now),
      claimDueLintRuns(p.db, now),
    ]);
    expect(results.reduce((sum, r) => sum + r.started, 0)).toBe(1);
    const [run] = await lintRuns(p);
    expect(run).toMatchObject({
      kind: "lint",
      trigger: "schedule",
      status: "queued",
      startedById: null,
    });
    const row = await p.db.projectWikiSettings.findUniqueOrThrow({
      where: { projectId: p.projectId },
    });
    expect(row.lintNextRunAt!.getTime()).toBeGreaterThan(now.getTime());
    expect(row.lintSkipReason).toBeNull();
  }, 60_000);

  it("skips and shows a slot while a run is active, paused or missed", async () => {
    const p = await wikiProject();
    const now = new Date();
    const slot = new Date(now.getTime() - 60_000);
    const row = () =>
      p.db.projectWikiSettings.findUniqueOrThrow({
        where: { projectId: p.projectId },
      });

    await due(p, slot);
    await p.db.wikiRun.create({
      data: {
        projectId: p.projectId,
        agentId: (await row()).agentId!,
        kind: "ingest",
        status: "queued",
        queuedAt: now,
      },
    });
    expect(await claimDueLintRuns(p.db, now)).toEqual({
      started: 0,
      skipped: 1,
    });
    expect(await row()).toMatchObject({ lintSkipReason: "run_active" });
    await p.db.wikiRun.deleteMany({ where: { projectId: p.projectId } });

    await due(p, slot);
    await p.db.projectWikiSettings.update({
      where: { projectId: p.projectId },
      data: { lintPausedAt: now },
    });
    await claimDueLintRuns(p.db, now);
    expect(await row()).toMatchObject({ lintSkipReason: "lint_paused" });

    await due(p, slot);
    await p.db.projectWikiSettings.update({
      where: { projectId: p.projectId },
      data: { lintPausedAt: null, destructivePausedAt: now },
    });
    await claimDueLintRuns(p.db, now);
    expect(await row()).toMatchObject({ lintSkipReason: "budget_paused" });

    await due(p, new Date(now.getTime() - DAY));
    await p.db.projectWikiSettings.update({
      where: { projectId: p.projectId },
      data: { destructivePausedAt: null },
    });
    await claimDueLintRuns(p.db, now);
    expect(await row()).toMatchObject({ lintSkipReason: "missed" });
    expect(await lintRuns(p)).toHaveLength(0);
    const view = await getWikiSettings(p.db, p.security, p.projectId);
    expect(view.lintSkipped?.reason).toBe("missed");
  }, 60_000);

  it("the tick starts a due lint run and dispatches it", async () => {
    const p = await wikiProject();
    await due(p, new Date(Date.now() - 1_000));
    await runWikiTick(p.db, { hasActiveRunJob: async () => true });
    expect(await lintRuns(p)).toHaveLength(1);
  }, 60_000);

  it("does nothing while disabled", async () => {
    const p = await wikiProject();
    await due(p, new Date(Date.now() - 1_000));
    await disableWiki(p.db, p.security, {
      projectId: p.projectId,
      expectedRevision: (
        await p.db.projectWikiSettings.findUniqueOrThrow({
          where: { projectId: p.projectId },
        })
      ).revision,
    });
    expect(await claimDueLintRuns(p.db, new Date())).toEqual({
      started: 0,
      skipped: 0,
    });
  }, 60_000);
});

describe("lint failure streak", () => {
  beforeEach(resetDb, 60_000);

  async function runEnding(p: WikiProject, end: Parameters<typeof endRun>[3]) {
    const agentId = (
      await p.db.projectWikiSettings.findUniqueOrThrow({
        where: { projectId: p.projectId },
      })
    ).agentId!;
    const run = await p.db.wikiRun.create({
      data: {
        projectId: p.projectId,
        agentId,
        kind: "lint",
        trigger: "schedule",
        status: "running",
      },
    });
    await endRun(p.db, run.id, ["running"], end);
  }
  const fail = { status: "failed", errorCode: "X", note: "n" } as const;
  const row = (p: WikiProject) =>
    p.db.projectWikiSettings.findUniqueOrThrow({
      where: { projectId: p.projectId },
    });

  it("pauses after five failures, resets on success and ignores clean stops and cancels", async () => {
    const p = await wikiProject();
    for (let i = 0; i < 4; i++) await runEnding(p, fail);
    expect(await row(p)).toMatchObject({
      lintConsecutiveFailures: 4,
      lintPausedAt: null,
    });
    await runEnding(p, {
      status: "stopped",
      stopReason: "step_cap",
      note: "n",
    });
    await runEnding(p, { status: "cancelled", stopReason: "user", note: "n" });
    expect((await row(p)).lintConsecutiveFailures).toBe(4);
    await runEnding(p, { status: "succeeded", note: "n" });
    expect((await row(p)).lintConsecutiveFailures).toBe(0);

    for (let i = 0; i < 4; i++) await runEnding(p, fail);
    await runEnding(p, {
      status: "stopped",
      stopReason: "model_stopped",
      errorCode: "X",
      note: "n",
    });
    const paused = await row(p);
    expect(paused.lintConsecutiveFailures).toBe(5);
    expect(paused.lintPausedAt).not.toBeNull();
    const view = await getWikiSettings(p.db, p.security, p.projectId);
    expect(view.lintPausedAt).not.toBeNull();

    const cleared = await clearLintPause(p.db, p.security, {
      projectId: p.projectId,
      expectedRevision: paused.revision,
    });
    expect(cleared).toMatchObject({
      lintPausedAt: null,
      lintConsecutiveFailures: 0,
    });
  }, 60_000);

  it("only an Owner clears the pause", async () => {
    const p = await wikiProject();
    const maintainer = await makeUser("User", "lint-maint");
    await addMembership(p.projectId, maintainer.id, "Maintainer");
    await expect(
      clearLintPause(p.db, securityContextFor(maintainer), {
        projectId: p.projectId,
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  }, 60_000);
});

describe("run maintenance now", () => {
  beforeEach(async () => {
    await resetDb();
    setJobQueueForTests(new FakeJobQueue());
  }, 60_000);
  afterEach(() => setJobQueueForTests(null));

  it("starts once per hour per project with a clear message", async () => {
    const p = await wikiProject();
    const { runId } = await startMaintenance(p.db, p.security, {
      projectId: p.projectId,
    });
    expect(
      await p.db.wikiRun.findUniqueOrThrow({ where: { id: runId } }),
    ).toMatchObject({
      kind: "lint",
      trigger: "manual",
      status: "queued",
      startedById: p.owner.id,
    });
    await endRun(p.db, runId, ["queued"], {
      status: "cancelled",
      note: "n",
    });
    await expect(
      startMaintenance(p.db, p.security, { projectId: p.projectId }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringMatching(/less than an hour ago/),
      details: { reason: "RATE_LIMITED" },
    });
    const later = new Date(Date.now() + 61 * 60_000);
    await expect(
      startMaintenance(p.db, p.security, { projectId: p.projectId }, later),
    ).resolves.toMatchObject({ runId: expect.any(String) });
  }, 60_000);

  it("refuses a second concurrent start, a viewer, a disabled wiki and a paused budget", async () => {
    const p = await wikiProject();
    const viewer = await makeUser("User", "lint-viewer");
    await addMembership(p.projectId, viewer.id, "Viewer");
    await expect(
      startMaintenance(p.db, securityContextFor(viewer), {
        projectId: p.projectId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await p.db.projectWikiSettings.update({
      where: { projectId: p.projectId },
      data: { destructivePausedAt: new Date() },
    });
    await expect(
      startMaintenance(p.db, p.security, { projectId: p.projectId }),
    ).rejects.toMatchObject({ details: { reason: "DESTRUCTIVE_PAUSED" } });
    await p.db.projectWikiSettings.update({
      where: { projectId: p.projectId },
      data: { destructivePausedAt: null },
    });

    const results = await Promise.allSettled([
      startMaintenance(p.db, p.security, { projectId: p.projectId }),
      startMaintenance(p.db, p.security, { projectId: p.projectId }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    await p.db.wikiRun.deleteMany({ where: { projectId: p.projectId } });
    const row = await p.db.projectWikiSettings.findUniqueOrThrow({
      where: { projectId: p.projectId },
    });
    await disableWiki(p.db, p.security, {
      projectId: p.projectId,
      expectedRevision: row.revision,
    });
    await expect(
      startMaintenance(
        p.db,
        p.security,
        { projectId: p.projectId },
        new Date(Date.now() + 2 * DAY),
      ),
    ).rejects.toMatchObject({ details: { reason: "WIKI_DISABLED" } });
  }, 60_000);

  it("fails visibly with ROUTE_UNSUITABLE when no model is routed", async () => {
    const p = await wikiProject();
    const { runId } = await startMaintenance(p.db, p.security, {
      projectId: p.projectId,
    });
    await executeWikiRun(deps(null), runId);
    expect(
      await p.db.wikiRun.findUniqueOrThrow({ where: { id: runId } }),
    ).toMatchObject({ status: "failed", errorCode: "ROUTE_UNSUITABLE" });
  }, 60_000);
});

describe("a scripted lint run", () => {
  beforeEach(async () => {
    await resetDb();
    setJobQueueForTests(new FakeJobQueue());
  }, 60_000);
  afterEach(() => setJobQueueForTests(null));

  const report = {
    folderPath: ["wiki"],
    title: "Wiki lint report",
    markdown: "# Report\n\nNothing yet.\n",
    properties: { type: "report", summary: "Lint findings" },
  };

  function script(extra: Step[] = []): Step[] {
    return [
      () => [["load_tools", { names: ["list_missing_entity_pages"] }]],
      () => [["inspect_links", { mode: "orphans" }]],
      () => [["wiki_create_page", report]],
      ...extra,
      () => [["finish_run", { summary: "Checked links." }]],
    ];
  }

  it("creates the report page, records it, and patches the same page next time", async () => {
    await seedWikiRoute();
    const p = await wikiProject();
    const { runId } = await startMaintenance(p.db, p.security, {
      projectId: p.projectId,
    });
    const first = scripted(script());
    await executeWikiRun(deps(first.model), runId);
    expect(
      await p.db.wikiRun.findUniqueOrThrow({ where: { id: runId } }),
    ).toMatchObject({
      status: "succeeded",
      summary: "Checked links.",
      writes: 1,
    });
    const settings = await p.db.projectWikiSettings.findUniqueOrThrow({
      where: { projectId: p.projectId },
    });
    const doc = await p.db.document.findUniqueOrThrow({
      where: { id: settings.reportDocumentId! },
    });
    expect(doc).toMatchObject({
      wikiType: "report",
      lastEditedByMachineKind: "wikiAgent",
    });
    expect(first.prompts[0]![0]!.content).toContain("Lint protocol");

    // The next run is told the report exists and patches it; a second create is refused.
    await p.db.wikiRun.updateMany({
      where: { id: runId },
      data: { startedAt: new Date(Date.now() - 2 * 60 * 60_000) },
    });
    const next = await startMaintenance(
      p.db,
      p.security,
      { projectId: p.projectId },
      new Date(Date.now() + 2 * 60 * 60_000),
    );
    let refusal: unknown = null;
    const second = scripted([
      ({ prompt }) => {
        const start = JSON.stringify(
          prompt.find((m) => m.role === "user")!.content,
        );
        expect(start).toContain(`Report page: ${doc.id}`);
        return [["wiki_create_page", report]];
      },
      ({ results }) => {
        refusal = results.get("wiki_create_page");
        return [
          [
            "wiki_patch_page",
            {
              documentId: doc.id,
              baseCommitSha: doc.headCommitSha,
              actions: [
                {
                  action: "replace_section_body",
                  sectionId: "report",
                  text: "All good.",
                },
              ],
            },
          ],
        ];
      },
      () => [["finish_run", { summary: "Patched." }]],
    ]);
    await executeWikiRun(deps(second.model), next.runId);
    expect(JSON.stringify(refusal)).toContain("report page already exists");
    expect(
      await p.db.wikiRun.findUniqueOrThrow({ where: { id: next.runId } }),
    ).toMatchObject({ status: "succeeded" });
  }, 120_000);

  it("refuses any other page, a folder, and the input tools in a lint run", async () => {
    await seedWikiRoute();
    const p = await wikiProject();
    const { runId } = await startMaintenance(p.db, p.security, {
      projectId: p.projectId,
    });
    const seen: Record<string, unknown> = {};
    const model = scripted([
      () => [
        [
          "wiki_create_page",
          {
            ...report,
            title: "Other",
            properties: { type: "topic", summary: "x" },
          },
        ],
        ["wiki_create_folder", { parentPath: [], name: "extra" }],
        ["read_input", { id: randomUUID() }],
        ["complete_input", { id: randomUUID(), outcome: "skipped", note: "n" }],
        ["wiki_note", { text: "n" }],
        ["list_inputs", {}],
      ],
      ({ prompt }) => {
        for (const message of prompt)
          if (message.role === "tool" && typeof message.content !== "string")
            for (const part of message.content)
              seen[part.toolName] = part.output.value;
        return [["finish_run", { summary: "Done." }]];
      },
    ]);
    await executeWikiRun(deps(model.model), runId);
    for (const name of [
      "wiki_create_page",
      "wiki_create_folder",
      "read_input",
      "complete_input",
      "wiki_note",
    ])
      expect(JSON.stringify(seen[name])).toMatch(/error|lint|inputs|report/i);
    expect(JSON.stringify(seen.list_inputs)).toContain('"inputs":[]');
    expect(
      await p.db.document.count({
        where: { projectId: p.projectId, title: "Other" },
      }),
    ).toBe(0);
  }, 120_000);

  it("a human-edited report is non-owned: replace_section_body is refused and a dated append works", async () => {
    await seedWikiRoute();
    const p = await wikiProject();
    const first = await startMaintenance(p.db, p.security, {
      projectId: p.projectId,
    });
    await executeWikiRun(deps(scripted(script()).model), first.runId);
    const settings = await p.db.projectWikiSettings.findUniqueOrThrow({
      where: { projectId: p.projectId },
    });
    await humanEdit(p, settings.reportDocumentId!, "# Report\n\nHuman note.\n");
    const doc = await p.db.document.findUniqueOrThrow({
      where: { id: settings.reportDocumentId! },
    });
    const next = await startMaintenance(
      p.db,
      p.security,
      { projectId: p.projectId },
      new Date(Date.now() + 2 * 60 * 60_000),
    );
    const results: unknown[] = [];
    const model = scripted([
      () => [
        [
          "wiki_patch_page",
          {
            documentId: doc.id,
            baseCommitSha: doc.headCommitSha,
            actions: [
              {
                action: "replace_section_body",
                sectionId: "report",
                text: "x",
              },
            ],
          },
        ],
      ],
      ({ results: seen }) => {
        results.push(seen.get("wiki_patch_page"));
        return [
          [
            "wiki_patch_page",
            {
              documentId: doc.id,
              baseCommitSha: doc.headCommitSha,
              actions: [
                {
                  action: "append",
                  text: "\n## Lint 2026-11-03\n\nOrphans: none.\n",
                },
              ],
            },
          ],
        ];
      },
      ({ results: seen }) => {
        results.push(seen.get("wiki_patch_page"));
        return [["finish_run", { summary: "Appended." }]];
      },
    ]);
    await executeWikiRun(deps(model.model), next.runId);
    expect(JSON.stringify(results[0])).toMatch(/error|owned|section/i);
    expect(JSON.stringify(results[1])).toContain("commitSha");
  }, 120_000);

  it("records a new report when the recorded one is gone, and a parallel create makes only one", async () => {
    await seedWikiRoute();
    const p = await wikiProject();
    const first = await startMaintenance(p.db, p.security, {
      projectId: p.projectId,
    });
    await executeWikiRun(deps(scripted(script()).model), first.runId);
    const settings = await p.db.projectWikiSettings.findUniqueOrThrow({
      where: { projectId: p.projectId },
    });
    const oldId = settings.reportDocumentId!;
    // The crash-recovery view: the id is lost but this run's ledger still names the page.
    await p.db.projectWikiSettings.update({
      where: { projectId: p.projectId },
      data: { reportDocumentId: null },
    });
    expect(
      (await lintStartContext(p.db, first.runId, p.projectId)).reportDocumentId,
    ).toBe(oldId);
    // A dangling id counts as none.
    const dangling = randomUUID();
    await p.db.projectWikiSettings.update({
      where: { projectId: p.projectId },
      data: { reportDocumentId: dangling },
    });
    expect(
      (await lintStartContext(p.db, randomUUID(), p.projectId))
        .reportDocumentId,
    ).toBeNull();
    await p.db.document.delete({ where: { id: oldId } });

    const next = await startMaintenance(
      p.db,
      p.security,
      { projectId: p.projectId },
      new Date(Date.now() + 2 * 60 * 60_000),
    );
    const results: unknown[] = [];
    const model = scripted([
      () => [
        ["wiki_create_page", report],
        ["wiki_create_page", { ...report, title: "Wiki lint report B" }],
      ],
      ({ results: seen }) => {
        results.push(seen.get("wiki_create_page"));
        return [["finish_run", { summary: "Recreated." }]];
      },
    ]);
    await executeWikiRun(deps(model.model), next.runId);
    const after = await p.db.projectWikiSettings.findUniqueOrThrow({
      where: { projectId: p.projectId },
    });
    expect(after.reportDocumentId).not.toBe(dangling);
    expect(after.reportDocumentId).not.toBeNull();
    expect(
      await p.db.document.count({
        where: { projectId: p.projectId, wikiType: "report" },
      }),
    ).toBe(1);
    expect(
      await p.db.wikiRunOperation.count({
        where: {
          runId: next.runId,
          toolName: "wiki_create_page",
          status: "committed",
        },
      }),
    ).toBe(1);
  }, 120_000);

  it("allows small text edits on other pages but not section rewrites or removals", async () => {
    await seedWikiRoute();
    const p = await wikiProject();
    const page = await humanPage(p, "Notes", "Intro text.\n");
    const { runId } = await startMaintenance(p.db, p.security, {
      projectId: p.projectId,
    });
    const results: unknown[] = [];
    const patch = (action: Record<string, unknown>) =>
      [
        "wiki_patch_page",
        {
          documentId: page.id,
          baseCommitSha: page.headCommitSha,
          actions: [action],
        },
      ] as [string, Record<string, unknown>];
    const model = scripted([
      () => [patch({ action: "remove_section", sectionId: "notes" })],
      ({ results: seen }) => {
        results.push(seen.get("wiki_patch_page"));
        return [
          patch({
            action: "replace_section_body",
            sectionId: "notes",
            text: "x",
          }),
        ];
      },
      ({ results: seen }) => {
        results.push(seen.get("wiki_patch_page"));
        return [
          patch({ action: "replace_text", find: "Intro", replace: "Start" }),
        ];
      },
      ({ results: seen }) => {
        results.push(seen.get("wiki_patch_page"));
        return [["finish_run", { summary: "Done." }]];
      },
    ]);
    await executeWikiRun(deps(model.model), runId);
    expect(JSON.stringify(results[0])).toMatch(/lint run may not rewrite/);
    expect(JSON.stringify(results[1])).toMatch(/lint run may not rewrite/);
    expect(JSON.stringify(results[2])).toContain("commitSha");
    expect(
      (await p.db.document.findUniqueOrThrow({ where: { id: page.id } }))
        .excerpt,
    ).toContain("Start text.");
  }, 120_000);
});

describe("lint lease loss", () => {
  beforeEach(resetDb, 60_000);

  it("restarts a lost lint run, and at the attempt limit fails it toward the pause", async () => {
    const p = await wikiProject();
    const { runId } = await startMaintenance(p.db, p.security, {
      projectId: p.projectId,
    });
    expect(
      await leaseWikiRun(p.db, { runId, workerId: "dead" }),
    ).not.toBeNull();
    const later = new Date(Date.now() + 5 * 60_000);
    expect(await expireWikiRunLeases(p.db, later)).toMatchObject({
      restarted: 1,
      failed: 0,
    });
    expect(
      await p.db.wikiRun.findUniqueOrThrow({ where: { id: runId } }),
    ).toMatchObject({ status: "queued", stopReason: null, leaseToken: null });

    await p.db.wikiRun.update({ where: { id: runId }, data: { attempts: 3 } });
    expect(
      await leaseWikiRun(p.db, { runId, workerId: "dead-2" }),
    ).not.toBeNull();
    await p.db.wikiRun.update({ where: { id: runId }, data: { attempts: 3 } });
    expect(
      await expireWikiRunLeases(p.db, new Date(Date.now() + 10 * 60_000)),
    ).toMatchObject({ restarted: 0, failed: 1 });
    expect(
      await p.db.wikiRun.findUniqueOrThrow({ where: { id: runId } }),
    ).toMatchObject({ status: "failed", errorCode: "LEASE_LOST" });
    expect(
      (
        await p.db.projectWikiSettings.findUniqueOrThrow({
          where: { projectId: p.projectId },
        })
      ).lintConsecutiveFailures,
    ).toBe(1);
  }, 60_000);
});

describe("lint reads", () => {
  beforeEach(resetDb, 60_000);

  async function generation(p: WikiProject, status: "active" | "superseded") {
    return p.db.knowledgeGeneration.create({
      data: {
        projectId: p.projectId,
        configFingerprint: randomUUID(),
        embeddingModel: "m",
        embeddingDimensions: 4,
        extractionSchemaVersion: 1,
        promptVersion: "v",
        status,
      },
    });
  }

  async function mention(
    p: WikiProject,
    generationId: string,
    name: string,
    documentIds: string[],
  ) {
    const entity = await p.db.graphEntity.create({
      data: {
        projectId: p.projectId,
        generationId,
        entityType: "concept",
        canonicalName: name,
        normalizedName: name.toLowerCase(),
      },
    });
    for (const documentId of documentIds)
      await p.db.entityMention.create({
        data: {
          projectId: p.projectId,
          generationId,
          entityId: entity.id,
          documentId,
          sourceChunkId: "c",
          sourceCommitSha: "a".repeat(40),
          mentionText: name,
          confidence: 1,
        },
      });
    return entity;
  }

  it("lists entities in many pages without a page, active generation only, bounded", async () => {
    const p = await wikiProject();
    const docs = await Promise.all(
      ["One", "Two", "Three"].map((t) => humanPage(p, `Doc ${t}`, "body")),
    );
    const ids = docs.map((d) => d.id);
    const active = await generation(p, "active");
    const old = await generation(p, "superseded");
    await mention(p, active.id, "Widget", ids);
    await mention(p, active.id, "Rare", ids.slice(0, 2));
    await mention(p, active.id, "Doc One", ids);
    await mention(p, old.id, "Ghost", ids);
    await humanPage(p, "Gadget", "body");
    await mention(p, active.id, "Gadget", ids);
    const result = await listMissingEntityPages(
      p.db,
      { projectId: p.projectId },
      p.security,
    );
    expect(result.entities.map((e) => e.name)).toEqual(["Widget"]);
    expect(result.entities[0]).toMatchObject({ pages: 3, type: "concept" });
    expect(result.nextCursor).toBeNull();
    const loose = await listMissingEntityPages(
      p.db,
      { projectId: p.projectId, minPages: 2, limit: 1 },
      p.security,
    );
    expect(loose.entities.map((e) => e.name)).toEqual(["Widget"]);
    expect(loose.nextCursor).not.toBeNull();
    const rest = await listMissingEntityPages(
      p.db,
      {
        projectId: p.projectId,
        minPages: 2,
        limit: 1,
        cursor: loose.nextCursor!,
      },
      p.security,
    );
    expect(rest.entities.map((e) => e.name)).toEqual(["Rare"]);
    await expect(
      listMissingEntityPages(
        p.db,
        { projectId: p.projectId, cursor: "garbage" },
        p.security,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }, 60_000);

  it("lists pages whose sources changed after the page", async () => {
    const p = await wikiProject();
    const source = await humanPage(p, "Source doc", "v1");
    const page = await humanPage(p, "Derived", "built from source");
    const other = await humanPage(p, "Fresh", "later than its source");
    await p.db.document.update({
      where: { id: page.id },
      data: {
        wikiSources: [
          { kind: "document", id: source.id },
          { kind: "document", id: source.id },
        ],
        lastEditedAt: new Date("2026-01-01T00:00:00Z"),
      },
    });
    await p.db.document.update({
      where: { id: other.id },
      data: {
        wikiSources: [{ kind: "document", id: source.id }],
        lastEditedAt: new Date("2099-01-01T00:00:00Z"),
      },
    });
    const result = await listPagesWithNewerSources(
      p.db,
      { projectId: p.projectId },
      p.security,
    );
    expect(result.pages.map((x) => x.id)).toEqual([page.id]);
    expect(result.pages[0]!.sources).toHaveLength(1);
    expect(result.pages[0]!.sources[0]).toMatchObject({
      kind: "document",
      id: source.id,
      title: "Source doc",
    });
    expect(result.nextCursor).toBeNull();
  }, 60_000);
});

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeJobQueue, setJobQueueForTests } from "@weaver/core/jobs/queue";
import {
  addTextInput,
  confirmInput,
  listInputs,
  processInputs,
  removeInput,
  retryInput,
} from "@weaver/core/services/wikiInputs";
import {
  cancelRun,
  failRunWithoutRunner,
  WIKI_NO_WORKER_MESSAGE,
} from "@weaver/core/services/wikiRuns";
import {
  disableWiki,
  enableWiki,
  getWikiSettings,
  revokeAgent,
} from "@weaver/core/services/wikiSettings";
import {
  hasActiveWikiRunJob,
  reapWikiRuns,
  runWikiTick,
} from "@weaver/core/services/wikiTick";
import {
  addMembership,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
} from "./_harness";

async function fixture() {
  const db = getPrisma();
  const owner = await makeUser("User", "wiki-owner");
  const editor = await makeUser("User", "wiki-editor");
  const viewer = await makeUser("User", "wiki-viewer");
  const project = await makeProject("Wiki inputs");
  await addMembership(project.id, owner.id, "Owner");
  await addMembership(project.id, editor.id, "Editor");
  await addMembership(project.id, viewer.id, "Viewer");
  const ownerContext = securityContextFor(owner);
  await enableWiki(db, ownerContext, {
    projectId: project.id,
    expectedRevision: 0,
  });
  return {
    db,
    owner,
    project,
    projectId: project.id,
    ownerContext,
    editorContext: securityContextFor(editor),
    viewerContext: securityContextFor(viewer),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function revision(f: Fixture): Promise<number> {
  return (await getWikiSettings(f.db, f.ownerContext, f.projectId)).revision;
}

function addNote(f: Fixture, text = "A note", title?: string) {
  return addTextInput(f.db, f.editorContext, {
    projectId: f.projectId,
    text,
    ...(title === undefined ? {} : { title }),
  });
}

describe("wiki input queue", () => {
  beforeEach(resetDb);

  it("refuses a note that is empty once stripped", async () => {
    const f = await fixture();
    for (const text of ["", "   \n\t", "\u200b\u202e\u2066\u00ad", " \ufeff "])
      await expect(addNote(f, text)).rejects.toMatchObject({
        code: "BAD_REQUEST",
        details: { field: "text" },
      });
    expect(await f.db.wikiInputItem.count()).toBe(0);
  }, 15_000);

  it("derives a stable title and never stores an empty one", async () => {
    const f = await fixture();
    expect((await addNote(f, "body", "\u200b\u202e  ")).title).toBe("body");
    expect((await addNote(f, "# Heading\n\nbody")).title).toBe("Heading");
    expect((await addNote(f, "body", "Mine\u202e")).title).toBe("Mine");
    expect((await addNote(f, "\u200b\n  \ntext line")).title).toBe("text line");
  }, 15_000);

  const SECRET = ["ghp_", "abcdefghijklmnopqrstuvwxyz0123456789"].join("");
  const NEUTRAL = /^Note \d{4}-\d{2}-\d{2}$/;

  it.each([
    ["derived from the first line", `key ${SECRET}\n\nbody`, undefined],
    ["supplied", "body", `Rotate ${SECRET}`],
    ["past the title cut-off", `${"word ".repeat(30)}${SECRET}`, undefined],
  ])(
    "a title with a secret %s is stored neutral",
    async (_label, text, title) => {
      const f = await fixture();
      const created = await addNote(f, text, title);
      expect(created.title).toMatch(NEUTRAL);
      const list = await listInputs(f.db, f.viewerContext, {
        projectId: f.projectId,
      });
      expect(JSON.stringify(list)).not.toContain(SECRET);
      expect(JSON.stringify(list)).not.toContain("ghp_");
    },
    15_000,
  );

  it("remove keeps only the id, kind, status, timestamps and the source link", async () => {
    const f = await fixture();
    const created = await addNote(f, "Private first line\n\nbody");
    const digest = "a".repeat(64);
    await f.db.wikiInputItem.update({
      where: { id: created.id },
      data: {
        status: "held",
        heldDigest: digest,
        heldHits: [{ kind: "jwt", location: "note, line 1" }],
        confirmedDigest: digest,
        outcomeNote: "note",
        errorCode: "X",
        errorMessage: "message",
      },
    });
    await removeInput(f.db, f.editorContext, {
      projectId: f.projectId,
      itemId: created.id,
    });
    const row = await f.db.wikiInputItem.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row).toMatchObject({
      status: "removed",
      kind: "text",
      title: "Removed input",
      text: null,
      textDigest: null,
      artifactId: null,
      artifactDigest: null,
      byteSize: 0,
      heldDigest: null,
      heldHits: null,
      confirmedDigest: null,
      confirmedById: null,
      outcomeNote: null,
      errorCode: null,
      errorMessage: null,
      createdById: null,
      processStartedById: null,
    });
    expect(JSON.stringify(row)).not.toContain("Private first line");
  }, 15_000);

  it("refuses over the limit, images and a Viewer", async () => {
    const f = await fixture();
    await expect(addNote(f, "x".repeat(200_001))).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(addNote(f, "![a](weaver-image:x)")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(addNote(f, "<img src=x>")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      addTextInput(f.db, f.viewerContext, {
        projectId: f.projectId,
        text: "x",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  }, 15_000);

  it("holds the queue at 200 open items; removed and processed do not count", async () => {
    const f = await fixture();
    const make = (status: "queued" | "removed" | "processed") => ({
      projectId: f.projectId,
      kind: "text" as const,
      title: "n",
      byteSize: 1,
      status,
    });
    await f.db.wikiInputItem.createMany({
      data: [
        ...Array.from({ length: 200 }, () => make("queued")),
        make("removed"),
        make("processed"),
      ],
    });
    await expect(addNote(f)).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "QUEUE_FULL" },
    });
  }, 15_000);

  it("refuses inputs while the wiki is disabled", async () => {
    const f = await fixture();
    await disableWiki(f.db, f.ownerContext, {
      projectId: f.projectId,
      expectedRevision: await revision(f),
    });
    await expect(addNote(f)).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "WIKI_DISABLED" },
    });
  }, 15_000);

  it("never returns note text from the list", async () => {
    const f = await fixture();
    await addNote(f, "Title line\n\na very private sentence");
    const list = await listInputs(f.db, f.viewerContext, {
      projectId: f.projectId,
    });
    expect(list.queue).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain("a very private sentence");
  }, 15_000);
});

describe("processInputs", () => {
  beforeEach(resetDb);

  it("selects the 10 oldest and leaves the rest queued", async () => {
    const f = await fixture();
    const base = Date.now() - 60_000;
    await f.db.wikiInputItem.createMany({
      data: Array.from({ length: 13 }, (_, index) => ({
        id: randomUUID(),
        projectId: f.projectId,
        kind: "text" as const,
        title: `n${index}`,
        text: "x",
        byteSize: 1,
        createdAt: new Date(base + index * 1_000),
      })),
    });
    const result = await processInputs(f.db, f.editorContext, {
      projectId: f.projectId,
      itemIds: "all",
    });
    expect(result).toMatchObject({ selected: 10, remaining: 3 });
    const chosen = await f.db.wikiInputItem.findMany({
      where: { runId: result.runId },
      select: { title: true, status: true, processStartedById: true },
    });
    expect(chosen.map((item) => item.title).sort()).toEqual(
      Array.from({ length: 10 }, (_, index) => `n${index}`).sort(),
    );
    expect(new Set(chosen.map((item) => item.status))).toEqual(
      new Set(["preparing"]),
    );
    expect(chosen[0]?.processStartedById).toBe(f.editorContext.userId);
  }, 15_000);

  it("takes only the chosen items", async () => {
    const f = await fixture();
    const a = await addNote(f, "a");
    await addNote(f, "b");
    const result = await processInputs(f.db, f.editorContext, {
      projectId: f.projectId,
      itemIds: [a.id],
    });
    expect(result).toMatchObject({ selected: 1, remaining: 1 });
  }, 15_000);

  it("two concurrent calls: one RUN_ACTIVE, no item in two runs", async () => {
    const f = await fixture();
    for (let index = 0; index < 4; index += 1) await addNote(f, `n${index}`);
    const results = await Promise.allSettled([
      processInputs(f.db, f.editorContext, {
        projectId: f.projectId,
        itemIds: "all",
      }),
      processInputs(f.db, f.ownerContext, {
        projectId: f.projectId,
        itemIds: "all",
      }),
    ]);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "CONFLICT",
      details: { reason: "RUN_ACTIVE" },
    });
    const runs = await f.db.wikiRun.findMany();
    expect(runs).toHaveLength(1);
    const items = await f.db.wikiInputItem.findMany();
    expect(new Set(items.map((item) => item.runId))).toEqual(
      new Set([runs[0]!.id]),
    );
  }, 15_000);

  it("refuses with nothing queued, without leaving a run", async () => {
    const f = await fixture();
    await expect(
      processInputs(f.db, f.editorContext, {
        projectId: f.projectId,
        itemIds: "all",
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      details: { reason: "NOTHING_QUEUED" },
    });
    expect(await f.db.wikiRun.count()).toBe(0);
  }, 15_000);

  it("a Viewer sees but cannot process", async () => {
    const f = await fixture();
    await addNote(f);
    await expect(
      processInputs(f.db, f.viewerContext, {
        projectId: f.projectId,
        itemIds: "all",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  }, 15_000);
});

async function startRun(f: Fixture, text = "A note") {
  const item = await addNote(f, text);
  const { runId } = await processInputs(f.db, f.editorContext, {
    projectId: f.projectId,
    itemIds: [item.id],
  });
  return { itemId: item.id, runId };
}

async function setRun(
  f: Fixture,
  runId: string,
  data: Parameters<Fixture["db"]["wikiRun"]["update"]>[0]["data"],
) {
  await f.db.wikiRun.update({ where: { id: runId }, data });
}

describe("run lifecycle", () => {
  beforeEach(resetDb);
  afterEach(() => setJobQueueForTests(null));

  it("disable cancels preparing and queued runs and returns items with a note", async () => {
    const f = await fixture();
    const { itemId, runId } = await startRun(f);
    await disableWiki(f.db, f.ownerContext, {
      projectId: f.projectId,
      expectedRevision: await revision(f),
    });
    const run = await f.db.wikiRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run).toMatchObject({
      status: "cancelled",
      stopReason: "wiki_disabled",
    });
    expect(run.endedAt).not.toBeNull();
    const item = await f.db.wikiInputItem.findUniqueOrThrow({
      where: { id: itemId },
    });
    expect(item).toMatchObject({ status: "queued", runId: null });
    expect(item.outcomeNote).toMatch(/disabled/);
    expect(item.text).toBe("A note");
  }, 15_000);

  it("revoke cancels too; a running run stays for its fence", async () => {
    const f = await fixture();
    const { runId } = await startRun(f);
    await setRun(f, runId, { status: "running" });
    await disableWiki(f.db, f.ownerContext, {
      projectId: f.projectId,
      expectedRevision: await revision(f),
    });
    expect(
      (await f.db.wikiRun.findUniqueOrThrow({ where: { id: runId } })).status,
    ).toBe("running");
    await setRun(f, runId, { status: "queued", queuedAt: new Date() });
    await revokeAgent(f.db, f.ownerContext, {
      projectId: f.projectId,
      expectedRevision: await revision(f),
    });
    expect(
      (await f.db.wikiRun.findUniqueOrThrow({ where: { id: runId } })).status,
    ).toBe("cancelled");
  }, 15_000);

  it("cancelRun returns items; a second cancel is a CONFLICT", async () => {
    const f = await fixture();
    const { itemId, runId } = await startRun(f);
    const input = { projectId: f.projectId, runId };
    await expect(cancelRun(f.db, f.viewerContext, input)).rejects.toMatchObject(
      { code: "FORBIDDEN" },
    );
    await cancelRun(f.db, f.editorContext, input);
    await expect(cancelRun(f.db, f.editorContext, input)).rejects.toMatchObject(
      {
        code: "CONFLICT",
        details: { reason: "RUN_ENDED" },
      },
    );
    expect(
      (await f.db.wikiInputItem.findUniqueOrThrow({ where: { id: itemId } }))
        .status,
    ).toBe("queued");
    await expect(
      cancelRun(f.db, f.ownerContext, {
        projectId: f.projectId,
        runId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  }, 15_000);

  it("the partial unique index frees up after a run ends", async () => {
    const f = await fixture();
    const { runId } = await startRun(f);
    await cancelRun(f.db, f.editorContext, { projectId: f.projectId, runId });
    await addNote(f);
    await expect(
      processInputs(f.db, f.editorContext, {
        projectId: f.projectId,
        itemIds: "all",
      }),
    ).resolves.toMatchObject({ selected: 2 });
  }, 15_000);

  it("a delivered run without a runner fails plainly and returns items", async () => {
    const f = await fixture();
    const { itemId, runId } = await startRun(f);
    await setRun(f, runId, { status: "queued", queuedAt: new Date() });
    await f.db.wikiInputItem.update({
      where: { id: itemId },
      data: { status: "ready" },
    });
    expect(await failRunWithoutRunner(f.db, runId)).toBe(true);
    const run = await f.db.wikiRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run).toMatchObject({
      status: "failed",
      errorCode: "RUNNER_UNAVAILABLE",
    });
    const item = await f.db.wikiInputItem.findUniqueOrThrow({
      where: { id: itemId },
    });
    expect(item).toMatchObject({ status: "queued", runId: null });
    expect(item.outcomeNote).toMatch(/does not run the wiki agent/);
    // A redelivery of a finished run is a no-op.
    expect(await failRunWithoutRunner(f.db, runId)).toBe(false);
  }, 15_000);

  it("the tick publishes queued runs with a singleton key per run", async () => {
    const f = await fixture();
    const queue = new FakeJobQueue();
    setJobQueueForTests(queue);
    const { runId } = await startRun(f);
    await setRun(f, runId, { status: "queued", queuedAt: new Date() });
    await runWikiTick(f.db);
    await runWikiTick(f.db);
    const published = queue.jobs.filter((job) => job.name === "wiki.run");
    expect(published).toEqual([{ name: "wiki.run", data: { runId } }]);
  }, 15_000);
});

describe("no worker", () => {
  beforeEach(resetDb);

  const old = (minutes: number) => new Date(Date.now() - minutes * 60_000);

  it("auto-cancels a queued run after 10 minutes with no active job", async () => {
    const f = await fixture();
    const { itemId, runId } = await startRun(f);
    await setRun(f, runId, { status: "queued", queuedAt: old(11) });
    const { cancelled } = await reapWikiRuns(f.db, {
      hasActiveRunJob: async () => false,
    });
    expect(cancelled).toBe(1);
    const run = await f.db.wikiRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run).toMatchObject({
      status: "cancelled",
      errorCode: "NO_WORKER",
      errorMessage: WIKI_NO_WORKER_MESSAGE,
    });
    const list = await listInputs(f.db, f.viewerContext, {
      projectId: f.projectId,
    });
    expect(list.lastRun?.errorMessage).toBe(WIKI_NO_WORKER_MESSAGE);
    expect(list.activeRun).toBeNull();
    const item = list.queue.find((entry) => entry.id === itemId);
    expect(item?.status).toBe("queued");
    expect(item?.outcomeNote).toContain(WIKI_NO_WORKER_MESSAGE);
  }, 15_000);

  it("waits under 10 minutes and while another run holds the worker", async () => {
    const f = await fixture();
    const { runId } = await startRun(f);
    await setRun(f, runId, { status: "queued", queuedAt: old(9) });
    expect(
      await reapWikiRuns(f.db, { hasActiveRunJob: async () => false }),
    ).toMatchObject({ cancelled: 0 });
    await setRun(f, runId, { queuedAt: old(11) });
    expect(
      await reapWikiRuns(f.db, { hasActiveRunJob: async () => true }),
    ).toMatchObject({ cancelled: 0 });
  }, 15_000);

  it("reads pg-boss for real", async () => {
    await expect(hasActiveWikiRunJob(getPrisma())).resolves.toBe(false);
  });

  it("75 minutes of preparing fails unparsed items and leaves nothing hanging", async () => {
    const f = await fixture();
    const { itemId, runId } = await startRun(f);
    await setRun(f, runId, { startedAt: old(76) });
    await reapWikiRuns(f.db);
    const item = await f.db.wikiInputItem.findUniqueOrThrow({
      where: { id: itemId },
    });
    expect(item).toMatchObject({
      status: "failed",
      errorCode: "PREPARE_TIMEOUT",
    });
    const run = await f.db.wikiRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run).toMatchObject({
      status: "stopped",
      stopReason: "no_ready_items",
    });
    expect(run.endedAt).not.toBeNull();
    // The queue is usable again and Retry brings the item back.
    await retryInput(f.db, f.editorContext, {
      projectId: f.projectId,
      itemId,
    });
    await expect(
      processInputs(f.db, f.editorContext, {
        projectId: f.projectId,
        itemIds: "all",
      }),
    ).resolves.toMatchObject({ selected: 1 });
  }, 15_000);
});

describe("remove, retry, confirm", () => {
  beforeEach(resetDb);

  it("remove clears the text at any removable state and a processing item refuses", async () => {
    const f = await fixture();
    const { itemId } = await startRun(f);
    await removeInput(f.db, f.editorContext, {
      projectId: f.projectId,
      itemId,
    });
    expect(
      await f.db.wikiInputItem.findUniqueOrThrow({ where: { id: itemId } }),
    ).toMatchObject({ status: "removed", text: null, runId: null });
    const other = await addNote(f, "other");
    await f.db.wikiInputItem.update({
      where: { id: other.id },
      data: { status: "processing" },
    });
    await expect(
      removeInput(f.db, f.editorContext, {
        projectId: f.projectId,
        itemId: other.id,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "NOT_REMOVABLE" },
    });
  }, 15_000);

  it("confirm is bound to the digest the Editor saw", async () => {
    const f = await fixture();
    const item = await addNote(f);
    const digest = "a".repeat(64);
    await f.db.wikiInputItem.update({
      where: { id: item.id },
      data: {
        status: "held",
        heldDigest: digest,
        heldHits: [{ kind: "jwt", location: "note, line 1" }],
      },
    });
    const input = { projectId: f.projectId, itemId: item.id };
    await expect(
      confirmInput(f.db, f.editorContext, {
        ...input,
        expectedDigest: "b".repeat(64),
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "HOLD_CHANGED" },
    });
    await expect(
      confirmInput(f.db, f.viewerContext, { ...input, expectedDigest: digest }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await confirmInput(f.db, f.editorContext, {
      ...input,
      expectedDigest: digest,
    });
    expect(
      await f.db.wikiInputItem.findUniqueOrThrow({ where: { id: item.id } }),
    ).toMatchObject({
      status: "queued",
      confirmedById: f.editorContext.userId,
      confirmedDigest: digest,
      heldHits: null,
    });
  }, 15_000);

  it("items of another project are NOT_FOUND", async () => {
    const f = await fixture();
    const item = await addNote(f);
    const other = await makeProject("Other");
    await addMembership(other.id, f.editorContext.userId, "Editor");
    await expect(
      retryInput(f.db, f.editorContext, {
        projectId: other.id,
        itemId: item.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  }, 15_000);
});

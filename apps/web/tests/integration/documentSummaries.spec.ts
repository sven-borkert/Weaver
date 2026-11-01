import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openProjectRepo } from "@weaver/git-store";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import {
  flushDiagnostics,
  startDiagnosticWriter,
  stopDiagnosticWriter,
  waitForDiagnosticWriterReady,
} from "@weaver/core/diagnostics/writer";
import {
  invalidateDiagnosticsSettingsCache,
  setDiagnosticsSettings,
} from "@weaver/core/services/diagnosticsSettings";
import {
  FakeJobQueue,
  setJobQueueForTests,
  type JobQueue,
} from "@weaver/core/jobs/queue";
import { registerKnowledgeJobHandlers } from "@weaver/core/jobs/runtime";
import { knowledgeSystemContextForTests } from "@weaver/core/jobs/systemContext";
import type { KnowledgeJobPayloads } from "@weaver/core/jobs/types";
import { parseKnowledgeConfig } from "@weaver/core/knowledge/config";
import {
  pruneDocumentChangeSummaries,
  reconcileDocumentChangeSummaries,
} from "@weaver/core/services/documentChangeSummaries";
import {
  addMembership,
  callerFor,
  getPrisma,
  makeProject,
  makeUser,
  noKnowledgeRouting,
  resetDb,
  securityContextFor,
  testEncryptionKeys,
} from "./_harness";

type SummaryPayload = KnowledgeJobPayloads["document.change-summary"];

async function setup(
  options: { configured?: boolean; requestTimeoutMs?: number } = {},
) {
  // Install the fake queue first so the create's search-sync never reaches pg-boss.
  const queue = new FakeJobQueue();
  setJobQueueForTests(queue);
  const editor = await makeUser("User", "summary-editor");
  const admin = await makeUser("Admin", "summary-admin");
  const project = await makeProject("Document summaries");
  await addMembership(project.id, editor.id, "Editor");
  const caller = callerFor(editor);
  const document = await caller.document.create({
    projectId: project.id,
    folderPath: [],
    title: "Original title",
    contentJson: parseDocumentBody("Original source sentinel"),
  });
  if (options.configured !== false) {
    const adminCaller = callerFor(admin);
    const connection = await adminCaller.llm.createConnection({
      name: "Summary provider",
      providerType: "openai_compatible",
      endpoint: "https://summary.example/v1",
      credential: "summary-secret",
      ...(options.requestTimeoutMs
        ? { requestTimeoutMs: options.requestTimeoutMs }
        : {}),
    });
    const model = await adminCaller.llm.createModel({
      connectionId: connection.id,
      providerModelId: "summary-chat",
      displayName: "Summary chat",
      capabilities: ["chat"],
      contextWindow: 8_000,
      inputCostMicrosPerMillion: 10,
      outputCostMicrosPerMillion: 20,
      currency: "USD",
    });
    await adminCaller.llm.setRoute({
      purpose: "document_summary",
      modelId: model.id,
    });
  }
  return {
    editor,
    admin,
    project,
    caller,
    document,
    queue,
    update: {
      projectId: project.id,
      documentId: document.id,
      baseCommitSha: document.headCommitSha,
      content: {
        kind: "markdown" as const,
        contentJson: parseDocumentBody("Revised source sentinel"),
      },
    },
  };
}

function summaryJob(queue: FakeJobQueue): SummaryPayload {
  const job = queue.jobs.find(
    (entry) => entry.name === "document.change-summary",
  );
  if (!job) throw new Error("no document.change-summary job queued");
  return job.data as SummaryPayload;
}

function summaryRow(projectId: string, commitSha: string) {
  return getPrisma().documentChangeSummary.findUnique({
    where: { projectId_commitSha: { projectId, commitSha } },
  });
}

const completion = (text = "Clarify the introduction") =>
  Response.json({
    choices: [
      { message: { role: "assistant", content: text }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
  });

async function worker(queue: FakeJobQueue, fetchImpl: typeof fetch) {
  await registerKnowledgeJobHandlers({
    queue,
    context: knowledgeSystemContextForTests(),
    db: getPrisma(),
    config: parseKnowledgeConfig(process.env),
    routing: noKnowledgeRouting,
    roles: new Set(["knowledge"]),
    changeSummaries: { ring: testEncryptionKeys(), fetchImpl },
  });
}

async function startWriter(admin: Parameters<typeof securityContextFor>[0]) {
  const db = getPrisma();
  await setDiagnosticsSettings(db, securityContextFor(admin), {
    level: "verbose",
  });
  startDiagnosticWriter({ db, runtime: "worker", flushIntervalMs: 60_000 });
  await waitForDiagnosticWriterReady();
}

describe("document summary saves", () => {
  beforeEach(async () => {
    vi.stubEnv("WEAVER_JOBS_ENABLED", "true");
    await resetDb();
  });
  afterEach(async () => {
    setJobQueueForTests(null);
    await stopDiagnosticWriter();
    invalidateDiagnosticsSettingsCache();
    vi.unstubAllEnvs();
  });

  it("commits a plain message and queues a pending summary", async () => {
    const { caller, project, document, queue, update } = await setup();
    const saved = await caller.document.update({
      ...update,
      title: "Renamed title",
    });
    expect(Object.keys(saved).sort()).toEqual([
      "headCommitSha",
      "id",
      "path",
      "slug",
      "title",
    ]);
    const history = await caller.document.history({
      projectId: project.id,
      documentId: document.id,
      limit: 1,
    });
    expect(history.entries[0]).toMatchObject({
      sha: saved.headCommitSha,
      message: "update: renamed-title.md (was original-title.md)",
    });
    expect(await summaryRow(project.id, saved.headCommitSha)).toMatchObject({
      status: "pending",
      attempts: 0,
      documentId: document.id,
      baseCommitSha: update.baseCommitSha,
      pathAtSha: "renamed-title.md",
      basePathAtSha: "original-title.md",
    });
    expect(summaryJob(queue)).toEqual({
      projectId: project.id,
      documentId: document.id,
      commitSha: saved.headCommitSha,
      baseCommitSha: update.baseCommitSha,
      pathAtSha: "renamed-title.md",
    });
  });

  it("keeps explicit comments in the commit and queues nothing", async () => {
    const { caller, project, queue, update } = await setup();
    const saved = await caller.document.update({
      ...update,
      changeSummary: "My explicit comment",
    });
    const history = await caller.document.history({
      projectId: project.id,
      documentId: update.documentId,
      limit: 1,
    });
    expect(history.entries[0]?.message).toBe(
      "update: original-title.md — My explicit comment",
    );
    expect(await summaryRow(project.id, saved.headCommitSha)).toBeNull();
    expect(
      queue.jobs.filter((job) => job.name === "document.change-summary"),
    ).toEqual([]);
  });

  it("writes nothing when no summary route is configured", async () => {
    const { caller, project, queue, update } = await setup({
      configured: false,
    });
    const saved = await caller.document.update(update);
    expect(await summaryRow(project.id, saved.headCommitSha)).toBeNull();
    expect(
      queue.jobs.some((job) => job.name === "document.change-summary"),
    ).toBe(false);
  });

  it("rejects unauthorized saves before queueing", async () => {
    const { project, queue, update } = await setup();
    const viewer = await makeUser("User", "summary-viewer");
    await addMembership(project.id, viewer.id, "Viewer");
    await expect(
      callerFor(viewer).document.update(update),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const outsider = await makeUser("Admin", "summary-outsider");
    await expect(
      callerFor(outsider).document.update(update),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      queue.jobs.filter((job) => job.name === "document.change-summary"),
    ).toEqual([]);
    expect(await getPrisma().documentChangeSummary.count()).toBe(0);
  });

  it("keeps the save and logs a warning when the job cannot be published", async () => {
    const { admin, caller, document, update } = await setup();
    const db = getPrisma();
    await setDiagnosticsSettings(db, securityContextFor(admin), {
      level: "standard",
    });
    startDiagnosticWriter({ db, runtime: "web", flushIntervalMs: 60_000 });
    await waitForDiagnosticWriterReady();
    const failing: JobQueue = {
      send: async () => {
        throw new Error("queue unavailable");
      },
      work: async () => undefined,
      schedule: async () => undefined,
      stop: async () => undefined,
    };
    setJobQueueForTests(failing);
    const saved = await caller.document.update(update);
    expect(
      await summaryRow(update.projectId, saved.headCommitSha),
    ).toMatchObject({ status: "pending", attempts: 0 });
    await flushDiagnostics(true);
    expect(
      await db.diagnosticEvent.findFirst({
        where: { event: "document.summary.retrying", documentId: document.id },
      }),
    ).toMatchObject({
      severity: "warn",
      runtime: "web",
      details: expect.objectContaining({
        reason: "enqueue",
        commitSha: saved.headCommitSha,
      }),
    });
  });
});

describe("document summary worker", () => {
  beforeEach(async () => {
    vi.stubEnv("WEAVER_JOBS_ENABLED", "true");
    await resetDb();
  });
  afterEach(async () => {
    setJobQueueForTests(null);
    await stopDiagnosticWriter();
    invalidateDiagnosticsSettingsCache();
    vi.unstubAllEnvs();
  });

  it("completes a summary with usage and metadata-only events", async () => {
    const { admin, caller, project, document, queue, update } = await setup();
    await startWriter(admin);
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      completion("Generated summary sentinel"),
    );
    await worker(queue, fetchImpl);
    const saved = await caller.document.update({
      ...update,
      title: "Renamed title",
    });
    await queue.run("document.change-summary", summaryJob(queue), {
      jobId: "summary-job",
    });

    const request = JSON.parse(
      fetchImpl.mock.calls[0]?.[1]?.body as string,
    ) as { messages: { content: string }[] };
    expect(request.messages[1]?.content).toContain("Original title");
    expect(request.messages[1]?.content).toContain("Renamed title");
    expect(request.messages[1]?.content).toContain("Revised source sentinel");
    expect(await summaryRow(project.id, saved.headCommitSha)).toMatchObject({
      status: "ready",
      summary: "Generated summary sentinel",
      attempts: 1,
      failureReason: null,
    });
    const db = getPrisma();
    expect(
      await db.aiUsage.findMany({ where: { documentId: document.id } }),
    ).toEqual([
      expect.objectContaining({
        operation: "document.change_summary",
        outcome: "success",
        jobId: "summary-job",
        inputTokens: 20,
        outputTokens: 4,
      }),
    ]);
    await flushDiagnostics(true);
    const events = await db.diagnosticEvent.findMany({
      where: { documentId: document.id },
    });
    expect(
      events.find((event) => event.event === "document.summary.completed"),
    ).toMatchObject({
      severity: "info",
      jobId: "summary-job",
      projectId: project.id,
      details: expect.objectContaining({
        commitSha: saved.headCommitSha,
        attempts: 1,
      }),
    });
    expect(events.find((event) => event.event === "ai.request")).toMatchObject({
      hasRequestBody: false,
      hasResponseBody: false,
    });
    expect(JSON.stringify(events)).not.toMatch(
      /source sentinel|Generated summary sentinel|summary-secret/,
    );
  });

  it("retries a timeout twice, then fails with timeout and logs every attempt", async () => {
    const { admin, caller, project, document, queue, update } = await setup({
      requestTimeoutMs: 1_000,
    });
    await startWriter(admin);
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason as Error),
            { once: true },
          );
        }),
    );
    await worker(queue, fetchImpl);
    const saved = await caller.document.update(update);
    const job = summaryJob(queue);
    await expect(
      queue.run("document.change-summary", job, { retryCount: 0 }),
    ).rejects.toThrow("timed out");
    await expect(
      queue.run("document.change-summary", job, { retryCount: 1 }),
    ).rejects.toThrow("timed out");
    await queue.run("document.change-summary", job, { retryCount: 2 });

    expect(await summaryRow(project.id, saved.headCommitSha)).toMatchObject({
      status: "failed",
      failureReason: "timeout",
      attempts: 3,
    });
    const db = getPrisma();
    expect(
      (await db.aiUsage.findMany({ where: { documentId: document.id } })).map(
        (row) => row.outcome,
      ),
    ).toEqual(["provider_failure", "provider_failure", "provider_failure"]);
    await flushDiagnostics(true);
    const events = await db.diagnosticEvent.findMany({
      where: { documentId: document.id },
    });
    const named = (name: string) =>
      events.filter((event) => event.event === name);
    expect(named("document.summary.retrying")).toHaveLength(2);
    expect(named("job.failed")).toHaveLength(2);
    expect(named("ai.request").map((event) => event.outcome)).toEqual([
      "timeout",
      "timeout",
      "timeout",
    ]);
    expect(named("document.summary.failed")).toEqual([
      expect.objectContaining({
        severity: "error",
        outcome: "timeout",
        details: expect.objectContaining({ reason: "timeout", attempts: 3 }),
      }),
    ]);
  });

  it("retries a non-provider error via job.failed instead of recording a permanent failure", async () => {
    const { admin, caller, project, document, queue, update } = await setup();
    const db = getPrisma();
    await setDiagnosticsSettings(db, securityContextFor(admin), {
      level: "standard",
    });
    startDiagnosticWriter({ db, runtime: "worker", flushIntervalMs: 60_000 });
    await waitForDiagnosticWriterReady();
    const fetchImpl = vi.fn<typeof fetch>(async () => completion());
    // A null key ring makes decryptConnectionCredential throw a CoreError
    // before any fetch, which is deterministic and not an AiProviderError.
    await registerKnowledgeJobHandlers({
      queue,
      context: knowledgeSystemContextForTests(),
      db,
      config: parseKnowledgeConfig(process.env),
      routing: noKnowledgeRouting,
      roles: new Set(["knowledge"]),
      changeSummaries: { ring: null, fetchImpl },
    });
    const saved = await caller.document.update(update);
    const job = summaryJob(queue);
    await expect(
      queue.run("document.change-summary", job, { jobId: "summary-job" }),
    ).rejects.toThrow(/Encryption keys/);

    expect(await summaryRow(project.id, saved.headCommitSha)).toMatchObject({
      status: "pending",
      attempts: 1,
      failureReason: null,
      lastErrorClass: "CoreError",
      lastJobId: "summary-job",
    });
    expect(
      await db.aiUsage.findMany({ where: { documentId: document.id } }),
    ).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    await flushDiagnostics(true);
    expect(
      await db.diagnosticEvent.findFirst({
        where: { event: "job.failed", documentId: document.id },
      }),
    ).toMatchObject({ severity: "error" });

    await db.documentChangeSummary.updateMany({
      where: { projectId: project.id, commitSha: saved.headCommitSha },
      data: { attempts: 3 },
    });
    await queue.run("document.change-summary", job, {
      jobId: "summary-job-2",
    });
    expect(await summaryRow(project.id, saved.headCommitSha)).toMatchObject({
      status: "failed",
      failureReason: "abandoned",
    });
    await flushDiagnostics(true);
    expect(
      await db.diagnosticEvent.findFirst({
        where: {
          event: "document.summary.failed",
          documentId: document.id,
        },
      }),
    ).toMatchObject({
      details: expect.objectContaining({ reason: "abandoned" }),
    });
  });

  it("fails unusable output without retrying", async () => {
    const { caller, project, document, queue, update } = await setup();
    await worker(
      queue,
      vi.fn<typeof fetch>(async () => completion("x".repeat(121))),
    );
    const saved = await caller.document.update(update);
    await queue.run("document.change-summary", summaryJob(queue));
    expect(await summaryRow(project.id, saved.headCommitSha)).toMatchObject({
      status: "failed",
      failureReason: "validation",
      attempts: 1,
    });
    expect(
      await getPrisma().aiUsage.findMany({
        where: { documentId: document.id },
      }),
    ).toEqual([expect.objectContaining({ outcome: "validation_failure" })]);
  });

  it("fails once on a non-retryable provider error without leaking the response body", async () => {
    const { admin, caller, project, document, queue, update } = await setup();
    await startWriter(admin);
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response("private upstream detail", { status: 400 }),
    );
    await worker(queue, fetchImpl);
    const saved = await caller.document.update(update);
    await queue.run("document.change-summary", summaryJob(queue));

    expect(await summaryRow(project.id, saved.headCommitSha)).toMatchObject({
      status: "failed",
      failureReason: "provider",
      lastErrorClass: "AiProviderError",
      attempts: 1,
    });
    const db = getPrisma();
    expect(
      await db.aiUsage.findMany({ where: { documentId: document.id } }),
    ).toEqual([expect.objectContaining({ outcome: "provider_failure" })]);
    await flushDiagnostics(true);
    const events = await db.diagnosticEvent.findMany({
      where: { documentId: document.id },
    });
    expect(
      events.find((event) => event.event === "document.summary.failed"),
    ).toMatchObject({
      severity: "error",
      outcome: "error",
      statusCode: 400,
      details: expect.objectContaining({ reason: "provider" }),
    });
    expect(JSON.stringify(events)).not.toContain("private upstream detail");
  });

  it("skips unchanged content and removed routes, and fails unreadable versions", async () => {
    const { caller, project, document, queue, update } = await setup();
    const fetchImpl = vi.fn<typeof fetch>(async () => completion());
    await worker(queue, fetchImpl);
    const db = getPrisma();

    const unchanged = await caller.document.update({
      ...update,
      content: {
        kind: "markdown",
        contentJson: parseDocumentBody("Original source sentinel"),
      },
    });
    await queue.run("document.change-summary", summaryJob(queue));
    expect(await summaryRow(project.id, unchanged.headCommitSha)).toMatchObject(
      { status: "skipped", failureReason: "no_change" },
    );

    queue.jobs.length = 0;
    const changed = await caller.document.update({
      ...update,
      baseCommitSha: unchanged.headCommitSha,
    });

    const missing = {
      projectId: project.id,
      documentId: document.id,
      commitSha: "f".repeat(40),
      baseCommitSha: changed.headCommitSha,
      pathAtSha: changed.path,
    };
    const now = new Date();
    await db.documentChangeSummary.create({
      data: { ...missing, status: "pending", createdAt: now, updatedAt: now },
    });
    await queue.run("document.change-summary", missing);
    expect(await summaryRow(project.id, missing.commitSha)).toMatchObject({
      status: "failed",
      failureReason: "source_missing",
    });

    await db.llmRoute.deleteMany({ where: { purpose: "document_summary" } });
    await queue.run("document.change-summary", summaryJob(queue));
    expect(await summaryRow(project.id, changed.headCommitSha)).toMatchObject({
      status: "skipped",
      failureReason: "no_route",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not let a stale delivery overwrite a newer claim", async () => {
    const { caller, project, queue, update } = await setup();
    const state: { job?: SummaryPayload } = {};
    await worker(
      queue,
      vi.fn<typeof fetch>(async () => {
        await getPrisma().documentChangeSummary.updateMany({
          where: { commitSha: state.job!.commitSha },
          data: { attempts: { increment: 1 } },
        });
        return completion();
      }),
    );
    const saved = await caller.document.update(update);
    state.job = summaryJob(queue);
    await queue.run("document.change-summary", state.job);
    expect(await summaryRow(project.id, saved.headCommitSha)).toMatchObject({
      status: "pending",
      attempts: 2,
      summary: null,
    });
  });

  it("fails a pending summary that already used every attempt", async () => {
    const { caller, project, queue, update } = await setup();
    const fetchImpl = vi.fn<typeof fetch>(async () => completion());
    await worker(queue, fetchImpl);
    const saved = await caller.document.update(update);
    await getPrisma().documentChangeSummary.updateMany({
      data: { attempts: 3, failureReason: "provider" },
    });
    await queue.run("document.change-summary", summaryJob(queue));
    expect(await summaryRow(project.id, saved.headCommitSha)).toMatchObject({
      status: "failed",
      failureReason: "provider",
      attempts: 3,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("re-queues stale pending summaries and abandons day-old ones", async () => {
    const { caller, project, queue, update } = await setup();
    const saved = await caller.document.update(update);
    const db = getPrisma();
    const now = new Date();
    queue.jobs.length = 0;
    await db.documentChangeSummary.updateMany({
      data: { updatedAt: new Date(now.getTime() - 16 * 60_000) },
    });
    expect(await reconcileDocumentChangeSummaries(db, now)).toEqual({
      requeued: 1,
      abandoned: 0,
    });
    expect(summaryJob(queue).commitSha).toBe(saved.headCommitSha);

    await db.documentChangeSummary.updateMany({
      data: { createdAt: new Date(now.getTime() - 25 * 60 * 60_000) },
    });
    expect(await reconcileDocumentChangeSummaries(db, now)).toEqual({
      requeued: 0,
      abandoned: 1,
    });
    expect(await summaryRow(project.id, saved.headCommitSha)).toMatchObject({
      status: "failed",
      failureReason: "abandoned",
    });
  });

  it("reads the base version at the stored path across a rename with a full rewrite", async () => {
    const { caller, project, queue, update } = await setup();
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      completion("Rewrote and renamed the note"),
    );
    await worker(queue, fetchImpl);
    const saved = await caller.document.update({
      ...update,
      title: "Completely different title",
      content: {
        kind: "markdown",
        contentJson: parseDocumentBody("zebra quartz lantern ".repeat(200)),
      },
    });
    const repo = await openProjectRepo(project.id);
    expect(
      await repo!.renamedPathBetween(
        saved.headCommitSha,
        update.baseCommitSha,
        saved.path,
      ),
    ).toBeNull();
    expect(await summaryRow(project.id, saved.headCommitSha)).toMatchObject({
      basePathAtSha: "original-title.md",
      pathAtSha: "completely-different-title.md",
    });
    await getPrisma().documentChangeSummary.updateMany({
      where: { projectId: project.id, commitSha: saved.headCommitSha },
      data: { lastErrorClass: "TimeoutError" },
    });

    await queue.run("document.change-summary", summaryJob(queue), {
      jobId: "rename-job",
    });

    expect(await summaryRow(project.id, saved.headCommitSha)).toMatchObject({
      status: "ready",
      lastJobId: "rename-job",
      lastErrorClass: null,
    });
    const request = JSON.parse(
      fetchImpl.mock.calls[0]?.[1]?.body as string,
    ) as { messages: { content: string }[] };
    expect(request.messages[1]?.content).toContain("Original source sentinel");
  });
});

describe("document summary retention", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("prunes old failed and skipped rows but keeps ready, recent, and pending rows", async () => {
    const project = await makeProject("Summary retention");
    const db = getPrisma();
    const now = new Date("2026-10-20T12:00:00.000Z");
    const daysAgo = (days: number) =>
      new Date(now.getTime() - days * 24 * 60 * 60_000);
    const row = (
      index: number,
      status: "pending" | "ready" | "failed" | "skipped",
      completedAt: Date | null,
    ) => ({
      projectId: project.id,
      commitSha: index.toString(16).padStart(40, "0"),
      documentId: "11111111-1111-4111-8111-111111111111",
      pathAtSha: "doc.md",
      baseCommitSha: "f".repeat(40),
      status,
      attempts: 1,
      createdAt: daysAgo(40),
      updatedAt: completedAt ?? daysAgo(40),
      completedAt,
    });
    await db.documentChangeSummary.createMany({
      data: [
        row(1, "failed", daysAgo(31)),
        row(2, "skipped", daysAgo(31)),
        row(3, "ready", daysAgo(31)),
        row(4, "failed", daysAgo(29)),
        row(5, "pending", null),
      ],
    });

    expect(await pruneDocumentChangeSummaries(db, now)).toBe(2);
    const remaining = await db.documentChangeSummary.findMany({
      orderBy: { commitSha: "asc" },
      select: { commitSha: true },
    });
    expect(
      remaining.map((item) => Number.parseInt(item.commitSha, 16)),
    ).toEqual([3, 4, 5]);
  });

  it("stops after the batch cap", async () => {
    const project = await makeProject("Summary retention cap");
    const db = getPrisma();
    const now = new Date("2026-10-20T12:00:00.000Z");
    const old = new Date(now.getTime() - 40 * 24 * 60 * 60_000);
    await db.documentChangeSummary.createMany({
      data: Array.from({ length: 7 }, (_, index) => ({
        projectId: project.id,
        commitSha: (index + 1).toString(16).padStart(40, "0"),
        documentId: "11111111-1111-4111-8111-111111111111",
        pathAtSha: "doc.md",
        baseCommitSha: "f".repeat(40),
        status: "failed" as const,
        attempts: 3,
        createdAt: old,
        updatedAt: old,
        completedAt: old,
      })),
    });

    expect(
      await pruneDocumentChangeSummaries(db, now, {
        batchSize: 2,
        maxBatches: 2,
      }),
    ).toBe(4);
    expect(await db.documentChangeSummary.count()).toBe(3);
  });
});

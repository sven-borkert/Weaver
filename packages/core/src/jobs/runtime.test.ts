vi.mock("../services/examOperations", () => ({
  pruneExamOperations: vi.fn().mockResolvedValue(0),
}));
vi.mock("../exams/tick", () => ({ runExamTick: vi.fn() }));
vi.mock("../services/documents", () => ({
  repairDocumentProjectionInRepo: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/projectRepo", () => ({
  withExistingProjectRepoReader: vi.fn(
    async (_id: string, fn: (repo: unknown) => Promise<unknown>) => fn({}),
  ),
}));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticEmitInput } from "../diagnostics/writer";
import type * as IngestionHandlers from "./ingestionHandlers";
import { KNOWLEDGE_JOB_NAMES } from "./types";

// task.tick/task.run/project.git-* are gated behind the tasks/git roles,
// which the mocked WEAVER_WORKER_ROLES below excludes.
const HANDLED_JOB_NAMES = KNOWLEDGE_JOB_NAMES.filter(
  (name) =>
    ![
      "artifact.notebook.prepare",
      "task.tick",
      "exam.tick",
      "task.run",
      "project.git-sync",
      "project.git-push",
      "project.git-pull",
    ].includes(name),
);

const gitRemoteOperations = vi.hoisted(() => ({
  discoverProjectGitRemotes: vi.fn(),
  pushProjectGitRemote: vi.fn(),
  pullProjectGitRemote: vi.fn(),
}));
vi.mock("../services/projectGitRemoteJobs", () => gitRemoteOperations);
vi.mock("../services/artifactNotebookJobs", () => ({
  reconcileArtifactNotebooks: vi.fn(),
}));

vi.mock("@weaver/db", () => ({ db: {} }));
vi.mock("@weaver/config/server", () => ({
  parseServerEnv: () => ({
    WEAVER_DATA_DIR: "./data-test",
    WEAVER_WORKER_ROLES: new Set(["knowledge", "assistant", "ingestion"]),
  }),
}));

const fakePgBoss = vi.hoisted(() => ({
  instances: [] as Array<{
    startCalls: number;
    stopCalls: number;
    workCalls: number;
    scheduleCalls: number;
    sendCalls: number;
  }>,
  startPromises: [] as Promise<void>[],
  stopPromises: [] as Promise<void>[],
  schedulePromises: [] as Promise<void>[],
}));

const knowledgeOperations = vi.hoisted(() => ({
  blockGenerationBuildForConfiguration: vi.fn(),
  blockGenerationDocumentForConfiguration: vi.fn(),
  deleteKnowledgeContent: vi.fn(),
  ensureGenerationForCurrentConfig: vi.fn(),
  processGenerationDocument: vi.fn(),
  recordDocumentChangeForGenerations: vi.fn(),
  resumeGenerationBuild: vi.fn(),
}));

vi.mock("../services/knowledgeGenerations", () => knowledgeOperations);
vi.mock("../services/keywordIndex", () => ({
  syncDocumentKeywordIndex: vi.fn().mockResolvedValue({ outcome: "indexed" }),
  syncTableKeywordIndex: vi.fn(),
}));
const reconciliationOperations = vi.hoisted(() => ({
  reconcileAllProjects: vi.fn(),
  reconcileProjectKnowledge: vi.fn(),
}));
vi.mock("../services/knowledgeReconciliation", () => reconciliationOperations);

const ingestionReconciliation = vi.hoisted(() => ({
  sweepAbandonedUploads: vi.fn(),
  reconcileIngestionFiles: vi.fn(),
}));
vi.mock("./ingestionHandlers", async (importOriginal) => ({
  ...(await importOriginal<typeof IngestionHandlers>()),
  ...ingestionReconciliation,
}));

const assistantOperations = vi.hoisted(() => ({
  reconcileAssistantRuns: vi.fn(),
}));
vi.mock("../services/assistantRuns", () => assistantOperations);

const taskOperations = vi.hoisted(() => ({
  runTaskTick: vi.fn(),
}));
vi.mock("../scheduledTasks/tick", () => taskOperations);

const externalMcpOperations = vi.hoisted(() => ({
  reconcileExternalMcpState: vi
    .fn()
    .mockResolvedValue({ approvals: 0, calls: 0, pruned: 0 }),
}));
vi.mock("../services/externalMcp/retention", () => externalMcpOperations);

const backgroundWorkOperations = vi.hoisted(() => ({
  pruneBackgroundWorkReceipts: vi.fn().mockResolvedValue(0),
}));
vi.mock("../services/backgroundWork", () => backgroundWorkOperations);
const processingOperations = vi.hoisted(() => ({
  pruneProcessingHistory: vi.fn(),
}));
vi.mock("../services/processingRetention", () => processingOperations);

vi.mock("../services/diagnosticEvents", () => ({
  pruneDiagnosticEvents: vi.fn(),
}));
vi.mock("../services/diagnosticsSettings", () => ({
  getDiagnosticsSettings: vi.fn(),
}));

const mcpOperations = vi.hoisted(() => ({
  pruneMcpRecords: vi.fn(),
}));
const projectApiOperations = vi.hoisted(() => ({
  pruneProjectApiRecords: vi.fn(),
}));
vi.mock("../projectApi/retention", () => projectApiOperations);
vi.mock("../services/mcpOperations", () => mcpOperations);

const changeSummaryOperations = vi.hoisted(() => ({
  runDocumentChangeSummary: vi.fn(),
  reconcileDocumentChangeSummaries: vi
    .fn()
    .mockResolvedValue({ requeued: 0, abandoned: 0 }),
  pruneDocumentChangeSummaries: vi.fn().mockResolvedValue(0),
}));
vi.mock("../services/documentChangeSummaries", () => changeSummaryOperations);
const headerOperations = vi.hoisted(() => ({
  upgradeDocumentHeaders: vi
    .fn()
    .mockResolvedValue({ projects: 0, documents: 0 }),
}));
vi.mock("../services/documentHeaderUpgrade", () => headerOperations);
const folderOperations = vi.hoisted(() => ({
  upgradeFolderMetadata: vi.fn().mockResolvedValue({ projects: 0, folders: 0 }),
}));
vi.mock("../services/folderMetadataUpgrade", () => folderOperations);

const diagnosticOperations = vi.hoisted(() => ({
  emitDiagnostic: vi.fn<(input: DiagnosticEmitInput) => void>(),
}));
vi.mock("../diagnostics/writer", () => diagnosticOperations);

vi.mock("./pgBossQueue", () => ({
  PgBossQueue: class {
    startCalls = 0;
    stopCalls = 0;
    workCalls = 0;
    scheduleCalls = 0;
    sendCalls = 0;

    constructor() {
      fakePgBoss.instances.push(this);
    }

    start(): Promise<void> {
      this.startCalls += 1;
      return fakePgBoss.startPromises.shift() ?? Promise.resolve();
    }

    stop(): Promise<void> {
      this.stopCalls += 1;
      return fakePgBoss.stopPromises.shift() ?? Promise.resolve();
    }

    work(): Promise<void> {
      this.workCalls += 1;
      return Promise.resolve();
    }

    schedule(): Promise<void> {
      this.scheduleCalls += 1;
      return fakePgBoss.schedulePromises.shift() ?? Promise.resolve();
    }

    send(): Promise<string | null> {
      this.sendCalls += 1;
      return Promise.resolve("job-id");
    }
  },
}));

import { stopKnowledgePublisher } from "./publisher";
import { FakeJobQueue, requestKnowledgeJob } from "./queue";
import {
  registerKnowledgeJobHandlers,
  startKnowledgeWorkers,
  stopKnowledgeWorkers,
} from "./runtime";

type AssistantRunner = NonNullable<
  Parameters<typeof registerKnowledgeJobHandlers>[0]["assistantRunner"]
>;

function registerAssistantHandler(
  queue: FakeJobQueue,
  assistantRunner: AssistantRunner,
): Promise<void> {
  return registerKnowledgeJobHandlers({
    queue,
    context: {} as never,
    db: {} as never,
    dataDir: "/tmp/weaver-runtime-test",
    config: {
      reconcileCron: "*/15 * * * *",
      assistantReconcileCron: "* * * * *",
      ingestionTmpTtlMinutes: 60,
    } as never,
    routing: {
      resolve: vi.fn(),
      resolveFresh: vi.fn(),
      providerFor: vi.fn(),
    },
    assistantRunner,
    ingestionParseRunner: vi.fn(),
  });
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.stubEnv("WEAVER_JOBS_ENABLED", "true");
  reconciliationOperations.reconcileAllProjects.mockClear();
  assistantOperations.reconcileAssistantRuns.mockClear();
  externalMcpOperations.reconcileExternalMcpState.mockClear();
  ingestionReconciliation.sweepAbandonedUploads.mockClear();
  ingestionReconciliation.reconcileIngestionFiles.mockClear();
  mcpOperations.pruneMcpRecords.mockClear();
  projectApiOperations.pruneProjectApiRecords.mockClear();
  backgroundWorkOperations.pruneBackgroundWorkReceipts
    .mockReset()
    .mockResolvedValue(0);
  diagnosticOperations.emitDiagnostic.mockClear();
});

afterEach(async () => {
  await stopKnowledgeWorkers();
  await stopKnowledgePublisher();
  fakePgBoss.instances.length = 0;
  fakePgBoss.startPromises.length = 0;
  fakePgBoss.stopPromises.length = 0;
  fakePgBoss.schedulePromises.length = 0;
  vi.unstubAllEnvs();
});

describe("knowledge worker runtime", () => {
  describe("job diagnostic severity", () => {
    let queue: FakeJobQueue;
    const routineJobs = [
      {
        name: "project.git-sync",
        operation: gitRemoteOperations.discoverProjectGitRemotes,
      },
      { name: "task.tick", operation: taskOperations.runTaskTick },
      {
        name: "assistant.reconcile",
        operation: assistantOperations.reconcileAssistantRuns,
      },
    ] as const;

    beforeEach(async () => {
      queue = new FakeJobQueue();
      for (const { operation } of routineJobs) operation.mockReset();
      await registerKnowledgeJobHandlers({
        queue,
        context: {} as never,
        db: {} as never,
        dataDir: "/tmp/weaver-runtime-test",
        config: {} as never,
        routing: {
          resolve: vi.fn(),
          resolveFresh: vi.fn(),
          providerFor: vi.fn(),
        },
        roles: new Set(["git", "tasks", "assistant"]),
      });
    });

    it.each(routineJobs)(
      "emits debug lifecycle events when $name succeeds",
      async ({ name }) => {
        await queue.run(name, {});

        expect(
          diagnosticOperations.emitDiagnostic.mock.calls.map(([event]) => ({
            event: event.event,
            severity: event.severity ?? "info",
          })),
        ).toEqual([
          { event: "job.started", severity: "debug" },
          { event: "job.completed", severity: "debug" },
        ]);
      },
    );

    it.each(routineJobs)(
      "keeps $name failures at error severity and rethrows for queue recovery",
      async ({ name, operation }) => {
        const error = new Error("routine check failed");
        operation.mockRejectedValueOnce(error);

        await expect(queue.run(name, {})).rejects.toBe(error);

        expect(
          diagnosticOperations.emitDiagnostic.mock.calls.map(([event]) => ({
            event: event.event,
            severity: event.severity ?? "info",
          })),
        ).toEqual([
          { event: "job.started", severity: "debug" },
          { event: "job.failed", severity: "error" },
        ]);
      },
    );

    it("keeps actual Git push lifecycle events at info severity", async () => {
      await queue.run("project.git-push", {
        projectId: "project-id",
        queueToken: "queue-token",
      });

      expect(
        diagnosticOperations.emitDiagnostic.mock.calls.map(([event]) => ({
          event: event.event,
          severity: event.severity ?? "info",
        })),
      ).toEqual([
        { event: "job.started", severity: "info" },
        { event: "job.completed", severity: "info" },
      ]);
    });
  });

  it("classifies handler failures without logging arbitrary error content", async () => {
    const queue = new FakeJobQueue();
    const error = new Error(
      "PROMPT_MARKER_9 message=PRIVATE_CHAT DOCUMENT_CONTENT_9",
    );
    await registerKnowledgeJobHandlers({
      queue,
      context: {} as never,
      db: {} as never,
      dataDir: "/tmp/weaver-runtime-test",
      config: {
        reconcileCron: "*/15 * * * *",
        assistantReconcileCron: "* * * * *",
        ingestionTmpTtlMinutes: 60,
      } as never,
      routing: {
        resolve: vi.fn(),
        resolveFresh: vi.fn(),
        providerFor: vi.fn(),
      },
      assistantRunner: vi.fn().mockRejectedValue(error),
      ingestionParseRunner: vi.fn(),
    });

    await expect(
      queue.run(
        "assistant.run",
        { runId: "11111111-1111-4111-8111-111111111111" },
        { jobId: "job-9", retryCount: null },
      ),
    ).rejects.toBe(error);

    const failed = diagnosticOperations.emitDiagnostic.mock.calls
      .map(([event]) => event)
      .find((event) => event.event === "job.failed");
    expect(failed).toMatchObject({
      message: "assistant.run failed: Error",
      outcome: "error",
      details: {
        job: "assistant.run",
        retryCount: null,
        error: "Error",
      },
    });
    expect(JSON.stringify(failed)).not.toMatch(
      /PROMPT_MARKER_9|PRIVATE_CHAT|DOCUMENT_CONTENT_9/,
    );
  });

  it("isolates a throwing error name getter and rethrows the original object", async () => {
    const queue = new FakeJobQueue();
    const error = new Error("original job failure");
    const getterError = new Error("name getter failed");
    let nameReads = 0;
    Object.defineProperty(error, "name", {
      get() {
        nameReads += 1;
        throw getterError;
      },
    });
    await registerAssistantHandler(queue, vi.fn().mockRejectedValue(error));

    const rejection = await queue
      .run("assistant.run", {
        runId: "11111111-1111-4111-8111-111111111111",
      })
      .catch((thrown: unknown) => thrown);

    expect(rejection).toBe(error);
    expect(nameReads).toBe(1);
    const failed = diagnosticOperations.emitDiagnostic.mock.calls
      .map(([event]) => event)
      .find((event) => event.event === "job.failed");
    expect(failed).toMatchObject({
      message: "assistant.run failed: Error",
      outcome: "error",
      details: { error: "Error" },
    });
    expect(JSON.stringify(failed)).not.toContain(getterError.message);
  });

  it("reads a stateful error name once and never persists a later private value", async () => {
    const queue = new FakeJobQueue();
    const privateMarker = "PRIVATE_ERROR_NAME_MARKER_9";
    const error = new Error("original job failure");
    let nameReads = 0;
    Object.defineProperty(error, "name", {
      get() {
        nameReads += 1;
        return nameReads === 1 ? "TypeError" : privateMarker;
      },
    });
    await registerAssistantHandler(queue, vi.fn().mockRejectedValue(error));

    const rejection = await queue
      .run("assistant.run", {
        runId: "11111111-1111-4111-8111-111111111111",
      })
      .catch((thrown: unknown) => thrown);

    expect(rejection).toBe(error);
    expect(nameReads).toBe(1);
    const failed = diagnosticOperations.emitDiagnostic.mock.calls
      .map(([event]) => event)
      .find((event) => event.event === "job.failed");
    expect(failed).toMatchObject({
      message: "assistant.run failed: TypeError",
      outcome: "error",
      details: { error: "TypeError" },
    });
    expect(JSON.stringify(failed)).not.toContain(privateMarker);
  });

  it("records a resolved handler as cancelled when its delivery was aborted", async () => {
    const queue = new FakeJobQueue();
    const controller = new AbortController();
    const assistantRunner = vi.fn(async () => {
      controller.abort();
    });
    await registerKnowledgeJobHandlers({
      queue,
      context: {} as never,
      db: {} as never,
      dataDir: "/tmp/weaver-runtime-test",
      config: {
        reconcileCron: "*/15 * * * *",
        assistantReconcileCron: "* * * * *",
        ingestionTmpTtlMinutes: 60,
      } as never,
      routing: {
        resolve: vi.fn(),
        resolveFresh: vi.fn(),
        providerFor: vi.fn(),
      },
      assistantRunner,
      ingestionParseRunner: vi.fn(),
    });

    await expect(
      queue.run(
        "assistant.run",
        { runId: "11111111-1111-4111-8111-111111111111" },
        { jobId: "job-aborted", retryCount: 2, signal: controller.signal },
      ),
    ).resolves.toBeUndefined();

    const completed = diagnosticOperations.emitDiagnostic.mock.calls
      .map(([event]) => event)
      .find((event) => event.event === "job.completed");
    expect(completed).toMatchObject({
      message: "assistant.run completed after cancellation",
      outcome: "cancelled",
      details: { job: "assistant.run", retryCount: 2 },
    });
  });

  it("registers ingestion.parse through the injected runner with file-correlated instrumentation", async () => {
    const queue = new FakeJobQueue();
    const ingestionParseRunner = vi.fn(async () => undefined);
    await registerKnowledgeJobHandlers({
      queue,
      context: {} as never,
      db: {} as never,
      dataDir: "/tmp/weaver-runtime-test",
      config: {
        reconcileCron: "*/15 * * * *",
        assistantReconcileCron: "* * * * *",
        ingestionTmpTtlMinutes: 60,
      } as never,
      routing: {
        resolve: vi.fn(),
        resolveFresh: vi.fn(),
        providerFor: vi.fn(),
      },
      ingestionParseRunner,
    });
    const fileId = "11111111-1111-4111-8111-111111111111";
    const payload = {
      fileId,
      projectId: "22222222-2222-4222-8222-222222222222",
      contentDigest: "a".repeat(64),
      baseAttemptCount: 0,
    };
    await queue.run("ingestion.parse", payload, {
      jobId: "parse-job",
      retryCount: 1,
    });
    expect(ingestionParseRunner).toHaveBeenCalledWith(
      payload,
      expect.objectContaining({ jobId: "parse-job", retryCount: 1 }),
    );
    const events = diagnosticOperations.emitDiagnostic.mock.calls.map(
      ([event]) => event,
    );
    expect(events).toEqual([
      expect.objectContaining({
        event: "job.started",
        details: { job: "ingestion.parse", retryCount: 1, fileId },
      }),
      expect.objectContaining({
        event: "job.completed",
        details: { job: "ingestion.parse", retryCount: 1, fileId },
      }),
    ]);
  });

  it("removes only schedules disabled for the deployment, preserving other workers' roles", async () => {
    const queue = new FakeJobQueue();
    await queue.schedule("assistant.reconcile", "* * * * *");
    await queue.schedule("task.tick", "* * * * *");
    await queue.schedule("exam.tick", "* * * * *");
    await queue.schedule("project.git-sync", "* * * * *");
    const input = {
      queue,
      context: {} as never,
      db: {} as never,
      dataDir: "/tmp/weaver-schedules",
      config: { reconcileCron: "*/15 * * * *" } as never,
      roles: new Set(["ingestion"] as const),
      enabledRoles: new Set(["ingestion", "assistant"] as const),
      routing: {
        resolve: vi.fn(),
        resolveFresh: vi.fn(),
        providerFor: vi.fn(),
      },
    };
    await registerKnowledgeJobHandlers(input);
    expect(queue.schedules.map((schedule) => schedule.name)).toEqual([
      "assistant.reconcile",
      "system.reconcile",
    ]);
    await expect(
      registerKnowledgeJobHandlers({
        ...input,
        roles: new Set(["tasks"] as const),
      }),
    ).rejects.toThrow("WEAVER_ENABLED_WORKER_ROLES");
  });

  it("registers consumers per worker role and system.reconcile always", async () => {
    const baseInput = {
      context: {} as never,
      db: {} as never,
      dataDir: "/tmp/weaver-runtime-test",
      config: {
        reconcileCron: "*/15 * * * *",
        assistantReconcileCron: "* * * * *",
        taskTickCron: "* * * * *",
        ingestionTmpTtlMinutes: 60,
      } as never,
      routing: {
        resolve: vi.fn(),
        resolveFresh: vi.fn(),
        providerFor: vi.fn(),
      },
      artifactNotebookRunner: vi.fn(),
      assistantRunner: vi.fn(),
      ingestionParseRunner: vi.fn(),
      ingestionAnalyzeRunner: vi.fn(),
      ingestionLinkRunner: vi.fn(),
    };
    const register = async (
      roles: ReadonlySet<"knowledge" | "assistant" | "ingestion">,
    ) => {
      const queue = new FakeJobQueue();
      await registerKnowledgeJobHandlers({ ...baseInput, queue, roles });
      return queue;
    };
    const ingestionOnly = await register(new Set(["ingestion"]));
    expect([...ingestionOnly.handlers.keys()].sort()).toEqual([
      "artifact.notebook.prepare",
      "ingestion.analyze",
      "ingestion.link",
      "ingestion.parse",
      "system.reconcile",
    ]);
    expect(ingestionOnly.schedules.map((schedule) => schedule.name)).toEqual([
      "system.reconcile",
    ]);
    const knowledgeAssistant = await register(
      new Set(["knowledge", "assistant"]),
    );
    expect(knowledgeAssistant.handlers.has("ingestion.parse")).toBe(false);
    expect(knowledgeAssistant.handlers.has("artifact.notebook.prepare")).toBe(
      false,
    );
    expect(knowledgeAssistant.handlers.has("document.ai-enrich")).toBe(true);
    expect(knowledgeAssistant.handlers.has("document.change-summary")).toBe(
      true,
    );
    const summaryPayload = {
      projectId: "11111111-1111-4111-8111-111111111111",
      documentId: "22222222-2222-4222-8222-222222222222",
      commitSha: "b".repeat(40),
      baseCommitSha: "a".repeat(40),
      pathAtSha: "doc.md",
    };
    const summaryDeps = { ring: null, fetchImpl: vi.fn<typeof fetch>() };
    const summaryQueue = new FakeJobQueue();
    await registerKnowledgeJobHandlers({
      ...baseInput,
      queue: summaryQueue,
      roles: new Set(["knowledge"]),
      changeSummaries: summaryDeps,
    });
    await summaryQueue.run("document.change-summary", summaryPayload);
    expect(
      changeSummaryOperations.runDocumentChangeSummary,
    ).toHaveBeenCalledWith(
      baseInput.db,
      summaryPayload,
      expect.objectContaining({ jobId: "fake-run-1" }),
      summaryDeps,
    );
    expect(knowledgeAssistant.handlers.has("assistant.run")).toBe(true);
    expect(knowledgeAssistant.handlers.has("task.tick")).toBe(false);
    expect(knowledgeAssistant.handlers.has("exam.tick")).toBe(false);
    expect(
      knowledgeAssistant.schedules.map((schedule) => schedule.name).sort(),
    ).toEqual(["assistant.reconcile", "system.reconcile"]);
    const everything = await register(
      new Set(["knowledge", "assistant", "ingestion"]),
    );
    expect([...everything.handlers.keys()].sort()).toEqual(
      [...HANDLED_JOB_NAMES, "artifact.notebook.prepare"].sort(),
    );

    const gitQueue = new FakeJobQueue();
    await registerKnowledgeJobHandlers({
      ...baseInput,
      queue: gitQueue,
      roles: new Set(["git"]),
    });
    expect([...gitQueue.handlers.keys()].sort()).toEqual([
      "project.git-pull",
      "project.git-push",
      "project.git-sync",
      "system.reconcile",
    ]);
    expect(gitQueue.schedules).toContainEqual({
      name: "project.git-sync",
      cron: "* * * * *",
    });
    await gitQueue.run("project.git-sync", {});
    expect(gitRemoteOperations.discoverProjectGitRemotes).toHaveBeenCalledWith({
      db: baseInput.db,
      queue: gitQueue,
    });
    const gitPayload = { projectId: "project-id", queueToken: "queue-token" };
    await gitQueue.run("project.git-push", gitPayload);
    expect(gitRemoteOperations.pushProjectGitRemote).toHaveBeenCalledWith(
      expect.objectContaining({ db: baseInput.db, payload: gitPayload }),
    );
    const gitPullPayload = { projectId: "project-id", pullToken: "pull-token" };
    await gitQueue.run("project.git-pull", gitPullPayload);
    expect(gitRemoteOperations.pullProjectGitRemote).toHaveBeenCalledWith(
      expect.objectContaining({ db: baseInput.db, payload: gitPullPayload }),
    );

    const tasksQueue = new FakeJobQueue();
    await registerKnowledgeJobHandlers({
      ...baseInput,
      queue: tasksQueue,
      roles: new Set(["tasks"]),
    });
    expect([...tasksQueue.handlers.keys()].sort()).toEqual(
      ["system.reconcile", "task.run", "task.tick", "exam.tick"].sort(),
    );
    expect(tasksQueue.schedules).toEqual(
      expect.arrayContaining([
        { name: "task.tick", cron: "* * * * *" },
        { name: "exam.tick", cron: "* * * * *" },
      ]),
    );
  });

  it("skips ingestion.parse when the role is enabled but no runner is injected", async () => {
    const queue = new FakeJobQueue();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await registerKnowledgeJobHandlers({
      queue,
      context: {} as never,
      db: {} as never,
      dataDir: "/tmp/weaver-runtime-test",
      config: {
        reconcileCron: "*/15 * * * *",
        assistantReconcileCron: "* * * * *",
        ingestionTmpTtlMinutes: 60,
      } as never,
      routing: {
        resolve: vi.fn(),
        resolveFresh: vi.fn(),
        providerFor: vi.fn(),
      },
      roles: new Set(["ingestion"]),
    });
    expect(queue.handlers.has("ingestion.parse")).toBe(false);
    expect(queue.handlers.has("ingestion.analyze")).toBe(false);
    expect(queue.handlers.has("ingestion.link")).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("no ingestion parse runner"),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("no ingestion analyze runner"),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("no ingestion link runner"),
    );
    warn.mockRestore();
  });

  it.each([null, {}, { projectId: "invalid", documentId: "secret-body" }])(
    "acknowledges invalid knowledge payload without invoking persistence (%s)",
    async (payload) => {
      const queue = new FakeJobQueue();
      await registerKnowledgeJobHandlers({
        queue,
        context: {} as never,
        db: {} as never,
        dataDir: "/tmp/weaver-runtime-test",
        config: {} as never,
        routing: {
          resolve: vi.fn(),
          resolveFresh: vi.fn(),
          providerFor: vi.fn(),
        },
        roles: new Set(["knowledge"]),
      });
      await expect(
        queue.handlers.get("document.ai-enrich")!(payload as never, {
          jobId: "job",
          retryCount: null,
          signal: new AbortController().signal,
        }),
      ).resolves.toBeUndefined();
      expect(
        knowledgeOperations.processGenerationDocument,
      ).not.toHaveBeenCalled();
      expect(diagnosticOperations.emitDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "job.failed",
          details: expect.objectContaining({
            error: "invalid_payload",
          }) as object,
        }),
      );
      expect(
        JSON.stringify(diagnosticOperations.emitDiagnostic.mock.calls),
      ).not.toContain("secret-body");
    },
  );

  it.each(["document.ai-enrich", "project.generation-build"] as const)(
    "refreshes a stale cached route before handling %s",
    async (jobName) => {
      const handlers = new Map<string, (...args: never[]) => Promise<void>>();
      const queue = {
        work: vi.fn(async (name: string, handler: never) => {
          handlers.set(name, handler);
        }),
        schedule: vi.fn(),
      };
      const stale = { configFingerprint: "stale" };
      const snapshot = {
        connectionId: "connection",
        providerType: "openai_compatible",
        endpoint: "https://provider.test/v1",
        providerModelId: "model",
        inputCostMicrosPerMillion: null,
        outputCostMicrosPerMillion: null,
        currency: null,
      };
      const current = {
        configFingerprint: "current",
        embedding: { ...snapshot, providerModelId: "embedding" },
        extraction: { ...snapshot, providerModelId: "extraction" },
        embeddingDimensions: 1536,
      };
      const provider = {};
      const routing = {
        resolve: vi.fn().mockResolvedValue(stale),
        resolveFresh: vi.fn().mockResolvedValue(current),
        providerFor: vi.fn().mockReturnValue(provider),
      };

      await registerKnowledgeJobHandlers({
        queue: queue as never,
        context: {} as never,
        db: {} as never,
        dataDir: "/tmp/weaver-runtime-test",
        config: { reconcileCron: "0 3 * * *" } as never,
        routing,
        ingestionParseRunner: vi.fn(),
      });
      const payload = {
        projectId: "11111111-1111-4111-8111-111111111111",
        generationId: "22222222-2222-4222-8222-222222222222",
        configFingerprint: "current",
        ...(jobName === "document.ai-enrich"
          ? {
              documentId: "33333333-3333-4333-8333-333333333333",
              sourceCommitSha: "a".repeat(40),
              pathAtSha: "document.md",
            }
          : {}),
      };

      await handlers.get(jobName)?.(
        payload as never,
        {
          jobId: "job",
          retryCount: null,
          signal: new AbortController().signal,
        } as never,
      );

      expect(routing.resolveFresh).toHaveBeenCalledOnce();
      expect(
        knowledgeOperations.blockGenerationBuildForConfiguration,
      ).not.toHaveBeenCalled();
      expect(
        knowledgeOperations.blockGenerationDocumentForConfiguration,
      ).not.toHaveBeenCalled();
      if (jobName === "document.ai-enrich") {
        expect(
          knowledgeOperations.processGenerationDocument,
        ).toHaveBeenCalled();
        expect(routing.providerFor).toHaveBeenCalledWith(current);
      } else {
        expect(knowledgeOperations.resumeGenerationBuild).toHaveBeenCalled();
      }
    },
  );

  it("recovers assistant runs on their own cron, off the knowledge cadence", async () => {
    const handlers = new Map<string, (...args: never[]) => Promise<void>>();
    const schedules: Array<[string, string]> = [];
    const queue = {
      work: vi.fn(async (name: string, handler: never) => {
        handlers.set(name, handler);
      }),
      schedule: vi.fn(async (name: string, cron: string) => {
        schedules.push([name, cron]);
      }),
    };

    await registerKnowledgeJobHandlers({
      queue: queue as never,
      context: {} as never,
      db: {} as never,
      dataDir: "/tmp/weaver-runtime-test",
      config: {
        reconcileCron: "*/15 * * * *",
        assistantReconcileCron: "* * * * *",
        ingestionTmpTtlMinutes: 60,
      } as never,
      routing: {
        resolve: vi.fn(),
        resolveFresh: vi.fn(),
        providerFor: vi.fn(),
      },
      // Unrelated to tasks: keep this test's scope to the pre-existing roles.
      roles: new Set(["knowledge", "assistant", "ingestion"]),
      ingestionParseRunner: vi.fn(),
    });

    expect(schedules).toEqual([
      ["system.reconcile", "*/15 * * * *"],
      ["assistant.reconcile", "* * * * *"],
    ]);

    const execution = {
      jobId: "job",
      retryCount: null,
      signal: new AbortController().signal,
    } as never;
    // Knowledge reconciliation no longer drags assistant recovery to 15 minutes.
    await handlers.get("system.reconcile")?.({} as never, execution);
    expect(
      reconciliationOperations.reconcileAllProjects,
    ).toHaveBeenCalledOnce();
    expect(ingestionReconciliation.sweepAbandonedUploads).toHaveBeenCalledWith(
      {},
      { dataDir: "/tmp/weaver-runtime-test", ttlMinutes: 60 },
    );
    expect(
      ingestionReconciliation.reconcileIngestionFiles,
    ).toHaveBeenCalledWith({});
    expect(
      changeSummaryOperations.reconcileDocumentChangeSummaries,
    ).toHaveBeenCalledWith({}, expect.any(Date));
    expect(
      changeSummaryOperations.pruneDocumentChangeSummaries,
    ).toHaveBeenCalledWith({}, expect.any(Date));
    expect(headerOperations.upgradeDocumentHeaders).toHaveBeenCalledWith({});
    expect(folderOperations.upgradeFolderMetadata).toHaveBeenCalledWith({});
    expect(
      reconciliationOperations.reconcileAllProjects.mock.invocationCallOrder[0],
    ).toBeLessThan(
      ingestionReconciliation.sweepAbandonedUploads.mock
        .invocationCallOrder[0]!,
    );
    expect(
      externalMcpOperations.reconcileExternalMcpState,
    ).toHaveBeenCalledWith({}, expect.any(Date));
    expect(assistantOperations.reconcileAssistantRuns).not.toHaveBeenCalled();
    expect(mcpOperations.pruneMcpRecords).toHaveBeenCalledOnce();
    expect(projectApiOperations.pruneProjectApiRecords).toHaveBeenCalledOnce();
    expect(processingOperations.pruneProcessingHistory).toHaveBeenCalledWith(
      {},
    );
    expect(
      backgroundWorkOperations.pruneBackgroundWorkReceipts,
    ).toHaveBeenCalledWith({});

    backgroundWorkOperations.pruneBackgroundWorkReceipts.mockRejectedValueOnce(
      new Error("receipt cleanup failed"),
    );
    await expect(
      handlers.get("system.reconcile")?.({} as never, execution),
    ).rejects.toThrow("System reconciliation failed");
    expect(diagnosticOperations.emitDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "runtime.housekeeping.failed",
        severity: "warn",
        details: { operation: "background_receipts", errorClass: "Error" },
      }),
    );
    expect(ingestionReconciliation.sweepAbandonedUploads).toHaveBeenCalledTimes(
      2,
    );
    expect(
      externalMcpOperations.reconcileExternalMcpState,
    ).toHaveBeenCalledTimes(2);
    reconciliationOperations.reconcileAllProjects.mockClear();

    await handlers.get("assistant.reconcile")?.({} as never, execution);
    expect(assistantOperations.reconcileAssistantRuns).toHaveBeenCalledOnce();
    expect(mcpOperations.pruneMcpRecords).toHaveBeenCalledTimes(2);
    expect(projectApiOperations.pruneProjectApiRecords).toHaveBeenCalledTimes(
      2,
    );
    expect(
      reconciliationOperations.reconcileAllProjects,
    ).not.toHaveBeenCalled();
  });

  it("shares one in-flight start", async () => {
    const startGate = deferred();
    fakePgBoss.startPromises.push(startGate.promise);

    const firstStart = startKnowledgeWorkers({
      ingestionParseRunner: vi.fn(),
      ingestionAnalyzeRunner: vi.fn(),
      ingestionLinkRunner: vi.fn(),
    });
    const secondStart = startKnowledgeWorkers({
      ingestionParseRunner: vi.fn(),
    });
    const instancesBeforeStartCompletes = fakePgBoss.instances.length;
    startGate.resolve();
    await Promise.all([firstStart, secondStart]);

    expect(instancesBeforeStartCompletes).toBe(1);
    expect(fakePgBoss.instances).toHaveLength(1);
    expect(fakePgBoss.instances[0]?.startCalls).toBe(1);
  });

  it("keeps concurrent starts pending until registration finishes", async () => {
    const scheduleGate = deferred();
    fakePgBoss.schedulePromises.push(scheduleGate.promise);

    const firstStart = startKnowledgeWorkers({
      ingestionParseRunner: vi.fn(),
      ingestionAnalyzeRunner: vi.fn(),
      ingestionLinkRunner: vi.fn(),
    });
    await vi.waitFor(() => {
      expect(fakePgBoss.instances[0]?.scheduleCalls).toBe(1);
    });
    let secondSettled = false;
    const secondStart = startKnowledgeWorkers({
      ingestionParseRunner: vi.fn(),
    }).finally(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    const secondSettledBeforeRegistration = secondSettled;

    scheduleGate.resolve();
    await Promise.all([firstStart, secondStart]);
    expect(secondSettledBeforeRegistration).toBe(false);
    expect(fakePgBoss.instances[0]?.workCalls).toBe(HANDLED_JOB_NAMES.length);
  });

  it("rejects every concurrent caller and stays retryable after scheduling fails", async () => {
    const scheduleGate = deferred();
    const scheduleFailure = new Error("schedule registration failed");
    fakePgBoss.schedulePromises.push(scheduleGate.promise);

    const firstStart = startKnowledgeWorkers({
      ingestionParseRunner: vi.fn(),
      ingestionAnalyzeRunner: vi.fn(),
      ingestionLinkRunner: vi.fn(),
    });
    await vi.waitFor(() => {
      expect(fakePgBoss.instances[0]?.scheduleCalls).toBe(1);
    });
    const secondStart = startKnowledgeWorkers({
      ingestionParseRunner: vi.fn(),
    });
    scheduleGate.reject(scheduleFailure);

    const outcomes = await Promise.allSettled([firstStart, secondStart]);
    expect(outcomes).toEqual([
      { status: "rejected", reason: scheduleFailure },
      { status: "rejected", reason: scheduleFailure },
    ]);
    expect(fakePgBoss.instances[0]?.stopCalls).toBe(1);

    await startKnowledgeWorkers({
      ingestionParseRunner: vi.fn(),
      ingestionAnalyzeRunner: vi.fn(),
      ingestionLinkRunner: vi.fn(),
    });
    expect(fakePgBoss.instances).toHaveLength(2);
    expect(fakePgBoss.instances[1]?.workCalls).toBe(HANDLED_JOB_NAMES.length);
  });

  it("restarts after an overlapping stop completes", async () => {
    await startKnowledgeWorkers({
      ingestionParseRunner: vi.fn(),
      ingestionAnalyzeRunner: vi.fn(),
      ingestionLinkRunner: vi.fn(),
    });
    const stopGate = deferred();
    fakePgBoss.stopPromises.push(stopGate.promise);

    const stopping = stopKnowledgeWorkers();
    const restarting = startKnowledgeWorkers({
      ingestionParseRunner: vi.fn(),
      ingestionAnalyzeRunner: vi.fn(),
      ingestionLinkRunner: vi.fn(),
    });
    const instancesWhileStopping = fakePgBoss.instances.length;
    stopGate.resolve();
    await Promise.all([stopping, restarting]);

    expect(instancesWhileStopping).toBe(1);
    expect(fakePgBoss.instances).toHaveLength(2);
    expect(fakePgBoss.instances[1]?.startCalls).toBe(1);
  });

  it("shares one in-flight stop", async () => {
    await startKnowledgeWorkers({
      ingestionParseRunner: vi.fn(),
      ingestionAnalyzeRunner: vi.fn(),
      ingestionLinkRunner: vi.fn(),
    });
    const stopGate = deferred();
    fakePgBoss.stopPromises.push(stopGate.promise);

    const firstStop = stopKnowledgeWorkers();
    const secondStop = stopKnowledgeWorkers();
    const stopCalls = fakePgBoss.instances[0]?.stopCalls;
    stopGate.resolve();
    await Promise.all([firstStop, secondStop]);

    expect(stopCalls).toBe(1);
  });

  it("clears queue ownership so the runtime can restart when shutdown fails", async () => {
    await startKnowledgeWorkers({
      ingestionParseRunner: vi.fn(),
      ingestionAnalyzeRunner: vi.fn(),
      ingestionLinkRunner: vi.fn(),
    });
    const stopFailure = new Error("queue stop failed");
    fakePgBoss.stopPromises.push(Promise.reject(stopFailure));

    await expect(stopKnowledgeWorkers()).rejects.toBe(stopFailure);
    await startKnowledgeWorkers({
      ingestionParseRunner: vi.fn(),
      ingestionAnalyzeRunner: vi.fn(),
      ingestionLinkRunner: vi.fn(),
    });
    expect(fakePgBoss.instances).toHaveLength(2);
  });

  it("routes handler enqueues through the running worker queue", async () => {
    await startKnowledgeWorkers({
      ingestionParseRunner: vi.fn(),
      ingestionAnalyzeRunner: vi.fn(),
      ingestionLinkRunner: vi.fn(),
    });
    await requestKnowledgeJob("system.reconcile", {});
    expect(fakePgBoss.instances[0]?.sendCalls).toBe(1);

    await stopKnowledgeWorkers();
    await startKnowledgeWorkers({
      ingestionParseRunner: vi.fn(),
      ingestionAnalyzeRunner: vi.fn(),
      ingestionLinkRunner: vi.fn(),
    });
    await requestKnowledgeJob("system.reconcile", {});
    expect(fakePgBoss.instances[0]?.sendCalls).toBe(1);
    expect(fakePgBoss.instances[1]?.sendCalls).toBe(1);
  });

  it("stops a publisher that handler enqueues started during the drain", async () => {
    await startKnowledgeWorkers({
      ingestionParseRunner: vi.fn(),
      ingestionAnalyzeRunner: vi.fn(),
      ingestionLinkRunner: vi.fn(),
    });
    const worker = fakePgBoss.instances[0];
    const stopGate = deferred();
    fakePgBoss.stopPromises.push(stopGate.promise);

    const stopping = stopKnowledgeWorkers();
    await requestKnowledgeJob("system.reconcile", {});
    const publisher = fakePgBoss.instances.find(
      (instance) => instance !== worker,
    );
    expect(worker?.sendCalls).toBe(0);
    expect(publisher?.startCalls).toBe(1);
    expect(publisher?.sendCalls).toBe(1);

    stopGate.resolve();
    await stopping;
    expect(publisher?.stopCalls).toBe(1);
  });

  it("rejects enqueues after a completed stop instead of rebooting the publisher", async () => {
    await startKnowledgeWorkers({
      ingestionParseRunner: vi.fn(),
      ingestionAnalyzeRunner: vi.fn(),
      ingestionLinkRunner: vi.fn(),
    });
    await stopKnowledgeWorkers();
    const instancesAfterStop = fakePgBoss.instances.length;

    await expect(requestKnowledgeJob("system.reconcile", {})).rejects.toThrow(
      "after the worker runtime stopped",
    );

    expect(fakePgBoss.instances).toHaveLength(instancesAfterStop);
  });

  it("accepts enqueues again while the runtime restarts", async () => {
    await startKnowledgeWorkers({
      ingestionParseRunner: vi.fn(),
      ingestionAnalyzeRunner: vi.fn(),
      ingestionLinkRunner: vi.fn(),
    });
    await stopKnowledgeWorkers();
    const startGate = deferred();
    fakePgBoss.startPromises.push(startGate.promise);

    const restarting = startKnowledgeWorkers({
      ingestionParseRunner: vi.fn(),
      ingestionAnalyzeRunner: vi.fn(),
      ingestionLinkRunner: vi.fn(),
    });
    await expect(requestKnowledgeJob("system.reconcile", {})).resolves.toBe(
      "job-id",
    );
    expect(fakePgBoss.instances[1]?.sendCalls).toBe(0);

    startGate.resolve();
    await restarting;
    await requestKnowledgeJob("system.reconcile", {});
    expect(fakePgBoss.instances[1]?.sendCalls).toBe(1);
  });
});

it("repairs committed document projections before project reconciliation", async () => {
  const queue = new FakeJobQueue();
  await registerAssistantHandler(queue, vi.fn());
  const { repairDocumentProjectionInRepo } =
    await import("../services/documents");
  await queue.run("project.reconcile", {
    projectId: "11111111-1111-4111-8111-111111111111",
    repairDocumentIds: ["22222222-2222-4222-8222-222222222222"],
  });
  expect(repairDocumentProjectionInRepo).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  );
  expect(
    vi.mocked(repairDocumentProjectionInRepo).mock.invocationCallOrder.at(-1),
  ).toBeLessThan(
    reconciliationOperations.reconcileProjectKnowledge.mock.invocationCallOrder.at(
      -1,
    )!,
  );
});

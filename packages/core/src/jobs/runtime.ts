import { hostname } from "node:os";
import { pruneExamOperations } from "../services/examOperations";
import { runExamTick } from "../exams/tick";
import { repairDocumentProjectionInRepo } from "../services/documents";
import { withExistingProjectRepoReader } from "../services/projectRepo";
import { reconcileArtifactNotebooks } from "../services/artifactNotebookJobs";
import { upgradeDocumentHeaders } from "../services/documentHeaderUpgrade";
import { upgradeFolderMetadata } from "../services/folderMetadataUpgrade";
import { validKnowledgeJobPayload } from "./knowledgePayloads";
import {
  discoverProjectGitRemotes,
  pullProjectGitRemote,
  pushProjectGitRemote,
} from "../services/projectGitRemoteJobs";
import { reconcileExternalMcpState } from "../services/externalMcp/retention";
import type { PrismaClient } from "@weaver/db/client";
import { parseServerEnv } from "@weaver/config/server";
import { WORKER_ROLES, type WorkerRole } from "@weaver/config/workerRoles";
import {
  parseKnowledgeConfig,
  type KnowledgeConfig,
} from "@weaver/core/knowledge/config";
import { withDiagnosticContext } from "../diagnostics/context";
import { emitDiagnostic } from "../diagnostics/writer";
import { safeErrorClass } from "../diagnostics/errorClass";
import { runTaskTick } from "../scheduledTasks/tick";
import { failRunWithoutRunner } from "../services/wikiRuns";
import { executeWikiRevert } from "../services/wikiRevert";
import { reapWikiRuns, runWikiTick } from "../services/wikiTick";
import {
  createKnowledgeRoutingSource,
  knowledgeAiIdentity,
  type KnowledgeRoutingSource,
} from "../ai/registry";
import { db } from "@weaver/db";
import { loadEncryptionKeyRing } from "../security/encryption";
import {
  syncDocumentKeywordIndex,
  syncTableKeywordIndex,
} from "../services/keywordIndex";
import {
  blockGenerationBuildForConfiguration,
  blockGenerationDocumentForConfiguration,
  deleteKnowledgeContent,
  ensureGenerationForCurrentConfig,
  processGenerationDocument,
  recordDocumentChangeForGenerations,
  resumeGenerationBuild,
} from "../services/knowledgeGenerations";
import { knowledgeRouteSnapshot } from "../services/llmRoutes";
import {
  reconcileAllProjects,
  reconcileProjectKnowledge,
} from "../services/knowledgeReconciliation";
import { createKnowledgeQueue } from "./knowledgeQueue";
import type { PgBossQueue } from "./pgBossQueue";
import {
  createKnowledgeSystemContextForRuntime,
  type KnowledgeSystemContext,
} from "./systemContext";
import type {
  ArtifactNotebookRunner,
  AssistantRunner,
  IngestionAnalyzeRunner,
  IngestionLinkRunner,
  IngestionParseRunner,
  KnowledgeJobName,
  KnowledgeJobPayloads,
  TaskRunner,
  WikiRunner,
} from "./types";
import { reconcileAssistantRuns } from "../services/assistantRuns";
import {
  pruneDocumentChangeSummaries,
  reconcileDocumentChangeSummaries,
  runDocumentChangeSummary,
  type ChangeSummaryJobDeps,
} from "../services/documentChangeSummaries";
import { pruneDiagnosticEvents } from "../services/diagnosticEvents";
import { getDiagnosticsSettings } from "../services/diagnosticsSettings";
import { pruneBackgroundWorkReceipts } from "../services/backgroundWork";
import { pruneMcpRecords } from "../services/mcpOperations";
import { pruneProjectApiRecords } from "../projectApi/retention";
import { pruneProcessingHistory } from "../services/processingRetention";
import {
  setProcessJobQueue,
  setProcessJobsStopped,
  type JobExecution,
  type JobQueue,
} from "./queue";
import { stopKnowledgePublisher } from "./publisher";
import {
  reconcileIngestionFiles,
  sweepAbandonedUploads,
} from "./ingestionHandlers";

function jobContext(data: object, execution: JobExecution) {
  const payload = data as Partial<{
    projectId: string;
    documentId: string;
    generationId: string;
    runId: string;
  }>;
  return {
    jobId: execution.jobId ?? undefined,
    projectId: payload.projectId,
    documentId: payload.documentId,
    generationId: payload.generationId,
    runId: payload.runId,
  };
}

async function runDiagnosticHousekeeping(db: PrismaClient): Promise<void> {
  await pruneDiagnosticEvents(db, await getDiagnosticsSettings(db));
}

/** Wraps a handler so every delivery yields job.started plus job.completed or job.failed. */
function instrumentedJob<N extends KnowledgeJobName>(
  name: N,
  handler: (
    data: KnowledgeJobPayloads[N],
    execution: JobExecution,
  ) => Promise<void>,
): (data: KnowledgeJobPayloads[N], execution: JobExecution) => Promise<void> {
  const lifecycleSeverity =
    name === "project.git-sync" ||
    name === "task.tick" ||
    name === "exam.tick" ||
    name === "wiki.tick" ||
    name === "assistant.reconcile"
      ? "debug"
      : "info";
  return async (data, execution) => {
    if (!validKnowledgeJobPayload(name, data)) {
      emitDiagnostic({
        event: "job.failed",
        severity: "warn",
        outcome: "error",
        message: `${name} rejected an invalid payload`,
        details: {
          job: name,
          retryCount: execution.retryCount,
          error: "invalid_payload",
        },
      });
      return;
    }
    return withDiagnosticContext(jobContext(data, execution), async () => {
      const started = Date.now();
      const fileId = (data as Partial<{ fileId: string }>).fileId;
      const details = {
        job: name,
        retryCount: execution.retryCount,
        ...(fileId === undefined ? {} : { fileId }),
      };
      emitDiagnostic({
        event: "job.started",
        severity: lifecycleSeverity,
        message: `${name} started`,
        details,
      });
      try {
        await handler(data, execution);
        const cancelled = execution.signal.aborted;
        emitDiagnostic({
          event: "job.completed",
          severity: lifecycleSeverity,
          message: cancelled
            ? `${name} completed after cancellation`
            : `${name} completed`,
          durationMs: Date.now() - started,
          outcome: cancelled ? "cancelled" : "ok",
          details,
        });
      } catch (error) {
        const errorClass = safeErrorClass(error);
        emitDiagnostic({
          event: "job.failed",
          severity: "error",
          message: `${name} failed: ${errorClass}`,
          durationMs: Date.now() - started,
          outcome: execution.signal.aborted ? "cancelled" : "error",
          details: { ...details, error: errorClass },
        });
        throw error;
      }
    });
  };
}

type KnowledgeRuntimeState = {
  queue: PgBossQueue<KnowledgeJobPayloads> | null;
  systemContext: KnowledgeSystemContext | null;
  startPromise: Promise<void> | null;
  stopPromise: Promise<void> | null;
};

const knowledgeRuntimeSymbol: unique symbol = Symbol.for(
  "weaver.knowledge-job-runtime",
);

type GlobalWithKnowledgeRuntime = typeof globalThis & {
  [knowledgeRuntimeSymbol]?: KnowledgeRuntimeState;
};

function getRuntimeState(): KnowledgeRuntimeState {
  const globalWithRuntime = globalThis as GlobalWithKnowledgeRuntime;
  globalWithRuntime[knowledgeRuntimeSymbol] ??= {
    queue: null,
    systemContext: null,
    startPromise: null,
    stopPromise: null,
  };
  return globalWithRuntime[knowledgeRuntimeSymbol];
}

type IngestionStageJob =
  "ingestion.parse" | "ingestion.analyze" | "ingestion.link";

/** Without a runner the stage stays queued for a worker that has one. */
async function registerIngestionStage<N extends IngestionStageJob>(
  queue: JobQueue,
  name: N,
  label: "parse" | "analyze" | "link",
  runner:
    | ((
        data: KnowledgeJobPayloads[N],
        execution: JobExecution,
      ) => Promise<void>)
    | undefined,
): Promise<void> {
  if (!runner) {
    console.warn(
      `ingestion role enabled but no ingestion ${label} runner was injected; ${name} stays queued for another worker`,
    );
    return;
  }
  await queue.work(
    name,
    instrumentedJob(name, (payload, execution) => runner(payload, execution)),
  );
}

export async function registerKnowledgeJobHandlers(input: {
  queue: JobQueue;
  context: KnowledgeSystemContext;
  db: PrismaClient;
  config: KnowledgeConfig;
  routing: KnowledgeRoutingSource;
  dataDir?: string;
  roles?: ReadonlySet<WorkerRole>;
  enabledRoles?: ReadonlySet<WorkerRole>;
  artifactNotebookRunner?: ArtifactNotebookRunner;
  assistantRunner?: AssistantRunner;
  ingestionParseRunner?: IngestionParseRunner;
  ingestionAnalyzeRunner?: IngestionAnalyzeRunner;
  ingestionLinkRunner?: IngestionLinkRunner;
  taskRunner?: TaskRunner;
  wikiRunner?: WikiRunner;
  changeSummaries?: ChangeSummaryJobDeps;
}): Promise<void> {
  const dataDir = input.dataDir ?? parseServerEnv(process.env).WEAVER_DATA_DIR;
  const roles = input.roles ?? new Set<WorkerRole>(WORKER_ROLES);
  const enabledRoles = input.enabledRoles ?? new Set<WorkerRole>(WORKER_ROLES);
  for (const role of roles) {
    if (!enabledRoles.has(role))
      throw new Error(
        `Worker role ${role} is excluded by WEAVER_ENABLED_WORKER_ROLES`,
      );
  }
  for (const [role, schedule] of [
    ["assistant", "assistant.reconcile"],
    ["tasks", "task.tick"],
    ["tasks", "exam.tick"],
    ["git", "project.git-sync"],
    ["wiki", "wiki.tick"],
  ] as const) {
    if (!enabledRoles.has(role)) {
      if (!input.queue.unschedule)
        throw new Error("Queue cannot remove deployment-disabled schedules");
      await input.queue.unschedule(schedule);
    }
  }

  if (roles.has("knowledge")) {
    await input.queue.work(
      "document.search-sync",
      instrumentedJob("document.search-sync", async (payload) => {
        const result = await syncDocumentKeywordIndex(
          input.context,
          input.db,
          payload,
        );
        if (result.outcome === "indexed") {
          await recordDocumentChangeForGenerations(
            input.context,
            input.db,
            payload,
          );
        }
      }),
    );
    await input.queue.work(
      "document.ai-enrich",
      instrumentedJob("document.ai-enrich", async (payload, execution) => {
        await syncDocumentKeywordIndex(input.context, input.db, payload, {
          skipIfReady: true,
        });
        let routing = await input.routing.resolve();
        if (payload.configFingerprint !== routing?.configFingerprint) {
          routing = await input.routing.resolveFresh();
        }
        if (payload.configFingerprint !== routing?.configFingerprint) {
          await blockGenerationDocumentForConfiguration(
            input.context,
            input.db,
            payload,
            { jobId: execution.jobId, retryCount: execution.retryCount },
          );
          return;
        }
        await processGenerationDocument(
          input.context,
          input.db,
          input.routing.providerFor(routing),
          {
            ...payload,
            ...knowledgeAiIdentity(routing),
            jobId: execution.jobId,
          },
          {
            signal: execution.signal,
            delivery: {
              jobId: execution.jobId,
              retryCount: execution.retryCount,
            },
          },
        );
      }),
    );
    await input.queue.work(
      "document.change-summary",
      instrumentedJob("document.change-summary", async (payload, execution) => {
        await runDocumentChangeSummary(
          input.db,
          payload,
          execution,
          input.changeSummaries ?? { ring: loadEncryptionKeyRing() },
        );
      }),
    );
    await input.queue.work(
      "table.search-sync",
      instrumentedJob("table.search-sync", async (payload) => {
        await syncTableKeywordIndex(input.context, input.db, payload);
      }),
    );
    await input.queue.work(
      "content.delete",
      instrumentedJob("content.delete", async (payload) => {
        await deleteKnowledgeContent(input.context, input.db, payload);
      }),
    );
    await input.queue.work(
      "project.reconcile",
      instrumentedJob("project.reconcile", async (payload, execution) => {
        if (payload.repairDocumentIds?.length) {
          await withExistingProjectRepoReader(
            payload.projectId,
            async (repo) => {
              for (const documentId of payload.repairDocumentIds!) {
                execution.signal.throwIfAborted();
                await repairDocumentProjectionInRepo(
                  input.db,
                  repo,
                  payload.projectId,
                  documentId,
                );
              }
            },
          );
        }
        const routing = await input.routing.resolveFresh();
        if (routing) {
          await ensureGenerationForCurrentConfig(input.context, input.db, {
            projectId: payload.projectId,
            configFingerprint: routing.configFingerprint,
            embeddingModel: routing.embedding.providerModelId,
            embeddingDimensions: routing.embeddingDimensions,
            extractionSchemaVersion: routing.extractionSchemaVersion,
            promptVersion: routing.promptVersion,
            routeSnapshot: knowledgeRouteSnapshot(routing),
          });
        }
        await reconcileProjectKnowledge(
          input.context,
          input.db,
          payload.projectId,
          {
            signal: execution.signal,
            liveConfigFingerprint: routing?.configFingerprint,
          },
        );
      }),
    );
    await input.queue.work(
      "project.generation-build",
      instrumentedJob("project.generation-build", async (payload) => {
        let routing = await input.routing.resolve();
        if (payload.configFingerprint !== routing?.configFingerprint) {
          routing = await input.routing.resolveFresh();
        }
        if (payload.configFingerprint !== routing?.configFingerprint) {
          await blockGenerationBuildForConfiguration(
            input.context,
            input.db,
            payload,
          );
          return;
        }
        await resumeGenerationBuild(input.context, input.db, payload);
      }),
    );
  }
  await input.queue.work(
    "system.reconcile",
    instrumentedJob("system.reconcile", async () => {
      const operations: Array<[string, () => Promise<unknown>]> = [
        ["knowledge", () => reconcileAllProjects(input.context, input.db)],
        ["diagnostics", () => runDiagnosticHousekeeping(input.db)],
        ["background_receipts", () => pruneBackgroundWorkReceipts(input.db)],
        ["external_mcp", () => reconcileExternalMcpState(input.db, new Date())],
        ["mcp_records", () => pruneMcpRecords(input.db)],
        ["exam_records", () => pruneExamOperations(input.db)],
        ["project_api_records", () => pruneProjectApiRecords(input.db)],
        ["processing_history", () => pruneProcessingHistory(input.db)],
        [
          "abandoned_uploads",
          () =>
            sweepAbandonedUploads(input.db, {
              dataDir,
              ttlMinutes: input.config.ingestionTmpTtlMinutes,
            }),
        ],
        ["ingestion", () => reconcileIngestionFiles(input.db)],
        ["wiki_runs", () => reapWikiRuns(input.db)],
        [
          "artifact_notebooks",
          () => reconcileArtifactNotebooks(input.db, { dataDir }),
        ],
        ["document_headers", () => upgradeDocumentHeaders(input.db)],
        ["folder_metadata", () => upgradeFolderMetadata(input.db)],
        [
          "change_summaries",
          () => reconcileDocumentChangeSummaries(input.db, new Date()),
        ],
        [
          "change_summary_history",
          () => pruneDocumentChangeSummaries(input.db, new Date()),
        ],
      ];
      const results = await Promise.allSettled(
        operations.map(async ([operation, run]) => {
          try {
            await run();
          } catch (error) {
            emitDiagnostic({
              event: "runtime.housekeeping.failed",
              severity: "warn",
              message: "System housekeeping operation failed",
              outcome: "error",
              details: { operation, errorClass: safeErrorClass(error) },
            });
            throw error;
          }
        }),
      );
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length)
        throw new AggregateError(
          failures.map((result): unknown => result.reason),
          "System reconciliation failed",
        );
    }),
  );
  if (roles.has("assistant")) {
    // Separate from system.reconcile: assistant recovery latency is bounded by
    // the 30 s attempt lease, while knowledge reconciliation is happy at 15 min.
    // Safe to run from several workers at once — every expired attempt and every
    // requeued run is claimed with a conditional updateMany.
    await input.queue.work(
      "assistant.reconcile",
      instrumentedJob("assistant.reconcile", async () => {
        await reconcileAssistantRuns(input.db);
      }),
    );
    // Without a runner, the job is acked and dropped: nothing is written, and
    // the run is only recovered by the next assistant.reconcile republish, at
    // least 30 seconds later. Correct for any runtime that registers handlers
    // without a runner; only the agent worker passes one today.
    await input.queue.work(
      "assistant.run",
      instrumentedJob("assistant.run", async (payload, execution) => {
        if (!input.assistantRunner) {
          console.warn(
            `assistant.run ${payload.runId} received but no runner is registered`,
          );
          return;
        }
        await input.assistantRunner(payload, execution);
      }),
    );
  }
  if (roles.has("ingestion")) {
    if (input.artifactNotebookRunner)
      await input.queue.work(
        "artifact.notebook.prepare",
        instrumentedJob(
          "artifact.notebook.prepare",
          input.artifactNotebookRunner,
        ),
      );
    await registerIngestionStage(
      input.queue,
      "ingestion.parse",
      "parse",
      input.ingestionParseRunner,
    );
    await registerIngestionStage(
      input.queue,
      "ingestion.analyze",
      "analyze",
      input.ingestionAnalyzeRunner,
    );
    await registerIngestionStage(
      input.queue,
      "ingestion.link",
      "link",
      input.ingestionLinkRunner,
    );
  }
  if (roles.has("tasks")) {
    await input.queue.work(
      "exam.tick",
      instrumentedJob("exam.tick", async () => {
        await runExamTick(input.db);
      }),
    );
    await input.queue.work(
      "task.tick",
      instrumentedJob("task.tick", async () => {
        await runTaskTick(input.db);
      }),
    );
    // Like assistant.run: without a runner the delivery is acked and the tick
    // re-dispatches the still-queued run for a worker that has one.
    await input.queue.work(
      "task.run",
      instrumentedJob("task.run", async (payload, execution) => {
        if (!input.taskRunner) {
          console.warn(
            `task.run ${payload.runId} received but no runner is registered`,
          );
          return;
        }
        await input.taskRunner(payload, execution);
      }),
    );
  }
  if (roles.has("git")) {
    await input.queue.work(
      "project.git-sync",
      instrumentedJob("project.git-sync", async () => {
        await discoverProjectGitRemotes({ db: input.db, queue: input.queue });
      }),
    );
    await input.queue.work(
      "project.git-push",
      instrumentedJob("project.git-push", async (payload, execution) => {
        await pushProjectGitRemote({
          db: input.db,
          payload,
          signal: execution.signal,
        });
      }),
    );
    await input.queue.work(
      "project.git-pull",
      instrumentedJob("project.git-pull", async (payload, execution) => {
        await pullProjectGitRemote({
          db: input.db,
          payload,
          signal: execution.signal,
        });
      }),
    );
    await input.queue.schedule("project.git-sync", "* * * * *");
  }
  if (roles.has("wiki")) {
    await input.queue.work(
      "wiki.tick",
      instrumentedJob("wiki.tick", async () => {
        await runWikiTick(input.db);
      }),
    );
    // Unlike task.run a delivery without a runner ends the run visibly; nothing would pick it up.
    await input.queue.work(
      "wiki.run",
      instrumentedJob("wiki.run", async (payload, execution) => {
        // A revert needs no model, so a worker without the injected runner still performs it.
        const run = await input.db.wikiRun.findUnique({
          where: { id: payload.runId },
          select: { kind: true },
        });
        if (run?.kind === "revert") {
          await executeWikiRevert(input.db, payload.runId, {
            workerId: `${hostname()}:${process.pid}`,
            signal: execution.signal,
          });
          return;
        }
        if (!input.wikiRunner) {
          await failRunWithoutRunner(input.db, payload.runId);
          return;
        }
        await input.wikiRunner(payload, execution);
      }),
    );
    await input.queue.schedule("wiki.tick", "* * * * *");
  }
  await input.queue.schedule("system.reconcile", input.config.reconcileCron);
  if (roles.has("assistant")) {
    await input.queue.schedule(
      "assistant.reconcile",
      input.config.assistantReconcileCron,
    );
  }
  if (roles.has("tasks")) {
    await input.queue.schedule("task.tick", input.config.taskTickCron);
    await input.queue.schedule("exam.tick", "* * * * *");
  }
}

export async function startKnowledgeWorkers(
  options: {
    artifactNotebookRunner?: ArtifactNotebookRunner;
    assistantRunner?: AssistantRunner;
    ingestionParseRunner?: IngestionParseRunner;
    ingestionAnalyzeRunner?: IngestionAnalyzeRunner;
    ingestionLinkRunner?: IngestionLinkRunner;
    taskRunner?: TaskRunner;
    wikiRunner?: WikiRunner;
  } = {},
): Promise<void> {
  const config = parseKnowledgeConfig(process.env);
  if (!config.jobsEnabled) return;
  const serverEnv = parseServerEnv(process.env);

  const state = getRuntimeState();
  if (state.stopPromise) {
    await state.stopPromise;
    return startKnowledgeWorkers(options);
  }
  if (state.queue) return;
  if (state.startPromise) return state.startPromise;

  const startPromise = (async () => {
    setProcessJobsStopped(false);
    const queue = createKnowledgeQueue("worker");

    try {
      await queue.start();
      setProcessJobQueue(queue);
      const systemContext = createKnowledgeSystemContextForRuntime();
      await registerKnowledgeJobHandlers({
        queue,
        context: systemContext,
        db,
        config,
        routing: createKnowledgeRoutingSource(db, loadEncryptionKeyRing()),
        dataDir: serverEnv.WEAVER_DATA_DIR,
        roles: serverEnv.WEAVER_WORKER_ROLES,
        enabledRoles: serverEnv.WEAVER_ENABLED_WORKER_ROLES,
        artifactNotebookRunner: options.artifactNotebookRunner,
        assistantRunner: options.assistantRunner,
        ingestionParseRunner: options.ingestionParseRunner,
        ingestionAnalyzeRunner: options.ingestionAnalyzeRunner,
        ingestionLinkRunner: options.ingestionLinkRunner,
        taskRunner: options.taskRunner,
        wikiRunner: options.wikiRunner,
      });
      state.queue = queue;
      state.systemContext = systemContext;
    } catch (error) {
      setProcessJobQueue(null);
      if (state.queue === queue) {
        state.queue = null;
        state.systemContext = null;
      }
      await queue.stop().catch(() => undefined);
      throw error;
    }
  })();

  state.startPromise = startPromise;
  try {
    await startPromise;
  } finally {
    if (state.startPromise === startPromise) state.startPromise = null;
  }
}

export async function stopKnowledgeWorkers(): Promise<void> {
  const state = getRuntimeState();
  if (state.stopPromise) return state.stopPromise;

  const stopPromise = (async () => {
    if (state.startPromise) {
      await state.startPromise.catch(() => undefined);
    }
    if (!state.queue) return;

    const queue = state.queue;
    setProcessJobQueue(null);
    try {
      await queue.stop();
    } finally {
      setProcessJobsStopped(true);
      try {
        // Handler enqueues during the graceful drain may have started the fallback publisher.
        await stopKnowledgePublisher();
      } finally {
        if (state.queue === queue) {
          state.queue = null;
          state.systemContext = null;
        }
      }
    }
  })();

  state.stopPromise = stopPromise;
  try {
    await stopPromise;
  } finally {
    if (state.stopPromise === stopPromise) state.stopPromise = null;
  }
}

export async function probeKnowledgeWorkers(): Promise<boolean> {
  if (!parseKnowledgeConfig(process.env).jobsEnabled) return true;
  const state = getRuntimeState();
  return (
    state.queue !== null &&
    !state.stopPromise &&
    (await state.queue.isHealthy())
  );
}

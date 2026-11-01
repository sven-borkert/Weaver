import { assertOidcSecretsDecryptable } from "@weaver/core/services/oidc/credentials";
import { sweepStaleGitRemoteKeys } from "@weaver/core/services/projectGitRemoteJobs";
import { hostname } from "node:os";
import { parseServerEnv } from "@weaver/config/server";
import {
  emitDiagnostic,
  startDiagnosticWriter,
  stopDiagnosticWriter,
  waitForDiagnosticWriterReady,
} from "@weaver/core/diagnostics/writer";
import { diagnosticReference } from "@weaver/core/diagnostics/reference";
import { loadEncryptionKeyRing } from "@weaver/core/security/encryption";
import {
  probeKnowledgeWorkers,
  startKnowledgeWorkers,
  stopKnowledgeWorkers,
} from "@weaver/core/jobs/runtime";
import { createRuntimeLifecycle } from "@weaver/core/runtime/lifecycle";
import { assertProjectGitRemoteSecretsDecryptable } from "@weaver/core/services/projectGitRemote";
import { assertExternalMcpSecretsDecryptable } from "@weaver/core/services/externalMcp";
import { assertRemoteConnectionSecretsDecryptable } from "@weaver/core/services/remoteInstances";
import { assertConnectionSecretsDecryptable } from "@weaver/core/services/llmConnections";
import { db } from "@weaver/db";
import { createAssistantRunner } from "@weaver/ai/runner";
import { createScheduledTaskRunner } from "@weaver/ai/taskRunner";
import { createIngestionAnalyzeRunner } from "@weaver/ingestion/analyzeStage";
import { createIngestionLinkRunner } from "@weaver/ingestion/linkStage";
import { createIngestionParseRunner } from "@weaver/ingestion/parseStage";
import { createNotebookParser } from "@weaver/ingestion/notebook";
import { createArtifactNotebookRunner } from "@weaver/core/services/artifactNotebookJobs";
import { createWorkerHealthServer } from "./health";
import packageJson from "../../../package.json";

const env = parseServerEnv(process.env);
const workerId = `${hostname()}:${process.pid}`;
const ring = loadEncryptionKeyRing();
const roles = [...env.WEAVER_WORKER_ROLES];
const lifecycle = createRuntimeLifecycle({
  on: (event, handler) => process.on(event, handler),
  startHealth: (isReady) =>
    createWorkerHealthServer(
      env.WEAVER_WORKER_HEALTH_PORT,
      env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1",
      isReady,
      { roles, checkDependencies: probeKnowledgeWorkers },
    ),
  start: async () => {
    await sweepStaleGitRemoteKeys();
    startDiagnosticWriter({ db, runtime: "worker" });
    await waitForDiagnosticWriterReady();
    await assertConnectionSecretsDecryptable(db, ring);
    await assertExternalMcpSecretsDecryptable(db, ring);
    await assertProjectGitRemoteSecretsDecryptable(db, ring);
    await assertRemoteConnectionSecretsDecryptable(db, ring);
    await assertOidcSecretsDecryptable(db, ring);
    emitDiagnostic({
      event: "runtime.started",
      message: `agent-worker ${workerId} started`,
      details: {
        version: packageJson.version,
        node: process.version,
        pid: process.pid,
        workerId,
        roles,
      },
    });
    await startKnowledgeWorkers({
      assistantRunner: createAssistantRunner({ db, ring, workerId }),
      taskRunner: createScheduledTaskRunner({ db, ring, workerId }),
      ingestionParseRunner: createIngestionParseRunner({
        db,
        ring,
        dataDir: env.WEAVER_DATA_DIR,
        maxOcrPages: env.WEAVER_INGESTION_MAX_OCR_PAGES,
        maxFileBytes: env.WEAVER_INGESTION_MAX_FILE_BYTES,
      }),
      ingestionAnalyzeRunner: createIngestionAnalyzeRunner({ db, ring }),
      ingestionLinkRunner: createIngestionLinkRunner({ db }),
      artifactNotebookRunner: createArtifactNotebookRunner({
        db,
        dataDir: env.WEAVER_DATA_DIR,
        maxSourceBytes: env.WEAVER_ARTIFACT_MAX_FILE_BYTES,
        runNotebookParser: createNotebookParser({
          executable: env.WEAVER_ONENOTE_READER_PATH,
        }),
      }),
    });
  },
  stop: async () => {
    let failed = false;
    let failure: unknown;
    try {
      await stopKnowledgeWorkers();
    } catch (error) {
      failed = true;
      failure = error;
    }
    emitDiagnostic({
      event: "runtime.stopped",
      message: `agent-worker ${workerId} stopped`,
      details: {
        version: packageJson.version,
        node: process.version,
        pid: process.pid,
        workerId,
      },
    });
    try {
      await stopDiagnosticWriter();
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
    if (failed) throw failure;
  },
  disconnectDb: () => db.$disconnect(),
  exit: (code) => process.exit(code),
  logFatal: (event, cause, error) => {
    const reference = diagnosticReference(
      emitDiagnostic({
        event: "runtime.error",
        severity: "error",
        outcome: "error",
        message: `agent-worker fatal: ${event}`,
        details: {
          source: "lifecycle",
          fatal: event,
          ...cause,
          ...(error ? { error } : {}),
        },
      }),
    );
    console.error("agent-worker fatal", { event, cause, reference });
  },
  // pg-boss's graceful stop caps at 30 s; leave headroom before forcing exit.
  shutdownTimeoutMs: 40_000,
});

await lifecycle.run();

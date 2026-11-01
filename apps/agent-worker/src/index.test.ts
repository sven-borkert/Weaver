import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  createRuntimeLifecycle as CreateRuntimeLifecycle,
  RuntimeLifecycleDependencies,
} from "@weaver/core/runtime/lifecycle";
import packageJson from "../../../package.json";

vi.mock("@weaver/core/services/projectGitRemoteJobs", () => ({
  sweepStaleGitRemoteKeys: vi.fn().mockResolvedValue(undefined),
}));

type CapturedLifecycle = RuntimeLifecycleDependencies;

const lifecycle = vi.hoisted(() => ({
  dependencies: null as CapturedLifecycle | null,
  run: vi.fn().mockResolvedValue(undefined),
}));
const database = vi.hoisted(() => ({
  db: { $disconnect: vi.fn().mockResolvedValue(undefined) },
}));
const encryption = vi.hoisted(() => {
  const ring = { activeVersion: 1, keys: new Map() };
  return {
    ring,
    loadEncryptionKeyRing: vi.fn(() => ring),
  };
});
const secrets = vi.hoisted(() => ({
  assertConnectionSecretsDecryptable: vi.fn().mockResolvedValue(undefined),
  assertExternalMcpSecretsDecryptable: vi.fn().mockResolvedValue(undefined),
}));
const jobs = vi.hoisted(() => ({
  startKnowledgeWorkers: vi.fn().mockResolvedValue(undefined),
  stopKnowledgeWorkers: vi.fn().mockResolvedValue(undefined),
}));
const assistant = vi.hoisted(() => ({
  runner: { execute: vi.fn() },
  createAssistantRunner: vi.fn(),
}));
const ingestion = vi.hoisted(() => ({
  runner: vi.fn(),
  analyzeRunner: vi.fn(),
  linkRunner: vi.fn(),
  createIngestionParseRunner: vi.fn(),
  createIngestionAnalyzeRunner: vi.fn(),
  createIngestionLinkRunner: vi.fn(),
}));
const gitRemoteSecrets = vi.hoisted(() => ({
  assertProjectGitRemoteSecretsDecryptable: vi
    .fn()
    .mockResolvedValue(undefined),
}));
vi.mock("@weaver/core/services/projectGitRemote", () => gitRemoteSecrets);
const remoteSecrets = vi.hoisted(() => ({
  assertRemoteConnectionSecretsDecryptable: vi
    .fn()
    .mockResolvedValue(undefined),
}));
vi.mock("@weaver/core/services/remoteInstances", () => remoteSecrets);
const oidcSecrets = vi.hoisted(() => ({
  assertOidcSecretsDecryptable: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@weaver/core/services/oidc/credentials", () => oidcSecrets);

const diagnostics = vi.hoisted(() => ({
  emitDiagnostic: vi.fn(),
  startDiagnosticWriter: vi.fn(),
  stopDiagnosticWriter: vi.fn().mockResolvedValue(undefined),
  waitForDiagnosticWriterReady: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:os", () => ({ hostname: () => "test-host" }));
vi.mock("@weaver/config/server", () => ({
  parseServerEnv: () => ({
    NODE_ENV: "test",
    WEAVER_WORKER_HEALTH_PORT: 3101,
    WEAVER_DATA_DIR: "./data-test",
    WEAVER_WORKER_ROLES: new Set(["knowledge", "assistant", "ingestion"]),
    WEAVER_INGESTION_MAX_OCR_PAGES: 50,
    WEAVER_INGESTION_MAX_FILE_BYTES: 52_428_800,
  }),
}));
vi.mock("@weaver/core/diagnostics/writer", () => diagnostics);
vi.mock("@weaver/core/jobs/runtime", () => jobs);
vi.mock("@weaver/core/runtime/lifecycle", () => ({
  createRuntimeLifecycle: (dependencies: CapturedLifecycle) => {
    lifecycle.dependencies = dependencies;
    return { run: lifecycle.run };
  },
}));
vi.mock("@weaver/core/security/encryption", () => ({
  loadEncryptionKeyRing: encryption.loadEncryptionKeyRing,
}));
vi.mock("@weaver/core/services/llmConnections", () => secrets);
vi.mock("@weaver/core/services/externalMcp", () => secrets);
vi.mock("@weaver/db", () => database);
vi.mock("@weaver/ai/runner", () => ({
  createAssistantRunner: assistant.createAssistantRunner,
}));
vi.mock("@weaver/ingestion/parseStage", () => ({
  createIngestionParseRunner: ingestion.createIngestionParseRunner,
}));
vi.mock("@weaver/ingestion/analyzeStage", () => ({
  createIngestionAnalyzeRunner: ingestion.createIngestionAnalyzeRunner,
}));
vi.mock("@weaver/ingestion/linkStage", () => ({
  createIngestionLinkRunner: ingestion.createIngestionLinkRunner,
}));
vi.mock("./health", () => ({
  createWorkerHealthServer: vi.fn(),
}));

await import("./index");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  encryption.loadEncryptionKeyRing.mockReturnValue(encryption.ring);
  assistant.createAssistantRunner.mockReturnValue(assistant.runner);
  ingestion.createIngestionParseRunner.mockReturnValue(ingestion.runner);
  ingestion.createIngestionAnalyzeRunner.mockReturnValue(
    ingestion.analyzeRunner,
  );
  ingestion.createIngestionLinkRunner.mockReturnValue(ingestion.linkRunner);
  diagnostics.waitForDiagnosticWriterReady.mockResolvedValue(undefined);
  diagnostics.stopDiagnosticWriter.mockResolvedValue(undefined);
  jobs.startKnowledgeWorkers.mockResolvedValue(undefined);
  jobs.stopKnowledgeWorkers.mockResolvedValue(undefined);
});

describe("agent-worker runtime composition", () => {
  it("starts and stops the diagnostic writer around worker admission", async () => {
    const dependencies = lifecycle.dependencies;
    expect(dependencies).not.toBeNull();
    const ready = deferred();
    diagnostics.waitForDiagnosticWriterReady.mockReturnValueOnce(ready.promise);

    const starting = dependencies!.start();
    await vi.waitFor(() => {
      expect(diagnostics.startDiagnosticWriter).toHaveBeenCalledOnce();
    });
    expect(diagnostics.waitForDiagnosticWriterReady).toHaveBeenCalledOnce();
    expect(diagnostics.emitDiagnostic).not.toHaveBeenCalled();
    expect(jobs.startKnowledgeWorkers).not.toHaveBeenCalled();

    ready.resolve();
    await starting;

    expect(secrets.assertExternalMcpSecretsDecryptable).toHaveBeenCalledOnce();
    expect(secrets.assertConnectionSecretsDecryptable).toHaveBeenCalledWith(
      database.db,
      encryption.ring,
    );
    expect(
      gitRemoteSecrets.assertProjectGitRemoteSecretsDecryptable,
    ).toHaveBeenCalledOnce();
    expect(
      gitRemoteSecrets.assertProjectGitRemoteSecretsDecryptable.mock
        .invocationCallOrder[0],
    ).toBeGreaterThan(
      diagnostics.startDiagnosticWriter.mock.invocationCallOrder[0]!,
    );
    expect(
      remoteSecrets.assertRemoteConnectionSecretsDecryptable,
    ).toHaveBeenCalledWith(database.db, encryption.ring);
    expect(
      remoteSecrets.assertRemoteConnectionSecretsDecryptable.mock
        .invocationCallOrder[0],
    ).toBeGreaterThan(
      gitRemoteSecrets.assertProjectGitRemoteSecretsDecryptable.mock
        .invocationCallOrder[0]!,
    );
    expect(diagnostics.startDiagnosticWriter).toHaveBeenCalledWith({
      db: database.db,
      runtime: "worker",
    });
    expect(diagnostics.emitDiagnostic).toHaveBeenCalledWith({
      event: "runtime.started",
      message: `agent-worker test-host:${process.pid} started`,
      details: {
        version: packageJson.version,
        node: process.version,
        pid: process.pid,
        workerId: `test-host:${process.pid}`,
        roles: ["knowledge", "assistant", "ingestion"],
      },
    });
    expect(ingestion.createIngestionParseRunner).toHaveBeenCalledWith(
      // The ring is load-bearing: without it OCR credential decryption fails in production.
      expect.objectContaining({
        dataDir: "./data-test",
        maxOcrPages: 50,
        maxFileBytes: 52_428_800,
        ring: encryption.ring,
      }),
    );
    expect(ingestion.createIngestionAnalyzeRunner).toHaveBeenCalledWith(
      expect.objectContaining({ ring: encryption.ring }),
    );
    expect(jobs.startKnowledgeWorkers).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantRunner: assistant.runner,
        ingestionParseRunner: ingestion.runner,
        ingestionAnalyzeRunner: ingestion.analyzeRunner,
        ingestionLinkRunner: ingestion.linkRunner,
      }),
    );
    expect(
      secrets.assertConnectionSecretsDecryptable.mock.invocationCallOrder[0],
    ).toBeGreaterThan(
      diagnostics.startDiagnosticWriter.mock.invocationCallOrder[0]!,
    );
    expect(
      diagnostics.waitForDiagnosticWriterReady.mock.invocationCallOrder[0],
    ).toBeLessThan(diagnostics.emitDiagnostic.mock.invocationCallOrder[0]!);
    expect(diagnostics.emitDiagnostic.mock.invocationCallOrder[0]).toBeLessThan(
      jobs.startKnowledgeWorkers.mock.invocationCallOrder[0]!,
    );

    await dependencies!.stop();

    expect(jobs.stopKnowledgeWorkers).toHaveBeenCalledOnce();
    expect(diagnostics.emitDiagnostic).toHaveBeenLastCalledWith({
      event: "runtime.stopped",
      message: `agent-worker test-host:${process.pid} stopped`,
      details: {
        version: packageJson.version,
        node: process.version,
        pid: process.pid,
        workerId: `test-host:${process.pid}`,
      },
    });
    expect(diagnostics.stopDiagnosticWriter).toHaveBeenCalledOnce();
    expect(jobs.stopKnowledgeWorkers.mock.invocationCallOrder[0]).toBeLessThan(
      diagnostics.emitDiagnostic.mock.invocationCallOrder[1]!,
    );
    expect(diagnostics.emitDiagnostic.mock.invocationCallOrder[1]).toBeLessThan(
      diagnostics.stopDiagnosticWriter.mock.invocationCallOrder[0]!,
    );
  });

  it("drains diagnostics before disconnecting when worker shutdown fails", async () => {
    const dependencies = lifecycle.dependencies;
    expect(dependencies).not.toBeNull();
    const failure = new Error("worker drain failed");
    const writerDrain = deferred();
    jobs.stopKnowledgeWorkers.mockRejectedValueOnce(failure);
    diagnostics.stopDiagnosticWriter.mockReturnValueOnce(writerDrain.promise);
    const { createRuntimeLifecycle } = await vi.importActual<{
      createRuntimeLifecycle: typeof CreateRuntimeLifecycle;
    }>("@weaver/core/runtime/lifecycle");
    let observedFailure: unknown;
    const exit = vi.fn();
    const logFatal = vi.fn();
    const actual = createRuntimeLifecycle({
      ...dependencies!,
      on: vi.fn(),
      startHealth: async () => ({ close: async () => undefined }),
      stop: async () => {
        try {
          await dependencies!.stop();
        } catch (error) {
          observedFailure = error;
          throw error;
        }
      },
      exit,
      logFatal,
      shutdownTimeoutMs: 10_000,
    });
    await actual.run();

    const stopping = actual.shutdown(0);
    try {
      await vi.waitFor(() => {
        expect(diagnostics.stopDiagnosticWriter).toHaveBeenCalledOnce();
      });
      expect(diagnostics.emitDiagnostic).toHaveBeenLastCalledWith({
        event: "runtime.stopped",
        message: `agent-worker test-host:${process.pid} stopped`,
        details: {
          version: packageJson.version,
          node: process.version,
          pid: process.pid,
          workerId: `test-host:${process.pid}`,
        },
      });
      expect(database.db.$disconnect).not.toHaveBeenCalled();
    } finally {
      writerDrain.resolve();
      await stopping;
    }

    expect(observedFailure).toBe(failure);
    expect(database.db.$disconnect).toHaveBeenCalledOnce();
    expect(logFatal).toHaveBeenCalledExactlyOnceWith(
      "shutdown-failure",
      { name: "Error" },
      expect.objectContaining({ name: "Error" }),
    );
    expect(exit).toHaveBeenCalledWith(1);
  });
  it("refuses admission when an OIDC credential cannot be decrypted", async () => {
    oidcSecrets.assertOidcSecretsDecryptable.mockRejectedValueOnce(
      new Error("OIDC credentials unavailable"),
    );
    await expect(lifecycle.dependencies!.start()).rejects.toThrow(
      "OIDC credentials unavailable",
    );
    expect(jobs.startKnowledgeWorkers).not.toHaveBeenCalled();
  });
  it("refuses startup when a Git credential cannot be decrypted", async () => {
    gitRemoteSecrets.assertProjectGitRemoteSecretsDecryptable.mockRejectedValueOnce(
      new Error("Git credentials unavailable"),
    );
    await expect(lifecycle.dependencies!.start()).rejects.toThrow(
      "Git credentials unavailable",
    );
    expect(diagnostics.startDiagnosticWriter).toHaveBeenCalledOnce();
    expect(jobs.startKnowledgeWorkers).not.toHaveBeenCalled();
  });
});

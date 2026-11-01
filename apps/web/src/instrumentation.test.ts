import { afterEach, describe, expect, it, vi } from "vitest";
import packageJson from "../../../package.json";

const publisher = vi.hoisted(() => ({
  startKnowledgePublisher: vi.fn().mockResolvedValue(undefined),
  stopKnowledgePublisher: vi.fn().mockResolvedValue(undefined),
}));
const secrets = vi.hoisted(() => ({
  assertConnectionSecretsDecryptable: vi.fn().mockResolvedValue(undefined),
  assertExternalMcpSecretsDecryptable: vi.fn().mockResolvedValue(undefined),
}));
const encryption = vi.hoisted(() => ({
  ring: { activeVersion: 1, keys: new Map([[1, new Uint8Array(32)]]) },
  loadEncryptionKeyRing: vi.fn(),
}));
const database = vi.hoisted(() => ({
  db: { $disconnect: vi.fn().mockResolvedValue(undefined) },
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
const workers = vi.hoisted(() => ({
  startKnowledgeWorkers: vi.fn().mockResolvedValue(undefined),
  registerKnowledgeJobHandlers: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@weaver/core/jobs/publisher", () => publisher);
vi.mock("@weaver/core/jobs/runtime", () => workers);
vi.mock("@weaver/core/diagnostics/writer", () => diagnostics);
vi.mock("@weaver/core/security/encryption", () => ({
  loadEncryptionKeyRing: encryption.loadEncryptionKeyRing,
}));
vi.mock("@weaver/core/services/llmConnections", () => secrets);
vi.mock("@weaver/core/services/externalMcp", () => secrets);
vi.mock("@weaver/db", () => database);

import { register } from "./instrumentation";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  const runtime = globalThis as typeof globalThis & Record<symbol, unknown>;
  delete runtime[Symbol.for("weaver.web.cleanup")];
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  encryption.loadEncryptionKeyRing.mockReturnValue(encryption.ring);
  diagnostics.waitForDiagnosticWriterReady.mockResolvedValue(undefined);
});

describe("web instrumentation", () => {
  it("starts diagnostics after checking secrets and before the knowledge publisher", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    encryption.loadEncryptionKeyRing.mockReturnValue(encryption.ring);
    const ready = deferred();
    diagnostics.waitForDiagnosticWriterReady.mockReturnValueOnce(ready.promise);

    const registering = register();
    await vi.waitFor(() => {
      expect(diagnostics.startDiagnosticWriter).toHaveBeenCalledOnce();
    });
    expect(diagnostics.waitForDiagnosticWriterReady).toHaveBeenCalledOnce();
    expect(diagnostics.emitDiagnostic).not.toHaveBeenCalled();
    expect(publisher.startKnowledgePublisher).not.toHaveBeenCalled();

    ready.resolve();
    await registering;

    expect(secrets.assertConnectionSecretsDecryptable).toHaveBeenCalledWith(
      database.db,
      encryption.ring,
    );
    expect(secrets.assertExternalMcpSecretsDecryptable).toHaveBeenCalledWith(
      database.db,
      encryption.ring,
    );
    expect(
      secrets.assertExternalMcpSecretsDecryptable.mock.invocationCallOrder[0],
    ).toBeLessThan(
      diagnostics.startDiagnosticWriter.mock.invocationCallOrder[0]!,
    );
    expect(
      vi.mocked(secrets.assertConnectionSecretsDecryptable).mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(diagnostics.startDiagnosticWriter).mock.invocationCallOrder[0]!,
    );
    expect(
      vi.mocked(diagnostics.waitForDiagnosticWriterReady).mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(diagnostics.emitDiagnostic).mock.invocationCallOrder[0]!,
    );
    expect(
      vi.mocked(diagnostics.emitDiagnostic).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(publisher.startKnowledgePublisher).mock.invocationCallOrder[0]!,
    );
    expect(
      gitRemoteSecrets.assertProjectGitRemoteSecretsDecryptable,
    ).toHaveBeenCalledWith(database.db, encryption.ring);
    expect(
      gitRemoteSecrets.assertProjectGitRemoteSecretsDecryptable.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      diagnostics.startDiagnosticWriter.mock.invocationCallOrder[0]!,
    );
    expect(
      remoteSecrets.assertRemoteConnectionSecretsDecryptable,
    ).toHaveBeenCalledWith(database.db, encryption.ring);
    expect(
      remoteSecrets.assertRemoteConnectionSecretsDecryptable.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      diagnostics.startDiagnosticWriter.mock.invocationCallOrder[0]!,
    );
    expect(diagnostics.startDiagnosticWriter).toHaveBeenCalledWith({
      db: database.db,
      runtime: "web",
    });
    expect(diagnostics.emitDiagnostic).toHaveBeenCalledWith({
      event: "runtime.started",
      message: "web runtime started",
      details: {
        version: packageJson.version,
        node: process.version,
        pid: process.pid,
      },
    });
    expect(publisher.startKnowledgePublisher).toHaveBeenCalledOnce();
    expect(workers.startKnowledgeWorkers).not.toHaveBeenCalled();
    expect(workers.registerKnowledgeJobHandlers).not.toHaveBeenCalled();
  });
  it("refuses startup before publishing when an OIDC credential cannot be decrypted", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    oidcSecrets.assertOidcSecretsDecryptable.mockRejectedValueOnce(
      new Error("OIDC credentials unavailable"),
    );
    await expect(register()).rejects.toThrow("OIDC credentials unavailable");
    expect(publisher.startKnowledgePublisher).not.toHaveBeenCalled();
  });
  it("refuses startup before publishing when a Git credential cannot be decrypted", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    gitRemoteSecrets.assertProjectGitRemoteSecretsDecryptable.mockRejectedValueOnce(
      new Error("Git credentials unavailable"),
    );
    await expect(register()).rejects.toThrow("Git credentials unavailable");
    expect(diagnostics.startDiagnosticWriter).not.toHaveBeenCalled();
    expect(publisher.startKnowledgePublisher).not.toHaveBeenCalled();
  });
});

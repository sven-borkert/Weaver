import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  createRuntimeLifecycle as CreateRuntimeLifecycle,
  RuntimeLifecycleDependencies,
} from "@weaver/core/runtime/lifecycle";
import packageJson from "../../../package.json";

const publisher = vi.hoisted(() => ({
  stopKnowledgePublisher: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@weaver/core/jobs/publisher", () => publisher);

type CapturedLifecycle = RuntimeLifecycleDependencies;

const lifecycle = vi.hoisted(() => ({
  dependencies: null as CapturedLifecycle | null,
  run: vi.fn().mockResolvedValue(undefined),
}));
const database = vi.hoisted(() => ({
  db: { $disconnect: vi.fn().mockResolvedValue(undefined) },
}));
const auth = vi.hoisted(() => {
  const instance = {};
  const verifiers = {};
  return {
    instance,
    verifiers,
    createWeaverAuth: vi.fn(() => instance),
    createBearerVerifiers: vi.fn(() => verifiers),
  };
});
const externalSecrets = vi.hoisted(() => ({
  assertExternalMcpSecretsDecryptable: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@weaver/core/services/externalMcp", () => externalSecrets);

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
const mcp = vi.hoisted(() => {
  const config = {
    issuer: "http://issuer.test/api/auth",
    resourceUrl: "http://resource.test/mcp",
    production: false,
    mcpPath: "/mcp",
  };
  const handler = {};
  return {
    config,
    handler,
    close: vi.fn().mockResolvedValue(undefined),
    createMcpHttpHandler: vi.fn(() => handler),
    createMcpNodeServer: vi.fn(),
    mcpRuntimeConfigFromEnv: vi.fn(() => config),
  };
});

vi.mock("@weaver/auth", () => ({
  createBearerVerifiers: auth.createBearerVerifiers,
  createWeaverAuth: auth.createWeaverAuth,
}));
vi.mock("@weaver/config/server", () => ({
  parseServerEnv: () => ({
    AUTH_SECRET: "TEST_ONLY_AUTH_SECRET",
    WEAVER_MCP_PORT: 3200,
    WEAVER_MCP_TOOL_TIMEOUT_MS: 30_000,
    WEAVER_MCP_TRUST_PROXY: false,
  }),
}));
vi.mock("@weaver/core/diagnostics/writer", () => diagnostics);
vi.mock("@weaver/core/runtime/lifecycle", () => ({
  createRuntimeLifecycle: (dependencies: CapturedLifecycle) => {
    lifecycle.dependencies = dependencies;
    return { run: lifecycle.run };
  },
}));
vi.mock("@weaver/core/services/llmConnections", () => ({
  assertConnectionSecretsDecryptable: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@weaver/core/security/encryption", () => ({
  loadEncryptionKeyRing: vi.fn(),
}));
vi.mock("@weaver/db", () => database);
vi.mock("@weaver/mcp", () => ({
  createMcpHttpHandler: mcp.createMcpHttpHandler,
  createMcpNodeServer: mcp.createMcpNodeServer,
  mcpRuntimeConfigFromEnv: mcp.mcpRuntimeConfigFromEnv,
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
  auth.createWeaverAuth.mockReturnValue(auth.instance);
  auth.createBearerVerifiers.mockReturnValue(auth.verifiers);
  mcp.mcpRuntimeConfigFromEnv.mockReturnValue(mcp.config);
  mcp.createMcpHttpHandler.mockReturnValue(mcp.handler);
  mcp.createMcpNodeServer.mockResolvedValue({ port: 3200, close: mcp.close });
  mcp.close.mockResolvedValue(undefined);
  diagnostics.waitForDiagnosticWriterReady.mockResolvedValue(undefined);
  diagnostics.stopDiagnosticWriter.mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MCP runtime composition", () => {
  it("starts and stops the diagnostic writer around listener admission", async () => {
    const dependencies = lifecycle.dependencies;
    expect(dependencies).not.toBeNull();
    const ready = deferred();
    diagnostics.waitForDiagnosticWriterReady.mockReturnValueOnce(ready.promise);

    const starting = dependencies!.start();
    await vi.waitFor(() => {
      expect(diagnostics.startDiagnosticWriter).toHaveBeenCalledOnce();
    });
    expect(diagnostics.waitForDiagnosticWriterReady).toHaveBeenCalledOnce();
    expect(mcp.createMcpNodeServer).not.toHaveBeenCalled();
    expect(diagnostics.emitDiagnostic).not.toHaveBeenCalled();

    ready.resolve();
    await starting;
    expect(
      externalSecrets.assertExternalMcpSecretsDecryptable,
    ).toHaveBeenCalledOnce();

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
      remoteSecrets.assertRemoteConnectionSecretsDecryptable.mock.calls[0]?.[0],
    ).toBe(database.db);
    expect(
      remoteSecrets.assertRemoteConnectionSecretsDecryptable.mock
        .invocationCallOrder[0],
    ).toBeGreaterThan(
      gitRemoteSecrets.assertProjectGitRemoteSecretsDecryptable.mock
        .invocationCallOrder[0]!,
    );
    expect(diagnostics.startDiagnosticWriter).toHaveBeenCalledWith({
      db: database.db,
      runtime: "mcp",
    });
    expect(mcp.createMcpNodeServer).toHaveBeenCalledWith(
      mcp.handler,
      expect.objectContaining({
        port: 3200,
        host: "127.0.0.1",
        trustProxy: false,
      }),
    );
    expect(diagnostics.emitDiagnostic).toHaveBeenCalledWith({
      event: "runtime.started",
      message: "mcp-server listening on 3200",
      details: {
        version: packageJson.version,
        node: process.version,
        pid: process.pid,
        port: 3200,
      },
    });
    expect(
      diagnostics.startDiagnosticWriter.mock.invocationCallOrder[0],
    ).toBeLessThan(mcp.createMcpNodeServer.mock.invocationCallOrder[0]!);
    expect(
      diagnostics.waitForDiagnosticWriterReady.mock.invocationCallOrder[0],
    ).toBeLessThan(mcp.createMcpNodeServer.mock.invocationCallOrder[0]!);
    expect(mcp.createMcpNodeServer.mock.invocationCallOrder[0]).toBeLessThan(
      diagnostics.emitDiagnostic.mock.invocationCallOrder[0]!,
    );

    await dependencies!.stop();

    expect(mcp.close).toHaveBeenCalledOnce();
    expect(diagnostics.emitDiagnostic).toHaveBeenLastCalledWith({
      event: "runtime.stopped",
      message: "mcp-server stopped",
      details: {
        version: packageJson.version,
        node: process.version,
        pid: process.pid,
        port: 3200,
      },
    });
    expect(diagnostics.stopDiagnosticWriter).toHaveBeenCalledOnce();
    expect(publisher.stopKnowledgePublisher).toHaveBeenCalledOnce();
    expect(mcp.close.mock.invocationCallOrder[0]).toBeLessThan(
      diagnostics.emitDiagnostic.mock.invocationCallOrder[1]!,
    );
    expect(diagnostics.emitDiagnostic.mock.invocationCallOrder[1]).toBeLessThan(
      diagnostics.stopDiagnosticWriter.mock.invocationCallOrder[0]!,
    );
  });

  it("drains diagnostics before disconnecting when listener shutdown fails", async () => {
    const dependencies = lifecycle.dependencies;
    expect(dependencies).not.toBeNull();
    const failure = new Error("listener drain failed");
    const writerDrain = deferred();
    mcp.close.mockRejectedValueOnce(failure);
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
        message: "mcp-server stopped",
        details: {
          version: packageJson.version,
          node: process.version,
          pid: process.pid,
          port: 3200,
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
    expect(mcp.createMcpNodeServer).not.toHaveBeenCalled();
  });
  it("refuses startup when a Git credential cannot be decrypted", async () => {
    gitRemoteSecrets.assertProjectGitRemoteSecretsDecryptable.mockRejectedValueOnce(
      new Error("Git credentials unavailable"),
    );
    await expect(lifecycle.dependencies!.start()).rejects.toThrow(
      "Git credentials unavailable",
    );
    expect(diagnostics.startDiagnosticWriter).toHaveBeenCalledOnce();
    expect(mcp.createMcpNodeServer).not.toHaveBeenCalled();
  });
});

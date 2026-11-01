import { createWebRuntimeCleanup } from "./server/runtime/shutdown";
import packageJson from "../../../package.json";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const [
      { assertConnectionSecretsDecryptable },
      { assertExternalMcpSecretsDecryptable },
      { assertProjectGitRemoteSecretsDecryptable },
      { assertRemoteConnectionSecretsDecryptable },
      { assertOidcSecretsDecryptable },
      { loadEncryptionKeyRing },
      { db },
      { startKnowledgePublisher, stopKnowledgePublisher },
      {
        emitDiagnostic,
        startDiagnosticWriter,
        stopDiagnosticWriter,
        waitForDiagnosticWriterReady,
      },
    ] = await Promise.all([
      import("@weaver/core/services/llmConnections"),
      import("@weaver/core/services/externalMcp"),
      import("@weaver/core/services/projectGitRemote"),
      import("@weaver/core/services/remoteInstances"),
      import("@weaver/core/services/oidc/credentials"),
      import("@weaver/core/security/encryption"),
      import("@weaver/db"),
      import("@weaver/core/jobs/publisher"),
      import("@weaver/core/diagnostics/writer"),
    ]);
    const runtime = globalThis as typeof globalThis &
      Record<symbol, (() => Promise<void>) | undefined>;
    runtime[Symbol.for("weaver.web.cleanup")] = createWebRuntimeCleanup({
      stopPublisher: stopKnowledgePublisher,
      emitStopped: () =>
        emitDiagnostic({
          event: "runtime.stopped",
          message: "web runtime stopped",
        }),
      stopWriter: stopDiagnosticWriter,
      disconnect: () => db.$disconnect(),
    });
    await assertConnectionSecretsDecryptable(db, loadEncryptionKeyRing());
    await assertExternalMcpSecretsDecryptable(db, loadEncryptionKeyRing());
    await assertProjectGitRemoteSecretsDecryptable(db, loadEncryptionKeyRing());
    await assertRemoteConnectionSecretsDecryptable(db, loadEncryptionKeyRing());
    await assertOidcSecretsDecryptable(db, loadEncryptionKeyRing());
    startDiagnosticWriter({ db, runtime: "web" });
    await waitForDiagnosticWriterReady();
    emitDiagnostic({
      event: "runtime.started",
      message: "web runtime started",
      details: {
        version: packageJson.version,
        node: process.version,
        pid: process.pid,
      },
    });
    await startKnowledgePublisher();
  }
}

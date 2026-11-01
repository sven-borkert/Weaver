import { assertOidcSecretsDecryptable } from "@weaver/core/services/oidc/credentials";
import { createPinnedFetch } from "@weaver/config/outboundFetch";
import { createBearerVerifiers, createWeaverAuth } from "@weaver/auth";
import { parseServerEnv } from "@weaver/config/server";
import {
  emitDiagnostic,
  startDiagnosticWriter,
  stopDiagnosticWriter,
  waitForDiagnosticWriterReady,
} from "@weaver/core/diagnostics/writer";
import { diagnosticReference } from "@weaver/core/diagnostics/reference";
import { stopKnowledgePublisher } from "@weaver/core/jobs/publisher";
import { createRuntimeLifecycle } from "@weaver/core/runtime/lifecycle";
import { parseKnowledgeConfig } from "@weaver/core/knowledge/config";
import { loadEncryptionKeyRing } from "@weaver/core/security/encryption";
import { assertProjectGitRemoteSecretsDecryptable } from "@weaver/core/services/projectGitRemote";
import { assertExternalMcpSecretsDecryptable } from "@weaver/core/services/externalMcp";
import { assertRemoteConnectionSecretsDecryptable } from "@weaver/core/services/remoteInstances";
import { assertConnectionSecretsDecryptable } from "@weaver/core/services/llmConnections";
import { db } from "@weaver/db";
import { createExternalMcpTransport } from "@weaver/external-mcp";
import {
  createMcpHttpHandler,
  createMcpNodeServer,
  mcpRuntimeConfigFromEnv,
  type McpNodeServer,
} from "@weaver/mcp";
import packageJson from "../../../package.json";

const env = parseServerEnv(process.env);
const config = mcpRuntimeConfigFromEnv(env, {
  basePath: process.env.NEXT_PUBLIC_BASE_PATH,
  version: packageJson.version,
});
const knowledgeConfig = parseKnowledgeConfig(process.env);
const keyRing = loadEncryptionKeyRing();
const runtimeFacts = {
  basePath: process.env.NEXT_PUBLIC_BASE_PATH ?? "",
  dataDir: env.WEAVER_DATA_DIR,
  poolMax: env.DATABASE_POOL_MAX,
  statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
  jobsEnabled: knowledgeConfig.jobsEnabled,
  reconcileCron: knowledgeConfig.reconcileCron,
  assistantReconcileCron: knowledgeConfig.assistantReconcileCron,
  mcpPort: env.WEAVER_MCP_PORT,
  encryptionKeyVersions: keyRing
    ? [...keyRing.keys.keys()].sort((a, b) => a - b)
    : [],
};
// Same secret and database as the web runtime. This instance never serves
// auth routes: it verifies keys (api-key plugin) and reads the shared JWKS.
const auth = createWeaverAuth({
  db,
  secret: env.AUTH_SECRET,
  baseURL: config.issuer,
});
const verifiers = createBearerVerifiers(auth, {
  issuer: config.issuer,
  audience: config.resourceUrl,
});
const handler = createMcpHttpHandler({
  db,
  verifiers,
  config,
  ring: keyRing,
  llmFetch: createPinnedFetch(fetch),
  runtimeFacts,
  // A pre-guarded fetch would double-wrap; the transport pins its own.
  external: keyRing
    ? {
        db,
        ring: keyRing,
        transport: createExternalMcpTransport({ fetchImpl: fetch }),
        now: () => new Date(),
      }
    : null,
});

let server: McpNodeServer | null = null;
const lifecycle = createRuntimeLifecycle({
  on: (event, listener) => process.on(event, listener),
  // Liveness is served on the MCP port itself (/health, unauthenticated).
  startHealth: async () => ({ close: async () => undefined }),
  start: async () => {
    startDiagnosticWriter({ db, runtime: "mcp" });
    await waitForDiagnosticWriterReady();
    await assertConnectionSecretsDecryptable(db, keyRing);
    await assertExternalMcpSecretsDecryptable(db, keyRing);
    await assertProjectGitRemoteSecretsDecryptable(db, keyRing);
    await assertRemoteConnectionSecretsDecryptable(db, keyRing);
    await assertOidcSecretsDecryptable(db, keyRing);
    server = await createMcpNodeServer(handler, {
      port: env.WEAVER_MCP_PORT,
      host: config.production ? "0.0.0.0" : "127.0.0.1",
      trustProxy: env.WEAVER_MCP_TRUST_PROXY,
      onError: (error) => console.error(`mcp-server adapter: ${error.name}`),
    });
    emitDiagnostic({
      event: "runtime.started",
      message: `mcp-server listening on ${server.port}`,
      details: {
        version: packageJson.version,
        node: process.version,
        pid: process.pid,
        port: server.port,
      },
    });
    console.log(
      JSON.stringify({
        event: "mcp.listening",
        port: server.port,
        path: config.mcpPath,
        resource: config.resourceUrl,
        issuer: config.issuer,
      }),
    );
  },
  stop: async () => {
    const port = server?.port ?? null;
    let failed = false;
    let failure: unknown;
    try {
      await server?.close();
    } catch (error) {
      failed = true;
      failure = error;
    }
    server = null;
    try {
      await stopKnowledgePublisher();
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
    emitDiagnostic({
      event: "runtime.stopped",
      message: "mcp-server stopped",
      details: {
        version: packageJson.version,
        node: process.version,
        pid: process.pid,
        port,
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
        message: `mcp-server fatal: ${event}`,
        details: {
          source: "lifecycle",
          fatal: event,
          ...cause,
          ...(error ? { error } : {}),
        },
      }),
    );
    console.error("mcp-server fatal", { event, cause, reference });
  },
  shutdownTimeoutMs: env.WEAVER_MCP_TOOL_TIMEOUT_MS + 10_000,
});

await lifecycle.run();

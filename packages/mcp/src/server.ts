import { McpServer } from "@modelcontextprotocol/server";
import type { ToolContext } from "@weaver/assistant-tools/contract";
import { mcpToolsForActor } from "@weaver/assistant-tools/registry";
import {
  MCP_TOOLSET_NAMES,
  parseToolsets,
  type McpToolsetName,
} from "@weaver/assistant-tools/toolsetNames";
import { selectMcpTools } from "@weaver/assistant-tools/toolsets";
import {
  resolveMcpScopeSnapshot,
  type ScopeSnapshot,
} from "@weaver/core/assistant/scope";
import type { InboundExternalTool } from "@weaver/core/externalMcp/types";
import type { McpPrincipal } from "@weaver/core/security/bearer";
import { hasCapability } from "@weaver/core/security/context";
import {
  recordMcpAudit,
  type McpAuditInput,
} from "@weaver/core/services/mcpOperations";
import type { PrismaClient } from "@weaver/db/client";
import type { McpRuntimeConfig } from "./config";
import { registerExternalTools, type ExternalToolDeps } from "./externalTools";
import { buildMcpInstructions } from "./instructions";
import { META_TOOL_NAMES, registerMetaTools } from "./metaTools";
import { registerResources } from "./resources";
import { registerContractTools, type ToolDeps } from "./tools";

export type ServerDeps = {
  db: PrismaClient;
  principal: McpPrincipal;
  requestId: string;
  config: McpRuntimeConfig;
  runtimeFacts?: AdminRuntimeFacts;
  llm?: ToolContext["llm"];
  external?: ToolContext["external"];
  auditState?: McpAuditState;
  writeRequestSignal?: AbortSignal;
  externalTools?: readonly InboundExternalTool[];
  callExternal?: ExternalToolDeps["call"];
  toolsets?: readonly McpToolsetName[];
  /** Set for tools/call: every permitted tool is registered so unlisted ones stay directly callable. */
  registerUnlisted?: boolean;
};

export type AdminRuntimeFacts = {
  basePath: string;
  dataDir: string;
  poolMax: number;
  statementTimeoutMs: number;
  jobsEnabled: boolean;
  reconcileCron: string;
  assistantReconcileCron: string;
  mcpPort: number;
  encryptionKeyVersions: number[];
};

export type McpAuditState = { claimed: boolean };

/** Synchronously claims the one audit slot shared by the SDK callback and HTTP fallback. */
export function claimMcpAudit(state: McpAuditState | undefined): boolean {
  if (!state) return true;
  if (state.claimed) return false;
  state.claimed = true;
  return true;
}

/** One fresh instance per HTTP request (spec §16): tools are registered for this actor only. */
export function createWeaverMcpServer(deps: ServerDeps): McpServer {
  const { security, profile, clientId } = deps.principal;
  const permitted = mcpToolsForActor(security);
  const selection = selectMcpTools(
    security,
    deps.toolsets ?? parseToolsets(null),
  );
  const external = deps.callExternal ? (deps.externalTools ?? []) : [];
  const externalListed = selection.external ? external : [];
  const listed = new Set<string>([
    ...selection.tools.map((tool) => tool.name),
    ...externalListed.map((tool) => tool.name),
    ...META_TOOL_NAMES,
  ]);
  const server = new McpServer(
    { name: "weaver", version: deps.config.version },
    {
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false },
      },
      instructions: buildMcpInstructions({
        exams: selection.active.includes("exams"),
        activeToolsets: selection.active,
        availableToolsets: MCP_TOOLSET_NAMES.filter(
          (name) => name !== "all" && !selection.active.includes(name),
        ),
        admin: selection.tools.some(
          (tool) => tool.capability === "system:admin",
        ),
        // Instructions go out before external tools are fetched, so no tool list here.
        external:
          selection.external &&
          hasCapability(security, "external:use") &&
          !!deps.callExternal,
      }),
      cacheHints: {
        "tools/list": { ttlMs: 60_000, cacheScope: "private" },
        "resources/templates/list": {
          ttlMs: 60_000,
          cacheScope: "private",
        },
        "server/discover": { ttlMs: 60_000, cacheScope: "private" },
        "resources/read": { ttlMs: 0, cacheScope: "private" },
      },
    },
  );
  // Spec §26.2 item 10: no conversation, so the scope is "all" (100-project cap).
  let scope: Promise<ScopeSnapshot> | undefined;
  const runtime = deps.runtimeFacts
    ? {
        version: deps.config.version,
        config: {
          basePath: deps.runtimeFacts.basePath,
          dataDir: deps.runtimeFacts.dataDir,
          poolMax: deps.runtimeFacts.poolMax,
          statementTimeoutMs: deps.runtimeFacts.statementTimeoutMs,
          jobsEnabled: deps.runtimeFacts.jobsEnabled,
          reconcileCron: deps.runtimeFacts.reconcileCron,
          assistantReconcileCron: deps.runtimeFacts.assistantReconcileCron,
          mcp: {
            port: deps.runtimeFacts.mcpPort,
            toolTimeoutMs: deps.config.toolTimeoutMs,
            maxBodyBytes: deps.config.maxBodyBytes,
            maxResourceChars: deps.config.maxResourceChars,
            rateLimitPerMinute: deps.config.rateLimitPerMinute,
          },
          encryptionKeyVersions: [...deps.runtimeFacts.encryptionKeyVersions],
        },
      }
    : undefined;
  const context = async (): Promise<ToolContext> => ({
    db: deps.db,
    actor: security,
    scope: await (scope ??= resolveMcpScopeSnapshot(deps.db, security)),
    profile,
    run: null,
    runtime,
    llm: deps.llm,
    external: deps.external,
  });
  const audit = async (
    event: Omit<
      McpAuditInput,
      | "requestId"
      | "userId"
      | "credentialId"
      | "authenticationMethod"
      | "clientId"
    >,
  ): Promise<boolean> => {
    if (!claimMcpAudit(deps.auditState)) return false;
    await recordMcpAudit(deps.db, {
      requestId: deps.requestId,
      userId: security.userId,
      credentialId: security.credentialId,
      authenticationMethod: security.authenticationMethod,
      clientId,
      ...event,
    });
    return true;
  };
  const toolDeps: ToolDeps = {
    context,
    toolTimeoutMs: deps.config.toolTimeoutMs,
    writeRequestSignal: deps.writeRequestSignal,
    onAudit: (event) => audit({ method: "tools/call", ...event }),
  };
  const externalDeps: ExternalToolDeps | undefined = deps.callExternal
    ? {
        call: deps.callExternal,
        writeRequestSignal: deps.writeRequestSignal,
        onAudit: (event) => audit({ method: "tools/call", ...event }),
      }
    : undefined;
  registerContractTools(
    server,
    deps.registerUnlisted ? permitted : selection.tools,
    toolDeps,
  );
  const externalRegistered = deps.registerUnlisted ? external : externalListed;
  if (externalRegistered.length && externalDeps)
    registerExternalTools(server, externalRegistered, externalDeps);
  registerMetaTools(server, {
    contracts: permitted,
    external,
    listed,
    activeToolsets: selection.active,
    tool: toolDeps,
    externalDeps,
  });
  registerResources(server, {
    db: deps.db,
    actor: security,
    scope: async () => (await context()).scope,
    maxResourceChars: deps.config.maxResourceChars,
    onAudit: (event) =>
      audit({ method: "resources/read", commitSha: null, ...event }),
  });
  return server;
}

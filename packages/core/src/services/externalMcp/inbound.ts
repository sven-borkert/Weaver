import { loadRuntimeCatalog } from "./capacity";
import { CoreError } from "../../errors";
import { assignInboundToolNames } from "../../externalMcp/inboundTools";
import type {
  ExternalResult,
  ExternalRuntimeDeps,
  InboundExternalTool,
  JsonObject,
} from "../../externalMcp/types";
import {
  hasCapability,
  type UserSecurityContext,
} from "../../security/context";
import { reviewedTool, type ExternalAccessDeps } from "./access";
import { prepareExternalCall } from "./calls";
import { executeExternalCall } from "./execution";

export async function listInboundExternalTools(
  deps: ExternalAccessDeps,
  actor: UserSecurityContext,
): Promise<InboundExternalTool[]> {
  if (
    (actor.authenticationMethod !== "apiKey" &&
      actor.authenticationMethod !== "oauth") ||
    !hasCapability(actor, "mcp:use") ||
    !hasCapability(actor, "external:use")
  )
    return [];
  const canRead = hasCapability(actor, "content:read");
  const canWrite = hasCapability(actor, "content:write");
  const connections = await loadRuntimeCatalog(deps.db, actor.userId);
  const found: Array<Omit<InboundExternalTool, "name">> = [];
  for (const connection of connections)
    for (const tool of [...connection.tools].sort((a, b) =>
      a.remoteName.localeCompare(b.remoteName),
    )) {
      const definition = reviewedTool(tool);
      if (!definition || !tool.effect || !tool.reviewDigest) continue;
      if (tool.effect === "read" ? !canRead : !canWrite) continue;
      found.push({
        toolId: tool.id,
        connectionId: connection.id,
        connectionName: connection.name,
        remoteName: definition.name,
        description: `[${connection.name}] ${definition.description ?? ""}${
          tool.effect === "write"
            ? " (Changes data; a retried call runs again.)"
            : ""
        }`.trim(),
        effect: tool.effect,
        inputSchema: definition.inputSchema,
        configRevision: connection.revision,
        reviewDigest: tool.reviewDigest,
        timeoutMs: connection.timeoutMs,
      });
    }
  const names = assignInboundToolNames(found);
  return found
    .map((tool, index) => ({ ...tool, name: names[index]! }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function callInboundExternalTool(
  deps: ExternalRuntimeDeps,
  actor: UserSecurityContext,
  input: {
    tool: InboundExternalTool;
    arguments: JsonObject;
    requestId: string;
    signal: AbortSignal;
    timeoutMs: number;
  },
): Promise<ExternalResult> {
  if (
    actor.authenticationMethod !== "apiKey" &&
    actor.authenticationMethod !== "oauth"
  )
    throw new CoreError("FORBIDDEN");
  const now = deps.now();
  const invocation = {
    owner: {
      kind: "mcp" as const,
      requestId: input.requestId,
      credentialId: actor.credentialId,
      authenticationMethod: actor.authenticationMethod,
    },
    scope: {
      kind: "all" as const,
      projectIds: [],
      documentId: null,
      tableId: null,
      resolvedAt: now.toISOString(),
      truncated: false,
    },
    toolId: input.tool.toolId,
    expectedConfigRevision: input.tool.configRevision,
    expectedToolDigest: input.tool.reviewDigest,
    arguments: input.arguments,
    deadline: new Date(
      now.getTime() + Math.min(input.timeoutMs, input.tool.timeoutMs),
    ),
  };
  const prepared = await prepareExternalCall(deps, actor, invocation);
  return executeExternalCall(deps, actor, {
    callId: prepared.callId,
    invocation,
    signal: input.signal,
  });
}

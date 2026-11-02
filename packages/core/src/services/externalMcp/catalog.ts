import { MAX_ENABLED_EXTERNAL_TOOLS } from "../../externalMcp/limits";
import { assertCatalogCapacity, lockExternalOwner } from "./capacity";
import type { z } from "zod";
import { emitDiagnostic } from "../../diagnostics/writer";
import { describeNetworkFailure } from "../../diagnostics/networkFailure";
import { externalTransaction } from "./diagnostics";
import {
  ExternalMcpError,
  parseToolDefinitions,
  type RemoteCatalog,
  type ExternalMcpSession,
} from "@weaver/external-mcp";
import { CoreError } from "../../errors";
import type { UserSecurityContext } from "../../security/context";
import { canonicalDigest } from "../../externalMcp/digest";
import { MAX_CATALOG_BYTES } from "../../externalMcp/limits";
import {
  toolBulkReviewSchema,
  connectionUpdateSchema,
} from "../../externalMcp/schema";
import { suggestedToolEffect } from "../../externalMcp/toolState";
import type { ExternalRuntimeDeps } from "../../externalMcp/types";
import {
  CONNECTION_SELECT,
  TOOL_SELECT,
  assertConnectionManager,
  externalSettingsChanged,
  lockExternalConnection,
  parseInput,
  revisionInput,
} from "./connections";
import { decryptExternalConnectionCredential } from "./credentials";
import { invalidateExternalApprovals } from "./approvals";

export async function discoverExternalConnection(
  deps: ExternalRuntimeDeps,
  actor: UserSecurityContext,
  input: { id: string; expectedRevision: number },
) {
  assertConnectionManager(actor);
  parseInput(revisionInput, input);
  const snapshot = await deps.db.externalMcpConnection.findFirst({
    where: { id: input.id, ownerId: actor.userId },
    select: CONNECTION_SELECT,
  });
  if (!snapshot)
    throw new CoreError("NOT_FOUND", "External connection not found");
  if (snapshot.revision !== input.expectedRevision)
    throw new CoreError(
      "CONFLICT",
      "External connection configuration changed",
    );
  let session: ExternalMcpSession | undefined;
  let catalog: RemoteCatalog;
  try {
    session = await deps.transport.open({
      endpoint: snapshot.endpoint,
      token: () =>
        decryptExternalConnectionCredential(
          deps.db,
          deps.ring,
          snapshot.id,
          snapshot.endpoint,
        ),
      signal: AbortSignal.timeout(snapshot.timeoutMs),
      timeoutMs: snapshot.timeoutMs,
      insecureTls: snapshot.allowInsecureTls,
    });
    catalog = await session.discover();
    if (
      Buffer.byteLength(JSON.stringify(catalog), "utf8") > MAX_CATALOG_BYTES ||
      catalog.protocolVersion.length > 40 ||
      catalog.tools.some((t) => t.name.length > 300)
    )
      throw new ExternalMcpError("INVALID_CATALOG");
    parseInput(connectionUpdateSchema, { endpoint: catalog.canonicalEndpoint });
    catalog.tools = parseToolDefinitions(catalog.tools);
  } catch (error) {
    const code =
      error instanceof ExternalMcpError ? error.code : "TRANSPORT_ERROR";
    const network =
      code === "TRANSPORT_ERROR"
        ? describeNetworkFailure(
            error instanceof ExternalMcpError ? error.cause : error,
          )
        : null;
    const reportedCode = network?.code ?? code;
    const summary = network?.text ?? "External MCP discovery failed";
    const connection = await externalTransaction(
      deps.db,
      async (tx, _diagnostics) => {
        await lockExternalConnection(
          tx,
          actor.userId,
          input.id,
          input.expectedRevision,
        );
        return tx.externalMcpConnection.update({
          where: { id: input.id },
          data: {
            discoveryErrorCode: reportedCode,
            discoveryErrorSummary: summary,
          },
          select: CONNECTION_SELECT,
        });
      },
    );
    emitDiagnostic({
      event: "external.discovery.completed",
      message: "External MCP discovery failed",
      connectionId: input.id,
      userId: actor.userId,
      outcome: "error",
      details: {
        errorCode: reportedCode,
        configRevision: input.expectedRevision,
      },
    });
    return {
      status: "failed" as const,
      connection,
      totalTools: connection.discoveryToolCount ?? 0,
      totalResources: connection.discoveryResourceCount ?? 0,
      canonicalEndpoint: null,
    };
  } finally {
    if (session) await session.close().catch(() => undefined);
  }
  const now = deps.now();
  const connection = await externalTransaction(
    deps.db,
    async (tx, _diagnostics) => {
      await lockExternalConnection(
        tx,
        actor.userId,
        input.id,
        input.expectedRevision,
      );
      const existing = await tx.externalMcpTool.findMany({
        where: {
          connectionId: input.id,
          remoteName: { in: catalog.tools.map((tool) => tool.name) },
        },
        select: {
          id: true,
          remoteName: true,
          discoveredRemoteDigest: true,
          reviewedRemoteDigest: true,
        },
      });
      const byName = new Map(existing.map((t) => [t.remoteName, t]));
      const names = new Set(catalog.tools.map((t) => t.name));
      await tx.externalMcpTool.updateMany({
        where: {
          connectionId: input.id,
          presentInCatalog: true,
          remoteName: { notIn: [...names] },
        },
        data: { enabled: false, presentInCatalog: false },
      });
      for (const tool of catalog.tools) {
        const digest = canonicalDigest(tool);
        const old = byName.get(tool.name);
        const data = {
          presentInCatalog: true,
          description: tool.description ?? null,
          discoveredDefinition: tool,
          discoveredRemoteDigest: digest,
          discoveredAt: now,
        };
        if (old)
          await tx.externalMcpTool.update({
            where: { id: old.id },
            data: {
              ...data,
              ...(old.discoveredRemoteDigest !== digest
                ? { enabled: false }
                : {}),
              ...(old.reviewedRemoteDigest === null
                ? { effect: suggestedToolEffect(tool) }
                : {}),
            },
            select: { id: true },
          });
        else
          await tx.externalMcpTool.create({
            data: {
              ...data,
              connectionId: input.id,
              remoteName: tool.name,
              effect: suggestedToolEffect(tool),
            },
            select: { id: true },
          });
      }
      await invalidateExternalApprovals(
        tx,
        {
          connectionId: input.id,
          reason: "configuration_changed",
        },
        _diagnostics,
      );
      return tx.externalMcpConnection.update({
        where: { id: input.id },
        data: {
          revision: { increment: 1 },
          lastDiscoveredAt: now,
          discoveryProtocol: catalog.protocolVersion,
          discoveryServerName:
            typeof catalog.serverInfo.name === "string"
              ? catalog.serverInfo.name.slice(0, 200)
              : null,
          discoveryToolCount: catalog.tools.length,
          discoveryResourceCount: catalog.resources?.length ?? 0,
          discoveryErrorCode: null,
          discoveryErrorSummary: null,
        },
        select: CONNECTION_SELECT,
      });
    },
  );
  externalSettingsChanged(actor, input.id, "discovered");
  emitDiagnostic({
    event: "external.discovery.completed",
    message: "External MCP discovery completed",
    connectionId: input.id,
    userId: actor.userId,
    outcome: "ok",
    details: {
      configRevision: connection.revision,
      totalTools: catalog.tools.length,
      totalResources: catalog.resources?.length ?? 0,
    },
  });
  return {
    status: "success" as const,
    connection,
    totalTools: catalog.tools.length,
    totalResources: catalog.resources?.length ?? 0,
    canonicalEndpoint: catalog.canonicalEndpoint,
  };
}
export async function reviewExternalTools(
  deps: ExternalRuntimeDeps,
  actor: UserSecurityContext,
  input: z.input<typeof toolBulkReviewSchema>,
) {
  assertConnectionManager(actor);
  const { connectionId, items } = parseInput(toolBulkReviewSchema, input);
  const result = await externalTransaction(
    deps.db,
    async (tx, _diagnostics) => {
      await lockExternalOwner(tx, actor.userId);
      const connection = await lockExternalConnection(
        tx,
        actor.userId,
        connectionId,
      );
      const tools = await tx.externalMcpTool.findMany({
        where: {
          connectionId,
          id: { in: items.map((item) => item.toolId) },
        },
        select: TOOL_SELECT,
      });
      const byId = new Map(tools.map((tool) => [tool.id, tool]));
      const reviews = items.map((item) => {
        const tool = byId.get(item.toolId);
        if (!tool) throw new CoreError("NOT_FOUND", "External tool not found");
        if (tool.discoveredRemoteDigest !== item.expectedRemoteDigest)
          throw new CoreError(
            "CONFLICT",
            `External tool definition changed: ${tool.remoteName}`,
          );
        if (!tool.presentInCatalog)
          throw new CoreError(
            "PRECONDITION_FAILED",
            `External tool is no longer available: ${tool.remoteName}`,
          );
        const definition = parseToolDefinitions([tool.discoveredDefinition])[0];
        if (!definition?.supportStatus.available)
          throw new CoreError(
            "PRECONDITION_FAILED",
            `External tool schema is unsupported: ${tool.remoteName}`,
          );
        return {
          tool,
          definition,
          enabled: item.enabled ?? tool.enabled,
          effect:
            item.effect ??
            tool.effect ??
            suggestedToolEffect(tool.discoveredDefinition),
        };
      });
      const retained = await tx.externalMcpTool.findMany({
        where: {
          connection: { ownerId: actor.userId },
          enabled: true,
          presentInCatalog: true,
          id: { notIn: items.map((item) => item.toolId) },
        },
        select: { reviewedDefinition: true },
        take: MAX_ENABLED_EXTERNAL_TOOLS + 1,
      });
      assertCatalogCapacity([
        ...retained.map((tool) => tool.reviewedDefinition),
        ...reviews
          .filter((review) => review.enabled)
          .map((review) => review.definition),
      ]);
      await invalidateExternalApprovals(
        tx,
        { connectionId: connection.id, reason: "configuration_changed" },
        _diagnostics,
      );
      await tx.externalMcpConnection.update({
        where: { id: connection.id },
        data: { revision: { increment: 1 } },
        select: { id: true },
      });
      const reviewedAt = deps.now();
      const saved = [];
      for (const review of reviews)
        saved.push(
          await tx.externalMcpTool.update({
            where: { id: review.tool.id },
            data: {
              enabled: review.enabled,
              effect: review.effect,
              reviewedDefinition: review.definition,
              reviewedRemoteDigest: review.tool.discoveredRemoteDigest,
              reviewDigest: canonicalDigest({
                remoteDigest: review.tool.discoveredRemoteDigest,
                effect: review.effect,
              }),
              reviewedById: actor.userId,
              reviewedAt,
            },
            select: TOOL_SELECT,
          }),
        );
      return saved;
    },
    { timeout: 30_000 },
  );
  externalSettingsChanged(actor, connectionId, "reviewed");
  return result;
}

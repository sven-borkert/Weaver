import { externalTransaction } from "./diagnostics";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma, type PrismaClient } from "@weaver/db/client";
import { CoreError } from "../../errors";
import { hasCapability, type SecurityContext } from "../../security/context";
import {
  connectionCreateSchema,
  connectionUpdateSchema,
  toolFilterSchema,
} from "../../externalMcp/schema";
import { lockExternalOwner } from "./capacity";
import {
  MAX_STORED_EXTERNAL_CONNECTIONS,
  MAX_TOOL_KEYS,
} from "../../externalMcp/limits";
import { externalToolState } from "../../externalMcp/toolState";
import type { ExternalRuntimeDeps } from "../../externalMcp/types";
import { emitDiagnostic } from "../../diagnostics/writer";
import {
  decodeIdPageCursor,
  decodeTextIdPageCursor,
  encodePageCursor,
} from "../adminPaging";
import { invalidateExternalApprovals } from "./approvals";
import {
  CREDENTIAL_SELECT,
  EMPTY_CREDENTIAL,
  encryptExternalCredential,
} from "./credentials";
export const TOOL_SELECT = {
  presentInCatalog: true,
  id: true,
  connectionId: true,
  remoteName: true,
  description: true,
  discoveredDefinition: true,
  discoveredRemoteDigest: true,
  reviewedDefinition: true,
  reviewedRemoteDigest: true,
  reviewDigest: true,
  effect: true,
  enabled: true,
  reviewedAt: true,
  discoveredAt: true,
} satisfies Prisma.ExternalMcpToolSelect;
export const CONNECTION_SELECT = {
  id: true,
  name: true,
  endpoint: true,
  enabled: true,
  allowInsecureTls: true,
  authMode: true,
  revision: true,
  timeoutMs: true,
  createdAt: true,
  updatedAt: true,
  lastDiscoveredAt: true,
  discoveryProtocol: true,
  discoveryServerName: true,
  discoveryToolCount: true,
  discoveryResourceCount: true,
  discoveryErrorCode: true,
  discoveryErrorSummary: true,
} satisfies Prisma.ExternalMcpConnectionSelect;
export const CLEARED_REVIEW = {
  enabled: false,
  reviewedDefinition: Prisma.DbNull,
  reviewedRemoteDigest: null,
  reviewDigest: null,
  reviewedAt: null,
  reviewedById: null,
  effect: null,
};
export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new CoreError("BAD_REQUEST", "Invalid external MCP configuration");
  return result.data;
}
export const revisionInput = z.object({
  id: z.uuid(),
  expectedRevision: z.number().int().positive(),
});
export function assertConnectionManager(actor: SecurityContext) {
  if (
    actor.authenticationMethod === "task" ||
    !hasCapability(actor, "external:manage")
  )
    throw new CoreError(
      "FORBIDDEN",
      "Managing MCP connections requires external:manage",
    );
  if (
    actor.authenticationMethod !== "session" &&
    !hasCapability(actor, "mcp:use")
  )
    throw new CoreError(
      "FORBIDDEN",
      "Managing MCP connections requires mcp:use",
    );
}
const notFound = () =>
  new CoreError("NOT_FOUND", "External connection not found");
const duplicateName = () =>
  new CoreError("CONFLICT", "You already have a connection with this name", {
    field: "name",
  });
export async function lockExternalConnection(
  tx: Prisma.TransactionClient,
  ownerId: string,
  id: string,
  expectedRevision?: number,
) {
  await tx.$queryRaw`SELECT id FROM "ExternalMcpConnection" WHERE id = ${id}::uuid AND "ownerId" = ${ownerId}::uuid FOR UPDATE`;
  const row = await tx.externalMcpConnection.findFirst({
    where: { id, ownerId },
    select: CONNECTION_SELECT,
  });
  if (!row) throw notFound();
  if (expectedRevision !== undefined && row.revision !== expectedRevision)
    throw new CoreError(
      "CONFLICT",
      "External connection configuration changed",
    );
  return row;
}
export function externalSettingsChanged(
  actor: SecurityContext,
  id: string,
  action: string,
) {
  emitDiagnostic({
    event: "settings.changed",
    message: "External MCP configuration changed",
    userId: actor.userId,
    credentialId: actor.credentialId,
    connectionId: id,
    details: { setting: "external_mcp", action },
  });
}
export async function createExternalConnection(
  deps: ExternalRuntimeDeps,
  actor: SecurityContext,
  input: z.input<typeof connectionCreateSchema>,
) {
  assertConnectionManager(actor);
  const { token, ...data } = parseInput(connectionCreateSchema, input);
  const id = randomUUID();
  try {
    const result = await deps.db.$transaction(async (tx) => {
      await lockExternalOwner(tx, actor.userId);
      if (
        (await tx.externalMcpConnection.count({
          where: { ownerId: actor.userId },
        })) >= MAX_STORED_EXTERNAL_CONNECTIONS
      )
        throw new CoreError(
          "PRECONDITION_FAILED",
          "External connection capacity exceeded",
        );
      return tx.externalMcpConnection.create({
        data: {
          ...data,
          id,
          ownerId: actor.userId,
          createdAt: deps.now(),
          ...(token
            ? encryptExternalCredential(deps.ring, token, id)
            : EMPTY_CREDENTIAL),
        },
        select: CONNECTION_SELECT,
      });
    });
    externalSettingsChanged(actor, id, "created");
    return result;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    )
      throw duplicateName();
    throw error;
  }
}
export async function getExternalConnection(
  db: PrismaClient,
  actor: SecurityContext,
  id: string,
) {
  assertConnectionManager(actor);
  parseInput(z.uuid(), id);
  const result = await db.externalMcpConnection.findFirst({
    where: { id, ownerId: actor.userId },
    select: {
      ...CONNECTION_SELECT,
      tools: {
        where: { presentInCatalog: true },
        select: TOOL_SELECT,
        orderBy: { remoteName: "asc" },
        take: 25,
      },
      _count: { select: { tools: { where: { presentInCatalog: true } } } },
    },
  });
  if (!result) throw notFound();
  const { _count, ...connection } = result;
  return {
    ...connection,
    totalTools: _count.tools,
    toolsTruncated: _count.tools > connection.tools.length,
  };
}
export async function listExternalConnections(
  db: PrismaClient,
  actor: SecurityContext,
  page: { cursor?: string; limit?: number; search?: string } = {},
) {
  assertConnectionManager(actor);
  const input = parseInput(
    z.object({
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(50),
      search: z.string().max(120).optional(),
    }),
    page,
  );
  const rows = await db.externalMcpConnection.findMany({
    where: {
      ownerId: actor.userId,
      ...(input.cursor ? { id: { gt: decodeIdPageCursor(input.cursor) } } : {}),
      ...(input.search
        ? { name: { contains: input.search, mode: "insensitive" } }
        : {}),
    },
    select: CONNECTION_SELECT,
    orderBy: { id: "asc" },
    take: input.limit + 1,
  });
  const items = rows.slice(0, input.limit);
  return {
    items,
    nextCursor:
      rows.length > input.limit ? encodePageCursor([items.at(-1)!.id]) : null,
  };
}
export async function updateExternalConnection(
  deps: ExternalRuntimeDeps,
  actor: SecurityContext,
  input: {
    id: string;
    expectedRevision: number;
    patch: z.input<typeof connectionUpdateSchema>;
  },
) {
  assertConnectionManager(actor);
  parseInput(revisionInput, input);
  const { token, ...patch } = parseInput(connectionUpdateSchema, input.patch);
  const result = await externalTransaction(
    deps.db,
    async (tx, _diagnostics) => {
      const existing = await lockExternalConnection(
        tx,
        actor.userId,
        input.id,
        input.expectedRevision,
      );
      const authMode = patch.authMode ?? existing.authMode;
      const secret = await tx.externalMcpConnection.findUniqueOrThrow({
        where: { id: input.id },
        select: CREDENTIAL_SELECT,
      });
      if (
        (authMode === "bearer" && !token && !secret.credentialCiphertext) ||
        (authMode === "none" && token)
      )
        throw new CoreError(
          "BAD_REQUEST",
          "Bearer authentication requires a token",
        );
      const originChanged =
        patch.endpoint !== undefined &&
        new URL(patch.endpoint).origin !== new URL(existing.endpoint).origin;
      // The origin is the credential boundary: a retained token must never reach a new one.
      if (originChanged && authMode === "bearer" && !token)
        throw new CoreError(
          "BAD_REQUEST",
          "Changing the endpoint origin requires re-entering the bearer token",
          { field: "token" },
        );
      if (patch.endpoint !== undefined && patch.endpoint !== existing.endpoint)
        await tx.externalMcpTool.updateMany({
          where: { connectionId: input.id },
          data: { ...CLEARED_REVIEW, presentInCatalog: false },
        });
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
          ...patch,
          revision: { increment: 1 },
          ...(authMode === "none"
            ? EMPTY_CREDENTIAL
            : token
              ? encryptExternalCredential(deps.ring, token, input.id)
              : {}),
        },
        select: CONNECTION_SELECT,
      });
    },
  ).catch((error: unknown) => {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    )
      throw duplicateName();
    throw error;
  });
  externalSettingsChanged(actor, input.id, "updated");
  return result;
}
export async function deleteExternalConnection(
  db: PrismaClient,
  actor: SecurityContext,
  input: { id: string; expectedRevision: number },
) {
  assertConnectionManager(actor);
  parseInput(revisionInput, input);
  try {
    await externalTransaction(db, async (tx, _diagnostics) => {
      await lockExternalConnection(
        tx,
        actor.userId,
        input.id,
        input.expectedRevision,
      );
      const used = await tx.scheduledTaskExternalInput.findFirst({
        where: { tool: { connectionId: input.id } },
        select: { task: { select: { name: true } } },
      });
      if (used)
        throw new CoreError(
          "CONFLICT",
          `Remove this connection's tools from the scheduled task "${used.task.name}" before deleting it`,
        );
      await invalidateExternalApprovals(
        tx,
        {
          connectionId: input.id,
          reason: "configuration_changed",
        },
        _diagnostics,
      );
      await tx.externalMcpConnection.delete({
        where: { id: input.id },
        select: { id: true },
      });
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2003"
    )
      throw new CoreError(
        "CONFLICT",
        "Remove this connection's tools from your scheduled tasks before deleting it",
      );
    throw error;
  }
  externalSettingsChanged(actor, input.id, "deleted");
}

type ToolFilter = z.output<typeof toolFilterSchema>;

function toolWhere(
  db: PrismaClient,
  filter: ToolFilter,
): Prisma.ExternalMcpToolWhereInput {
  const state: Prisma.ExternalMcpToolWhereInput =
    filter.reviewState === "removed"
      ? { presentInCatalog: false }
      : filter.reviewState === "unreviewed"
        ? { presentInCatalog: true, reviewedRemoteDigest: null }
        : filter.reviewState === "changed"
          ? {
              presentInCatalog: true,
              reviewedRemoteDigest: { not: null },
              NOT: {
                reviewedRemoteDigest: {
                  equals: db.externalMcpTool.fields.discoveredRemoteDigest,
                },
              },
            }
          : filter.reviewState === "reviewed"
            ? {
                presentInCatalog: true,
                reviewedRemoteDigest: {
                  equals: db.externalMcpTool.fields.discoveredRemoteDigest,
                },
              }
            : filter.reviewState === "unsupported"
              ? {
                  presentInCatalog: true,
                  discoveredDefinition: {
                    path: ["supportStatus", "available"],
                    equals: false,
                  },
                }
              : { presentInCatalog: true };
  return {
    connectionId: filter.connectionId,
    ...state,
    ...(filter.search
      ? {
          OR: [
            { remoteName: { contains: filter.search, mode: "insensitive" } },
            { description: { contains: filter.search, mode: "insensitive" } },
          ],
        }
      : {}),
    ...(filter.effect ? { effect: filter.effect } : {}),
    ...(filter.enabled !== undefined ? { enabled: filter.enabled } : {}),
    ...(filter.suggestedEffect === "read"
      ? {
          AND: [
            {
              discoveredDefinition: {
                path: ["annotations", "readOnlyHint"],
                equals: true,
              },
            },
          ],
        }
      : {}),
  };
}

const TOOL_ORDER = [
  { remoteName: "asc" },
  { id: "asc" },
] satisfies Prisma.ExternalMcpToolOrderByWithRelationInput[];

async function assertConnectionExists(
  db: PrismaClient,
  ownerId: string,
  id: string,
) {
  const connection = await db.externalMcpConnection.findFirst({
    where: { id, ownerId },
    select: { id: true },
  });
  if (!connection) throw notFound();
}

export async function listExternalTools(
  db: PrismaClient,
  actor: SecurityContext,
  input: z.input<typeof toolFilterSchema> & { cursor?: string; limit?: number },
) {
  assertConnectionManager(actor);
  const page = parseInput(
    toolFilterSchema.extend({
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(25),
    }),
    input,
  );
  await assertConnectionExists(db, actor.userId, page.connectionId);
  const after = page.cursor ? decodeTextIdPageCursor(page.cursor) : null;
  const items = await db.externalMcpTool.findMany({
    where: {
      AND: [
        toolWhere(db, page),
        after
          ? {
              OR: [
                { remoteName: { gt: after[0] } },
                { remoteName: after[0], id: { gt: after[1] } },
              ],
            }
          : {},
      ],
    },
    select: TOOL_SELECT,
    orderBy: TOOL_ORDER,
    take: page.limit + 1,
  });
  const hasMore = items.length > page.limit;
  const rows = items.slice(0, page.limit);
  const last = rows.at(-1);
  return {
    items: rows,
    nextCursor:
      hasMore && last ? encodePageCursor([last.remoteName, last.id]) : null,
  };
}

export async function listExternalToolKeys(
  db: PrismaClient,
  actor: SecurityContext,
  input: z.input<typeof toolFilterSchema>,
) {
  assertConnectionManager(actor);
  const filter = parseInput(toolFilterSchema, input);
  await assertConnectionExists(db, actor.userId, filter.connectionId);
  const rows = await db.externalMcpTool.findMany({
    where: toolWhere(db, filter),
    select: {
      id: true,
      remoteName: true,
      presentInCatalog: true,
      reviewedRemoteDigest: true,
      discoveredRemoteDigest: true,
      discoveredDefinition: true,
    },
    orderBy: TOOL_ORDER,
    take: MAX_TOOL_KEYS + 1,
  });
  if (rows.length > MAX_TOOL_KEYS)
    throw new CoreError(
      "PRECONDITION_FAILED",
      `More than ${MAX_TOOL_KEYS} tools match; narrow the filter`,
    );
  return {
    items: rows.map((row) => ({
      id: row.id,
      remoteName: row.remoteName,
      discoveredRemoteDigest: row.discoveredRemoteDigest,
      state: externalToolState(row),
    })),
  };
}

export async function getExternalTool(
  db: PrismaClient,
  actor: SecurityContext,
  toolId: string,
) {
  assertConnectionManager(actor);
  parseInput(z.uuid(), toolId);
  const tool = await db.externalMcpTool.findFirst({
    where: { id: toolId, connection: { ownerId: actor.userId } },
    select: TOOL_SELECT,
  });
  if (!tool) throw new CoreError("NOT_FOUND", "External tool not found");
  return tool;
}

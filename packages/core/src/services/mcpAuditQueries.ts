import type { McpOutcome, PrismaClient } from "@weaver/db/client";
import {
  assertSystemAdmin,
  type SecurityContext,
} from "@weaver/core/security/context";
import {
  clampLimit,
  decodeTimestampIdPageCursor,
  encodePageCursor,
} from "./adminPaging";

const MCP_AUDIT_SELECT = {
  id: true,
  requestId: true,
  userId: true,
  credentialId: true,
  authenticationMethod: true,
  clientId: true,
  method: true,
  name: true,
  projectId: true,
  outcome: true,
  errorCode: true,
  durationMs: true,
  commitSha: true,
  createdAt: true,
} as const;

export async function listMcpAuditEvents(
  db: PrismaClient,
  actor: SecurityContext,
  filter: {
    since?: Date;
    userId?: string;
    outcome?: McpOutcome;
    name?: string;
    limit?: number;
    cursor?: string;
  },
) {
  assertSystemAdmin(actor);
  const limit = clampLimit(filter.limit);
  const cursor = filter.cursor
    ? decodeTimestampIdPageCursor(filter.cursor)
    : null;
  const rows = await db.mcpAuditEvent.findMany({
    where: {
      ...(filter.since ? { createdAt: { gte: filter.since } } : {}),
      ...(filter.userId ? { userId: filter.userId } : {}),
      ...(filter.outcome ? { outcome: filter.outcome } : {}),
      ...(filter.name ? { name: filter.name } : {}),
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor[0] } },
              { createdAt: cursor[0], id: { lt: cursor[1] } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: MCP_AUDIT_SELECT,
  });
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? encodePageCursor([last.createdAt.toISOString(), last.id])
        : null,
    truncated: rows.length > limit,
  };
}

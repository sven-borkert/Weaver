import type { AssistantRunStatus, PrismaClient } from "@weaver/db/client";
import { CoreError } from "@weaver/core/errors";
import {
  assertSystemAdmin,
  type SecurityContext,
} from "@weaver/core/security/context";
import {
  clampLimit,
  decodeTimestampIdPageCursor,
  encodePageCursor,
} from "./adminPaging";

const DETAIL_LIST_MAX = 200;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,79}$/;

const RUN_SELECT = {
  id: true,
  conversationId: true,
  status: true,
  attemptCount: true,
  maxAttempts: true,
  jobId: true,
  errorCode: true,
  routeSnapshot: true,
  cancelRequestedAt: true,
  queuedAt: true,
  startedAt: true,
  finishedAt: true,
  conversation: { select: { ownerId: true } },
} as const;

export async function listAssistantRuns(
  db: PrismaClient,
  actor: SecurityContext,
  filter: {
    since?: Date;
    status?: AssistantRunStatus;
    userId?: string;
    limit?: number;
    cursor?: string;
  },
) {
  assertSystemAdmin(actor);
  const limit = clampLimit(filter.limit);
  const cursor = filter.cursor
    ? decodeTimestampIdPageCursor(filter.cursor)
    : null;
  const rows = await db.assistantRun.findMany({
    where: {
      ...(filter.since ? { queuedAt: { gte: filter.since } } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.userId ? { conversation: { ownerId: filter.userId } } : {}),
      ...(cursor
        ? {
            OR: [
              { queuedAt: { lt: cursor[0] } },
              { queuedAt: cursor[0], id: { lt: cursor[1] } },
            ],
          }
        : {}),
    },
    orderBy: [{ queuedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: RUN_SELECT,
  });
  const items = rows.slice(0, limit).map(({ conversation, ...run }) => ({
    ...run,
    ownerId: conversation.ownerId,
  }));
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? encodePageCursor([last.queuedAt.toISOString(), last.id])
        : null,
    truncated: rows.length > limit,
  };
}

function toolNameOf(type: string, payload: unknown): string | null {
  if (type !== "tool.call" && type !== "tool.result") return null;
  if (!payload || typeof payload !== "object") return null;
  const toolName = (payload as { toolName?: unknown }).toolName;
  return typeof toolName === "string" && TOOL_NAME_PATTERN.test(toolName)
    ? toolName
    : null;
}

/** Metadata only: event payload text never leaves this function (design §10.2). */
export async function getAssistantRunDetail(
  db: PrismaClient,
  actor: SecurityContext,
  runId: string,
) {
  assertSystemAdmin(actor);
  const run = await db.assistantRun.findUnique({
    where: { id: runId },
    select: {
      ...RUN_SELECT,
      attempts: {
        orderBy: { number: "asc" },
        take: DETAIL_LIST_MAX + 1,
        select: {
          id: true,
          number: true,
          workerId: true,
          status: true,
          leaseExpiresAt: true,
          startedAt: true,
          endedAt: true,
          failureCode: true,
        },
      },
      events: {
        orderBy: { sequence: "asc" },
        take: DETAIL_LIST_MAX + 1,
        select: { sequence: true, type: true, createdAt: true, payload: true },
      },
    },
  });
  if (!run) throw new CoreError("NOT_FOUND", "Run not found");
  const { conversation, attempts, events, ...rest } = run;
  return {
    ...rest,
    ownerId: conversation.ownerId,
    attempts: attempts.slice(0, DETAIL_LIST_MAX),
    events: events.slice(0, DETAIL_LIST_MAX).map((event) => ({
      sequence: event.sequence,
      type: event.type,
      createdAt: event.createdAt,
      toolName: toolNameOf(event.type, event.payload),
    })),
    truncated:
      attempts.length > DETAIL_LIST_MAX || events.length > DETAIL_LIST_MAX,
  };
}

import type { ReplayStep } from "../assistant/replay";
import {
  externalSelectionSchema,
  externalToolSnapshotsSchema,
} from "../externalMcp/schema";
import { z } from "zod";
import type { ExternalSource } from "../externalMcp/types";
import type {
  AssistantConversation,
  AssistantMessage,
  Prisma,
  PrismaClient,
} from "@weaver/db/client";
import { scopeSnapshotSchema, type ScopeSnapshot } from "../assistant/scope";
import { CoreError } from "../errors";
import { hasCapability, type SecurityContext } from "../security/context";
import { resolveProjectAccess } from "./projectAccess";

import { parseContextProjectIds } from "../externalMcp/historyScope";

type Db = PrismaClient | Prisma.TransactionClient;

export const MAX_CONVERSATION_TITLE_CHARS = 200;
const DEFAULT_TITLE = "New conversation";
export const ACTIVE_RUN_STATUSES = ["queued", "running", "cancelling"] as const;
type ActiveRunStatus = (typeof ACTIVE_RUN_STATUSES)[number];
export type RunStatus =
  "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";

export function assertAssistantUse(actor: SecurityContext): void {
  if (!hasCapability(actor, "assistant:use")) throw new CoreError("FORBIDDEN");
}

export type ConversationSummary = {
  id: string;
  title: string;
  pinnedProjectId: string | null;
  autoApproveChanges: boolean;
  lastMessageAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  activeRun: { id: string; status: "queued" | "running" | "cancelling" } | null;
  lastRunStatus: RunStatus | null;
};

export type MessageView = {
  id: string;
  position: number;
  role: "user" | "assistant";
  status: "pending" | "complete" | "failed" | "cancelled";
  text: string;
  citationIds: string[];
  proposalIds: string[];
  scopeSnapshot: ScopeSnapshot | null;
  contextProjectIds: string[] | null;
  hasExternalContext?: boolean;
  hasExternalTools?: boolean;
  externalSources?: ExternalSource[];
  runId: string | null;
  /** Set only on leased history, for assistant turns that called tools and whose run events still exist. */
  replaySteps?: ReplayStep[];
  createdAt: Date;
  /** Set only when the triggering run failed; cancelled runs never show Details. */
  error: { code: string; message: string } | null;
};

export type ConversationDetail = ConversationSummary & {
  messages: MessageView[];
  hasEarlierMessages: boolean;
};

type MessageContent = {
  text?: unknown;
  citationIds?: unknown;
  proposalIds?: unknown;
  contextProjectIds?: unknown;
  hasExternalContext?: unknown;
  externalSelections?: unknown;
  externalToolSnapshots?: unknown;
  externalSources?: unknown;
};

export function toMessageView(
  row: AssistantMessage & {
    triggeredRun?: {
      id: string;
      errorCode?: string | null;
      errorMessage?: string | null;
    } | null;
    producedBy?: { id: string } | null;
  },
): MessageView {
  const content = (row.content ?? {}) as MessageContent;
  const strings = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((v): v is string => typeof v === "string")
      : [];
  const scope = row.scopeSnapshot
    ? scopeSnapshotSchema.safeParse(row.scopeSnapshot)
    : null;
  return {
    id: row.id,
    position: row.position,
    role: row.role,
    status: row.status,
    text: typeof content.text === "string" ? content.text : "",
    citationIds: strings(content.citationIds),
    proposalIds: strings(content.proposalIds),
    scopeSnapshot: scope?.success ? scope.data : null,
    hasExternalTools:
      (externalSelectionSchema.safeParse(content.externalSelections).data
        ?.length ?? 0) > 0 ||
      (externalToolSnapshotsSchema.safeParse(content.externalToolSnapshots).data
        ?.length ?? 0) > 0,
    hasExternalContext:
      content.hasExternalContext === true ||
      (Array.isArray(content.externalSources) &&
        content.externalSources.length > 0),
    externalSources:
      z
        .array(
          z.object({
            callId: z.string(),
            connectionId: z.string(),
            connectionName: z.string(),
            toolName: z.string(),
            retrievedAt: z.string(),
            truncated: z.boolean(),
          }),
        )
        .safeParse(content.externalSources).data ?? [],
    contextProjectIds:
      row.role === "user"
        ? scope?.success
          ? parseContextProjectIds(scope.data.projectIds)
          : null
        : parseContextProjectIds(content.contextProjectIds),
    runId: row.triggeredRun?.id ?? row.producedBy?.id ?? null,
    createdAt: row.createdAt,
    error:
      row.status === "failed" && row.triggeredRun?.errorCode
        ? {
            code: row.triggeredRun.errorCode,
            message: row.triggeredRun.errorMessage ?? "",
          }
        : null,
  };
}

// Latest run by queuedAt; at most one run is active per conversation
// (submitUserMessage guards it), so the latest run is the active one when any is.
const SUMMARY_INCLUDE = {
  runs: {
    orderBy: [{ queuedAt: "desc" }, { id: "desc" }],
    select: { id: true, status: true },
    take: 1,
  },
} satisfies Prisma.AssistantConversationInclude;

function toSummary(
  row: AssistantConversation & { runs: Array<{ id: string; status: string }> },
): ConversationSummary {
  const latest = row.runs[0];
  const active =
    latest && (ACTIVE_RUN_STATUSES as readonly string[]).includes(latest.status)
      ? latest
      : undefined;
  return {
    id: row.id,
    title: row.title,
    pinnedProjectId: row.pinnedProjectId,
    autoApproveChanges: row.autoApproveChanges,
    lastMessageAt: row.lastMessageAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    activeRun: active
      ? { id: active.id, status: active.status as ActiveRunStatus }
      : null,
    lastRunStatus: (latest?.status as RunStatus | undefined) ?? null,
  };
}

export async function requireOwnedConversation(
  db: Db,
  actor: SecurityContext,
  conversationId: string,
) {
  assertAssistantUse(actor);
  const row = await db.assistantConversation.findFirst({
    where: { id: conversationId, ownerId: actor.userId },
    include: SUMMARY_INCLUDE,
  });
  if (!row) throw new CoreError("NOT_FOUND");
  return row;
}

function normalizeTitle(title: string | undefined): string {
  const trimmed = (title ?? "").trim().replace(/\s+/g, " ");
  if (trimmed.length > MAX_CONVERSATION_TITLE_CHARS) {
    throw new CoreError("BAD_REQUEST", "title too long", { field: "title" });
  }
  return trimmed || DEFAULT_TITLE;
}

export async function createConversation(
  db: PrismaClient,
  actor: SecurityContext,
  input: { title?: string; pinnedProjectId?: string | null },
): Promise<ConversationSummary> {
  assertAssistantUse(actor);
  if (input.pinnedProjectId)
    await resolveProjectAccess(db, input.pinnedProjectId, actor);
  const row = await db.assistantConversation.create({
    data: {
      ownerId: actor.userId,
      title: normalizeTitle(input.title),
      pinnedProjectId: input.pinnedProjectId ?? null,
    },
    include: SUMMARY_INCLUDE,
  });
  return toSummary(row);
}

export async function listConversations(
  db: PrismaClient,
  actor: SecurityContext,
  input: { cursor?: string; limit?: number },
): Promise<{ items: ConversationSummary[]; nextCursor: string | null }> {
  assertAssistantUse(actor);
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
  const rows = await db.assistantConversation.findMany({
    where: { ownerId: actor.userId },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    include: SUMMARY_INCLUDE,
  });
  const items = rows.slice(0, limit).map(toSummary);
  return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
}

export async function getConversationStatus(
  db: PrismaClient,
  actor: SecurityContext,
  conversationId: string,
): Promise<ConversationSummary> {
  return toSummary(await requireOwnedConversation(db, actor, conversationId));
}

export async function getConversation(
  db: PrismaClient,
  actor: SecurityContext,
  conversationId: string,
  beforePosition?: number,
): Promise<ConversationDetail> {
  const row = await requireOwnedConversation(db, actor, conversationId);
  const messages = await db.assistantMessage.findMany({
    where: {
      conversationId,
      ...(beforePosition === undefined
        ? {}
        : { position: { lt: beforePosition } }),
    },
    orderBy: { position: "desc" },
    take: 201,
    include: {
      triggeredRun: {
        select: { id: true, errorCode: true, errorMessage: true },
      },
      producedBy: { select: { id: true } },
    },
  });
  return {
    ...toSummary(row),
    messages: messages.slice(0, 200).reverse().map(toMessageView),
    hasEarlierMessages: messages.length > 200,
  };
}

export async function renameConversation(
  db: PrismaClient,
  actor: SecurityContext,
  input: { conversationId: string; title: string },
): Promise<ConversationSummary> {
  await requireOwnedConversation(db, actor, input.conversationId);
  const row = await db.assistantConversation.update({
    where: { id: input.conversationId },
    data: { title: normalizeTitle(input.title) },
    include: SUMMARY_INCLUDE,
  });
  return toSummary(row);
}

export async function pinConversation(
  db: PrismaClient,
  actor: SecurityContext,
  input: { conversationId: string; projectId: string | null },
): Promise<ConversationSummary> {
  await requireOwnedConversation(db, actor, input.conversationId);
  if (input.projectId) await resolveProjectAccess(db, input.projectId, actor);
  const row = await db.assistantConversation.update({
    where: { id: input.conversationId },
    data: { pinnedProjectId: input.projectId },
    include: SUMMARY_INCLUDE,
  });
  return toSummary(row);
}

export async function setAutoApproveChanges(
  db: PrismaClient,
  actor: SecurityContext,
  input: { conversationId: string; enabled: boolean },
): Promise<ConversationSummary> {
  await requireOwnedConversation(db, actor, input.conversationId);
  if (input.enabled && !hasCapability(actor, "content:write"))
    throw new CoreError("FORBIDDEN");
  const row = await db.assistantConversation.update({
    where: { id: input.conversationId, ownerId: actor.userId },
    data: { autoApproveChanges: input.enabled },
    include: SUMMARY_INCLUDE,
  });
  return toSummary(row);
}

export async function deleteConversation(
  db: PrismaClient,
  actor: SecurityContext,
  conversationId: string,
): Promise<void> {
  const row = await requireOwnedConversation(db, actor, conversationId);
  if (
    row.runs.some((run) =>
      (ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status),
    )
  )
    throw new CoreError("CONFLICT", "a run is still active; cancel it first");
  await db.assistantConversation.delete({ where: { id: conversationId } });
}

import { z } from "zod";
import {
  Prisma,
  type DiagnosticSeverity,
  type PrismaClient,
} from "@weaver/db/client";
import type { DiagnosticsSettings } from "@weaver/core/diagnostics/settings";
import { emitDiagnostic } from "@weaver/core/diagnostics/writer";
import { CoreError } from "@weaver/core/errors";
import {
  assertSystemAdmin,
  type UserSecurityContext,
} from "@weaver/core/security/context";

import { decodeTimestampIdPageCursor, encodePageCursor } from "./adminPaging";
import {
  getDiagnosticsSettings,
  invalidateDiagnosticsStats,
} from "./diagnosticsSettings";
import { resolveProjectAccess } from "./projectAccess";
import { parseContextProjectIds } from "../externalMcp/historyScope";
import {
  DIAGNOSTIC_REFERENCE_PATTERN,
  referenceIdBounds,
} from "../diagnostics/reference";

export const DIAGNOSTIC_LIST_MAX = 200;
export const DIAGNOSTIC_BODY_SLICE_CHARS = 12_000;
const PRUNE_BATCH = 10_000;
const PRUNE_MAX_BATCHES = 50;
const PRUNE_LOCK_NAME = "weaver:diagnostic-prune";

export type DiagnosticEventFilter = {
  since?: Date;
  until?: Date;
  category?: string;
  event?: string;
  severity?: DiagnosticSeverity;
  excludeDebug?: boolean;
  reference?: string;
  requestId?: string;
  jobId?: string;
  runId?: string;
  userId?: string;
  projectId?: string;
  generationId?: string;
  documentId?: string;
  fileId?: string;
  connectionId?: string;
  text?: string;
  limit?: number;
  cursor?: string;
};

const SUMMARY_SELECT = {
  id: true,
  createdAt: true,
  runtime: true,
  severity: true,
  verbose: true,
  category: true,
  event: true,
  message: true,
  requestId: true,
  jobId: true,
  runId: true,
  userId: true,
  credentialId: true,
  projectId: true,
  generationId: true,
  documentId: true,
  connectionId: true,
  durationMs: true,
  statusCode: true,
  outcome: true,
  details: true,
  hasRequestBody: true,
  hasResponseBody: true,
} satisfies Prisma.DiagnosticEventSelect;

export type DiagnosticEventSummary = Prisma.DiagnosticEventGetPayload<{
  select: typeof SUMMARY_SELECT;
}>;

export function encodeDiagnosticEventCursor(row: {
  createdAt: Date;
  id: string;
}): string {
  return encodePageCursor([row.createdAt.toISOString(), row.id]);
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [createdAt, id] = decodeTimestampIdPageCursor(cursor);
  return { createdAt, id };
}

function listLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 50;
  return Math.min(Math.max(Math.trunc(limit), 1), DIAGNOSTIC_LIST_MAX);
}

function normalizeReference(reference: string): string {
  const normalized = reference.trim().toLowerCase();
  if (!DIAGNOSTIC_REFERENCE_PATTERN.test(normalized))
    throw new CoreError("BAD_REQUEST", "Invalid diagnostic reference");
  return normalized;
}

function fileEventQuery(
  filter: DiagnosticEventFilter,
  fileId: string,
  cursor: { createdAt: Date; id: string } | null,
  limit: number,
): Prisma.Sql {
  const predicates = [
    Prisma.sql`"details" ? 'fileId' AND "details"->>'fileId' = ${fileId}`,
  ];
  for (const key of ["category", "event", "requestId", "jobId"] as const) {
    if (filter[key])
      predicates.push(Prisma.sql`${Prisma.raw(`"${key}"`)} = ${filter[key]}`);
  }
  for (const key of [
    "runId",
    "userId",
    "projectId",
    "generationId",
    "documentId",
    "connectionId",
  ] as const) {
    if (filter[key])
      predicates.push(
        Prisma.sql`${Prisma.raw(`"${key}"`)} = ${filter[key]}::uuid`,
      );
  }
  if (filter.since) predicates.push(Prisma.sql`"createdAt" >= ${filter.since}`);
  if (filter.until) predicates.push(Prisma.sql`"createdAt" <= ${filter.until}`);
  if (filter.severity)
    predicates.push(Prisma.sql`"severity"::text = ${filter.severity}`);
  else if (filter.excludeDebug)
    predicates.push(Prisma.sql`"severity" != 'debug'`);
  if (filter.reference) {
    const bounds = referenceIdBounds(normalizeReference(filter.reference));
    predicates.push(
      Prisma.sql`"id" >= ${bounds.gte}::uuid AND "id" <= ${bounds.lte}::uuid`,
    );
  }
  if (filter.text)
    predicates.push(
      Prisma.sql`"message" ILIKE ${`%${filter.text.slice(0, 200)}%`}`,
    );
  if (cursor)
    predicates.push(
      Prisma.sql`("createdAt", "id") < (${cursor.createdAt}, ${cursor.id}::uuid)`,
    );
  const columns = Object.keys(SUMMARY_SELECT).map((key) =>
    Prisma.raw(`"${key}"`),
  );
  return Prisma.sql`SELECT ${Prisma.join(columns)} FROM "DiagnosticEvent"
    WHERE ${Prisma.join(predicates, " AND ")}
    ORDER BY "createdAt" DESC, "id" DESC LIMIT ${limit + 1}`;
}

export async function listDiagnosticEvents(
  db: PrismaClient,
  actor: UserSecurityContext,
  filter: DiagnosticEventFilter,
): Promise<{
  items: DiagnosticEventSummary[];
  nextCursor: string | null;
  truncated: boolean;
}> {
  assertSystemAdmin(actor);
  if (filter.fileId !== undefined && !z.uuid().safeParse(filter.fileId).success)
    throw new CoreError("BAD_REQUEST", "Invalid ingestion file ID", {
      field: "fileId",
    });
  const limit = listLimit(filter.limit);
  const cursor = filter.cursor ? decodeCursor(filter.cursor) : null;
  const where: Prisma.DiagnosticEventWhereInput = {
    ...(filter.since || filter.until
      ? {
          createdAt: {
            ...(filter.since ? { gte: filter.since } : {}),
            ...(filter.until ? { lte: filter.until } : {}),
          },
        }
      : {}),
    ...(filter.category ? { category: filter.category } : {}),
    ...(filter.event ? { event: filter.event } : {}),
    ...(filter.severity
      ? { severity: filter.severity }
      : filter.excludeDebug
        ? { severity: { not: "debug" } }
        : {}),
    ...(filter.reference
      ? { id: referenceIdBounds(normalizeReference(filter.reference)) }
      : {}),
    ...(filter.requestId ? { requestId: filter.requestId } : {}),
    ...(filter.jobId ? { jobId: filter.jobId } : {}),
    ...(filter.runId ? { runId: filter.runId } : {}),
    ...(filter.userId ? { userId: filter.userId } : {}),
    ...(filter.projectId ? { projectId: filter.projectId } : {}),
    ...(filter.generationId ? { generationId: filter.generationId } : {}),
    ...(filter.documentId ? { documentId: filter.documentId } : {}),
    ...(filter.connectionId ? { connectionId: filter.connectionId } : {}),
    ...(filter.text
      ? {
          message: { contains: filter.text.slice(0, 200), mode: "insensitive" },
        }
      : {}),
    ...(cursor
      ? {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        }
      : {}),
  };
  const rows = filter.fileId
    ? await db.$queryRaw<DiagnosticEventSummary[]>(
        fileEventQuery(filter, filter.fileId.toLowerCase(), cursor, limit),
      )
    : await db.diagnosticEvent.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        select: SUMMARY_SELECT,
      });
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  const truncated = rows.length > limit;
  return {
    items,
    nextCursor: truncated && last ? encodeDiagnosticEventCursor(last) : null,
    truncated,
  };
}

export type BodySlice = {
  part: "request" | "response";
  text: string;
  offset: number;
  nextOffset: number | null;
  total: number;
};

function boundedOffset(offset: number | undefined, total: number): number {
  if (offset === undefined || Number.isNaN(offset)) return 0;
  if (offset === Number.POSITIVE_INFINITY) return total;
  if (offset === Number.NEGATIVE_INFINITY) return 0;
  return Math.max(0, Math.min(Math.trunc(offset), total));
}

function bodyRange(
  text: string,
  requested: number | undefined,
): { start: number; end: number } {
  let start = boundedOffset(requested, text.length);
  if (start > 0 && start < text.length) {
    const current = text.charCodeAt(start);
    const previous = text.charCodeAt(start - 1);
    if (
      current >= 0xdc00 &&
      current <= 0xdfff &&
      previous >= 0xd800 &&
      previous <= 0xdbff
    ) {
      start -= 1;
    }
  }
  let end = Math.min(start + DIAGNOSTIC_BODY_SLICE_CHARS, text.length);
  if (
    end < text.length &&
    text.charCodeAt(end - 1) >= 0xd800 &&
    text.charCodeAt(end - 1) <= 0xdbff &&
    text.charCodeAt(end) >= 0xdc00 &&
    text.charCodeAt(end) <= 0xdfff
  ) {
    end -= 1;
  }
  return { start, end };
}

export async function getDiagnosticEvent(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: {
    id?: string;
    reference?: string;
    body?: "none" | "request" | "response";
    offset?: number;
  },
): Promise<{ event: DiagnosticEventSummary; body: BodySlice | null }> {
  assertSystemAdmin(actor);
  if ((input.id ? 1 : 0) + (input.reference ? 1 : 0) !== 1)
    throw new CoreError(
      "BAD_REQUEST",
      "Provide exactly one of id or reference",
    );
  const part = input.body ?? "none";
  const select = {
    ...SUMMARY_SELECT,
    bodyProjectIds: part !== "none",
    requestBody: part === "request",
    responseBody: part === "response",
  };
  const row = input.id
    ? await db.diagnosticEvent.findUnique({ where: { id: input.id }, select })
    : await db.diagnosticEvent.findFirst({
        where: { id: referenceIdBounds(normalizeReference(input.reference!)) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select,
      });
  if (!row) throw new CoreError("NOT_FOUND", "Diagnostic event not found");
  const { bodyProjectIds, requestBody, responseBody, ...event } =
    row as DiagnosticEventSummary & {
      bodyProjectIds?: Prisma.JsonValue;
      requestBody?: string | null;
      responseBody?: string | null;
    };
  if (part !== "none") {
    if (row.projectId) await resolveProjectAccess(db, row.projectId, actor);
    if (row.runId || bodyProjectIds != null) {
      const projectIds = parseContextProjectIds(bodyProjectIds);
      if (projectIds === null)
        throw new CoreError("NOT_FOUND", "Diagnostic source unavailable");
      for (const projectId of projectIds)
        await resolveProjectAccess(db, projectId, actor);
    }
    if (!row.runId && !row.projectId && row.runtime === "worker") {
      throw new CoreError("NOT_FOUND", "Diagnostic source unavailable");
    }
  }
  const text =
    part === "request"
      ? requestBody
      : part === "response"
        ? responseBody
        : null;
  if (part === "none" || text == null) return { event, body: null };
  const { start, end } = bodyRange(text, input.offset);
  return {
    event,
    body: {
      part,
      text: text.slice(start, end),
      offset: start,
      nextOffset: end < text.length ? end : null,
      total: text.length,
    },
  };
}

export type PruneResult = {
  verboseRemoved: number;
  expiredRemoved: number;
  overflowRemoved: number;
  batches: number;
};

async function deleteBatches(
  db: PrismaClient,
  where: Prisma.DiagnosticEventWhereInput,
  budget: { batches: number },
  limit = Number.POSITIVE_INFINITY,
): Promise<number> {
  let removed = 0;
  while (budget.batches < PRUNE_MAX_BATCHES && removed < limit) {
    const take = Math.min(PRUNE_BATCH, limit - removed);
    const batch = await withPruneLock(db, async (tx) => {
      const ids = await tx.diagnosticEvent.findMany({
        where,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take,
        select: { id: true },
      });
      if (ids.length === 0) return { selected: 0, removed: 0 };
      const result = await tx.diagnosticEvent.deleteMany({
        where: { id: { in: ids.map((row) => row.id) } },
      });
      return { selected: ids.length, removed: result.count };
    });
    if (batch.selected === 0) break;
    budget.batches += 1;
    removed += batch.removed;
    if (batch.selected < take) break;
  }
  return removed;
}

async function deleteOverflowBatches(
  db: PrismaClient,
  maxRows: number,
  budget: { batches: number },
): Promise<number> {
  const cutoff = await withPruneLock(db, (tx) =>
    tx.diagnosticEvent.findFirst({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: maxRows,
      select: { createdAt: true, id: true },
    }),
  );
  if (!cutoff) return 0;
  return deleteBatches(
    db,
    {
      OR: [
        { createdAt: { lt: cutoff.createdAt } },
        { createdAt: cutoff.createdAt, id: { lte: cutoff.id } },
      ],
    },
    budget,
  );
}

async function withPruneLock<T>(
  db: PrismaClient,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${PRUNE_LOCK_NAME}, 0)
      )::text
    `);
    return operation(tx);
  });
}

async function clearExpiredBodies(
  db: PrismaClient,
  before: Date,
  budget: { batches: number },
): Promise<number> {
  let cleared = 0;
  while (budget.batches < PRUNE_MAX_BATCHES) {
    const result = await withPruneLock(db, async (tx) => {
      const rows = await tx.diagnosticEvent.findMany({
        where: {
          event: "ai.request",
          verbose: true,
          createdAt: { lt: before },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: PRUNE_BATCH,
        select: { id: true },
      });
      if (!rows.length) return 0;
      return (
        await tx.diagnosticEvent.updateMany({
          where: { id: { in: rows.map((row) => row.id) } },
          data: {
            requestBody: null,
            responseBody: null,
            hasRequestBody: false,
            hasResponseBody: false,
            verbose: false,
          },
        })
      ).count;
    });
    if (!result) break;
    budget.batches += 1;
    cleared += result;
    if (result < PRUNE_BATCH) break;
  }
  return cleared;
}

/** Runs on every system.reconcile regardless of the diagnostic level. */
export async function pruneDiagnosticEvents(
  db: PrismaClient,
  settings: DiagnosticsSettings,
  now = new Date(),
): Promise<PruneResult> {
  const started = Date.now();
  const budget = { batches: 0 };
  const bodiesCleared = await clearExpiredBodies(
    db,
    new Date(now.getTime() - settings.verboseRetentionHours * 3_600_000),
    budget,
  );
  const verboseRemoved = await deleteBatches(
    db,
    {
      verbose: true,
      event: { not: "ai.request" },
      createdAt: {
        lt: new Date(
          now.getTime() - settings.verboseRetentionHours * 3_600_000,
        ),
      },
    },
    budget,
  );
  const expiredRemoved = await deleteBatches(
    db,
    {
      createdAt: {
        lt: new Date(now.getTime() - settings.retentionDays * 86_400_000),
      },
    },
    budget,
  );
  const overflowRemoved = await deleteOverflowBatches(
    db,
    settings.maxRows,
    budget,
  );
  invalidateDiagnosticsStats();
  const result = {
    verboseRemoved,
    expiredRemoved,
    overflowRemoved,
    batches: budget.batches,
  };
  emitDiagnostic({
    event: "diagnostics.pruned",
    message: `pruned ${verboseRemoved + expiredRemoved + overflowRemoved} diagnostic rows`,
    durationMs: Date.now() - started,
    outcome: "ok",
    details: { ...result, bodiesCleared },
  });
  return result;
}

export async function pruneDiagnosticEventsAsAdmin(
  db: PrismaClient,
  actor: UserSecurityContext,
): Promise<PruneResult> {
  assertSystemAdmin(actor);
  return pruneDiagnosticEvents(db, await getDiagnosticsSettings(db));
}

import {
  Prisma,
  type AiUsageOutcome,
  type PrismaClient,
} from "@weaver/db/client";
import {
  assertSystemAdmin,
  type SecurityContext,
} from "@weaver/core/security/context";
import {
  clampLimit,
  decodeTimestampIdPageCursor,
  encodePageCursor,
} from "./adminPaging";

const USAGE_SELECT = {
  id: true,
  projectId: true,
  operation: true,
  jobId: true,
  runId: true,
  documentId: true,
  provider: true,
  model: true,
  connectionId: true,
  inputTokens: true,
  outputTokens: true,
  cachedTokens: true,
  totalTokens: true,
  durationMs: true,
  outcome: true,
  costMicros: true,
  currency: true,
  createdAt: true,
} satisfies Prisma.AiUsageSelect;

type ExactJsonInteger = number | string;

/** JSON-safe exact integer: decimal string only when a value exceeds the safe number range. */
function exactJsonInteger(value: bigint | string): ExactJsonInteger {
  const parsed = typeof value === "bigint" ? value : BigInt(value);
  return parsed <= BigInt(Number.MAX_SAFE_INTEGER) &&
    parsed >= BigInt(Number.MIN_SAFE_INTEGER)
    ? Number(parsed)
    : parsed.toString();
}

export type AiUsageFilter = {
  since?: Date;
  until?: Date;
  outcome?: AiUsageOutcome;
  operation?: string;
  model?: string;
  connectionId?: string;
  projectId?: string;
  jobId?: string;
  runId?: string;
  limit?: number;
  cursor?: string;
};

export type AiUsageRow = Omit<
  Prisma.AiUsageGetPayload<{ select: typeof USAGE_SELECT }>,
  "costMicros"
> & { costMicros: ExactJsonInteger | null };

export async function listAiUsage(
  db: PrismaClient,
  actor: SecurityContext,
  filter: AiUsageFilter,
): Promise<{
  items: AiUsageRow[];
  nextCursor: string | null;
  truncated: boolean;
}> {
  assertSystemAdmin(actor);
  const limit = clampLimit(filter.limit);
  const cursor = filter.cursor
    ? decodeTimestampIdPageCursor(filter.cursor)
    : null;
  const rows = await db.aiUsage.findMany({
    where: {
      ...(filter.since || filter.until
        ? {
            createdAt: {
              ...(filter.since ? { gte: filter.since } : {}),
              ...(filter.until ? { lte: filter.until } : {}),
            },
          }
        : {}),
      ...(filter.outcome ? { outcome: filter.outcome } : {}),
      ...(filter.operation ? { operation: filter.operation } : {}),
      ...(filter.model ? { model: filter.model } : {}),
      ...(filter.connectionId ? { connectionId: filter.connectionId } : {}),
      ...(filter.projectId ? { projectId: filter.projectId } : {}),
      ...(filter.jobId ? { jobId: filter.jobId } : {}),
      ...(filter.runId ? { runId: filter.runId } : {}),
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
    select: USAGE_SELECT,
  });
  const items = rows.slice(0, limit).map((row) => ({
    ...row,
    costMicros:
      row.costMicros === null ? null : exactJsonInteger(row.costMicros),
  }));
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

export type AiUsageGroupBy = "model" | "operation" | "outcome" | "day";

export type AiUsageSummaryGroup = {
  key: string;
  currency: string | null;
  unpricedCalls: ExactJsonInteger;
  calls: ExactJsonInteger;
  failures: ExactJsonInteger;
  inputTokens: ExactJsonInteger;
  outputTokens: ExactJsonInteger;
  costMicros: ExactJsonInteger;
  averageDurationMs: ExactJsonInteger;
};

type RawSummaryGroup = {
  key: string;
  currency: string | null;
  unpricedCalls: string;
  calls: string;
  failures: string;
  inputTokens: string;
  outputTokens: string;
  costMicros: string;
  averageDurationMs: string;
};

export async function aiUsageSummary(
  db: PrismaClient,
  actor: SecurityContext,
  input: { since?: Date; until?: Date; groupBy: AiUsageGroupBy },
): Promise<{ groups: AiUsageSummaryGroup[]; truncated: boolean }> {
  assertSystemAdmin(actor);
  const keyExpression =
    input.groupBy === "model"
      ? Prisma.sql`"model"`
      : input.groupBy === "operation"
        ? Prisma.sql`"operation"`
        : input.groupBy === "outcome"
          ? Prisma.sql`"outcome"::text`
          : Prisma.sql`to_char("createdAt", 'YYYY-MM-DD')`;
  const conditions: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (input.since) conditions.push(Prisma.sql`"createdAt" >= ${input.since}`);
  if (input.until) conditions.push(Prisma.sql`"createdAt" <= ${input.until}`);
  const rows = await db.$queryRaw<RawSummaryGroup[]>(Prisma.sql`
    SELECT ${keyExpression} AS key, "currency",
           count(*) FILTER (WHERE "costMicros" IS NULL)::bigint::text AS "unpricedCalls",
           count(*)::bigint::text AS calls,
           count(*) FILTER (WHERE "outcome" <> 'success')::bigint::text AS failures,
           coalesce(sum("inputTokens"::bigint), 0)::text AS "inputTokens",
           coalesce(sum("outputTokens"::bigint), 0)::text AS "outputTokens",
           coalesce(sum("costMicros"), 0)::text AS "costMicros",
           coalesce(round(avg("durationMs")), 0)::bigint::text AS "averageDurationMs"
    FROM "AiUsage"
    WHERE ${Prisma.join(conditions, " AND ")}
    GROUP BY 1, "currency"
    ORDER BY count(*) DESC, key ASC, "currency" ASC NULLS LAST
    LIMIT 201
  `);
  return {
    groups: rows.slice(0, 200).map((row) => ({
      key: row.key,
      currency: row.currency,
      unpricedCalls: exactJsonInteger(row.unpricedCalls),
      calls: exactJsonInteger(row.calls),
      failures: exactJsonInteger(row.failures),
      inputTokens: exactJsonInteger(row.inputTokens),
      outputTokens: exactJsonInteger(row.outputTokens),
      costMicros: exactJsonInteger(row.costMicros),
      averageDurationMs: exactJsonInteger(row.averageDurationMs),
    })),
    truncated: rows.length > 200,
  };
}

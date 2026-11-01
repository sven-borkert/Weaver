import { Prisma, type PrismaClient } from "@weaver/db/client";
import { errorSummary, sanitizeText } from "@weaver/core/diagnostics/sanitize";
import { CoreError } from "@weaver/core/errors";
import {
  assertSystemAdmin,
  type SecurityContext,
} from "@weaver/core/security/context";
import {
  clampLimit,
  decodeTimestampPageCursor,
  encodePageCursor,
} from "./adminPaging";

export const QUEUE_JOB_STATES = [
  "created",
  "retry",
  "active",
  "completed",
  "cancelled",
  "failed",
] as const;
export type QueueJobState = (typeof QUEUE_JOB_STATES)[number];

export type QueueJobRow = {
  id: string;
  name: string;
  state: string;
  priority: number;
  retryCount: number;
  retryLimit: number;
  singletonKey: string | null;
  output: Record<string, string> | null;
  data: Record<string, string>;
  createdOn: Date;
  startedOn: Date | null;
  completedOn: Date | null;
  startAfter: Date;
  keepUntil: Date;
};

type RawQueueJobRow = Omit<QueueJobRow, "data" | "output"> & {
  data: unknown;
  output: unknown;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/i;

function safePayload(data: unknown): Record<string, string> {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const source = data as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const key of [
    "projectId",
    "documentId",
    "fileId",
    "tableId",
    "sourceId",
    "generationId",
    "runId",
  ]) {
    const value = source[key];
    if (typeof value === "string" && UUID_PATTERN.test(value))
      result[key] = value;
  }
  const sourceCommitSha = source.sourceCommitSha;
  if (typeof sourceCommitSha === "string" && SHA_PATTERN.test(sourceCommitSha))
    result.sourceCommitSha = sourceCommitSha;
  const configFingerprint = source.configFingerprint;
  if (
    typeof configFingerprint === "string" &&
    FINGERPRINT_PATTERN.test(configFingerprint)
  )
    result.configFingerprint = configFingerprint;
  const cursor = source.cursor;
  if (typeof cursor === "string" && UUID_PATTERN.test(cursor))
    result.cursor = cursor;
  return result;
}

function safeOutput(output: unknown): Record<string, string> | null {
  if (!output || typeof output !== "object" || Array.isArray(output))
    return null;
  const source = output as Record<string, unknown>;
  const value =
    typeof source.error === "string"
      ? source.error
      : typeof source.message === "string"
        ? source.message
        : null;
  if (value === null) return null;
  const characters = Array.from(sanitizeText(errorSummary(value), 1_024));
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const length = Math.ceil((low + high) / 2);
    if (
      JSON.stringify({ error: characters.slice(0, length).join("") }).length <=
      1_024
    )
      low = length;
    else high = length - 1;
  }
  return { error: characters.slice(0, low).join("") };
}

function publicJob(row: RawQueueJobRow): QueueJobRow {
  return {
    ...row,
    data: safePayload(row.data),
    output: safeOutput(row.output),
  };
}

async function pgbossPresent(db: PrismaClient): Promise<boolean> {
  const [row] = await db.$queryRaw<Array<{ relation: string | null }>>(
    Prisma.sql`SELECT to_regclass('pgboss.job')::text AS relation`,
  );
  return Boolean(row?.relation);
}

export async function listQueueJobs(
  db: PrismaClient,
  actor: SecurityContext,
  filter: {
    name?: string;
    state?: QueueJobState;
    since?: Date;
    generationId?: string;
    runId?: string;
    limit?: number;
    cursor?: string;
  },
): Promise<{
  items: QueueJobRow[];
  nextCursor: string | null;
  truncated: boolean;
}> {
  assertSystemAdmin(actor);
  if (!(await pgbossPresent(db)))
    return { items: [], nextCursor: null, truncated: false };
  const limit = clampLimit(filter.limit);
  const cursor = filter.cursor
    ? decodeTimestampPageCursor(filter.cursor, 2)
    : null;
  if (cursor && !UUID_PATTERN.test(cursor[1]!)) {
    throw new CoreError("BAD_REQUEST", "Invalid cursor", { field: "cursor" });
  }
  const conditions: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (filter.name) conditions.push(Prisma.sql`job.name = ${filter.name}`);
  if (filter.state)
    conditions.push(Prisma.sql`job.state::text = ${filter.state}`);
  if (filter.since)
    conditions.push(
      Prisma.sql`job.created_on >= ${filter.since.toISOString()}::timestamptz`,
    );
  if (filter.generationId)
    conditions.push(
      Prisma.sql`job.data->>'generationId' = ${filter.generationId}`,
    );
  if (filter.runId)
    conditions.push(Prisma.sql`job.data->>'runId' = ${filter.runId}`);
  if (cursor) {
    conditions.push(Prisma.sql`
      (date_trunc('milliseconds', job.created_on), job.id)
      < (${cursor[0].toISOString()}::timestamptz, ${cursor[1]}::uuid)
    `);
  }
  const rows = await db.$queryRaw<RawQueueJobRow[]>(Prisma.sql`
    SELECT job.id::text AS id, job.name, job.state::text AS state, job.priority,
           job.retry_count AS "retryCount", job.retry_limit AS "retryLimit",
           job.singleton_key AS "singletonKey", job.output, job.data,
           date_trunc('milliseconds', job.created_on) AT TIME ZONE 'UTC' AS "createdOn",
           job.started_on AT TIME ZONE 'UTC' AS "startedOn",
           job.completed_on AT TIME ZONE 'UTC' AS "completedOn",
           job.start_after AT TIME ZONE 'UTC' AS "startAfter",
           job.keep_until AT TIME ZONE 'UTC' AS "keepUntil"
    FROM pgboss.job AS job
    WHERE ${Prisma.join(conditions, " AND ")}
    ORDER BY date_trunc('milliseconds', job.created_on) DESC, job.id DESC
    LIMIT ${limit + 1}
  `);
  const items = rows.slice(0, limit).map(publicJob);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? encodePageCursor([last.createdOn.toISOString(), last.id])
        : null,
    truncated: rows.length > limit,
  };
}

export async function getQueueJob(
  db: PrismaClient,
  actor: SecurityContext,
  id: string,
): Promise<QueueJobRow | null> {
  assertSystemAdmin(actor);
  if (!UUID_PATTERN.test(id) || !(await pgbossPresent(db))) return null;
  const [row] = await db.$queryRaw<RawQueueJobRow[]>(Prisma.sql`
    SELECT job.id::text AS id, job.name, job.state::text AS state, job.priority,
           job.retry_count AS "retryCount", job.retry_limit AS "retryLimit",
           job.singleton_key AS "singletonKey", job.output, job.data,
           date_trunc('milliseconds', job.created_on) AT TIME ZONE 'UTC' AS "createdOn",
           job.started_on AT TIME ZONE 'UTC' AS "startedOn",
           job.completed_on AT TIME ZONE 'UTC' AS "completedOn",
           job.start_after AT TIME ZONE 'UTC' AS "startAfter",
           job.keep_until AT TIME ZONE 'UTC' AS "keepUntil"
    FROM pgboss.job AS job
    WHERE job.id = ${id}::uuid
  `);
  return row ? publicJob(row) : null;
}

export async function queueSummary(
  db: PrismaClient,
  actor: SecurityContext,
): Promise<{
  queues: Array<{
    name: string;
    state: string;
    count: number;
    oldestCreatedOn: Date | null;
  }>;
  schedules: Array<{ name: string; cron: string }>;
  truncated: boolean;
}> {
  assertSystemAdmin(actor);
  if (!(await pgbossPresent(db)))
    return { queues: [], schedules: [], truncated: false };
  const [queueRows, scheduleRows] = await Promise.all([
    db.$queryRaw<
      Array<{
        name: string;
        state: string;
        count: string;
        oldestCreatedOn: Date | null;
      }>
    >(Prisma.sql`
      SELECT name, state::text AS state, count(*)::bigint::text AS count,
             min(created_on) AT TIME ZONE 'UTC' AS "oldestCreatedOn"
      FROM pgboss.job
      GROUP BY name, state
      ORDER BY name, state
      LIMIT 201
    `),
    db.$queryRaw<Array<{ name: string; cron: string }>>(Prisma.sql`
      SELECT name, cron FROM pgboss.schedule ORDER BY name, key LIMIT 201
    `),
  ]);
  let truncated = queueRows.length > 200 || scheduleRows.length > 200;
  const queues = queueRows.slice(0, 200).map((row) => {
    const parsed = BigInt(row.count);
    if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) truncated = true;
    return {
      ...row,
      count: Number(
        parsed > BigInt(Number.MAX_SAFE_INTEGER)
          ? BigInt(Number.MAX_SAFE_INTEGER)
          : parsed,
      ),
      name: sanitizeText(row.name, 80),
      state: sanitizeText(row.state, 20),
    };
  });
  const schedules = scheduleRows.slice(0, 200).map((row) => ({
    name: sanitizeText(row.name, 80),
    cron: sanitizeText(row.cron, 200),
  }));
  return {
    queues,
    schedules,
    truncated,
  };
}

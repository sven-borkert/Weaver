import { diagnosticWriterStats } from "@weaver/core/diagnostics/writer";
import {
  assertSystemAdmin,
  type UserSecurityContext,
} from "@weaver/core/security/context";
import { Prisma, type PrismaClient } from "@weaver/db/client";
import { getDiagnosticsSettings } from "./diagnosticsSettings";

const MAX_OUTPUT_CHARS = 16_000;
const MAX_METADATA_ROWS = 200;
const MAX_FACT_CHARS = 1_000;

export type AdminRuntimeConfig = {
  basePath: string;
  dataDir: string;
  poolMax: number;
  statementTimeoutMs: number;
  jobsEnabled: boolean;
  reconcileCron: string;
  assistantReconcileCron: string;
  mcp: {
    port: number;
    toolTimeoutMs: number;
    maxBodyBytes: number;
    maxResourceChars: number;
    rateLimitPerMinute: number;
  };
  encryptionKeyVersions: number[];
};

const OVERVIEW_TABLES = [
  "DiagnosticEvent",
  "SystemSetting",
  "KnowledgeGeneration",
  "KnowledgeGenerationDocument",
  "DocumentSearchChunk",
  "KnowledgeEmbedding",
  "GraphEntity",
  "GraphRelation",
  "AiUsage",
  "AssistantRun",
  "AssistantRunEvent",
  "McpAuditEvent",
  "McpOperation",
] as const;

type RelationSize = { name: string; rows: number; bytes: number };

export type AdminOverview = {
  version: string;
  node: string;
  pid: number;
  uptimeSeconds: number;
  config: AdminRuntimeConfig;
  tables: RelationSize[];
  pgboss: RelationSize[];
  truncated: boolean;
};

type RawRelationSize = { name: string; rows: string; bytes: string };

function safeNumber(value: string): { value: number; truncated: boolean } {
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER))
    return { value: Number.MAX_SAFE_INTEGER, truncated: true };
  return { value: Number(parsed), truncated: false };
}

function relationSizes(rows: RawRelationSize[]): {
  items: RelationSize[];
  truncated: boolean;
} {
  let truncated = rows.length > MAX_METADATA_ROWS;
  const items = rows.slice(0, MAX_METADATA_ROWS).map((row) => {
    const count = safeNumber(row.rows);
    const bytes = safeNumber(row.bytes);
    truncated ||= count.truncated || bytes.truncated;
    return { name: row.name, rows: count.value, bytes: bytes.value };
  });
  return { items, truncated };
}

async function selectedTableSizes(
  db: PrismaClient,
  schema: string,
  names: readonly string[],
): Promise<ReturnType<typeof relationSizes>> {
  const rows = await db.$queryRaw<RawRelationSize[]>(Prisma.sql`
    SELECT c.relname AS name,
           GREATEST(c.reltuples, 0)::bigint::text AS rows,
           pg_total_relation_size(c.oid)::bigint::text AS bytes
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schema}
      AND c.relkind IN ('r', 'p')
      AND c.relname IN (${Prisma.join([...names])})
    ORDER BY c.relname
  `);
  return relationSizes(rows);
}

async function pgBossTableSizes(
  db: PrismaClient,
): Promise<ReturnType<typeof relationSizes>> {
  const rows = await db.$queryRaw<RawRelationSize[]>(Prisma.sql`
    SELECT c.relname AS name,
           GREATEST(c.reltuples, 0)::bigint::text AS rows,
           pg_total_relation_size(c.oid)::bigint::text AS bytes
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'pgboss'
      AND c.relkind IN ('r', 'p')
    ORDER BY c.relname
    LIMIT ${MAX_METADATA_ROWS + 1}
  `);
  return relationSizes(rows);
}

function fits(value: unknown): boolean {
  return JSON.stringify(value).length <= MAX_OUTPUT_CHARS;
}

function boundedString(value: string, max = MAX_FACT_CHARS) {
  return value.length > max
    ? { value: value.slice(0, max), truncated: true }
    : { value, truncated: false };
}

function boundedRuntimeConfig(config: AdminRuntimeConfig): {
  config: AdminRuntimeConfig;
  truncated: boolean;
} {
  const basePath = boundedString(config.basePath);
  const dataDir = boundedString(config.dataDir);
  const reconcileCron = boundedString(config.reconcileCron);
  const assistantReconcileCron = boundedString(config.assistantReconcileCron);
  const encryptionKeyVersions = config.encryptionKeyVersions.slice(
    0,
    MAX_METADATA_ROWS,
  );
  return {
    config: {
      basePath: basePath.value,
      dataDir: dataDir.value,
      poolMax: config.poolMax,
      statementTimeoutMs: config.statementTimeoutMs,
      jobsEnabled: config.jobsEnabled,
      reconcileCron: reconcileCron.value,
      assistantReconcileCron: assistantReconcileCron.value,
      mcp: {
        port: config.mcp.port,
        toolTimeoutMs: config.mcp.toolTimeoutMs,
        maxBodyBytes: config.mcp.maxBodyBytes,
        maxResourceChars: config.mcp.maxResourceChars,
        rateLimitPerMinute: config.mcp.rateLimitPerMinute,
      },
      encryptionKeyVersions,
    },
    truncated:
      basePath.truncated ||
      dataDir.truncated ||
      reconcileCron.truncated ||
      assistantReconcileCron.truncated ||
      encryptionKeyVersions.length < config.encryptionKeyVersions.length,
  };
}

export async function adminOverview(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: { version: string; config: AdminRuntimeConfig },
): Promise<AdminOverview> {
  assertSystemAdmin(actor);
  const version = boundedString(input.version);
  const runtime = boundedRuntimeConfig(input.config);
  const [schema] = await db.$queryRaw<
    Array<{ name: string }>
  >`SELECT current_schema() AS name`;
  const [tables, pgboss] = await Promise.all([
    selectedTableSizes(db, schema?.name ?? "public", OVERVIEW_TABLES),
    pgBossTableSizes(db),
  ]);
  const output: AdminOverview = {
    version: version.value,
    node: process.version,
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    config: runtime.config,
    tables: tables.items,
    pgboss: pgboss.items,
    truncated:
      version.truncated ||
      runtime.truncated ||
      tables.truncated ||
      pgboss.truncated,
  };
  while (!fits(output) && output.pgboss.length) {
    output.pgboss.pop();
    output.truncated = true;
  }
  while (!fits(output) && output.tables.length) {
    output.tables.pop();
    output.truncated = true;
  }
  return output;
}

export type AdminHealth = {
  database: { roundTripMs: number };
  pgboss: {
    present: boolean;
    version: number | null;
    cronOn: Date | null;
    schedules: Array<{ name: string; cron: string; updatedOn: Date | null }>;
    lastSystemReconcileAt: Date | null;
    lastAssistantReconcileAt: Date | null;
    workerLastSeenAt: Date | null;
  };
  queues: Array<{
    name: string;
    state: string;
    count: number;
    oldestCreatedOn: Date | null;
  }>;
  assistant: { expiredRunningAttempts: number };
  diagnostics: {
    settings: Awaited<ReturnType<typeof getDiagnosticsSettings>>;
    writer: ReturnType<typeof diagnosticWriterStats>;
  };
  truncated: boolean;
};

export async function adminHealth(
  db: PrismaClient,
  actor: UserSecurityContext,
): Promise<AdminHealth> {
  assertSystemAdmin(actor);
  const started = performance.now();
  await db.$queryRaw`SELECT 1`;
  const roundTripMs = performance.now() - started;
  const [relation] = await db.$queryRaw<Array<{ relation: string | null }>>(
    Prisma.sql`SELECT to_regclass('pgboss.job')::text AS relation`,
  );
  const present = Boolean(relation?.relation);
  let truncated = false;
  let pgboss: AdminHealth["pgboss"] = {
    present,
    version: null,
    cronOn: null,
    schedules: [],
    lastSystemReconcileAt: null,
    lastAssistantReconcileAt: null,
    workerLastSeenAt: null,
  };
  let queues: AdminHealth["queues"] = [];
  if (present) {
    const [version] = await db.$queryRaw<
      Array<{ version: number; cron_on: Date | null }>
    >(Prisma.sql`
      SELECT version, cron_on AT TIME ZONE 'UTC' AS cron_on
      FROM pgboss.version LIMIT 1
    `);
    const scheduleRows = await db.$queryRaw<
      Array<{ name: string; cron: string; updated_on: Date | null }>
    >(Prisma.sql`
      SELECT name, cron, updated_on AT TIME ZONE 'UTC' AS updated_on
      FROM pgboss.schedule
      ORDER BY name
      LIMIT ${MAX_METADATA_ROWS + 1}
    `);
    const completions = await db.$queryRaw<
      Array<{ name: string; last: Date | null }>
    >(Prisma.sql`
      SELECT name, max(completed_on) AT TIME ZONE 'UTC' AS last
      FROM pgboss.job
      WHERE state = 'completed'
        AND name IN ('system.reconcile', 'assistant.reconcile')
      GROUP BY name
    `);
    const [seen] = await db.$queryRaw<Array<{ last: Date | null }>>(
      Prisma.sql`
        SELECT max(completed_on) AT TIME ZONE 'UTC' AS last
        FROM pgboss.job
        WHERE state = 'completed'
      `,
    );
    const queueRows = await db.$queryRaw<
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
      LIMIT ${MAX_METADATA_ROWS + 1}
    `);
    truncated ||=
      scheduleRows.length > MAX_METADATA_ROWS ||
      queueRows.length > MAX_METADATA_ROWS;
    const schedules = scheduleRows.slice(0, MAX_METADATA_ROWS).map((row) => ({
      name: row.name,
      cron: row.cron,
      updatedOn: row.updated_on,
    }));
    queues = queueRows.slice(0, MAX_METADATA_ROWS).map((row) => {
      const count = safeNumber(row.count);
      truncated ||= count.truncated;
      return { ...row, count: count.value };
    });
    pgboss = {
      present,
      version: version?.version ?? null,
      cronOn: version?.cron_on ?? null,
      schedules,
      lastSystemReconcileAt:
        completions.find((row) => row.name === "system.reconcile")?.last ??
        null,
      lastAssistantReconcileAt:
        completions.find((row) => row.name === "assistant.reconcile")?.last ??
        null,
      workerLastSeenAt: seen?.last ?? null,
    };
  }
  const output: AdminHealth = {
    database: { roundTripMs },
    pgboss,
    queues,
    assistant: {
      expiredRunningAttempts: await db.assistantRunAttempt.count({
        where: { status: "running", leaseExpiresAt: { lt: new Date() } },
      }),
    },
    diagnostics: {
      settings: await getDiagnosticsSettings(db),
      writer: diagnosticWriterStats(),
    },
    truncated,
  };
  while (!fits(output) && output.queues.length) {
    output.queues.pop();
    output.truncated = true;
  }
  while (!fits(output) && output.pgboss.schedules.length) {
    output.pgboss.schedules.pop();
    output.truncated = true;
  }
  return output;
}

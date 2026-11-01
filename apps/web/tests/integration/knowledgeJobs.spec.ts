import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { PgBoss, type Db } from "pg-boss";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { PgBossQueue } from "@weaver/core/jobs/pgBossQueue";
import {
  sendKnowledgePublisherJob,
  startKnowledgePublisher,
  stopKnowledgePublisher,
} from "@weaver/core/jobs/publisher";
import {
  FakeJobQueue,
  type JobExecution,
  setJobQueueForTests,
} from "@weaver/core/jobs/queue";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import { parseKnowledgeConfig } from "@weaver/core/knowledge/config";
import type { JobQueue } from "@weaver/core/jobs/queue";
import { registerKnowledgeJobHandlers } from "@weaver/core/jobs/runtime";
import { knowledgeSystemContextForTests } from "@weaver/core/jobs/systemContext";
import {
  KNOWLEDGE_JOB_NAMES,
  KNOWLEDGE_ENRICHMENT_EXPIRE_IN_SECONDS,
  type KnowledgeJobName,
  type KnowledgeJobPayloads,
} from "@weaver/core/jobs/types";
import {
  addMembership,
  callerFor,
  getPrisma,
  makeProject,
  makeUser,
  noKnowledgeRouting,
  resetDb,
} from "./_harness";

class CapturingWorkerQueue implements JobQueue {
  readonly handlers = new Map<
    KnowledgeJobName,
    (
      data: KnowledgeJobPayloads[KnowledgeJobName],
      execution: JobExecution,
    ) => Promise<void>
  >();
  readonly schedules: Array<{ name: "system.reconcile"; cron: string }> = [];

  async send(): Promise<string> {
    return "captured-job";
  }

  async work<N extends KnowledgeJobName>(
    name: N,
    handler: (
      data: KnowledgeJobPayloads[N],
      execution: JobExecution,
    ) => Promise<void>,
  ): Promise<void> {
    this.handlers.set(
      name,
      handler as (
        data: KnowledgeJobPayloads[KnowledgeJobName],
        execution: JobExecution,
      ) => Promise<void>,
    );
  }

  async schedule(name: "system.reconcile", cron: string): Promise<void> {
    this.schedules.push({ name, cron });
  }

  async stop(): Promise<void> {
    return Promise.resolve();
  }

  async run<N extends KnowledgeJobName>(
    name: N,
    data: KnowledgeJobPayloads[N],
  ): Promise<void> {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`missing handler for ${name}`);
    await handler(data, {
      jobId: "captured-job",
      retryCount: null,
      signal: new AbortController().signal,
    });
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  return Promise.race([promise, deadline]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

async function waitForMigrationBlockedBy(backendPid: number): Promise<void> {
  await vi.waitFor(
    async () => {
      const [lock] = await getPrisma().$queryRaw<
        Array<{ migrationBlocked: boolean }>
      >`
        SELECT EXISTS (
          SELECT 1
          FROM pg_locks AS waiting
          WHERE waiting.granted = false
            AND waiting.mode = 'AccessExclusiveLock'
            AND ${backendPid} = ANY(pg_blocking_pids(waiting.pid))
        ) AS "migrationBlocked"
      `;
      expect(lock?.migrationBlocked).toBe(true);
    },
    { timeout: 10_000, interval: 20 },
  );
}

type QueueJobSnapshot = {
  queuePolicy: string;
  queueRetryLimit: number;
  queueRetryDelay: number;
  queueRetryBackoff: boolean;
  queueRetryDelayMax: number | null;
  queueExpireInSeconds: number;
  queueRetentionSeconds: number;
  queueDeletionSeconds: number;
  queueDeadLetter: string | null;
  queuePartition: boolean;
  queueTableName: string;
  queueHeartbeatSeconds: number | null;
  queueNotify: boolean;
  id: string | null;
  state: string | null;
  data: unknown;
  singletonKey: string | null;
  jobPolicy: string | null;
  jobRetryLimit: number | null;
  jobRetryDelay: number | null;
  jobRetryBackoff: boolean | null;
  jobExpireInSeconds: number | null;
  jobSnapshot: Record<string, unknown> | null;
};

async function snapshotQueue(name: string): Promise<QueueJobSnapshot[]> {
  return getPrisma().$queryRaw<QueueJobSnapshot[]>`
    SELECT queue.policy AS "queuePolicy",
           queue.retry_limit AS "queueRetryLimit",
           queue.retry_delay AS "queueRetryDelay",
           queue.retry_backoff AS "queueRetryBackoff",
           queue.retry_delay_max AS "queueRetryDelayMax",
           queue.expire_seconds AS "queueExpireInSeconds",
           queue.retention_seconds AS "queueRetentionSeconds",
           queue.deletion_seconds AS "queueDeletionSeconds",
           queue.dead_letter AS "queueDeadLetter",
           queue.partition AS "queuePartition",
           queue.table_name AS "queueTableName",
           queue.heartbeat_seconds AS "queueHeartbeatSeconds",
           queue.notify AS "queueNotify",
           job.id,
           job.state,
           job.data,
           job.singleton_key AS "singletonKey",
           job.policy AS "jobPolicy",
           job.retry_limit AS "jobRetryLimit",
           job.retry_delay AS "jobRetryDelay",
           job.retry_backoff AS "jobRetryBackoff",
           job.expire_seconds AS "jobExpireInSeconds",
           to_jsonb(job) AS "jobSnapshot"
    FROM pgboss.queue AS queue
    LEFT JOIN pgboss.job AS job ON job.name = queue.name
    WHERE queue.name = ${name}
    ORDER BY job.created_on, job.id
  `;
}

function withoutMigratedJobFields(
  snapshot: Record<string, unknown>,
): Record<string, unknown> {
  const preserved = { ...snapshot };
  delete preserved.policy;
  delete preserved.retry_limit;
  delete preserved.retry_delay;
  delete preserved.retry_backoff;
  delete preserved.expire_seconds;
  return preserved;
}

type DedicatedQueueLayoutSnapshot = {
  queue: Record<string, unknown>;
  jobs: Record<string, unknown>[];
  indexes: Array<{ name: string; definition: string }>;
};

async function snapshotDedicatedQueueLayout(
  name: string,
): Promise<DedicatedQueueLayoutSnapshot> {
  const [queue] = await getPrisma().$queryRaw<
    Array<{ snapshot: Record<string, unknown> }>
  >`
    SELECT to_jsonb(queue) AS snapshot
    FROM pgboss.queue
    WHERE name = ${name}
  `;
  if (!queue) throw new Error(`Missing test queue ${name}`);

  const jobs = await getPrisma().$queryRaw<
    Array<{ snapshot: Record<string, unknown> }>
  >`
    SELECT to_jsonb(job) AS snapshot
    FROM pgboss.job
    WHERE name = ${name}
    ORDER BY created_on, id
  `;
  const indexes = await getPrisma().$queryRaw<
    Array<{ name: string; definition: string }>
  >`
    SELECT indexes.indexname AS name,
           indexes.indexdef AS definition
    FROM pgboss.queue AS queue
    JOIN pg_catalog.pg_indexes AS indexes
      ON indexes.schemaname = 'pgboss'
     AND indexes.tablename = queue.table_name
    WHERE queue.name = ${name}
    ORDER BY indexes.indexname
  `;

  return {
    queue: queue.snapshot,
    jobs: jobs.map((job) => job.snapshot),
    indexes,
  };
}

async function replaceDedicatedEnforcementIndex(
  queueName: string,
  createCommand?: string,
): Promise<void> {
  await getPrisma().$queryRaw`
    SELECT pgboss.job_table_run(
      'DROP INDEX pgboss.job_i3',
      queue.table_name
    )::text
    FROM pgboss.queue AS queue
    WHERE queue.name = ${queueName}
  `;
  if (!createCommand) return;

  await getPrisma().$queryRaw`
    SELECT pgboss.job_table_run(
      ${createCommand},
      queue.table_name
    )::text
    FROM pgboss.queue AS queue
    WHERE queue.name = ${queueName}
  `;
}

function withHostileDeparserSettings(connectionString: string): string {
  const url = new URL(connectionString);
  url.searchParams.set(
    "options",
    "-csearch_path=pgboss,public -cquote_all_identifiers=on",
  );
  return url.toString();
}

describe("knowledge job queue", () => {
  beforeEach(async () => {
    vi.stubEnv("NODE_ENV", "test");
    await resetDb();
  });

  afterEach(() => {
    setJobQueueForTests(null);
    vi.unstubAllEnvs();
  });

  it("restarts the global publisher after database reset", async () => {
    await stopKnowledgePublisher();
    await startKnowledgePublisher();

    try {
      await resetDb();
      await expect(
        sendKnowledgePublisherJob("system.reconcile", {}),
      ).resolves.toEqual(expect.any(String));
    } finally {
      await stopKnowledgePublisher();
    }
  });

  it("resetDb drops dedicated partitions an interrupted run left attached", async () => {
    const queueName = "document.ai-enrich";
    const legacyBoss = new PgBoss({
      connectionString: process.env.DATABASE_URL!,
      schema: "pgboss",
    });
    await legacyBoss.start();
    await legacyBoss.createQueue(queueName, {
      partition: true,
      policy: "stately",
    });
    // Stop without deleteQueue, as a killed test process would.
    await legacyBoss.stop();

    await resetDb();

    const partitions = await getPrisma().$queryRaw<Array<{ name: string }>>`
      SELECT child.relname AS name
      FROM pg_catalog.pg_inherits AS inheritance
      JOIN pg_catalog.pg_class AS child ON child.oid = inheritance.inhrelid
      WHERE inheritance.inhparent = 'pgboss.job'::regclass
    `;
    expect(partitions.map(({ name }) => name)).toEqual(["job_common"]);

    const queue = new PgBossQueue<
      Pick<KnowledgeJobPayloads, "document.ai-enrich">
    >({
      connectionString: process.env.DATABASE_URL!,
      queueNames: [queueName],
      workerConcurrency: 1,
    });
    try {
      await queue.start();
      expect(
        await queue.send(queueName, {
          projectId: randomUUID(),
          generationId: randomUUID(),
          documentId: randomUUID(),
          sourceCommitSha: "a".repeat(40),
          pathAtSha: "after-reset.md",
          configFingerprint: "b".repeat(64),
        }),
      ).toEqual(expect.any(String));
    } finally {
      await queue.stop();
    }
  });

  it("ingestion review: pg-boss deduplicates queued recovery deliveries", async () => {
    const queue = new PgBossQueue({
      connectionString: process.env.DATABASE_URL!,
      queueNames: ["ingestion.parse"],
      workerConcurrency: 1,
    });
    try {
      await queue.start();
      const payload = {
        fileId: randomUUID(),
        projectId: randomUUID(),
        contentDigest: "a".repeat(64),
        baseAttemptCount: 0,
      };
      expect(await queue.send("ingestion.parse", payload)).not.toBeNull();
      expect(await queue.send("ingestion.parse", payload)).toBeNull();
      expect(
        await queue.send("ingestion.parse", {
          ...payload,
          baseAttemptCount: 1,
        }),
      ).not.toBeNull();
    } finally {
      await queue.stop();
    }
  });

  it("claims one job through a real pg-boss lifecycle", async () => {
    const queueName = `knowledge-jobs-${randomUUID()}`;
    const marker = randomUUID();
    const queue = new PgBossQueue<Record<string, { marker: string }>>({
      connectionString: process.env.DATABASE_URL!,
      queueNames: [queueName],
      workerConcurrency: 1,
    });
    let claims = 0;
    let resolveClaim!: (value: {
      data: { marker: string };
      hasSignal: boolean;
      jobId: string | null;
    }) => void;
    const claimed = new Promise<{
      data: { marker: string };
      hasSignal: boolean;
      jobId: string | null;
    }>((resolve) => {
      resolveClaim = resolve;
    });
    let received:
      | {
          data: { marker: string };
          hasSignal: boolean;
          jobId: string | null;
        }
      | undefined;

    try {
      await queue.start();

      const [queueOptions] = await getPrisma().$queryRaw<
        Array<{
          retryLimit: number;
          retryDelay: number;
          retryBackoff: boolean;
          expireInSeconds: number;
        }>
      >`
        SELECT retry_limit AS "retryLimit",
               retry_delay AS "retryDelay",
               retry_backoff AS "retryBackoff",
               expire_seconds AS "expireInSeconds"
        FROM pgboss.queue
        WHERE name = ${queueName}
      `;
      expect(queueOptions).toEqual({
        retryLimit: 5,
        retryDelay: 5,
        retryBackoff: true,
        expireInSeconds: 900,
      });

      await queue.send(queueName, { marker });
      await queue.work(queueName, async (data, execution) => {
        claims += 1;
        resolveClaim({
          data,
          hasSignal: execution.signal instanceof AbortSignal,
          jobId: execution.jobId,
        });
      });

      received = await withTimeout(claimed, 10_000);
    } finally {
      await queue.stop();
      await getPrisma().$queryRaw`
        SELECT pgboss.delete_queue(${queueName})::text
      `;
    }

    expect(received).toEqual({
      data: { marker },
      hasSignal: true,
      jobId: expect.any(String),
    });
    expect(claims).toBe(1);
    const [remaining] = await getPrisma().$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count
      FROM pgboss.queue
      WHERE name = ${queueName}
    `;
    expect(remaining?.count).toBe(0n);
  });

  it("keeps one queued enrichment job for one durable target identity", async () => {
    const queueName = "document.ai-enrich";
    const legacyBoss = new PgBoss({
      connectionString: process.env.DATABASE_URL!,
      schema: "pgboss",
    });
    await legacyBoss.start();
    await legacyBoss.createQueue(queueName, {
      policy: "standard",
      retryLimit: 1,
      retryDelay: 1,
      retryBackoff: false,
      expireInSeconds: 60,
    });
    await legacyBoss.stop();
    const queue = new PgBossQueue<
      Pick<KnowledgeJobPayloads, "document.ai-enrich">
    >({
      connectionString: process.env.DATABASE_URL!,
      queueNames: [queueName],
      workerConcurrency: 1,
    });
    const payload = {
      projectId: randomUUID(),
      generationId: randomUUID(),
      documentId: randomUUID(),
      sourceCommitSha: "a".repeat(40),
      pathAtSha: "durable-target.md",
      configFingerprint: "b".repeat(64),
    };

    try {
      await queue.start();
      const ids = await Promise.all(
        Array.from({ length: 5 }, () => queue.send(queueName, payload)),
      );
      const [queueRow] = await getPrisma().$queryRaw<
        Array<{
          policy: string;
          retryLimit: number;
          retryDelay: number;
          retryBackoff: boolean;
          expireInSeconds: number;
        }>
      >`
        SELECT policy,
               retry_limit AS "retryLimit",
               retry_delay AS "retryDelay",
               retry_backoff AS "retryBackoff",
               expire_seconds AS "expireInSeconds"
        FROM pgboss.queue
        WHERE name = ${queueName}
      `;
      const rows = await getPrisma().$queryRaw<
        Array<{ singletonKey: string | null }>
      >`
        SELECT singleton_key AS "singletonKey"
        FROM pgboss.job
        WHERE name = ${queueName}
          AND state = 'created'
      `;

      expect(ids.filter((id) => id !== null)).toHaveLength(1);
      expect(queueRow).toEqual({
        policy: "stately",
        retryLimit: 5,
        retryDelay: 5,
        retryBackoff: true,
        expireInSeconds: KNOWLEDGE_ENRICHMENT_EXPIRE_IN_SECONDS,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.singletonKey).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await queue.stop();
      await getPrisma().$queryRaw`
        SELECT pgboss.delete_queue(${queueName})::text
      `;
    }
  });

  it("refuses a dedicated legacy standard queue without mutating its layout", async () => {
    const queueName = "document.ai-enrich";
    const payload = { marker: randomUUID() };
    const legacyBoss = new PgBoss({
      connectionString: process.env.DATABASE_URL!,
      schema: "pgboss",
    });
    await legacyBoss.start();
    await legacyBoss.createQueue(queueName, {
      partition: true,
      policy: "standard",
      retryLimit: 2,
      retryDelay: 7,
      retryBackoff: false,
      expireInSeconds: 61,
    });
    const legacyJobId = await legacyBoss.send(queueName, payload, {
      singletonKey: "6".repeat(64),
    });
    const [claimed] = await legacyBoss.fetch(queueName);
    expect(claimed?.id).toBe(legacyJobId);
    await expect(
      legacyBoss.complete(queueName, legacyJobId!),
    ).resolves.toMatchObject({ requested: 1, affected: 1 });
    const before = await snapshotDedicatedQueueLayout(queueName);
    const queue = new PgBossQueue<
      Pick<KnowledgeJobPayloads, "document.ai-enrich">
    >({
      connectionString: process.env.DATABASE_URL!,
      queueNames: [queueName],
      workerConcurrency: 1,
    });

    try {
      await expect(queue.start()).rejects.toThrow(
        "Cannot safely upgrade dedicated document.ai-enrich queue; drain and recreate it with pg-boss using partition=true and policy=stately, then retry startup",
      );
      expect(await snapshotDedicatedQueueLayout(queueName)).toEqual(before);
    } finally {
      await queue.stop();
      await legacyBoss.stop();
      await getPrisma().$queryRaw`
        SELECT pgboss.delete_queue(${queueName})::text
      `;
    }
  });

  it("starts a healthy dedicated stately queue under hostile deparser settings", async () => {
    const queueName = "document.ai-enrich";
    const legacyBoss = new PgBoss({
      connectionString: process.env.DATABASE_URL!,
      schema: "pgboss",
    });
    await legacyBoss.start();
    await legacyBoss.createQueue(queueName, {
      partition: true,
      policy: "stately",
      retryLimit: 5,
      retryDelay: 5,
      retryBackoff: true,
      expireInSeconds: KNOWLEDGE_ENRICHMENT_EXPIRE_IN_SECONDS,
    });
    const queue = new PgBossQueue<
      Pick<KnowledgeJobPayloads, "document.ai-enrich">
    >({
      connectionString: withHostileDeparserSettings(process.env.DATABASE_URL!),
      queueNames: [queueName],
      workerConcurrency: 1,
    });
    const payload = {
      projectId: randomUUID(),
      generationId: randomUUID(),
      documentId: randomUUID(),
      sourceCommitSha: "1".repeat(40),
      pathAtSha: "hostile-settings.md",
      configFingerprint: "2".repeat(64),
    };

    try {
      await expect(queue.start()).resolves.toBeUndefined();
      const ids = await Promise.all(
        Array.from({ length: 5 }, () => queue.send(queueName, payload)),
      );
      const [created] = await getPrisma().$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*)::bigint AS count
        FROM pgboss.job
        WHERE name = ${queueName}
          AND state = 'created'
      `;

      expect(ids.filter((id) => id !== null)).toHaveLength(1);
      expect(created?.count).toBe(1n);
    } finally {
      await queue.stop();
      await legacyBoss.deleteQueue(queueName).catch(() => undefined);
      await legacyBoss.stop();
    }
  });

  it("refuses a dedicated queue whose persisted table is job_common", async () => {
    const queueName = "document.ai-enrich";
    const expectedTableName =
      "jf3af097e9bbafd2c59e2a8d55809a4191590c0bcbf318607e86bd16d";
    const legacyBoss = new PgBoss({
      connectionString: process.env.DATABASE_URL!,
      schema: "pgboss",
    });
    await legacyBoss.start();
    await legacyBoss.createQueue(queueName, {
      partition: true,
      policy: "stately",
      retryLimit: 5,
      retryDelay: 5,
      retryBackoff: true,
      expireInSeconds: KNOWLEDGE_ENRICHMENT_EXPIRE_IN_SECONDS,
    });
    const [createdQueue] = await getPrisma().$queryRaw<
      Array<{ tableName: string }>
    >`
      SELECT table_name AS "tableName"
      FROM pgboss.queue
      WHERE name = ${queueName}
    `;
    expect(createdQueue?.tableName).toBe(expectedTableName);
    await getPrisma().$executeRaw`
      UPDATE pgboss.queue
      SET table_name = 'job_common'
      WHERE name = ${queueName}
    `;
    const before = await snapshotQueue(queueName);
    const queue = new PgBossQueue<
      Pick<KnowledgeJobPayloads, "document.ai-enrich">
    >({
      connectionString: process.env.DATABASE_URL!,
      queueNames: [queueName],
      workerConcurrency: 1,
    });

    try {
      await expect(queue.start()).rejects.toThrow(
        "Cannot safely upgrade dedicated document.ai-enrich queue; drain and recreate it with pg-boss using partition=true and policy=stately, then retry startup",
      );
      expect(await snapshotQueue(queueName)).toEqual(before);
    } finally {
      await queue.stop();
      await getPrisma().$executeRaw`
        UPDATE pgboss.queue
        SET table_name = ${expectedTableName}
        WHERE name = ${queueName}
      `;
      await legacyBoss.deleteQueue(queueName).catch(() => undefined);
      await legacyBoss.stop();
    }
  });

  it("refuses a dedicated queue whose persisted table belongs to another queue", async () => {
    const queueName = "document.ai-enrich";
    const otherQueueName = `knowledge-dedicated-${randomUUID()}`;
    const legacyBoss = new PgBoss({
      connectionString: process.env.DATABASE_URL!,
      schema: "pgboss",
    });
    await legacyBoss.start();
    await legacyBoss.createQueue(queueName, {
      partition: true,
      policy: "stately",
      retryLimit: 5,
      retryDelay: 5,
      retryBackoff: true,
      expireInSeconds: KNOWLEDGE_ENRICHMENT_EXPIRE_IN_SECONDS,
    });
    await legacyBoss.createQueue(otherQueueName, {
      partition: true,
      policy: "stately",
    });
    const queueRows = await getPrisma().$queryRaw<
      Array<{ name: string; tableName: string }>
    >`
      SELECT name, table_name AS "tableName"
      FROM pgboss.queue
      WHERE name IN (${queueName}, ${otherQueueName})
    `;
    const enrichmentTableName = queueRows.find(
      (row) => row.name === queueName,
    )!.tableName;
    const otherTableName = queueRows.find(
      (row) => row.name === otherQueueName,
    )!.tableName;
    await getPrisma().$executeRaw`
      UPDATE pgboss.queue
      SET table_name = ${otherTableName}
      WHERE name = ${queueName}
    `;
    const enrichmentBefore = await snapshotQueue(queueName);
    const otherBefore = await snapshotDedicatedQueueLayout(otherQueueName);
    const queue = new PgBossQueue<
      Pick<KnowledgeJobPayloads, "document.ai-enrich">
    >({
      connectionString: process.env.DATABASE_URL!,
      queueNames: [queueName],
      workerConcurrency: 1,
    });

    try {
      await expect(queue.start()).rejects.toThrow(
        "Cannot safely upgrade dedicated document.ai-enrich queue; drain and recreate it with pg-boss using partition=true and policy=stately, then retry startup",
      );
      expect(await snapshotQueue(queueName)).toEqual(enrichmentBefore);
      expect(await snapshotDedicatedQueueLayout(otherQueueName)).toEqual(
        otherBefore,
      );
    } finally {
      await queue.stop();
      await getPrisma().$executeRaw`
        UPDATE pgboss.queue
        SET table_name = ${enrichmentTableName}
        WHERE name = ${queueName}
      `;
      await legacyBoss.deleteQueue(queueName).catch(() => undefined);
      await legacyBoss.deleteQueue(otherQueueName).catch(() => undefined);
      await legacyBoss.stop();
    }
  });

  it("refuses a dedicated queue whose partition bound names another queue", async () => {
    const queueName = "document.ai-enrich";
    const expectedTableName =
      "jf3af097e9bbafd2c59e2a8d55809a4191590c0bcbf318607e86bd16d";
    const legacyBoss = new PgBoss({
      connectionString: process.env.DATABASE_URL!,
      schema: "pgboss",
    });
    await legacyBoss.start();
    await legacyBoss.createQueue(queueName, {
      partition: true,
      policy: "stately",
      retryLimit: 5,
      retryDelay: 5,
      retryBackoff: true,
      expireInSeconds: KNOWLEDGE_ENRICHMENT_EXPIRE_IN_SECONDS,
    });
    const [createdQueue] = await getPrisma().$queryRaw<
      Array<{ tableName: string }>
    >`
      SELECT table_name AS "tableName"
      FROM pgboss.queue
      WHERE name = ${queueName}
    `;
    expect(createdQueue?.tableName).toBe(expectedTableName);
    await getPrisma().$executeRawUnsafe(
      `ALTER TABLE pgboss.job DETACH PARTITION pgboss.${expectedTableName}`,
    );
    await getPrisma().$executeRawUnsafe(
      `ALTER TABLE pgboss.job ATTACH PARTITION pgboss.${expectedTableName} FOR VALUES IN ('another.queue')`,
    );
    const before = await snapshotDedicatedQueueLayout(queueName);
    const queue = new PgBossQueue<
      Pick<KnowledgeJobPayloads, "document.ai-enrich">
    >({
      connectionString: process.env.DATABASE_URL!,
      queueNames: [queueName],
      workerConcurrency: 1,
    });

    try {
      await expect(queue.start()).rejects.toThrow(
        "Cannot safely upgrade dedicated document.ai-enrich queue; drain and recreate it with pg-boss using partition=true and policy=stately, then retry startup",
      );
      expect(await snapshotDedicatedQueueLayout(queueName)).toEqual(before);
    } finally {
      await queue.stop();
      await legacyBoss.deleteQueue(queueName).catch(() => undefined);
      await legacyBoss.stop();
    }
  });

  it("refuses a dedicated stately queue with no enforcement index", async () => {
    const queueName = "document.ai-enrich";
    const legacyBoss = new PgBoss({
      connectionString: process.env.DATABASE_URL!,
      schema: "pgboss",
    });
    await legacyBoss.start();
    await legacyBoss.createQueue(queueName, {
      partition: true,
      policy: "stately",
      retryLimit: 5,
      retryDelay: 5,
      retryBackoff: true,
      expireInSeconds: KNOWLEDGE_ENRICHMENT_EXPIRE_IN_SECONDS,
    });
    await replaceDedicatedEnforcementIndex(queueName);
    const before = await snapshotDedicatedQueueLayout(queueName);
    const queue = new PgBossQueue<
      Pick<KnowledgeJobPayloads, "document.ai-enrich">
    >({
      connectionString: process.env.DATABASE_URL!,
      queueNames: [queueName],
      workerConcurrency: 1,
    });

    try {
      await expect(queue.start()).rejects.toThrow(
        "Cannot safely upgrade dedicated document.ai-enrich queue; drain and recreate it with pg-boss using partition=true and policy=stately, then retry startup",
      );
      expect(await snapshotDedicatedQueueLayout(queueName)).toEqual(before);
    } finally {
      await queue.stop();
      await legacyBoss.deleteQueue(queueName).catch(() => undefined);
      await legacyBoss.stop();
    }
  });

  it.each([
    [
      "operator class",
      `CREATE UNIQUE INDEX job_i3
       ON pgboss.job (
         name text_pattern_ops,
         state,
         COALESCE(singleton_key, '')
       )
       WHERE state <= 'active' AND policy = 'stately'`,
    ],
    [
      "collation",
      `CREATE UNIQUE INDEX job_i3
       ON pgboss.job (
         name COLLATE "C",
         state,
         (COALESCE(singleton_key, '')) COLLATE "C"
       )
       WHERE state <= 'active' AND policy = 'stately'`,
    ],
    [
      "sort/null flags",
      `CREATE UNIQUE INDEX job_i3
       ON pgboss.job (
         name ASC NULLS FIRST,
         state,
         COALESCE(singleton_key, '')
       )
       WHERE state <= 'active' AND policy = 'stately'`,
    ],
    [
      "null equality",
      `CREATE UNIQUE INDEX job_i3
       ON pgboss.job (name, state, COALESCE(singleton_key, ''))
       NULLS NOT DISTINCT
       WHERE state <= 'active' AND policy = 'stately'`,
    ],
    [
      "relation options",
      `CREATE UNIQUE INDEX job_i3
       ON pgboss.job (name, state, COALESCE(singleton_key, ''))
       WITH (fillfactor = 70)
       WHERE state <= 'active' AND policy = 'stately'`,
    ],
  ] as const)(
    "refuses a dedicated stately index with altered %s",
    async (_property, createCommand) => {
      const queueName = "document.ai-enrich";
      const legacyBoss = new PgBoss({
        connectionString: process.env.DATABASE_URL!,
        schema: "pgboss",
      });
      await legacyBoss.start();
      await legacyBoss.createQueue(queueName, {
        partition: true,
        policy: "stately",
        retryLimit: 5,
        retryDelay: 5,
        retryBackoff: true,
        expireInSeconds: KNOWLEDGE_ENRICHMENT_EXPIRE_IN_SECONDS,
      });
      await replaceDedicatedEnforcementIndex(queueName, createCommand);
      const before = await snapshotDedicatedQueueLayout(queueName);
      const queue = new PgBossQueue<
        Pick<KnowledgeJobPayloads, "document.ai-enrich">
      >({
        connectionString: process.env.DATABASE_URL!,
        queueNames: [queueName],
        workerConcurrency: 1,
      });

      try {
        await expect(queue.start()).rejects.toThrow(
          "Cannot safely upgrade dedicated document.ai-enrich queue; drain and recreate it with pg-boss using partition=true and policy=stately, then retry startup",
        );
        expect(await snapshotDedicatedQueueLayout(queueName)).toEqual(before);
      } finally {
        await queue.stop();
        await legacyBoss.deleteQueue(queueName).catch(() => undefined);
        await legacyBoss.stop();
      }
    },
  );

  it("refuses a dedicated stately queue with a corrupt enforcement index", async () => {
    const queueName = "document.ai-enrich";
    const legacyBoss = new PgBoss({
      connectionString: process.env.DATABASE_URL!,
      schema: "pgboss",
    });
    await legacyBoss.start();
    await legacyBoss.createQueue(queueName, {
      partition: true,
      policy: "stately",
      retryLimit: 5,
      retryDelay: 5,
      retryBackoff: true,
      expireInSeconds: KNOWLEDGE_ENRICHMENT_EXPIRE_IN_SECONDS,
    });
    await getPrisma().$queryRaw`
      SELECT pgboss.job_table_run(
        'DROP INDEX pgboss.job_i3',
        queue.table_name
      )::text
      FROM pgboss.queue AS queue
      WHERE queue.name = ${queueName}
    `;
    await getPrisma().$queryRaw`
      SELECT pgboss.job_table_run(
        $command$
          CREATE UNIQUE INDEX job_i3
          ON pgboss.job (name, COALESCE(singleton_key, ''))
          WHERE state = 'created' AND policy = 'stately'
        $command$,
        queue.table_name
      )::text
      FROM pgboss.queue AS queue
      WHERE queue.name = ${queueName}
    `;
    const before = await snapshotDedicatedQueueLayout(queueName);
    const queue = new PgBossQueue<
      Pick<KnowledgeJobPayloads, "document.ai-enrich">
    >({
      connectionString: process.env.DATABASE_URL!,
      queueNames: [queueName],
      workerConcurrency: 1,
    });

    try {
      await expect(queue.start()).rejects.toThrow(
        "Cannot safely upgrade dedicated document.ai-enrich queue; drain and recreate it with pg-boss using partition=true and policy=stately, then retry startup",
      );
      expect(await snapshotDedicatedQueueLayout(queueName)).toEqual(before);
    } finally {
      await queue.stop();
      await legacyBoss.stop();
      await getPrisma().$queryRaw`
        SELECT pgboss.delete_queue(${queueName})::text
      `;
    }
  });

  it("retains dedicated work through refusal, then starts after drain and supported recreate", async () => {
    const queueName = "document.ai-enrich";
    const legacyBoss = new PgBoss({
      connectionString: process.env.DATABASE_URL!,
      schema: "pgboss",
    });
    await legacyBoss.start();
    await legacyBoss.createQueue(queueName, {
      partition: true,
      policy: "standard",
    });
    const refusedQueue = new PgBossQueue<
      Pick<KnowledgeJobPayloads, "document.ai-enrich">
    >({
      connectionString: process.env.DATABASE_URL!,
      queueNames: [queueName],
      workerConcurrency: 1,
    });
    let retryQueue: PgBossQueue<
      Pick<KnowledgeJobPayloads, "document.ai-enrich">
    > | null = null;
    const payload = {
      projectId: randomUUID(),
      generationId: randomUUID(),
      documentId: randomUUID(),
      sourceCommitSha: "7".repeat(40),
      pathAtSha: "recreated-dedicated.md",
      configFingerprint: "8".repeat(64),
    };
    const retainedJobId = await legacyBoss.send(queueName, payload, {
      singletonKey: "9".repeat(64),
    });
    expect(retainedJobId).not.toBeNull();
    const beforeRefusal = await snapshotDedicatedQueueLayout(queueName);

    try {
      await expect(refusedQueue.start()).rejects.toThrow(
        "Cannot safely upgrade dedicated document.ai-enrich queue; drain and recreate it with pg-boss using partition=true and policy=stately, then retry startup",
      );
      expect(await snapshotDedicatedQueueLayout(queueName)).toEqual(
        beforeRefusal,
      );
      const [claimed] = await legacyBoss.fetch(queueName);
      expect(claimed?.id).toBe(retainedJobId);
      await expect(
        legacyBoss.complete(queueName, retainedJobId!),
      ).resolves.toMatchObject({ requested: 1, affected: 1 });
      const [drained] = await snapshotQueue(queueName);
      expect(drained).toMatchObject({
        id: retainedJobId,
        state: "completed",
        data: payload,
        jobPolicy: "standard",
      });

      await refusedQueue.stop();
      await legacyBoss.deleteQueue(queueName);
      await legacyBoss.createQueue(queueName, {
        partition: true,
        policy: "stately",
      });

      retryQueue = new PgBossQueue<
        Pick<KnowledgeJobPayloads, "document.ai-enrich">
      >({
        connectionString: process.env.DATABASE_URL!,
        queueNames: [queueName],
        workerConcurrency: 1,
      });
      await retryQueue.start();
      const ids = await Promise.all(
        Array.from({ length: 5 }, () => retryQueue!.send(queueName, payload)),
      );
      const [created] = await getPrisma().$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*)::bigint AS count
        FROM pgboss.job
        WHERE name = ${queueName}
          AND state = 'created'
      `;

      expect(ids.filter((id) => id !== null)).toHaveLength(1);
      expect(created?.count).toBe(1n);
    } finally {
      await refusedQueue.stop();
      if (retryQueue) await retryQueue.stop();
      await legacyBoss.deleteQueue(queueName).catch(() => undefined);
      await legacyBoss.stop();
    }
  });

  it("waits for an in-flight legacy send before refusing migration", async () => {
    const queueName = "document.ai-enrich";
    const payload = {
      projectId: randomUUID(),
      generationId: randomUUID(),
      documentId: randomUUID(),
      sourceCommitSha: "c".repeat(40),
      pathAtSha: "legacy-in-flight.md",
      configFingerprint: "d".repeat(64),
    };
    const singletonKey = "e".repeat(64);
    const legacyBoss = new PgBoss({
      connectionString: process.env.DATABASE_URL!,
      schema: "pgboss",
    });
    const legacyTransaction = new Client({
      connectionString: process.env.DATABASE_URL!,
    });
    await legacyBoss.start();
    await legacyBoss.createQueue(queueName, {
      policy: "standard",
      retryLimit: 2,
      retryDelay: 7,
      retryBackoff: false,
      expireInSeconds: 61,
    });
    await legacyTransaction.connect();
    await legacyTransaction.query("BEGIN");
    const { rows: backendRows } = await legacyTransaction.query<{
      backendPid: number;
    }>(`SELECT pg_backend_pid() AS "backendPid"`);
    const backendPid = backendRows[0]!.backendPid;
    const transactionDb: Db = {
      executeSql: (text, values) => legacyTransaction.query(text, values),
    };
    const legacyJobId = await legacyBoss.send(queueName, payload, {
      db: transactionDb,
      singletonKey,
    });
    expect(legacyJobId).not.toBeNull();
    const queue = new PgBossQueue<
      Pick<KnowledgeJobPayloads, "document.ai-enrich">
    >({
      connectionString: process.env.DATABASE_URL!,
      queueNames: [queueName],
      workerConcurrency: 1,
    });
    const startup = queue.start().then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );

    try {
      const beforeCommit = await Promise.race([
        startup.then(() => "settled" as const),
        waitForMigrationBlockedBy(backendPid).then(() => "blocked" as const),
      ]);
      await legacyTransaction.query("COMMIT");
      const outcome = await startup;
      const [persisted] = await getPrisma().$queryRaw<
        Array<{ policy: string; state: string; data: unknown }>
      >`
        SELECT policy, state, data
        FROM pgboss.job
        WHERE name = ${queueName}
          AND id = ${legacyJobId}::uuid
      `;

      expect(beforeCommit).toBe("blocked");
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.error).toEqual(
          expect.objectContaining({
            message:
              "Cannot migrate document.ai-enrich queue policy while work is active",
          }),
        );
      }
      expect(persisted).toEqual({
        policy: "standard",
        state: "created",
        data: payload,
      });
    } finally {
      await legacyTransaction.query("ROLLBACK").catch(() => undefined);
      await legacyTransaction.end();
      await startup;
      await queue.stop();
      await legacyBoss.stop();
      await getPrisma().$queryRaw`
        SELECT pgboss.delete_queue(${queueName})::text
      `;
    }
  });

  it("does not deadlock startup against a partition-first pg-boss insert", async () => {
    const queueName = "document.ai-enrich";
    const insertTransaction = new Client({
      connectionString: process.env.DATABASE_URL!,
    });
    await insertTransaction.connect();
    await insertTransaction.query("BEGIN");
    const { rows: backendRows } = await insertTransaction.query<{
      backendPid: number;
    }>(`SELECT pg_backend_pid() AS "backendPid"`);
    const backendPid = backendRows[0]!.backendPid;
    // pg-boss's cron insert locks its partition first, then reads the parent.
    await insertTransaction.query(
      "LOCK TABLE pgboss.job_common IN ROW EXCLUSIVE MODE",
    );
    const queue = new PgBossQueue<
      Pick<KnowledgeJobPayloads, "document.ai-enrich">
    >({
      connectionString: process.env.DATABASE_URL!,
      queueNames: [queueName],
      workerConcurrency: 1,
    });
    const startup = queue.start().then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );

    try {
      await waitForMigrationBlockedBy(backendPid);
      await insertTransaction.query("SET LOCAL lock_timeout = '3s'");
      // The blocked startup must not hold a parent lock that stalls this read.
      await expect(
        insertTransaction.query("SELECT 1 FROM ONLY pgboss.job LIMIT 1"),
      ).resolves.toBeDefined();
      await insertTransaction.query("COMMIT");
      expect(await startup).toEqual({ status: "fulfilled" });
    } finally {
      await insertTransaction.query("ROLLBACK").catch(() => undefined);
      await insertTransaction.end();
      await startup;
      await queue.stop();
    }
  });

  it("updates queued retry and expiry drift without refusing stately work", async () => {
    const name = "document.ai-enrich";
    const boss = new PgBoss({
      connectionString: process.env.DATABASE_URL!,
      schema: "pgboss",
    });
    const queue = new PgBossQueue<
      Pick<KnowledgeJobPayloads, "document.ai-enrich">
    >({
      connectionString: process.env.DATABASE_URL!,
      queueNames: [name],
      workerConcurrency: 1,
    });
    await boss.start();
    try {
      await boss.createQueue(name, {
        policy: "stately",
        retryLimit: 2,
        retryDelay: 7,
        retryBackoff: false,
        expireInSeconds: 61,
      });
      const id = await boss.send(
        name,
        { marker: "queued drift" },
        { singletonKey: randomUUID() },
      );
      await expect(queue.start()).resolves.toBeUndefined();
      expect(
        (await snapshotQueue(name)).find((row) => row.id === id),
      ).toMatchObject({
        jobPolicy: "stately",
        jobRetryLimit: 5,
        jobRetryDelay: 5,
        jobRetryBackoff: true,
        jobExpireInSeconds: KNOWLEDGE_ENRICHMENT_EXPIRE_IN_SECONDS,
      });
    } finally {
      await queue.stop();
      await boss.stop();
      await getPrisma().$queryRaw`SELECT pgboss.delete_queue(${name})::text`;
    }
  });

  it("refuses incompatible work left behind under a stately queue row", async () => {
    const queueName = "document.ai-enrich";
    const payload = {
      projectId: randomUUID(),
      generationId: randomUUID(),
      documentId: randomUUID(),
      sourceCommitSha: "1".repeat(40),
      pathAtSha: "legacy-mismatch.md",
      configFingerprint: "2".repeat(64),
    };
    const legacyBoss = new PgBoss({
      connectionString: process.env.DATABASE_URL!,
      schema: "pgboss",
    });
    await legacyBoss.start();
    await legacyBoss.createQueue(queueName, {
      policy: "standard",
      retryLimit: 2,
      retryDelay: 7,
      retryBackoff: false,
      expireInSeconds: 61,
    });
    const legacyJobId = await legacyBoss.send(queueName, payload, {
      singletonKey: "3".repeat(64),
    });
    await getPrisma().$executeRaw`
      UPDATE pgboss.queue
      SET policy = 'stately'
      WHERE name = ${queueName}
    `;
    const before = await snapshotQueue(queueName);
    const queue = new PgBossQueue<
      Pick<KnowledgeJobPayloads, "document.ai-enrich">
    >({
      connectionString: process.env.DATABASE_URL!,
      queueNames: [queueName],
      workerConcurrency: 1,
    });

    try {
      await expect(queue.start()).rejects.toThrow(
        "Cannot migrate document.ai-enrich queue policy while work is active",
      );
      expect(await snapshotQueue(queueName)).toEqual(before);
      expect(before).toEqual([
        expect.objectContaining({
          id: legacyJobId,
          queuePolicy: "stately",
          jobPolicy: "standard",
          state: "created",
          data: payload,
        }),
      ]);
    } finally {
      await queue.stop();
      await legacyBoss.stop();
      await getPrisma().$queryRaw`
        SELECT pgboss.delete_queue(${queueName})::text
      `;
    }
  });

  it("pins terminal legacy jobs before retry or resume can reenter the queue", async () => {
    const queueName = "document.ai-enrich";
    const failedPayload = { marker: "failed", value: randomUUID() };
    const cancelledPayload = { marker: "cancelled", value: randomUUID() };
    const legacyBoss = new PgBoss({
      connectionString: process.env.DATABASE_URL!,
      schema: "pgboss",
    });
    await legacyBoss.start();
    await legacyBoss.createQueue(queueName, {
      policy: "standard",
      retryLimit: 2,
      retryDelay: 7,
      retryBackoff: false,
      expireInSeconds: 61,
    });
    const failedJobId = await legacyBoss.send(queueName, failedPayload, {
      priority: 7,
      singletonKey: "4".repeat(64),
      retryLimit: 0,
      retryDelay: 17,
      retryBackoff: false,
      expireInSeconds: 71,
      retentionSeconds: 1_001,
      deleteAfterSeconds: 2_001,
    });
    const [claimed] = await legacyBoss.fetch(queueName);
    expect(claimed?.id).toBe(failedJobId);
    await expect(
      legacyBoss.fail(queueName, failedJobId!, {
        reason: "legacy provider failed",
      }),
    ).resolves.toMatchObject({ requested: 1, affected: 1 });
    const cancelledJobId = await legacyBoss.send(queueName, cancelledPayload, {
      priority: 8,
      singletonKey: "5".repeat(64),
      retryLimit: 4,
      retryDelay: 19,
      retryBackoff: false,
      expireInSeconds: 73,
      retentionSeconds: 1_003,
      deleteAfterSeconds: 2_003,
    });
    await expect(
      legacyBoss.cancel(queueName, cancelledJobId!),
    ).resolves.toMatchObject({ requested: 1, affected: 1 });
    const before = await snapshotQueue(queueName);
    const queue = new PgBossQueue<
      Record<string, { marker: string; value: string }>
    >({
      connectionString: process.env.DATABASE_URL!,
      queueNames: [queueName],
      workerConcurrency: 1,
    });

    try {
      await queue.start();
      const afterMigration = await snapshotQueue(queueName);
      expect(before).toEqual([
        expect.objectContaining({
          id: failedJobId,
          state: "failed",
          data: failedPayload,
          jobPolicy: "standard",
        }),
        expect.objectContaining({
          id: cancelledJobId,
          state: "cancelled",
          data: cancelledPayload,
          jobPolicy: "standard",
        }),
      ]);
      for (const beforeRow of before) {
        const migrated = afterMigration.find((row) => row.id === beforeRow.id);
        expect(migrated).toMatchObject({
          queuePolicy: "stately",
          queueRetryLimit: 5,
          queueRetryDelay: 5,
          queueRetryBackoff: true,
          queueExpireInSeconds: KNOWLEDGE_ENRICHMENT_EXPIRE_IN_SECONDS,
          jobPolicy: "stately",
          jobRetryLimit: 5,
          jobRetryDelay: 5,
          jobRetryBackoff: true,
          jobExpireInSeconds: KNOWLEDGE_ENRICHMENT_EXPIRE_IN_SECONDS,
        });
        expect(withoutMigratedJobFields(migrated!.jobSnapshot!)).toEqual(
          withoutMigratedJobFields(beforeRow.jobSnapshot!),
        );
      }

      await expect(
        legacyBoss.retry(queueName, failedJobId!),
      ).resolves.toMatchObject({ requested: 1, affected: 1 });
      await expect(
        legacyBoss.resume(queueName, cancelledJobId!),
      ).resolves.toMatchObject({ requested: 1, affected: 1 });
      const reentered = new Map(
        (await snapshotQueue(queueName)).map((row) => [row.id, row]),
      );
      expect(reentered.get(failedJobId)).toMatchObject({
        state: "retry",
        jobPolicy: "stately",
        jobRetryLimit: 6,
        jobRetryDelay: 5,
        jobRetryBackoff: true,
        jobExpireInSeconds: KNOWLEDGE_ENRICHMENT_EXPIRE_IN_SECONDS,
      });
      expect(reentered.get(cancelledJobId)).toMatchObject({
        state: "created",
        jobPolicy: "stately",
        jobRetryLimit: 5,
        jobRetryDelay: 5,
        jobRetryBackoff: true,
        jobExpireInSeconds: KNOWLEDGE_ENRICHMENT_EXPIRE_IN_SECONDS,
      });
    } finally {
      await queue.stop();
      await legacyBoss.stop();
      await getPrisma().$queryRaw`
        SELECT pgboss.delete_queue(${queueName})::text
      `;
    }
  });

  it("preserves refused work until completion, then migrates only the enrichment queue", async () => {
    const queueName = "document.ai-enrich";
    const otherQueueName = `knowledge-other-${randomUUID()}`;
    const payload = {
      projectId: randomUUID(),
      generationId: randomUUID(),
      documentId: randomUUID(),
      sourceCommitSha: "f".repeat(40),
      pathAtSha: "legacy-active.md",
      configFingerprint: "a".repeat(64),
    };
    const singletonKey = "b".repeat(64);
    const legacyBoss = new PgBoss({
      connectionString: process.env.DATABASE_URL!,
      schema: "pgboss",
    });
    await legacyBoss.start();
    await legacyBoss.createQueue(queueName, {
      policy: "standard",
      retryLimit: 2,
      retryDelay: 7,
      retryBackoff: false,
      expireInSeconds: 61,
    });
    await legacyBoss.createQueue(otherQueueName, {
      policy: "short",
      retryLimit: 9,
      retryDelay: 13,
      retryBackoff: false,
      expireInSeconds: 121,
    });
    const legacyJobId = await legacyBoss.send(queueName, payload, {
      singletonKey,
      retryLimit: 3,
      retryDelay: 11,
      retryBackoff: false,
      expireInSeconds: 77,
    });
    const otherPayload = { marker: randomUUID() };
    const otherJobId = await legacyBoss.send(otherQueueName, otherPayload);
    expect(legacyJobId).not.toBeNull();
    expect(otherJobId).not.toBeNull();
    const queue = new PgBossQueue<
      Pick<KnowledgeJobPayloads, "document.ai-enrich">
    >({
      connectionString: process.env.DATABASE_URL!,
      queueNames: [queueName],
      workerConcurrency: 1,
    });
    let retryQueue: PgBossQueue<
      Pick<KnowledgeJobPayloads, "document.ai-enrich">
    > | null = null;

    const enrichmentBefore = await snapshotQueue(queueName);
    const otherBefore = await snapshotQueue(otherQueueName);

    try {
      await expect(queue.start()).rejects.toThrow(
        "Cannot migrate document.ai-enrich queue policy while work is active",
      );
      expect(await snapshotQueue(queueName)).toEqual(enrichmentBefore);
      expect(await snapshotQueue(otherQueueName)).toEqual(otherBefore);

      const [claimed] = await legacyBoss.fetch(queueName);
      expect(claimed?.id).toBe(legacyJobId);
      await expect(
        legacyBoss.complete(queueName, legacyJobId!),
      ).resolves.toMatchObject({ requested: 1, affected: 1 });
      const [completed] = await snapshotQueue(queueName);
      expect(completed).toMatchObject({
        id: legacyJobId,
        state: "completed",
        data: payload,
        singletonKey,
        jobPolicy: "standard",
        jobRetryLimit: 3,
        jobRetryDelay: 11,
        jobRetryBackoff: false,
        jobExpireInSeconds: 77,
      });

      await queue.stop();
      retryQueue = new PgBossQueue<
        Pick<KnowledgeJobPayloads, "document.ai-enrich">
      >({
        connectionString: process.env.DATABASE_URL!,
        queueNames: [queueName],
        workerConcurrency: 1,
      });
      await retryQueue.start();
      const ids = await Promise.all(
        Array.from({ length: 5 }, () => retryQueue!.send(queueName, payload)),
      );
      const rowsAfterMigration = await snapshotQueue(queueName);
      const migratedCompleted = rowsAfterMigration.find(
        (row) => row.id === legacyJobId,
      );

      expect(ids.filter((id) => id !== null)).toHaveLength(1);
      expect(rowsAfterMigration).toHaveLength(2);
      expect(withoutMigratedJobFields(migratedCompleted!.jobSnapshot!)).toEqual(
        withoutMigratedJobFields(completed!.jobSnapshot!),
      );
      expect(rowsAfterMigration).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: legacyJobId,
            state: "completed",
            data: payload,
            singletonKey,
            jobPolicy: "stately",
            jobRetryLimit: 5,
            jobRetryDelay: 5,
            jobRetryBackoff: true,
            jobExpireInSeconds: KNOWLEDGE_ENRICHMENT_EXPIRE_IN_SECONDS,
          }),
          expect.objectContaining({
            state: "created",
            data: payload,
            jobPolicy: "stately",
            jobRetryLimit: 5,
            jobRetryDelay: 5,
            jobRetryBackoff: true,
            jobExpireInSeconds: KNOWLEDGE_ENRICHMENT_EXPIRE_IN_SECONDS,
          }),
        ]),
      );
      for (const row of rowsAfterMigration) {
        expect(row).toMatchObject({
          queuePolicy: "stately",
          queueRetryLimit: 5,
          queueRetryDelay: 5,
          queueRetryBackoff: true,
          queueExpireInSeconds: KNOWLEDGE_ENRICHMENT_EXPIRE_IN_SECONDS,
        });
      }
      expect(await snapshotQueue(otherQueueName)).toEqual(otherBefore);
    } finally {
      await queue.stop();
      if (retryQueue) await retryQueue.stop();
      await legacyBoss.stop();
      await getPrisma().$queryRaw`
        SELECT pgboss.delete_queue(${queueName})::text
      `;
      await getPrisma().$queryRaw`
        SELECT pgboss.delete_queue(${otherQueueName})::text
      `;
    }
  });

  it("schedules system reconciliation with an empty payload", async () => {
    const queueName = "system.reconcile";
    const queue = new PgBossQueue({
      connectionString: process.env.DATABASE_URL!,
      queueNames: [queueName],
      workerConcurrency: 1,
    });
    let scheduledData: unknown;

    try {
      await queue.start();
      await queue.schedule(queueName, "0 3 * * *");
      const [schedule] = await getPrisma().$queryRaw<Array<{ data: unknown }>>`
        SELECT data
        FROM pgboss.schedule
        WHERE name = ${queueName}
      `;
      scheduledData = schedule?.data;
    } finally {
      await queue.stop();
      await getPrisma().$queryRaw`
        SELECT pgboss.delete_queue(${queueName})::text
      `;
    }

    expect(scheduledData).toEqual({});
  });

  it("registers every concrete handler and blocks AI work when configuration is disabled", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const db = getPrisma();
    const project = await makeProject("Knowledge handler wiring");
    const documentId = randomUUID();
    const sourceCommitSha = "a".repeat(40);
    const now = new Date();
    await db.document.create({
      data: {
        id: documentId,
        projectId: project.id,
        path: "handler.md",
        slug: "handler",
        title: "Handler",
        excerpt: "Handler source",
        headCommitSha: sourceCommitSha,
        lastEditedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
    const generation = await db.knowledgeGeneration.create({
      data: {
        projectId: project.id,
        configFingerprint: "handler-config",
        embeddingModel: "handler-embedding",
        embeddingDimensions: 1536,
        extractionSchemaVersion: 1,
        promptVersion: "prompt-v1",
      },
    });
    await db.knowledgeGenerationDocument.create({
      data: {
        generationId: generation.id,
        projectId: project.id,
        documentId,
        targetSha: sourceCommitSha,
        configFingerprint: generation.configFingerprint,
      },
    });
    const queue = new CapturingWorkerQueue();
    const config = parseKnowledgeConfig({
      WEAVER_JOBS_ENABLED: "true",
      WEAVER_KNOWLEDGE_RECONCILE_CRON: "0 3 * * *",
      WEAVER_ASSISTANT_RECONCILE_CRON: "*/2 * * * *",
    });

    await registerKnowledgeJobHandlers({
      queue,
      context: knowledgeSystemContextForTests(),
      db,
      config,
      routing: noKnowledgeRouting,
      // Mirrors the worker, which injects all four; a stage whose runner is
      // missing is deliberately left unregistered for another worker to claim.
      ingestionParseRunner: async () => undefined,
      ingestionAnalyzeRunner: async () => undefined,
      ingestionLinkRunner: async () => undefined,
      artifactNotebookRunner: async () => undefined,
    });

    expect([...queue.handlers.keys()].sort()).toEqual(
      [...KNOWLEDGE_JOB_NAMES].sort(),
    );
    expect(queue.schedules).toEqual([
      { name: "project.git-sync", cron: "* * * * *" },
      { name: "system.reconcile", cron: "0 3 * * *" },
      { name: "assistant.reconcile", cron: "*/2 * * * *" },
      { name: "task.tick", cron: "* * * * *" },
      { name: "exam.tick", cron: "* * * * *" },
    ]);
    await expect(
      queue.run("document.ai-enrich", {
        projectId: project.id,
        generationId: generation.id,
        documentId,
        sourceCommitSha,
        pathAtSha: "handler.md",
        configFingerprint: generation.configFingerprint,
      }),
    ).resolves.toBeUndefined();
    expect(
      await db.knowledgeGenerationDocument.findUnique({
        where: {
          generationId_documentId: {
            generationId: generation.id,
            documentId,
          },
        },
        select: {
          status: true,
          failureKind: true,
          failureSummary: true,
        },
      }),
    ).toEqual({
      status: "blocked_configuration",
      failureKind: "configuration",
      failureSummary: "AI configuration is unavailable",
    });
  });

  it("preserves exact controlled generation states through search-sync replay", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("WEAVER_JOBS_ENABLED", "true");
    const jobQueue = new FakeJobQueue();
    setJobQueueForTests(jobQueue);
    const editor = await makeUser("User", "search-sync-state-matrix");
    const project = await makeProject("Search sync state matrix");
    await addMembership(project.id, editor.id, "Editor");
    const caller = callerFor(editor);
    const titles = [
      "Ready",
      "Processing",
      "Controlled Failure",
      "Blocked",
      "Retryable Failure",
      "Expired Processing",
      "Missing",
      "Incomplete Ready",
    ];
    const documents: Array<{
      id: string;
      headCommitSha: string;
      path: string;
    }> = [];
    for (const title of titles) {
      documents.push(
        await caller.document.create({
          projectId: project.id,
          folderPath: [],
          title,
          contentJson: parseDocumentBody(
            `# ${title}\n\nExact replay source.\n`,
          ),
        }),
      );
    }
    const workerQueue = new CapturingWorkerQueue();
    const config = parseKnowledgeConfig({
      WEAVER_JOBS_ENABLED: "true",
    });
    const db = getPrisma();
    await registerKnowledgeJobHandlers({
      queue: workerQueue,
      context: knowledgeSystemContextForTests(),
      db,
      config,
      routing: noKnowledgeRouting,
    });
    for (const document of documents) {
      await workerQueue.run("document.search-sync", {
        projectId: project.id,
        documentId: document.id,
        sourceCommitSha: document.headCommitSha,
        pathAtSha: document.path,
      });
    }
    const generation = await db.knowledgeGeneration.create({
      data: {
        projectId: project.id,
        configFingerprint: "search-sync-state-matrix",
        embeddingModel: "embedding-model",
        embeddingDimensions: 1536,
        extractionSchemaVersion: 1,
        promptVersion: "prompt-v1",
        status: "active",
      },
    });
    const now = new Date();
    const oldAttempt = new Date(
      now.getTime() - (KNOWLEDGE_ENRICHMENT_EXPIRE_IN_SECONDS + 60) * 1_000,
    );
    await db.knowledgeGenerationDocument.createMany({
      data: documents.map((document, index) => ({
        generationId: generation.id,
        documentId: document.id,
        projectId: project.id,
        targetSha: document.headCommitSha,
        semanticIndexedSha: [0, 7].includes(index)
          ? document.headCommitSha
          : null,
        graphIndexedSha: index === 0 ? document.headCommitSha : null,
        configFingerprint: generation.configFingerprint,
        status: [
          "ready",
          "processing",
          "failed",
          "blocked_configuration",
          "failed",
          "processing",
          "missing",
          "ready",
        ][index] as
          | "ready"
          | "processing"
          | "failed"
          | "blocked_configuration"
          | "missing",
        attempts: [1, 2, 1, 1, 1, 2, 1, 1][index],
        failureKind: [
          null,
          null,
          "validation",
          "configuration",
          "provider",
          null,
          "source_missing",
          null,
        ][index] as
          "validation" | "configuration" | "provider" | "source_missing" | null,
        failureSummary: [
          null,
          null,
          "Controlled validation",
          "AI configuration is unavailable",
          "Provider unavailable",
          null,
          "Source document is no longer live",
          null,
        ][index],
        lastAttemptAt: index === 1 ? now : index === 5 ? oldAttempt : null,
        completedAt: [0, 2, 3, 6].includes(index) ? now : null,
      })),
    });
    jobQueue.jobs.length = 0;

    for (const document of documents) {
      await workerQueue.run("document.search-sync", {
        projectId: project.id,
        documentId: document.id,
        sourceCommitSha: document.headCommitSha,
        pathAtSha: document.path,
      });
    }

    const states = await db.knowledgeGenerationDocument.findMany({
      where: { generationId: generation.id },
      select: {
        documentId: true,
        status: true,
        attempts: true,
        failureKind: true,
        failureSummary: true,
      },
    });
    const stateByDocument = new Map(
      states.map((state) => [state.documentId, state]),
    );
    expect(stateByDocument.get(documents[0]!.id)).toMatchObject({
      status: "ready",
      attempts: 1,
      failureKind: null,
    });
    expect(stateByDocument.get(documents[1]!.id)).toMatchObject({
      status: "processing",
      attempts: 2,
      failureKind: null,
    });
    expect(stateByDocument.get(documents[2]!.id)).toMatchObject({
      status: "failed",
      attempts: 1,
      failureKind: "validation",
      failureSummary: "Controlled validation",
    });
    expect(stateByDocument.get(documents[3]!.id)).toMatchObject({
      status: "blocked_configuration",
      attempts: 1,
      failureKind: "configuration",
      failureSummary: "AI configuration is unavailable",
    });
    for (const document of documents.slice(4)) {
      expect(stateByDocument.get(document.id)).toMatchObject({
        status: "pending",
        failureKind: null,
        failureSummary: null,
      });
    }
    expect(
      jobQueue.jobs
        .flatMap((job) =>
          job.name === "document.ai-enrich" ? [job.data.documentId] : [],
        )
        .sort(),
    ).toEqual(
      documents
        .slice(4)
        .map((document) => document.id)
        .sort(),
    );
  });
});

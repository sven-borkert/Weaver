import { createHash } from "node:crypto";
import { Client } from "pg";
import { PgBoss } from "pg-boss";
import {
  knowledgeJobSendOptions,
  knowledgeJobExpireInSeconds,
  knowledgeJobWorkerConcurrency,
  type JobSendOptions,
  type KnowledgeJobPayloads,
  type ScheduledJobName,
} from "./types";
import type { JobExecution } from "./queue";
import { captureError } from "../diagnostics/writer";

type JobPayloadMap = Record<string, object>;
type JobName<Payloads extends JobPayloadMap> = Extract<keyof Payloads, string>;

export type PgBossQueueOptions<Payloads extends JobPayloadMap> = {
  connectionString: string;
  queueNames: readonly JobName<Payloads>[];
  workerConcurrency: number;
  mode?: "worker" | "publisher";
};

const baseQueueOptions = {
  retryLimit: 5,
  retryDelay: 5,
  retryBackoff: true,
  deleteAfterSeconds: 7 * 24 * 60 * 60,
} as const;

export function queueOptions(name: string) {
  return {
    ...baseQueueOptions,
    ...([
      "project.reconcile",
      "document.search-sync",
      "content.delete",
      "document.change-summary",
      "task.run",
      "wiki.run",
      "artifact.notebook.prepare",
      "ingestion.parse",
      "ingestion.analyze",
      "ingestion.link",
    ].includes(name)
      ? { policy: "short" as const }
      : {}),
    // Weaver persists the retry schedule for these jobs.
    ...([
      "assistant.run",
      "task.run",
      "wiki.run",
      "project.git-push",
      "project.git-pull",
      "system.reconcile",
    ].includes(name)
      ? { retryLimit: 0 }
      : {}),
    ...(name === "document.change-summary"
      ? { retryLimit: 2, retryDelay: 30 }
      : {}),
    expireInSeconds: knowledgeJobExpireInSeconds(name),
  };
}

export class PgBossQueue<
  Payloads extends JobPayloadMap = KnowledgeJobPayloads,
> {
  readonly #boss: PgBoss;
  readonly #connectionString: string;
  readonly #queueNames: readonly JobName<Payloads>[];
  readonly #workerConcurrency: number;
  readonly #mode: "worker" | "publisher";

  constructor(options: PgBossQueueOptions<Payloads>) {
    this.#connectionString = options.connectionString;
    this.#mode = options.mode ?? "worker";
    this.#boss = new PgBoss({
      connectionString: options.connectionString,
      schema: "pgboss",
      max: this.#mode === "publisher" ? 2 : 4,
      // Send-only publishers must not duplicate the worker's maintenance/cron loops.
      ...(this.#mode === "publisher"
        ? { supervise: false, schedule: false }
        : {}),
    });
    // pg-boss re-emits pool and maintenance failures as 'error'; unhandled, they crash the process.
    this.#boss.on("error", (error: unknown) => {
      const reference = captureError({
        event: "runtime.error",
        message: "pg-boss background error",
        error,
        details: { source: "pg-boss", mode: this.#mode },
      });
      console.error(`pg-boss background error (ref ${reference ?? "none"})`);
    });
    this.#queueNames = options.queueNames;
    this.#workerConcurrency = options.workerConcurrency;
  }

  async start(): Promise<void> {
    await this.#boss.start();
    try {
      for (const name of this.#queueNames) {
        await this.#boss.createQueue(name, {
          ...queueOptions(name),
          ...(name === "document.ai-enrich" ? { policy: "stately" } : {}),
        });
        if (
          [
            "project.reconcile",
            "document.search-sync",
            "content.delete",
            "document.change-summary",
            "task.run",
            "wiki.run",
            "artifact.notebook.prepare",
            "ingestion.parse",
            "ingestion.analyze",
            "ingestion.link",
          ].includes(name)
        )
          await this.#boss
            .getDb()
            .executeSql(
              "UPDATE pgboss.queue SET policy = 'short' WHERE name = $1",
              [name],
            );
        // createQueue never updates existing retry or retention settings.
        if (this.#mode === "worker" && name !== "document.ai-enrich") {
          const mutableOptions = { ...queueOptions(name) };
          delete mutableOptions.policy;
          await this.#boss.updateQueue(name, mutableOptions);
        }
        if (name === "document.ai-enrich" && this.#mode === "worker") {
          await this.#ensureEnrichmentQueueConfiguration(name);
          await this.#boss.updateQueue(name, queueOptions(name));
        }
      }
    } catch (error) {
      // pg-boss never stops itself; a half-started boss leaks its pool and timers.
      await this.#boss.stop().catch(() => undefined);
      throw error;
    }
  }

  async isHealthy(): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.#boss
          .getDb()
          .executeSql("SELECT 1", [])
          .then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), 2000);
        }),
      ]);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async send<N extends JobName<Payloads>>(
    name: N,
    data: Payloads[N],
    options?: JobSendOptions,
  ): Promise<string | null> {
    return this.#boss.send(
      name,
      data,
      options ?? knowledgeJobSendOptions(name, data),
    );
  }

  async work<N extends JobName<Payloads>>(
    name: N,
    handler: (data: Payloads[N], execution: JobExecution) => Promise<void>,
  ): Promise<void> {
    const workOptions = {
      batchSize: 1,
      includeMetadata: true,
      localConcurrency: knowledgeJobWorkerConcurrency(
        name,
        this.#workerConcurrency,
      ),
    } as const;
    await this.#boss.work<Payloads[N], void, typeof workOptions>(
      name,
      workOptions,
      async ([job]) => {
        if (!job) throw new Error(`pg-boss returned an empty ${name} batch`);
        await handler(job.data, {
          jobId: job.id,
          retryCount:
            typeof job.retryCount === "number" ? job.retryCount : null,
          signal: job.signal,
        });
      },
    );
  }

  async schedule(name: ScheduledJobName, cron: string): Promise<void> {
    await this.#boss.schedule(name, cron, {});
  }

  async unschedule(name: ScheduledJobName): Promise<void> {
    await this.#boss.unschedule(name);
  }

  async stop(): Promise<void> {
    await this.#boss.stop();
  }

  async #ensureEnrichmentQueueConfiguration(name: string): Promise<void> {
    const client = new Client({ connectionString: this.#connectionString });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL search_path = pg_catalog");
      await client.query("SET LOCAL quote_all_identifiers = off");
      // EXCLUSIVE, not ACCESS EXCLUSIVE: a pg-boss insert locks its partition
      // first and only then reads the parent, so a parent lock that blocks
      // that read deadlocks against the cron scheduler at startup.
      await client.query("LOCK TABLE ONLY pgboss.job IN EXCLUSIVE MODE");
      const tableNameResult = await client.query<{ tableName: string }>(
        `SELECT table_name AS "tableName" FROM pgboss.queue WHERE name = $1`,
        [name],
      );
      const tableName = tableNameResult.rows[0]?.tableName;
      if (!tableName) throw new Error(`Knowledge queue ${name} is missing`);
      if (!/^[a-z_][a-z0-9_]*$/.test(tableName)) {
        throw new Error(`Knowledge queue ${name} has an unexpected table name`);
      }
      // Parent then partition, the order DDL uses. This waits for in-flight
      // sends and must precede the row lock: a send commits through a deferred
      // foreign-key check on this queue row.
      await client.query(
        `LOCK TABLE pgboss.${client.escapeIdentifier(tableName)} IN ACCESS EXCLUSIVE MODE`,
      );
      const configurationResult = await client.query<{
        policy: string;
        partition: boolean;
        tableName: string;
      }>(
        `SELECT policy,
                partition,
                table_name AS "tableName"
         FROM pgboss.queue
         WHERE name = $1
         FOR UPDATE`,
        [name],
      );
      const configuration = configurationResult.rows[0];
      if (!configuration) throw new Error(`Knowledge queue ${name} is missing`);
      if (configuration.tableName !== tableName) {
        throw new Error(
          `Knowledge queue ${name} was recreated during startup; retry startup`,
        );
      }
      if (configuration.partition) {
        const expectedTableName = `j${createHash("sha224")
          .update(name, "utf8")
          .digest("hex")}`;
        const enforcementIndexResult = await client.query<{
          has_enforcement_index: boolean;
        }>(
          `SELECT EXISTS (
             SELECT 1
             FROM pg_catalog.pg_namespace AS table_namespace
             JOIN pg_catalog.pg_class AS job_table
               ON job_table.relnamespace = table_namespace.oid
             JOIN pg_catalog.pg_inherits AS inheritance
               ON inheritance.inhrelid = job_table.oid
             JOIN pg_catalog.pg_class AS parent_table
               ON parent_table.oid = inheritance.inhparent
             JOIN pg_catalog.pg_namespace AS parent_namespace
               ON parent_namespace.oid = parent_table.relnamespace
             JOIN pg_catalog.pg_partitioned_table AS partitioned_parent
               ON partitioned_parent.partrelid = parent_table.oid
             JOIN pg_catalog.pg_attribute AS parent_name_attribute
               ON parent_name_attribute.attrelid = parent_table.oid
              AND parent_name_attribute.attname = 'name'
              AND parent_name_attribute.attnum > 0
              AND NOT parent_name_attribute.attisdropped
             JOIN pg_catalog.pg_attribute AS name_attribute
               ON name_attribute.attrelid = job_table.oid
              AND name_attribute.attname = 'name'
              AND name_attribute.attnum > 0
              AND NOT name_attribute.attisdropped
             JOIN pg_catalog.pg_attribute AS state_attribute
               ON state_attribute.attrelid = job_table.oid
              AND state_attribute.attname = 'state'
              AND state_attribute.attnum > 0
              AND NOT state_attribute.attisdropped
             JOIN pg_catalog.pg_attribute AS singleton_key_attribute
               ON singleton_key_attribute.attrelid = job_table.oid
              AND singleton_key_attribute.attname = 'singleton_key'
              AND singleton_key_attribute.attnum > 0
              AND NOT singleton_key_attribute.attisdropped
             JOIN pg_catalog.pg_index AS enforcement_index
               ON enforcement_index.indrelid = job_table.oid
             JOIN pg_catalog.pg_class AS index_relation
               ON index_relation.oid = enforcement_index.indexrelid
             JOIN pg_catalog.pg_namespace AS index_namespace
               ON index_namespace.oid = index_relation.relnamespace
             JOIN pg_catalog.pg_am AS index_method
               ON index_method.oid = index_relation.relam
             JOIN pg_catalog.pg_namespace AS opclass_namespace
               ON opclass_namespace.nspname = 'pg_catalog'
             JOIN pg_catalog.pg_type AS text_type
               ON text_type.typnamespace = opclass_namespace.oid
              AND text_type.typname = 'text'
             JOIN pg_catalog.pg_type AS anyenum_type
               ON anyenum_type.typnamespace = opclass_namespace.oid
              AND anyenum_type.typname = 'anyenum'
             JOIN pg_catalog.pg_opclass AS text_opclass
               ON text_opclass.opcnamespace = opclass_namespace.oid
              AND text_opclass.opcname = 'text_ops'
              AND text_opclass.opcmethod = index_method.oid
              AND text_opclass.opcintype = text_type.oid
              AND text_opclass.opcdefault
             JOIN pg_catalog.pg_opclass AS enum_opclass
               ON enum_opclass.opcnamespace = opclass_namespace.oid
              AND enum_opclass.opcname = 'enum_ops'
              AND enum_opclass.opcmethod = index_method.oid
              AND enum_opclass.opcintype = anyenum_type.oid
              AND enum_opclass.opcdefault
             WHERE table_namespace.nspname = $1
               AND job_table.relname = $2
               AND job_table.relkind = 'r'
               AND job_table.relispartition
               AND parent_namespace.nspname = $1
               AND parent_table.relname = $3
               AND parent_table.relkind = 'p'
               AND inheritance.inhseqno = 1
               AND NOT inheritance.inhdetachpending
               AND partitioned_parent.partstrat = 'l'
               AND partitioned_parent.partnatts = 1
               AND partitioned_parent.partexprs IS NULL
               AND ARRAY(
                     SELECT partition_attnum
                     FROM pg_catalog.unnest(
                       partitioned_parent.partattrs
                     ) AS partition_attnum
                   ) = ARRAY[parent_name_attribute.attnum]::smallint[]
               AND pg_catalog.pg_get_expr(
                     job_table.relpartbound,
                     job_table.oid,
                     false
                   ) = $6
               AND index_namespace.nspname = $1
               AND index_relation.relname = $4
               AND index_relation.relkind = 'i'
               AND NOT index_relation.relispartition
               AND index_relation.reloptions IS NULL
               AND index_method.amname = $5
               AND enforcement_index.indisunique
               AND NOT enforcement_index.indnullsnotdistinct
               AND enforcement_index.indisvalid
               AND enforcement_index.indisready
               AND enforcement_index.indislive
               AND enforcement_index.indimmediate
               AND NOT enforcement_index.indisprimary
               AND NOT enforcement_index.indisexclusion
               AND enforcement_index.indnkeyatts = 3
               AND enforcement_index.indnatts = 3
               AND ARRAY(
                     SELECT key_attnum
                     FROM pg_catalog.unnest(
                       enforcement_index.indkey
                     ) AS key_attnum
                   ) = ARRAY[
                     name_attribute.attnum,
                     state_attribute.attnum,
                     0::smallint
                   ]::smallint[]
               AND ARRAY(
                     SELECT index_opclass_oid
                     FROM pg_catalog.unnest(
                       enforcement_index.indclass
                     ) AS index_opclass_oid
                   ) = ARRAY[
                     text_opclass.oid,
                     enum_opclass.oid,
                     text_opclass.oid
                   ]::oid[]
               AND ARRAY(
                     SELECT index_collation_oid
                     FROM pg_catalog.unnest(
                       enforcement_index.indcollation
                     ) AS index_collation_oid
                   ) = ARRAY[
                     name_attribute.attcollation,
                     0::oid,
                     singleton_key_attribute.attcollation
                   ]::oid[]
               AND ARRAY(
                     SELECT index_option
                     FROM pg_catalog.unnest(
                       enforcement_index.indoption
                     ) AS index_option
                   ) = ARRAY[0, 0, 0]::smallint[]
               AND pg_catalog.pg_get_expr(
                     enforcement_index.indexprs,
                     enforcement_index.indrelid,
                     false
                   ) = $7
               AND pg_catalog.pg_get_expr(
                     enforcement_index.indpred,
                     enforcement_index.indrelid,
                     false
                   ) = $8
           ) AS has_enforcement_index`,
          [
            "pgboss",
            expectedTableName,
            "job",
            `${expectedTableName}_i3`,
            "btree",
            `FOR VALUES IN ('${name}')`,
            "COALESCE(singleton_key, ''::text)",
            "((state <= 'active'::pgboss.job_state) AND (policy = 'stately'::text))",
          ],
        );
        if (
          configuration.policy !== "stately" ||
          configuration.tableName !== expectedTableName ||
          !enforcementIndexResult.rows[0]?.has_enforcement_index
        ) {
          throw new Error(
            `Cannot safely upgrade dedicated ${name} queue; drain and recreate it with pg-boss using partition=true and policy=stately, then retry startup`,
          );
        }
      }
      const expectedQueueOptions = queueOptions(name);
      const migrationParameters = [
        name,
        "stately",
        expectedQueueOptions.retryLimit,
        expectedQueueOptions.retryDelay,
        expectedQueueOptions.retryBackoff,
        expectedQueueOptions.expireInSeconds,
      ];
      const activeResult = await client.query<{ has_incompatible: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM pgboss.job
           WHERE name = $1
             AND state IN ('created', 'retry', 'active')
             AND policy IS DISTINCT FROM $2
         ) AS has_incompatible`,
        migrationParameters.slice(0, 2),
      );
      if (activeResult.rows[0]?.has_incompatible) {
        throw new Error(
          `Cannot migrate ${name} queue policy while work is active`,
        );
      }
      await client.query(
        `UPDATE pgboss.job
         SET policy = $2,
             retry_limit = $3,
             retry_delay = $4,
             retry_backoff = $5,
             expire_seconds = $6
         WHERE name = $1
           AND state IN ('created', 'retry', 'completed', 'failed', 'cancelled')
           AND (
             policy IS DISTINCT FROM $2
             OR retry_limit IS DISTINCT FROM $3
             OR retry_delay IS DISTINCT FROM $4
             OR retry_backoff IS DISTINCT FROM $5
             OR expire_seconds IS DISTINCT FROM $6
           )`,
        migrationParameters,
      );
      await client.query(
        `UPDATE pgboss.queue
         SET policy = $2,
             retry_limit = $3,
             retry_delay = $4,
             retry_backoff = $5,
             expire_seconds = $6,
             updated_on = now()
         WHERE name = $1`,
        migrationParameters,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }
}

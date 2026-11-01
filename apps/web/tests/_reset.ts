import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertTestEnvironment } from "@weaver/config/testEnvironment";
import { Prisma, type PrismaClient } from "@weaver/db/client";

async function resetPgBoss(db: PrismaClient): Promise<void> {
  const [schema] = await db.$queryRaw<Array<{ namespace: string | null }>>`
    SELECT to_regnamespace('pgboss')::text AS namespace
  `;
  if (!schema?.namespace) return;

  const tables = await db.$queryRaw<Array<{ tableName: string }>>`
    SELECT tablename AS "tableName"
    FROM pg_tables
    WHERE schemaname = 'pgboss' AND tablename <> 'version'
    ORDER BY tablename
  `;
  if (tables.length === 0) return;

  const identifiers = tables
    .map(({ tableName }) => `"pgboss"."${tableName.replaceAll('"', '""')}"`)
    .join(", ");
  await db.$executeRawUnsafe(
    `TRUNCATE TABLE ${identifiers} RESTART IDENTITY CASCADE;`,
  );
  // Truncating pgboss.queue orphans dedicated partitions an interrupted run left
  // attached to pgboss.job; pg-boss would then fail to recreate those queues.
  const partitions = await db.$queryRaw<Array<{ tableName: string }>>`
    SELECT child.relname AS "tableName"
    FROM pg_catalog.pg_inherits AS inheritance
    JOIN pg_catalog.pg_class AS child ON child.oid = inheritance.inhrelid
    WHERE inheritance.inhparent = 'pgboss.job'::regclass
      AND child.relname <> 'job_common'
    ORDER BY child.relname
  `;
  for (const { tableName } of partitions) {
    await db.$executeRawUnsafe(
      `DROP TABLE IF EXISTS "pgboss"."${tableName.replaceAll('"', '""')}";`,
    );
  }
}

export async function resetTestState(
  db: PrismaClient,
  suite: "integration" | "e2e",
) {
  const dataDir = assertTestEnvironment(
    process.env,
    suite,
    fileURLToPath(new URL("../../../", import.meta.url)),
  );
  await resetPgBoss(db);
  const tables = Object.values(Prisma.ModelName)
    .map((name) => `"${name}"`)
    .join(", ");
  await db.$executeRawUnsafe(
    `TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE;`,
  );
  await Promise.all(
    ["git", "files", "notebooks"].map((entry) =>
      rm(path.join(dataDir, entry), { recursive: true, force: true }),
    ),
  );
}

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import {
  acquireOAuthCutoverBarrier,
  assertOAuthCutoverQuiescent,
  inspectOAuthCutoverState,
  waitForOAuthCutoverMigrator,
  type MigrationSqlClient,
} from "../src/oauthCutoverBarrier";

const packageRoot = path.dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);

type ChildExit = { code: number; signal: NodeJS.Signals | null };

function startPrismaMigration(
  databaseUrl: string,
  applicationName?: string,
): {
  child: ChildProcess;
  exit: Promise<ChildExit>;
  hasExited: () => boolean;
} {
  const childUrl = new URL(databaseUrl);
  if (applicationName) {
    childUrl.searchParams.set("application_name", applicationName);
  }
  let exited = false;
  const child = spawn(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    ["exec", "prisma", "migrate", "deploy", "--config", "prisma.config.ts"],
    {
      cwd: packageRoot,
      env: { ...process.env, DATABASE_URL: childUrl.href },
      stdio: "inherit",
    },
  );
  const exit = new Promise<ChildExit>((resolve, reject) => {
    child.once("error", (error) => {
      exited = true;
      reject(error);
    });
    child.once("exit", (code, signal) => {
      exited = true;
      resolve({ code: code ?? 1, signal });
    });
  });
  return { child, exit, hasExited: () => exited };
}

async function stopChild(child: ChildProcess, exit: Promise<ChildExit>) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
  }
  await exit.catch(() => undefined);
}

async function deploy(databaseUrl: string): Promise<number> {
  const barrierName = `weaver-oauth-cutover-barrier-${process.pid}`;
  const barrier = new Client({
    connectionString: databaseUrl,
    application_name: barrierName,
  });
  await barrier.connect();
  const sql = barrier as unknown as MigrationSqlClient;
  let barrierOpen = false;
  let migration: ReturnType<typeof startPrismaMigration> | undefined;
  try {
    const state = await inspectOAuthCutoverState(sql);
    if (!state.needsBarrier) {
      return (await startPrismaMigration(databaseUrl).exit).code;
    }

    await acquireOAuthCutoverBarrier(sql, state.consentRelationOid);
    barrierOpen = true;
    process.stdout.write(
      "OAuth generation cutover barrier acquired; database is quiesced.\n",
    );

    const migratorName = `weaver-oauth-cutover-migrator-${randomUUID()}`;
    migration = startPrismaMigration(databaseUrl, migratorName);
    const handoff = await waitForOAuthCutoverMigrator(
      sql,
      state.consentRelationOid,
      migratorName,
      { hasExited: migration.hasExited, timeoutMs: migrationHandoffTimeoutMs },
    );
    if (handoff === "exited") {
      await barrier.query("ROLLBACK");
      barrierOpen = false;
      const result = await migration.exit;
      if (result.code !== 0) return result.code;
      const after = await inspectOAuthCutoverState(sql);
      if (after.needsBarrier) {
        throw new Error(
          "Prisma exited without applying the OAuth generation cutover",
        );
      }
      return 0;
    }

    await assertOAuthCutoverQuiescent(sql, migratorName);
    await barrier.query("COMMIT");
    barrierOpen = false;
    process.stdout.write(
      "OAuth generation cutover barrier handed to Prisma migrator.\n",
    );
    const result = await migration.exit;
    if (result.code !== 0) return result.code;
    const after = await inspectOAuthCutoverState(sql);
    if (after.needsBarrier) {
      throw new Error("OAuth generation cutover was not recorded as applied");
    }
    return 0;
  } catch (error) {
    if (migration) await stopChild(migration.child, migration.exit);
    throw error;
  } finally {
    if (barrierOpen) {
      await barrier.query("ROLLBACK").catch(() => undefined);
    }
    await barrier.end().catch(() => undefined);
  }
}

const migrationHandoffTimeoutMs = Number(
  process.env.WEAVER_MIGRATION_HANDOFF_TIMEOUT_MS ?? 600_000,
);
if (
  !Number.isSafeInteger(migrationHandoffTimeoutMs) ||
  migrationHandoffTimeoutMs < 30_000 ||
  migrationHandoffTimeoutMs > 3_600_000
)
  throw new Error("WEAVER_MIGRATION_HANDOFF_TIMEOUT_MS must be 30000..3600000");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
process.exitCode = await deploy(databaseUrl);

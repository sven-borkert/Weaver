import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { getPrisma } from "./_harness";

const CLEANUP = new URL(
  "../../../../packages/db/prisma/migrations/20261001160000_personal_external_mcp_cleanup/migration.sql",
  import.meta.url,
);

// Replays the cleanup in a scratch schema that still has the pre-migration column name.
it("keeps only inputs whose task owner created the connection and drops creator-less connections", async () => {
  const db = getPrisma();
  const schema = `mig_${randomUUID().replaceAll("-", "")}`;
  const statements = (await readFile(CLEANUP, "utf8"))
    .split(/;\s*$/m)
    .map((statement) => statement.trim())
    .filter((statement) => statement.replace(/^--.*$/gm, "").trim());
  const [userA, userB] = [randomUUID(), randomUUID()];
  const [connA, connNull] = [randomUUID(), randomUUID()];
  const [toolA, toolNull] = [randomUUID(), randomUUID()];
  const [taskA, taskB] = [randomUUID(), randomUUID()];
  const [keep, foreign, orphan] = [randomUUID(), randomUUID(), randomUUID()];
  try {
    const result = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      await tx.$executeRawUnsafe(
        `CREATE TABLE "ExternalMcpConnection" ("id" uuid PRIMARY KEY, "createdById" uuid)`,
      );
      await tx.$executeRawUnsafe(
        `CREATE TABLE "ExternalMcpTool" ("id" uuid PRIMARY KEY, "connectionId" uuid NOT NULL)`,
      );
      await tx.$executeRawUnsafe(
        `CREATE TABLE "ScheduledTask" ("id" uuid PRIMARY KEY, "ownerId" uuid NOT NULL)`,
      );
      await tx.$executeRawUnsafe(
        `CREATE TABLE "ScheduledTaskExternalInput" ("id" uuid PRIMARY KEY, "taskId" uuid NOT NULL, "toolId" uuid NOT NULL)`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "ExternalMcpConnection" VALUES ('${connA}', '${userA}'), ('${connNull}', NULL)`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "ExternalMcpTool" VALUES ('${toolA}', '${connA}'), ('${toolNull}', '${connNull}')`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "ScheduledTask" VALUES ('${taskA}', '${userA}'), ('${taskB}', '${userB}')`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "ScheduledTaskExternalInput" VALUES ('${keep}', '${taskA}', '${toolA}'), ('${foreign}', '${taskB}', '${toolA}'), ('${orphan}', '${taskA}', '${toolNull}')`,
      );
      for (const statement of statements) await tx.$executeRawUnsafe(statement);
      const inputs = await tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id"::text AS id FROM "ScheduledTaskExternalInput" ORDER BY "id"`,
      );
      const connections = await tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id"::text AS id FROM "ExternalMcpConnection" ORDER BY "id"`,
      );
      return { inputs, connections };
    });
    expect(result.inputs.map((row) => row.id)).toEqual([keep]);
    expect(result.connections.map((row) => row.id)).toEqual([connA]);
  } finally {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
});

const BACKFILL = new URL(
  "../../../../packages/db/prisma/migrations/20261001160600_external_mcp_backfill_suggested_effect/migration.sql",
  import.meta.url,
);

it("back-fills the suggested effect only for unreviewed tools without one", async () => {
  const db = getPrisma();
  const schema = `mig_${randomUUID().replaceAll("-", "")}`;
  const sql = await readFile(BACKFILL, "utf8");
  const rows = [
    ["hinted", { annotations: { readOnlyHint: true } }, null, null],
    ["string", { annotations: { readOnlyHint: "true" } }, null, null],
    ["plain", {}, null, null],
    ["kept", { annotations: { readOnlyHint: true } }, null, "write"],
    ["reviewed", { annotations: { readOnlyHint: true } }, "a".repeat(64), null],
  ] as const;
  try {
    const result = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await tx.$executeRawUnsafe(
        `SET LOCAL search_path TO "${schema}", public`,
      );
      await tx.$executeRawUnsafe(
        `CREATE TABLE "ExternalMcpTool" ("remoteName" text PRIMARY KEY, "discoveredDefinition" jsonb NOT NULL, "reviewedRemoteDigest" char(64), "effect" "ExternalMcpToolEffect")`,
      );
      for (const [name, definition, digest, effect] of rows)
        await tx.$executeRawUnsafe(
          `INSERT INTO "ExternalMcpTool" VALUES ($1, $2::jsonb, $3, $4::"ExternalMcpToolEffect")`,
          name,
          JSON.stringify(definition),
          digest,
          effect,
        );
      await tx.$executeRawUnsafe(sql);
      return tx.$queryRawUnsafe<
        { remoteName: string; effect: string | null }[]
      >(
        `SELECT "remoteName", "effect"::text AS effect FROM "ExternalMcpTool" ORDER BY "remoteName"`,
      );
    });
    expect(
      Object.fromEntries(result.map((r) => [r.remoteName, r.effect])),
    ).toEqual({
      hinted: "read",
      string: "write",
      plain: "write",
      kept: "write",
      reviewed: null,
    });
  } finally {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
});

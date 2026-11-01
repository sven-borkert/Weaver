import type { PrismaClient } from "@weaver/db/client";
import {
  PROJECT_API_OPERATION_RETENTION_MS,
  PROJECT_API_AUDIT_RETENTION_MS,
} from "./constants";
export async function pruneProjectApiRecords(
  db: PrismaClient,
  now = new Date(),
) {
  const operationsBefore = new Date(
    now.getTime() - PROJECT_API_OPERATION_RETENTION_MS,
  ).toISOString();
  const auditsBefore = new Date(
    now.getTime() - PROJECT_API_AUDIT_RETENTION_MS,
  ).toISOString();
  const ratesBefore = new Date(now.getTime() - 2 * 60_000).toISOString();
  return db.$transaction(
    async (tx) => {
      const [lock] = await tx.$queryRaw<
        { locked: boolean }[]
      >`SELECT pg_try_advisory_xact_lock(hashtext('weaver:project-api-retention')) AS locked`;
      if (!lock?.locked) return { operations: 0, audits: 0, rateWindows: 0 };
      const operations = await tx.$executeRaw`WITH expired AS (
      SELECT id FROM "ProjectApiOperation" WHERE state IN ('succeeded','failed') AND "completedAt" < (${operationsBefore}::timestamptz AT TIME ZONE 'UTC')
      ORDER BY "completedAt", id LIMIT 5000 FOR UPDATE SKIP LOCKED
    ) DELETE FROM "ProjectApiOperation" r USING expired WHERE r.id = expired.id`;
      const audits = await tx.$executeRaw`WITH expired AS (
      SELECT id FROM "ProjectApiAuditEvent" WHERE "createdAt" < (${auditsBefore}::timestamptz AT TIME ZONE 'UTC')
      ORDER BY "createdAt", id LIMIT 5000 FOR UPDATE SKIP LOCKED
    ) DELETE FROM "ProjectApiAuditEvent" r USING expired WHERE r.id = expired.id`;
      const rateWindows = await tx.$executeRaw`WITH expired AS (
      SELECT "keyId" FROM "ProjectApiRateWindow" WHERE "windowStartedAt" < (${ratesBefore}::timestamptz AT TIME ZONE 'UTC')
      ORDER BY "windowStartedAt", "keyId" LIMIT 5000 FOR UPDATE SKIP LOCKED
    ) DELETE FROM "ProjectApiRateWindow" r USING expired WHERE r."keyId" = expired."keyId"`;
      return { operations, audits, rateWindows };
    },
    { timeout: 30_000 },
  );
}

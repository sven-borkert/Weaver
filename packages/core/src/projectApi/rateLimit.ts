import { Prisma, type PrismaClient } from "@weaver/db/client";
import { CoreError } from "../errors";
import { requireLiveProjectMachineKey } from "../security/projectMachine";
import type { ProjectMachineContext } from "./types";

export async function admitProjectMachineRequest(
  db: PrismaClient,
  context: ProjectMachineContext,
  now = new Date(),
): Promise<{ retryAfterSeconds: number | null }> {
  const windowStartedAt = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ requestCount: number }>>(Prisma.sql`
      INSERT INTO "ProjectApiRateWindow" ("keyId", "windowStartedAt", "requestCount")
      SELECT k."id", ${windowStartedAt.toISOString()}::timestamp(3), 1
      FROM "ProjectApiKey" k JOIN "Project" p ON p."id" = k."projectId"
      WHERE k."id" = ${context.keyId}::uuid AND k."projectId" = ${context.projectId}::uuid
        AND k."revokedAt" IS NULL AND (k."expiresAt" IS NULL OR k."expiresAt" > ${now.toISOString()}::timestamp(3))
        AND p."deletedAt" IS NULL
      ON CONFLICT ("keyId") DO UPDATE SET
        "windowStartedAt" = EXCLUDED."windowStartedAt",
        "requestCount" = CASE WHEN "ProjectApiRateWindow"."windowStartedAt" < EXCLUDED."windowStartedAt" THEN 1 ELSE "ProjectApiRateWindow"."requestCount" + 1 END
      WHERE "ProjectApiRateWindow"."windowStartedAt" < EXCLUDED."windowStartedAt"
        OR ("ProjectApiRateWindow"."windowStartedAt" = EXCLUDED."windowStartedAt" AND "ProjectApiRateWindow"."requestCount" < (SELECT "rateLimitPerMinute" FROM "ProjectApiKey" WHERE "id" = ${context.keyId}::uuid))
      RETURNING "requestCount"
    `);
    if (rows.length === 0) {
      await requireLiveProjectMachineKey(
        tx,
        context.keyId,
        context.projectId,
        now,
      );
      throw new CoreError(
        "TOO_MANY_REQUESTS",
        "Project API key rate limit exceeded",
        {
          retryAfterSeconds: Math.max(
            1,
            Math.ceil(
              (windowStartedAt.getTime() + 60_000 - now.getTime()) / 1_000,
            ),
          ),
        },
      );
    }
    await tx.$executeRaw(
      Prisma.sql`UPDATE "ProjectApiKey" SET "lastUsedAt" = ${now.toISOString()}::timestamp(3) WHERE "id" = ${context.keyId}::uuid`,
    );
  });
  return { retryAfterSeconds: null };
}

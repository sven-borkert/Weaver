import { Prisma, type PrismaClient } from "@weaver/db/client";
import type { RateLimitDecision } from "../security/rateLimit";
import { UTC_NOW } from "../services/sql";

export async function checkUploadRateLimit(
  db: PrismaClient,
  userId: string,
  channel: "browser" | "external",
  limit: number,
): Promise<RateLimitDecision> {
  const [row] = await db.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    INSERT INTO "UploadRateLimit" ("userId", channel, "windowStart", count)
    VALUES (${userId}::uuid, ${channel}, date_trunc('minute', ${UTC_NOW}), 1)
    ON CONFLICT ("userId", channel) DO UPDATE SET
      "windowStart" = greatest("UploadRateLimit"."windowStart", EXCLUDED."windowStart"),
      count = CASE WHEN "UploadRateLimit"."windowStart" < EXCLUDED."windowStart" THEN 1
        ELSE LEAST("UploadRateLimit".count + 1, ${limit + 1}) END
    RETURNING count
  `);
  return row && row.count <= limit
    ? { allowed: true }
    : { allowed: false, retryAfterSeconds: 60 };
}

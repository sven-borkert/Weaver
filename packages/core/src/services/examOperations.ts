import type { Prisma, PrismaClient } from "@weaver/db/client";
import { CoreError } from "../errors";
import type { SecurityContext } from "../security/context";
import { IDEMPOTENCY_KEY_RE, requestHash } from "./mcpOperations";

export async function withExamOperation<T extends object>(
  db: PrismaClient,
  actor: SecurityContext,
  input: { idempotencyKey: string; toolName: string; request: unknown },
  run: (tx: Prisma.TransactionClient) => Promise<T>,
  authorize?: (tx: Prisma.TransactionClient) => Promise<unknown>,
): Promise<T & { replayed: boolean }> {
  if (!IDEMPOTENCY_KEY_RE.test(input.idempotencyKey))
    throw new CoreError("BAD_REQUEST", "Invalid idempotency key", {
      field: "idempotencyKey",
    });
  const hash = requestHash({
    toolName: input.toolName,
    request: input.request,
  });
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["exam-operation", actor.userId, input.idempotencyKey])}, 0))::text`;
    await authorize?.(tx);
    const key = { userId: actor.userId, idempotencyKey: input.idempotencyKey };
    const old = await tx.examOperation.findUnique({
      where: { userId_idempotencyKey: key },
    });
    if (old) {
      if (old.requestHash !== hash)
        throw new CoreError("CONFLICT", "Idempotency key already used", {
          reason: "IDEMPOTENCY_KEY_REUSED",
        });
      return { ...(old.result as T), replayed: true };
    }
    const result = await run(tx);
    const json = JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue;
    await tx.examOperation.create({
      data: {
        ...key,
        toolName: input.toolName,
        requestHash: hash,
        result: json,
        createdAt: new Date(),
      },
    });
    return { ...(JSON.parse(JSON.stringify(result)) as T), replayed: false };
  });
}
export async function pruneExamOperations(
  db: PrismaClient,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - 30 * 86400000);
  return db.$executeRaw`DELETE FROM "ExamOperation" WHERE ("userId", "idempotencyKey") IN (SELECT "userId", "idempotencyKey" FROM "ExamOperation" WHERE "createdAt" < ${cutoff} ORDER BY "createdAt" LIMIT 5000)`;
}

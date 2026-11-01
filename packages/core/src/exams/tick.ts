import type { PrismaClient } from "@weaver/db/client";
import { finalizeExpiredAttempts } from "../services/examAttempts";
export async function runExamTick(
  db: PrismaClient,
  now?: Date,
): Promise<{ expired: number }> {
  return finalizeExpiredAttempts(db, now);
}

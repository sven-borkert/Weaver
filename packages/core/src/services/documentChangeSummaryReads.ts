import type { Prisma, PrismaClient } from "@weaver/db/client";
import type { ChangeSummaryView } from "../documents/changeSummaryMessage";

type Db = PrismaClient | Prisma.TransactionClient;

/** Callers must already have authorized the project read. */
export async function loadChangeSummaries(
  db: Db,
  projectId: string,
  shas: readonly string[],
): Promise<Map<string, ChangeSummaryView>> {
  if (shas.length === 0) return new Map();
  const rows = await db.documentChangeSummary.findMany({
    where: { projectId, commitSha: { in: [...new Set(shas)] } },
    select: { commitSha: true, status: true, summary: true },
  });
  return new Map(
    rows.map((row) => [
      row.commitSha,
      { status: row.status, summary: row.summary },
    ]),
  );
}

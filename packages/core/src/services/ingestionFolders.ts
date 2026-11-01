import { Prisma, type PrismaClient } from "@weaver/db/client";

export const MAX_DRAFT_FOLDERS = 200;

/** Folders that currently hold content, bounded in SQL before loading projections. */
export async function listDraftFolders(
  db: PrismaClient,
  projectId: string,
  targetKind: "document" | "table",
): Promise<string[]> {
  const source =
    targetKind === "document"
      ? Prisma.sql`SELECT string_to_array("path", '/') AS segments FROM "Document" WHERE "projectId" = ${projectId}::uuid`
      : Prisma.sql`SELECT (string_to_array("path", '/'))[2:] AS segments FROM "DataTable" WHERE "projectId" = ${projectId}::uuid`;
  const rows = await db.$queryRaw<Array<{ folder: string }>>(Prisma.sql`
    WITH paths AS (${source})
    SELECT DISTINCT array_to_string(segments[1:depth], '/') AS folder
    FROM paths CROSS JOIN LATERAL generate_series(1, cardinality(segments) - 1) AS depth
    ORDER BY folder LIMIT ${MAX_DRAFT_FOLDERS}
  `);
  return rows.map((row) => row.folder);
}

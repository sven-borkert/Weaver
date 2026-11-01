import { Prisma, type PrismaClient } from "@weaver/db/client";

type Db = PrismaClient | Prisma.TransactionClient;

/** Digests of `digests` that an import or an artifact of the project still names. */
export async function referencedDigests(
  db: Db,
  projectId: string,
  digests: readonly string[],
): Promise<Set<string>> {
  if (digests.length === 0) return new Set();
  const rows = await db.$queryRaw<Array<{ digest: string }>>(Prisma.sql`
    SELECT "contentDigest" AS digest FROM "IngestionFile"
    WHERE "projectId" = ${projectId}::uuid AND "contentDigest" IN (${Prisma.join(digests)})
    UNION
    SELECT "contentDigest" AS digest FROM "Artifact"
    WHERE "projectId" = ${projectId}::uuid AND "contentDigest" IN (${Prisma.join(digests)})
  `);
  return new Set(rows.map((row) => row.digest));
}

export async function isBlobReferenced(
  db: Db,
  projectId: string,
  digest: string,
): Promise<boolean> {
  return (await referencedDigests(db, projectId, [digest])).has(digest);
}

/** Bytes the project keeps on disk once `incoming` is stored: every original
 *  blob (a shared digest counts once) plus the published OneNote read caches
 *  (`ArtifactNotebook.snapshotBytes` of `ready` rows). */
export async function retainedBytes(
  db: Db,
  projectId: string,
  incoming: ReadonlyArray<{ digest: string; byteSize: number }>,
  excludeArtifactIds: readonly string[] = [],
): Promise<bigint> {
  const incomingRows = incoming.length
    ? Prisma.sql`UNION ALL SELECT * FROM (VALUES ${Prisma.join(
        incoming.map(
          (file) => Prisma.sql`(${file.digest}, ${file.byteSize}::bigint)`,
        ),
      )}) AS incoming(digest, size)`
    : Prisma.empty;
  // Prisma.join throws on an empty list, so build the fragments only when ids exist.
  const excludedIds = () =>
    Prisma.join(excludeArtifactIds.map((id) => Prisma.sql`${id}::uuid`));
  const excluded = excludeArtifactIds.length
    ? Prisma.sql`AND "id" NOT IN (${excludedIds()})`
    : Prisma.empty;
  const excludedNotebooks = excludeArtifactIds.length
    ? Prisma.sql`AND a."id" NOT IN (${excludedIds()})`
    : Prisma.empty;
  const [row] = await db.$queryRaw<Array<{ bytes: bigint }>>(Prisma.sql`
    SELECT (
      (
        SELECT COALESCE(sum(bytes), 0) FROM (
          SELECT digest, max(size) AS bytes FROM (
            SELECT "contentDigest" AS digest, "byteSize"::bigint AS size
            FROM "IngestionFile" WHERE "projectId" = ${projectId}::uuid
            UNION ALL
            SELECT "contentDigest" AS digest, "byteSize"::bigint AS size
            FROM "Artifact" WHERE "projectId" = ${projectId}::uuid ${excluded}
            ${incomingRows}
          ) AS originals GROUP BY digest
        ) AS retained
      ) + (
        SELECT COALESCE(sum(n."snapshotBytes"), 0)
        FROM "ArtifactNotebook" n
        JOIN "Artifact" a ON a."id" = n."artifactId"
        WHERE a."projectId" = ${projectId}::uuid AND n."status" = 'ready'
          ${excludedNotebooks}
      )
    )::bigint AS bytes
  `);
  return row?.bytes ?? 0n;
}

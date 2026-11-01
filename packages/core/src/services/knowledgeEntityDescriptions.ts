import { Prisma } from "@weaver/db/client";
import {
  selectEntityDescription,
  type EntityDescriptionSource,
} from "../knowledge/entityDescriptions";

export async function loadCurrentEntityDescriptions(
  tx: Prisma.TransactionClient,
  input: {
    projectId: string;
    generationId: string;
    entityIds: string[];
    excludeDocumentId?: string;
  },
): Promise<Map<string, EntityDescriptionSource[]>> {
  const result = new Map<string, EntityDescriptionSource[]>();
  if (!input.entityIds.length) return result;
  const rows = await tx.$queryRaw<
    Array<EntityDescriptionSource & { entityId: string }>
  >(Prisma.sql`
    SELECT DISTINCT ON (mention."entityId") mention."entityId", mention."documentId", mention."sourceDescription" AS "description", mention."confidence"
    FROM "EntityMention" AS mention
    JOIN "Document" AS document ON document."id" = mention."documentId"
      AND document."projectId" = mention."projectId" AND document."headCommitSha" = mention."sourceCommitSha"
    WHERE mention."projectId" = ${input.projectId}::uuid
      AND mention."generationId" = ${input.generationId}::uuid
      AND mention."entityId" IN (${Prisma.join(input.entityIds.map((id) => Prisma.sql`${id}::uuid`))})
      AND mention."invalidatedAt" IS NULL AND mention."sourceDescription" IS NOT NULL
      ${input.excludeDocumentId ? Prisma.sql`AND mention."documentId" <> ${input.excludeDocumentId}::uuid` : Prisma.empty}
    ORDER BY mention."entityId", mention."confidence" DESC, mention."documentId", mention."sourceDescription" COLLATE "C"
  `);
  for (const row of rows) {
    const sources = result.get(row.entityId) ?? [];
    sources.push(row);
    result.set(row.entityId, sources);
  }
  return result;
}

export async function refreshEntityDescriptions(
  tx: Prisma.TransactionClient,
  input: { projectId: string; documentId: string; generationId?: string },
): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const touched = await tx.graphEntity.findMany({
      where: {
        projectId: input.projectId,
        generationId: input.generationId,
        mentions: {
          some: { projectId: input.projectId, documentId: input.documentId },
        },
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: 200,
      select: { id: true, generationId: true },
    });
    if (!touched.length) return;
    const byGeneration = new Map<string, string[]>();
    for (const row of touched) {
      const ids = byGeneration.get(row.generationId) ?? [];
      ids.push(row.id);
      byGeneration.set(row.generationId, ids);
    }
    for (const [generationId, entityIds] of byGeneration) {
      const sources = await loadCurrentEntityDescriptions(tx, {
        projectId: input.projectId,
        generationId,
        entityIds,
      });
      for (const entityId of entityIds) {
        const description = selectEntityDescription(
          sources.get(entityId) ?? [],
        );
        const updated = await tx.graphEntity.updateMany({
          where: {
            id: entityId,
            projectId: input.projectId,
            generationId,
            ...(description === null
              ? { description: { not: null } }
              : {
                  OR: [
                    { description: null },
                    { description: { not: description } },
                  ],
                }),
          },
          data: { description },
        });
        if (updated.count)
          await tx.knowledgeEmbedding.deleteMany({
            where: {
              projectId: input.projectId,
              generationId,
              ownerType: "entity",
              ownerId: entityId,
            },
          });
      }
    }
    cursor = touched.at(-1)!.id;
  }
}

import type { Prisma, PrismaClient } from "@weaver/db/client";
import type { CrossrefTarget } from "@weaver/core/documents/links";

type Db = PrismaClient | Prisma.TransactionClient;

export async function syncLinks(
  tx: Db,
  sourceDocumentId: string,
  targets: CrossrefTarget[],
): Promise<void> {
  const uniqueTargets = [
    ...new Map(
      targets.map((target) => [
        `${target.targetType}:${target.targetId}`,
        target,
      ]),
    ).values(),
  ];
  await tx.documentLink.deleteMany({
    where: {
      sourceDocumentId,
      NOT: uniqueTargets.map((target) => ({
        targetDocumentId: target.targetId,
        targetType: target.targetType,
      })),
    },
  });
  if (uniqueTargets.length === 0) return;
  await tx.documentLink.createMany({
    data: uniqueTargets.map((target) => ({
      sourceDocumentId,
      targetDocumentId: target.targetId,
      targetType: target.targetType,
    })),
    skipDuplicates: true,
  });
}

import type { Prisma } from "@weaver/db/client";

/** Drops a departed member's reviewer groups, defaults and document links in one project. */
export async function unlinkUserFromProjectReview(
  db: Prisma.TransactionClient,
  projectId: string,
  userId: string,
): Promise<void> {
  await db.reviewerGroupMember.deleteMany({
    where: { userId, group: { projectId } },
  });
  await db.projectDefaultReviewer.deleteMany({ where: { projectId, userId } });
  await db.documentReviewer.updateMany({
    where: { userId, document: { projectId } },
    data: { userId: null },
  });
}

/** Re-links the documents that still name a user who became a member again. */
export async function linkUserToProjectReview(
  db: Prisma.TransactionClient,
  projectId: string,
  userId: string,
): Promise<void> {
  await db.documentReviewer.updateMany({
    where: {
      type: "user",
      refId: userId,
      userId: null,
      document: { projectId },
    },
    data: { userId },
  });
}

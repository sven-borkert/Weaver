import type { Prisma, PrismaClient } from "@weaver/db/client";
import { CoreError } from "../errors";
import type { UserSecurityContext } from "../security/context";

export async function assertLiveAssistantPrincipal(
  db: PrismaClient | Prisma.TransactionClient,
  actor: UserSecurityContext,
): Promise<void> {
  const now = new Date();
  const session =
    actor.authenticationMethod === "session" &&
    (await db.session.findFirst({
      where: {
        id: actor.credentialId,
        userId: actor.userId,
        expiresAt: { gt: now },
        user: {
          mustChangePassword: false,
          OR: [{ banned: false }, { banExpires: { lte: now } }],
        },
      },
      select: { id: true },
    }));
  if (!session)
    throw new CoreError(
      "FORBIDDEN",
      "The assistant session is no longer authorized. Sign in again.",
    );
}

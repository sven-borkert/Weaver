import { CoreError } from "@weaver/core/errors";
import { Prisma, type PrismaClient } from "@weaver/db/client";
import type { ProjectActor } from "./projectAccess";

type Db = PrismaClient | Prisma.TransactionClient;

export type OAuthConsentSummary = {
  id: string;
  clientId: string;
  clientName: string | null;
  clientUri: string | null;
  scopes: string[];
  createdAt: Date | null;
};

function assertSessionActor(actor: ProjectActor): void {
  // A key or token must not manage the consents that grant keys and tokens.
  if (actor.authenticationMethod !== "session") {
    throw new CoreError(
      "FORBIDDEN",
      "Only a signed-in session can manage connected apps",
    );
  }
}

export async function listOAuthConsents(
  db: Db,
  actor: ProjectActor,
): Promise<OAuthConsentSummary[]> {
  assertSessionActor(actor);
  const rows = await db.oauthConsent.findMany({
    where: { userId: actor.userId },
    include: { client: { select: { name: true, uri: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
  });
  return rows.map((row) => ({
    id: row.id,
    clientId: row.clientId,
    clientName: row.client.name,
    clientUri: row.client.uri,
    scopes: [...row.scopes],
    createdAt: row.createdAt,
  }));
}

/** Spec §26.7: the consent row is the revocation signal; tokens die on the next MCP request. */
export async function revokeOAuthConsent(
  db: PrismaClient,
  actor: ProjectActor,
  consentId: string,
): Promise<void> {
  assertSessionActor(actor);
  await db.$transaction(async (tx) => {
    const [consent] = await tx.$queryRaw<
      Array<{ id: string; clientId: string; referenceId: string | null }>
    >(Prisma.sql`
      SELECT
        "id"::text AS "id",
        "clientId",
        "referenceId"
      FROM "OauthConsent"
      WHERE "id" = ${consentId}::uuid
        AND "userId" = ${actor.userId}::uuid
      FOR UPDATE
    `);
    if (!consent?.referenceId) throw new CoreError("NOT_FOUND");
    const now = new Date();
    await tx.oauthConsent.delete({ where: { id: consent.id } });
    await tx.oauthRefreshToken.updateMany({
      where: {
        clientId: consent.clientId,
        userId: actor.userId,
        revoked: null,
      },
      data: { revoked: now },
    });
    await tx.oauthAccessToken.updateMany({
      where: {
        clientId: consent.clientId,
        userId: actor.userId,
        revoked: null,
      },
      data: { revoked: now },
    });
  });
}

/**
 * Revokes every OAuth grant a user holds — an admin password reset's
 * containment step. Locks the user's consent rows first, in id order (the
 * same row-first order revokeOAuthConsent and the provider's code/token
 * inserts take), deletes them, then marks every live refresh and access
 * token revoked. Carries no actor check of its own: callers are services
 * that have already authorized the operation.
 */
export async function revokeAllOAuthGrantsForUser(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<{ consents: number }> {
  const consents = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"::text AS "id"
    FROM "OauthConsent"
    WHERE "userId" = ${userId}::uuid
    ORDER BY "id"
    FOR UPDATE
  `);
  const now = new Date();
  await tx.oauthConsent.deleteMany({ where: { userId } });
  await tx.oauthRefreshToken.updateMany({
    where: { userId, revoked: null },
    data: { revoked: now },
  });
  await tx.oauthAccessToken.updateMany({
    where: { userId, revoked: null },
    data: { revoked: now },
  });
  return { consents: consents.length };
}

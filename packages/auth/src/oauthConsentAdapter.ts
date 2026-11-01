import { tryGetCurrentAuthEndpointContext } from "@better-auth/core/context";
import { APIError } from "better-auth/api";
import { prismaAdapter } from "better-auth/adapters/prisma";

type ConsentDatabase = {
  $transaction<T>(
    fn: (tx: {
      $queryRawUnsafe<T>(sql: string, ...values: unknown[]): Promise<T>;
    }) => Promise<T>,
    options: { timeout: number; maxWait: number },
  ): Promise<T>;
};

export function consentGuardedAdapter(
  db: object,
): ReturnType<typeof prismaAdapter> {
  const factory = prismaAdapter(db, {
    provider: "postgresql",
    transaction: true,
  });
  return (options) => {
    const adapter = factory(options);
    const guarded = async <T>(
      model: string,
      write: (target: typeof adapter) => Promise<T>,
    ): Promise<T> => {
      if (model !== "oauthConsent") return write(adapter);
      const session = tryGetCurrentAuthEndpointContext()?.context.session;
      if (!session)
        throw new APIError("FORBIDDEN", {
          message: "A live session is required",
        });
      return (db as ConsentDatabase).$transaction(
        async (tx) => {
          await tx.$queryRawUnsafe(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text",
            `weaver:user-credentials:${session.user.id}`,
          );
          const live = await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `
          SELECT s."id" FROM "Session" s JOIN "User" u ON u."id" = s."userId"
          WHERE s."id" = $1::uuid AND s."userId" = $2::uuid AND s."expiresAt" > timezone('UTC', now())
            AND NOT u."mustChangePassword"
            AND (NOT coalesce(u."banned", false) OR u."banExpires" <= timezone('UTC', now()))
        `,
            session.session.id,
            session.user.id,
          );
          if (!live.length)
            throw new APIError("FORBIDDEN", {
              message: "Session was revoked. Sign in again.",
            });
          return write(
            prismaAdapter(tx, {
              provider: "postgresql",
              transaction: false,
            })(options),
          );
        },
        { timeout: 15_000, maxWait: 15_000 },
      );
    };
    return {
      ...adapter,
      create: (input) => guarded(input.model, (target) => target.create(input)),
      update: (input) => guarded(input.model, (target) => target.update(input)),
    };
  };
}

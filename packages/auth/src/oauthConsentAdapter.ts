import { tryGetCurrentAuthEndpointContext } from "@better-auth/core/context";
import { APIError } from "better-auth/api";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { withUserCredentialLock } from "./userCredentialLock";

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
      return withUserCredentialLock(
        session.user.id,
        "weaver-oauth-consent",
        (assertHeld) =>
          (db as ConsentDatabase).$transaction(
            async (tx) => {
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
              const result = await write(
                prismaAdapter(tx, {
                  provider: "postgresql",
                  transaction: false,
                })(options),
              );
              await assertHeld();
              return result;
            },
            { timeout: 15_000, maxWait: 15_000 },
          ),
      );
    };
    return {
      ...adapter,
      create: (input) => guarded(input.model, (target) => target.create(input)),
      update: (input) => guarded(input.model, (target) => target.update(input)),
    };
  };
}

import { parseServerEnv } from "@weaver/config/server";
import { Client } from "pg";

export class UserCredentialLockLostError extends Error {
  constructor(options?: ErrorOptions) {
    super("The credential lock was lost. Try again.", options);
    this.name = "UserCredentialLockLostError";
  }
}

// Better Auth uses the application pool while this separate connection owns the lock.
export async function withUserCredentialLock<T>(
  userId: string,
  applicationName: string,
  run: (assertHeld: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const lock = new Client({
    connectionString: parseServerEnv(process.env).DATABASE_URL,
    connectionTimeoutMillis: 15_000,
    statement_timeout: 15_000,
    query_timeout: 16_000,
    application_name: applicationName,
  });
  let lost = false;
  const markLost = () => {
    lost = true;
  };
  lock.on("error", markLost);
  lock.on("end", markLost);
  const assertHeld = async () => {
    if (lost) throw new UserCredentialLockLostError();
    await lock.query("SELECT 1").catch((cause: unknown) => {
      throw new UserCredentialLockLostError({ cause });
    });
    if (lost) throw new UserCredentialLockLostError();
  };

  try {
    await lock.connect();
    await lock.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
      `weaver:user-credentials:${userId}`,
    ]);
    return await run(assertHeld);
  } finally {
    await lock.end().catch(() => undefined);
  }
}

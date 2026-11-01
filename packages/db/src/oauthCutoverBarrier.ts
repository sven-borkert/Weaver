export const OAUTH_GENERATION_CUTOVER_MIGRATION =
  "20260906130000_oauth_generation_cutover";

export type MigrationSqlClient = {
  query(sql: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }>;
};

export type OAuthCutoverState =
  | { needsBarrier: false; consentRelationOid: null }
  | { needsBarrier: false; consentRelationOid: number }
  | { needsBarrier: true; consentRelationOid: number };

type CatalogRow = {
  consentOid: number | string | null;
  migrationsOid: number | string | null;
};

type AppliedRow = { applied: boolean };

type ClientCountRow = { otherClients: bigint | number | string };

export async function assertOAuthCutoverQuiescent(
  client: MigrationSqlClient,
  ignoredApplicationName: string | null = null,
): Promise<void> {
  const result = await client.query(
    `SELECT count(*)::bigint AS "otherClients"
     FROM pg_stat_activity
     WHERE datname = current_database()
       AND backend_type = 'client backend'
       AND pid <> pg_backend_pid()
       AND ($1::text IS NULL OR application_name <> $1)`,
    [ignoredApplicationName],
  );
  const count = BigInt(
    (result.rows[0] as ClientCountRow | undefined)?.otherClients ?? 0,
  );
  if (count > 0n) {
    throw new Error(
      `OAuth generation cutover requires a quiesced database (${count} other client connection(s) remain). Stop all Weaver runtime processes and retry.`,
    );
  }
}

// Inspect before BEGIN so the barrier transaction's first relation lock is OauthConsent.
export async function inspectOAuthCutoverState(
  client: MigrationSqlClient,
): Promise<OAuthCutoverState> {
  const catalogs = await client.query(`
    SELECT
      to_regclass('"OauthConsent"')::oid::int AS "consentOid",
      to_regclass('"_prisma_migrations"')::oid::int AS "migrationsOid"
  `);
  const catalog = catalogs.rows[0] as CatalogRow | undefined;
  if (catalog?.consentOid === null || catalog?.consentOid === undefined) {
    return { needsBarrier: false, consentRelationOid: null };
  }
  const consentRelationOid = Number(catalog.consentOid);
  if (catalog.migrationsOid === null || catalog.migrationsOid === undefined) {
    return { needsBarrier: true, consentRelationOid };
  }
  const appliedResult = await client.query(
    `SELECT EXISTS (
       SELECT 1
       FROM "_prisma_migrations"
       WHERE migration_name = $1
         AND finished_at IS NOT NULL
         AND rolled_back_at IS NULL
     ) AS applied`,
    [OAUTH_GENERATION_CUTOVER_MIGRATION],
  );
  const applied = (appliedResult.rows[0] as AppliedRow | undefined)?.applied;
  return {
    needsBarrier: applied !== true,
    consentRelationOid,
  };
}

// Caller commits only after the Prisma migrator queues for OauthConsent.
export async function acquireOAuthCutoverBarrier(
  client: MigrationSqlClient,
  consentRelationOid: number,
  options: { enforceQuiescence?: boolean } = {},
): Promise<void> {
  if (!Number.isSafeInteger(consentRelationOid) || consentRelationOid <= 0) {
    throw new Error("OauthConsent relation OID is invalid");
  }
  await client.query("BEGIN");
  try {
    // EXCLUSIVE conflicts with SELECT ... FOR UPDATE's ROW SHARE table lock.
    await client.query('LOCK TABLE "OauthConsent" IN EXCLUSIVE MODE');
    if (options.enforceQuiescence !== false) {
      await assertOAuthCutoverQuiescent(client);
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export async function waitForOAuthCutoverMigrator(
  client: MigrationSqlClient,
  consentRelationOid: number,
  applicationName: string,
  options: {
    hasExited: () => boolean;
    timeoutMs?: number;
    pollMs?: number;
  },
): Promise<"waiting" | "exited"> {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    if (options.hasExited()) return "exited";
    const result = await client.query(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_locks AS lock
         JOIN pg_stat_activity AS activity ON activity.pid = lock.pid
         WHERE lock.locktype = 'relation'
           AND lock.relation = $1::oid
           AND lock.granted = false
           AND activity.application_name = $2
       ) AS waiting`,
      [consentRelationOid, applicationName],
    );
    if ((result.rows[0] as { waiting?: boolean } | undefined)?.waiting) {
      return "waiting";
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 25));
  }
  throw new Error(
    "Prisma migrator did not queue for the OAuth cutover barrier in time",
  );
}

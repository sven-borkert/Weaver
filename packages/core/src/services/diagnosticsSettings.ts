import {
  DEFAULT_DIAGNOSTICS_SETTINGS,
  DIAGNOSTICS_SETTING_KEY,
  diagnosticsSettingsSchema,
  parseDiagnosticsSettings,
  type DiagnosticsSettings,
} from "@weaver/core/diagnostics/settings";
import {
  diagnosticWriterStats,
  emitDiagnostic,
} from "@weaver/core/diagnostics/writer";
import { processSingleton } from "@weaver/core/diagnostics/processState";
import { CoreError } from "@weaver/core/errors";
import {
  assertSystemAdmin,
  type SecurityContext,
} from "@weaver/core/security/context";
import { Prisma, type PrismaClient } from "@weaver/db/client";
import { getSystemSetting, setSystemSetting } from "./systemSettings";

const CACHE_TTL_MS = 15_000;
const DIAGNOSTICS_SETTINGS_LOCK = "weaver:diagnostics-settings";

type SettingsState = {
  cache: { value: DiagnosticsSettings; expiresAt: number } | null;
  refresh: {
    generation: number;
    promise: Promise<DiagnosticsSettings>;
    owner: object;
  } | null;
  cacheGeneration: number;
  statsCache: {
    db: PrismaClient;
    expiresAt: number;
    counts: Promise<{ rows: number; verboseRows: number }>;
  } | null;
};

const shared = processSingleton<SettingsState>("settings", () => ({
  cache: null,
  refresh: null,
  cacheGeneration: 0,
  statsCache: null,
}));

export function invalidateDiagnosticsStats(): void {
  shared.statsCache = null;
}

/** Synchronous view for hot paths; null until the first read completes. */
export function peekDiagnosticsSettings(
  now = Date.now(),
): { value: DiagnosticsSettings; stale: boolean } | null {
  if (!shared.cache) return null;
  return { value: shared.cache.value, stale: now >= shared.cache.expiresAt };
}

export function primeDiagnosticsSettingsCache(
  value: DiagnosticsSettings,
  now = Date.now(),
): void {
  shared.cacheGeneration += 1;
  shared.cache = { value, expiresAt: now + CACHE_TTL_MS };
}

export function invalidateDiagnosticsSettingsCache(): void {
  invalidateDiagnosticsStats();
  shared.cacheGeneration += 1;
  shared.cache = null;
}

export function supersedeDiagnosticsSettingsRefresh(): void {
  shared.cacheGeneration += 1;
}

export async function getDiagnosticsSettings(
  db: PrismaClient,
  now = Date.now(),
): Promise<DiagnosticsSettings> {
  const peeked = peekDiagnosticsSettings(now);
  if (peeked && !peeked.stale) return peeked.value;
  const refreshGeneration = shared.cacheGeneration;
  if (shared.refresh?.generation === refreshGeneration)
    return shared.refresh.promise;
  const owner = {};
  const promise = (async () => {
    try {
      const value = parseDiagnosticsSettings(
        await getSystemSetting(db, DIAGNOSTICS_SETTING_KEY),
      );
      if (shared.cacheGeneration === refreshGeneration) {
        primeDiagnosticsSettingsCache(value, now);
      }
      return value;
    } catch {
      // Keep serving the last known value; a missing cache means "off".
      return peeked?.value ?? DEFAULT_DIAGNOSTICS_SETTINGS;
    } finally {
      if (shared.refresh?.owner === owner) shared.refresh = null;
    }
  })();
  shared.refresh = { generation: refreshGeneration, promise, owner };
  return promise;
}

export type DiagnosticsSettingsPatch = Partial<DiagnosticsSettings>;

export async function setDiagnosticsSettings(
  db: PrismaClient,
  actor: SecurityContext,
  patch: DiagnosticsSettingsPatch,
): Promise<DiagnosticsSettings> {
  assertSystemAdmin(actor);
  const committed = await db.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${DIAGNOSTICS_SETTINGS_LOCK}, 0)
      )::text
    `);
    const before = parseDiagnosticsSettings(
      await getSystemSetting(tx, DIAGNOSTICS_SETTING_KEY),
    );
    const parsed = diagnosticsSettingsSchema.safeParse({ ...before, ...patch });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new CoreError("BAD_REQUEST", issue?.message ?? "Invalid setting", {
        field: String(issue?.path[0] ?? "level"),
      });
    }
    await setSystemSetting(tx, {
      key: DIAGNOSTICS_SETTING_KEY,
      value: parsed.data,
      updatedById: actor.userId,
    });
    return { before, after: parsed.data };
  });
  primeDiagnosticsSettingsCache(committed.after);
  invalidateDiagnosticsStats();
  emitDiagnostic({
    event: "settings.changed",
    message: `diagnostics level ${committed.before.level} → ${committed.after.level}`,
    userId: actor.userId,
    credentialId: actor.credentialId,
    details: {
      setting: DIAGNOSTICS_SETTING_KEY,
      before: committed.before,
      after: committed.after,
    },
  });
  return committed.after;
}

export type DiagnosticsStats = {
  rows: number;
  verboseRows: number;
  oldestAt: Date | null;
  newestAt: Date | null;
  writer: ReturnType<typeof diagnosticWriterStats>;
  writers?: Array<{
    runtime: string;
    dropped: number;
    reportedAt: string;
    started: boolean;
  }>;
};

export async function diagnosticsStats(
  db: PrismaClient,
  actor: SecurityContext,
): Promise<DiagnosticsStats> {
  assertSystemAdmin(actor);
  let stats = shared.statsCache;
  if (stats?.db !== db || stats.expiresAt <= Date.now()) {
    const counts = db.$queryRaw<Array<{ rows: number; verboseRows: number }>>`
      SELECT count(*)::float8 AS "rows", count(*) FILTER (WHERE "verbose")::float8 AS "verboseRows" FROM "DiagnosticEvent"
    `.then((rows) => rows[0] ?? { rows: 0, verboseRows: 0 });
    stats = { db, expiresAt: Date.now() + CACHE_TTL_MS, counts };
    shared.statsCache = stats;
  }
  const [counts, oldest, newest, snapshots] = await Promise.all([
    stats.counts,
    db.diagnosticEvent.findFirst({
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    db.diagnosticEvent.findFirst({
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    db.systemSetting.findMany({
      where: {
        key: {
          in: [
            "diagnostics.writer.web",
            "diagnostics.writer.worker",
            "diagnostics.writer.mcp",
          ],
        },
      },
      select: { value: true },
    }),
  ]);
  return {
    ...counts,
    oldestAt: oldest?.createdAt ?? null,
    newestAt: newest?.createdAt ?? null,
    writer: diagnosticWriterStats(),
    writers: snapshots.flatMap(({ value }) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return [];
      if (
        typeof value.runtime !== "string" ||
        typeof value.dropped !== "number" ||
        typeof value.reportedAt !== "string" ||
        typeof value.started !== "boolean"
      )
        return [];
      return [
        {
          runtime: value.runtime,
          dropped: value.dropped,
          reportedAt: value.reportedAt,
          started: value.started,
        },
      ];
    }),
  };
}

export async function getDiagnosticsSettingsAsAdmin(
  db: PrismaClient,
  actor: SecurityContext,
): Promise<DiagnosticsSettings> {
  assertSystemAdmin(actor);
  return getDiagnosticsSettings(db);
}

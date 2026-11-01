import { createPinnedFetch } from "@weaver/config/outboundFetch";
import { readBoundedResponse } from "../ai/http";
import { emitDiagnostic } from "@weaver/core/diagnostics/writer";
import { CoreError } from "@weaver/core/errors";
import {
  DEFAULT_INGESTION_SETTINGS,
  INGESTION_SETTING_KEY,
  doclingEndpoint,
  ingestionSettingsSchema,
  ingestionSettingsValueSchema,
  parseIngestionSettings,
  type IngestionSettings,
  type IngestionSettingsPatch,
} from "@weaver/core/ingestion/settings";
import {
  assertSystemAdmin,
  type SecurityContext,
} from "@weaver/core/security/context";
import { Prisma, type PrismaClient } from "@weaver/db/client";
import { getSystemSetting, setSystemSetting } from "./systemSettings";

const CACHE_TTL_MS = 15_000;
const INGESTION_SETTINGS_LOCK = "weaver:ingestion-settings";
const DOCLING_PROBE_TIMEOUT_MS = 5_000;

let cache: { value: IngestionSettings; expiresAt: number } | null = null;

export function invalidateIngestionSettingsCache(): void {
  cache = null;
}

export async function getIngestionSettings(
  db: PrismaClient,
  now = Date.now(),
): Promise<IngestionSettings> {
  if (cache && now < cache.expiresAt) return cache.value;
  try {
    const value = parseIngestionSettings(
      await getSystemSetting(db, INGESTION_SETTING_KEY),
    );
    cache = { value, expiresAt: now + CACHE_TTL_MS };
    return value;
  } catch {
    // Keep serving the last known value; a missing cache means the defaults.
    return cache?.value ?? DEFAULT_INGESTION_SETTINGS;
  }
}

export async function setIngestionSettings(
  db: PrismaClient,
  actor: SecurityContext,
  patch: IngestionSettingsPatch,
): Promise<IngestionSettings> {
  assertSystemAdmin(actor);
  const committed = await db.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${INGESTION_SETTINGS_LOCK}, 0)
      )::text
    `);
    const before = parseIngestionSettings(
      await getSystemSetting(tx, INGESTION_SETTING_KEY),
    );
    const parsed = ingestionSettingsSchema.safeParse({ ...before, ...patch });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new CoreError("BAD_REQUEST", issue?.message ?? "Invalid setting", {
        field: String(issue?.path[0] ?? "doclingBaseUrl"),
      });
    }
    await setSystemSetting(tx, {
      key: INGESTION_SETTING_KEY,
      value: parsed.data,
      updatedById: actor.userId,
    });
    return { before, after: parsed.data };
  });
  cache = { value: committed.after, expiresAt: Date.now() + CACHE_TTL_MS };
  emitDiagnostic({
    event: "settings.changed",
    message: "Docling settings updated",
    userId: actor.userId,
    credentialId: actor.credentialId,
    details: {
      setting: INGESTION_SETTING_KEY,
      changed: Object.keys(patch),
    },
  });
  return committed.after;
}

export type DoclingProbe = { ok: boolean; message: string; durationMs: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** GET <baseUrl>/health; docling-serve answers 200 `{ "status": "ok" }`. */
export async function probeDocling(
  db: PrismaClient,
  actor: SecurityContext,
  input: { baseUrl: string },
  fetchImpl: typeof fetch = createPinnedFetch(),
): Promise<DoclingProbe> {
  assertSystemAdmin(actor);
  void db;
  const parsed = ingestionSettingsValueSchema.shape.doclingBaseUrl.safeParse(
    input.baseUrl,
  );
  if (!parsed.success || parsed.data === null) {
    throw new CoreError("BAD_REQUEST", "Enter an http:// or https:// URL", {
      field: "doclingBaseUrl",
    });
  }
  const started = Date.now();
  try {
    const response = await fetchImpl(doclingEndpoint(parsed.data, "health"), {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(DOCLING_PROBE_TIMEOUT_MS),
    });
    const body: unknown = JSON.parse(
      await readBoundedResponse(response, 64 * 1024),
    );
    const status =
      isRecord(body) && typeof body.status === "string" ? body.status : null;
    const ok = response.ok && status === "ok";
    return {
      ok,
      durationMs: Date.now() - started,
      message: ok
        ? "docling-serve is reachable"
        : `docling-serve answered ${response.status}${status ? ` (${status})` : ""}`,
    };
  } catch (error) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      message:
        error instanceof Error && error.name === "TimeoutError"
          ? "docling-serve did not answer within 5 seconds"
          : "docling-serve is not reachable",
    };
  }
}

export async function getIngestionSettingsAsAdmin(
  db: PrismaClient,
  actor: SecurityContext,
): Promise<IngestionSettings> {
  assertSystemAdmin(actor);
  return getIngestionSettings(db);
}

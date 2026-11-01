import {
  DEFAULT_RETENTION_SETTINGS,
  RETENTION_SETTING_KEY,
  retentionSettingsSchema,
  parseRetentionSettings,
  type RetentionSettings,
} from "../diagnostics/retentionSettings";
import { emitDiagnostic } from "../diagnostics/writer";
import { CoreError } from "../errors";
import { assertSystemAdmin, type SecurityContext } from "../security/context";
import { Prisma, type PrismaClient } from "@weaver/db/client";
import { getSystemSetting, setSystemSetting } from "./systemSettings";

const RETENTION_SETTINGS_LOCK = "weaver:retention-settings";

export async function getRetentionSettings(
  db: PrismaClient,
): Promise<RetentionSettings> {
  return parseRetentionSettings(
    await getSystemSetting(db, RETENTION_SETTING_KEY),
  );
}

export type RetentionSettingsPatch = Partial<RetentionSettings>;

export async function setRetentionSettings(
  db: PrismaClient,
  actor: SecurityContext,
  patch: RetentionSettingsPatch,
): Promise<RetentionSettings> {
  assertSystemAdmin(actor);
  const committed = await db.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${RETENTION_SETTINGS_LOCK}, 0)
      )::text
    `);
    const before = parseRetentionSettings(
      await getSystemSetting(tx, RETENTION_SETTING_KEY),
    );
    const parsed = retentionSettingsSchema.safeParse({ ...before, ...patch });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new CoreError("BAD_REQUEST", issue?.message ?? "Invalid setting", {
        field: String(issue?.path[0] ?? "ingestionDays"),
      });
    }
    await setSystemSetting(tx, {
      key: RETENTION_SETTING_KEY,
      value: parsed.data,
      updatedById: actor.userId,
    });
    return { before, after: parsed.data };
  });
  emitDiagnostic({
    event: "settings.changed",
    message: "retention settings changed",
    userId: actor.userId,
    credentialId: actor.credentialId,
    details: {
      setting: RETENTION_SETTING_KEY,
      before: committed.before,
      after: committed.after,
    },
  });
  return committed.after;
}

export { DEFAULT_RETENTION_SETTINGS };

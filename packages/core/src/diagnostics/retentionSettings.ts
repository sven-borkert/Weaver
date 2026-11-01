import { z } from "zod";

export const RETENTION_SETTING_KEY = "retention";

export const retentionSettingsValueSchema = z.object({
  ingestionDays: z.number().int().min(1).max(365),
  assistantConversationDays: z.number().int().min(0).max(730),
  taskRunDays: z.number().int().min(1).max(365),
  aiUsageDays: z.number().int().min(1).max(730),
});
export const retentionSettingsPatchSchema =
  retentionSettingsValueSchema.partial();
export const retentionSettingsSchema = retentionSettingsValueSchema.extend({
  ingestionDays: retentionSettingsValueSchema.shape.ingestionDays.default(30),
  assistantConversationDays:
    retentionSettingsValueSchema.shape.assistantConversationDays.default(90),
  taskRunDays: retentionSettingsValueSchema.shape.taskRunDays.default(30),
  aiUsageDays: retentionSettingsValueSchema.shape.aiUsageDays.default(90),
});
export type RetentionSettings = z.infer<typeof retentionSettingsSchema>;

export const DEFAULT_RETENTION_SETTINGS: RetentionSettings =
  retentionSettingsSchema.parse({});

/** A stored value that no longer validates is treated as defaults, never as an error. */
export function parseRetentionSettings(value: unknown): RetentionSettings {
  const result = retentionSettingsSchema.safeParse(value);
  return result.success ? result.data : DEFAULT_RETENTION_SETTINGS;
}

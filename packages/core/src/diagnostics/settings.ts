import { z } from "zod";

export const DIAGNOSTICS_SETTING_KEY = "diagnostics";
export const DIAGNOSTIC_LEVELS = [
  "off",
  "errors",
  "standard",
  "verbose",
] as const;
export type DiagnosticLevel = (typeof DIAGNOSTIC_LEVELS)[number];

export const diagnosticsSettingsValueSchema = z.object({
  level: z.enum(DIAGNOSTIC_LEVELS),
  retentionDays: z.number().int().min(1).max(90),
  verboseRetentionHours: z.number().int().min(1).max(168),
  maxRows: z.number().int().min(10_000).max(10_000_000),
});
export const diagnosticsSettingsPatchSchema =
  diagnosticsSettingsValueSchema.partial();
export const diagnosticsSettingsSchema = diagnosticsSettingsValueSchema.extend({
  level: diagnosticsSettingsValueSchema.shape.level.default("standard"),
  retentionDays: diagnosticsSettingsValueSchema.shape.retentionDays.default(7),
  verboseRetentionHours:
    diagnosticsSettingsValueSchema.shape.verboseRetentionHours.default(24),
  maxRows: diagnosticsSettingsValueSchema.shape.maxRows.default(1_000_000),
});
export type DiagnosticsSettings = z.infer<typeof diagnosticsSettingsSchema>;

export const DEFAULT_DIAGNOSTICS_SETTINGS: DiagnosticsSettings =
  diagnosticsSettingsSchema.parse({});

/** A stored value that no longer validates is treated as defaults, never as an error. */
export function parseDiagnosticsSettings(value: unknown): DiagnosticsSettings {
  const result = diagnosticsSettingsSchema.safeParse(value);
  return result.success ? result.data : DEFAULT_DIAGNOSTICS_SETTINGS;
}

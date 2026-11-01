import { z } from "zod";

export const INGESTION_SETTING_KEY = "ingestion";

const httpUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, "Enter an http:// or https:// URL");

export const ingestionSettingsValueSchema = z.object({
  doclingBaseUrl: httpUrl.nullable(),
  doclingTimeoutMs: z.number().int().min(1_000).max(600_000),
});
export const ingestionSettingsPatchSchema =
  ingestionSettingsValueSchema.partial();
export const ingestionSettingsSchema = ingestionSettingsValueSchema.extend({
  doclingBaseUrl:
    ingestionSettingsValueSchema.shape.doclingBaseUrl.default(null),
  doclingTimeoutMs:
    ingestionSettingsValueSchema.shape.doclingTimeoutMs.default(120_000),
});
export type IngestionSettings = z.infer<typeof ingestionSettingsSchema>;
export type IngestionSettingsPatch = z.infer<
  typeof ingestionSettingsPatchSchema
>;

export const DEFAULT_INGESTION_SETTINGS: IngestionSettings =
  ingestionSettingsSchema.parse({});

/** A stored value that no longer validates is treated as defaults, never as an error. */
export function parseIngestionSettings(value: unknown): IngestionSettings {
  const result = ingestionSettingsSchema.safeParse(value);
  return result.success ? result.data : DEFAULT_INGESTION_SETTINGS;
}

export function doclingEndpoint(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).href;
}

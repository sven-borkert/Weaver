import { z } from "zod";

export { ingestionSettingsPatchSchema as setIngestionSettingsInput } from "@weaver/core/ingestion/settings";
export const probeDoclingInput = z.object({
  baseUrl: z.string().trim().min(1).max(2048),
});

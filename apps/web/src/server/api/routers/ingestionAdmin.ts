import {
  getIngestionSettingsAsAdmin,
  probeDocling,
  setIngestionSettings,
} from "@weaver/core/services/ingestionSettings";

import {
  probeDoclingInput,
  setIngestionSettingsInput,
} from "~/server/api/schemas/ingestionAdmin";
import { adminProcedure, createTRPCRouter } from "~/server/api/trpc";

export const ingestionAdminRouter = createTRPCRouter({
  getSettings: adminProcedure.query(({ ctx }) =>
    getIngestionSettingsAsAdmin(ctx.db, ctx.security),
  ),
  setSettings: adminProcedure
    .input(setIngestionSettingsInput)
    .mutation(({ ctx, input }) =>
      setIngestionSettings(ctx.db, ctx.security, input),
    ),
  probeDocling: adminProcedure
    .input(probeDoclingInput)
    .mutation(({ ctx, input }) =>
      probeDocling(ctx.db, ctx.security, input, ctx.llmFetch),
    ),
});

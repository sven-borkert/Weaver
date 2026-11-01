import {
  getOidcSettingsAsAdmin,
  testOidcConnectionAsAdmin,
  updateOidcSettings,
} from "@weaver/core/services/oidcSettings";
import {
  oidcSettingsInput,
  testOidcConnectionInput,
} from "~/server/api/schemas/oidc";
import { adminProcedure, createTRPCRouter } from "~/server/api/trpc";
import { oidcSettingsDeps } from "~/server/oidc";

export const oidcRouter = createTRPCRouter({
  getSettings: adminProcedure.query(({ ctx }) =>
    getOidcSettingsAsAdmin(
      ctx.db,
      ctx.security,
      oidcSettingsDeps({
        ring: ctx.encryptionKeys,
        fetchImpl: ctx.oidcFetch,
        fallback: ctx.oidcFallback,
      }),
    ),
  ),
  testConnection: adminProcedure
    .input(testOidcConnectionInput)
    .mutation(({ ctx, input }) =>
      testOidcConnectionAsAdmin(
        ctx.security,
        input.discoveryUrl,
        oidcSettingsDeps({
          ring: ctx.encryptionKeys,
          fetchImpl: ctx.oidcFetch,
          fallback: ctx.oidcFallback,
        }),
      ),
    ),
  updateSettings: adminProcedure
    .input(oidcSettingsInput)
    .mutation(({ ctx, input }) =>
      updateOidcSettings(
        ctx.db,
        ctx.security,
        input,
        oidcSettingsDeps({
          ring: ctx.encryptionKeys,
          fetchImpl: ctx.oidcFetch,
          fallback: ctx.oidcFallback,
        }),
      ),
    ),
});

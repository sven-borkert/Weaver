import { oauthConsentIdInput } from "~/server/api/schemas/oauthConsent";
import { authedProcedure, createTRPCRouter } from "~/server/api/trpc";
import {
  listOAuthConsents,
  revokeOAuthConsent,
} from "@weaver/core/services/oauthConsents";

export const oauthConsentRouter = createTRPCRouter({
  list: authedProcedure.query(({ ctx }) =>
    listOAuthConsents(ctx.db, ctx.security),
  ),

  revoke: authedProcedure
    .input(oauthConsentIdInput)
    .mutation(({ ctx, input }) =>
      revokeOAuthConsent(ctx.db, ctx.security, input.consentId),
    ),
});

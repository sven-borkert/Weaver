import {
  apiKeyIdInput,
  createApiKeyInput,
  updateApiKeyInput,
} from "~/server/api/schemas/apiKey";
import { authedProcedure, createTRPCRouter } from "~/server/api/trpc";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  updateApiKey,
} from "@weaver/core/services/apiKeys";

export const apiKeyRouter = createTRPCRouter({
  list: authedProcedure.query(({ ctx }) => listApiKeys(ctx.db, ctx.security)),

  create: authedProcedure
    .input(createApiKeyInput)
    .mutation(({ ctx, input }) =>
      createApiKey(ctx.db, ctx.security, input, ctx.apiKeyIssuer),
    ),

  update: authedProcedure
    .input(updateApiKeyInput)
    .mutation(({ ctx, input }) => updateApiKey(ctx.db, ctx.security, input)),

  revoke: authedProcedure
    .input(apiKeyIdInput)
    .mutation(({ ctx, input }) =>
      revokeApiKey(ctx.db, ctx.security, input.keyId),
    ),
});

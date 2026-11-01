import {
  createProjectApiKey,
  listProjectApiGrantTargets,
  listProjectApiKeys,
  listUnresolvedProjectApiOperations,
  projectApiConfiguration,
  revokeProjectApiKey,
  updateProjectApiKey,
} from "@weaver/core/services/projectApiKeys";
import { env } from "~/env";
import { authedProcedure, createTRPCRouter } from "~/server/api/trpc";
import {
  createProjectApiKeyInput,
  projectApiKeyIdInput,
  projectApiProjectInput,
  projectApiTargetInput,
  updateProjectApiKeyInput,
} from "~/server/api/schemas/projectApiKey";

export const projectApiKeyRouter = createTRPCRouter({
  list: authedProcedure
    .input(projectApiProjectInput)
    .query(({ ctx, input }) =>
      listProjectApiKeys(ctx.db, ctx.security, input.projectId),
    ),
  create: authedProcedure
    .input(createProjectApiKeyInput)
    .mutation(({ ctx, input }) =>
      createProjectApiKey(ctx.db, ctx.security, input),
    ),
  update: authedProcedure
    .input(updateProjectApiKeyInput)
    .mutation(({ ctx, input }) =>
      updateProjectApiKey(ctx.db, ctx.security, input),
    ),
  revoke: authedProcedure
    .input(projectApiKeyIdInput)
    .mutation(({ ctx, input }) =>
      revokeProjectApiKey(ctx.db, ctx.security, input),
    ),
  targets: authedProcedure
    .input(projectApiTargetInput)
    .query(({ ctx, input }) =>
      listProjectApiGrantTargets(ctx.db, ctx.security, input),
    ),
  configuration: authedProcedure
    .input(projectApiProjectInput)
    .query(({ ctx, input }) =>
      projectApiConfiguration(ctx.db, ctx.security, input.projectId, env),
    ),
  unresolvedOperations: authedProcedure
    .input(projectApiProjectInput)
    .query(({ ctx, input }) =>
      listUnresolvedProjectApiOperations(ctx.db, ctx.security, input.projectId),
    ),
});

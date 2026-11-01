import { resolveScopeSnapshot } from "@weaver/core/assistant/scope";
import {
  createExternalConnection,
  decideExternalApproval,
  deleteExternalConnection,
  discoverExternalConnection,
  getExternalApproval,
  getExternalConnection,
  listAvailableExternalTools,
  listExternalConnections,
  listExternalToolKeys,
  listExternalTools,
  listRunExternalApprovals,
  listRunExternalCalls,
  reviewExternalTools,
  updateExternalConnection,
} from "@weaver/core/services/externalMcp";
import {
  createExternalConnectionInput,
  externalApprovalDecisionInput,
  externalApprovalInput,
  externalApprovalListInput,
  externalCallListInput,
  externalAvailabilityInput,
  externalConnectionIdInput,
  externalConnectionListInput,
  externalToolKeysInput,
  externalToolsInput,
  revisionExternalConnectionInput,
  reviewExternalToolsInput,
  updateExternalConnectionInput,
} from "~/server/api/schemas/externalMcp";
import { authedProcedure, createTRPCRouter } from "~/server/api/trpc";
import { externalMcpRuntime } from "~/server/externalMcp";

export const externalMcpRouter = createTRPCRouter({
  list: authedProcedure
    .input(externalConnectionListInput)
    .query(({ ctx, input }) =>
      listExternalConnections(ctx.db, ctx.security, input),
    ),
  get: authedProcedure
    .input(externalConnectionIdInput)
    .query(({ ctx, input }) =>
      getExternalConnection(ctx.db, ctx.security, input.id),
    ),
  create: authedProcedure
    .input(createExternalConnectionInput)
    .mutation(({ ctx, input }) =>
      createExternalConnection(externalMcpRuntime(ctx), ctx.security, input),
    ),
  update: authedProcedure
    .input(updateExternalConnectionInput)
    .mutation(({ ctx, input }) =>
      updateExternalConnection(externalMcpRuntime(ctx), ctx.security, input),
    ),
  delete: authedProcedure
    .input(revisionExternalConnectionInput)
    .mutation(({ ctx, input }) =>
      deleteExternalConnection(ctx.db, ctx.security, input),
    ),
  discover: authedProcedure
    .input(revisionExternalConnectionInput)
    .mutation(({ ctx, input }) =>
      discoverExternalConnection(externalMcpRuntime(ctx), ctx.security, input),
    ),
  tools: authedProcedure
    .input(externalToolsInput)
    .query(({ ctx, input }) => listExternalTools(ctx.db, ctx.security, input)),
  toolKeys: authedProcedure
    .input(externalToolKeysInput)
    .query(({ ctx, input }) =>
      listExternalToolKeys(ctx.db, ctx.security, input),
    ),
  reviewTools: authedProcedure
    .input(reviewExternalToolsInput)
    .mutation(({ ctx, input }) =>
      reviewExternalTools(externalMcpRuntime(ctx), ctx.security, input),
    ),
  availability: authedProcedure
    .input(externalAvailabilityInput)
    .query(async ({ ctx, input }) => {
      const scope = await resolveScopeSnapshot(
        ctx.db,
        ctx.security,
        input.scope,
      );
      return listAvailableExternalTools(externalMcpRuntime(ctx), ctx.security, {
        scope,
        conversationId: input.conversationId,
      });
    }),
  listCalls: authedProcedure
    .input(externalCallListInput)
    .query(({ ctx, input }) =>
      listRunExternalCalls(
        { db: ctx.db, now: () => new Date() },
        ctx.security,
        input,
      ),
    ),
  listApprovals: authedProcedure
    .input(externalApprovalListInput)
    .query(({ ctx, input }) =>
      listRunExternalApprovals(
        externalMcpRuntime(ctx),
        ctx.security,
        input.runId,
      ),
    ),
  getApproval: authedProcedure
    .input(externalApprovalInput)
    .query(({ ctx, input }) =>
      getExternalApproval(externalMcpRuntime(ctx), ctx.security, input.id),
    ),
  decideApproval: authedProcedure
    .input(externalApprovalDecisionInput)
    .mutation(({ ctx, input }) =>
      decideExternalApproval(externalMcpRuntime(ctx), ctx.security, input),
    ),
});

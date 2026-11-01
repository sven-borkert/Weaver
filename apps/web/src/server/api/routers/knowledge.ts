import {
  knowledgeDocumentInput,
  knowledgeProjectInput,
  knowledgeRetryInput,
} from "~/server/api/schemas/knowledge";
import { authedProcedure, createTRPCRouter } from "~/server/api/trpc";
import {
  getKnowledgeReadiness,
  getKnowledgeStatus,
  requestKnowledgeRebuild,
  retryFailedKnowledge,
} from "@weaver/core/services/knowledge";
import { getDocumentKnowledge } from "@weaver/core/services/knowledgeDocument";

export const knowledgeRouter = createTRPCRouter({
  readiness: authedProcedure
    .input(knowledgeProjectInput)
    .query(({ ctx, input }) =>
      getKnowledgeReadiness(ctx.db, input, ctx.security),
    ),
  status: authedProcedure
    .input(knowledgeProjectInput)
    .query(({ ctx, input }) => getKnowledgeStatus(ctx.db, input, ctx.security)),
  document: authedProcedure
    .input(knowledgeDocumentInput)
    .query(({ ctx, input }) =>
      getDocumentKnowledge(ctx.db, input, ctx.security),
    ),
  rebuild: authedProcedure
    .input(knowledgeProjectInput)
    .mutation(({ ctx, input }) =>
      requestKnowledgeRebuild(ctx.db, input, ctx.security),
    ),
  retryFailed: authedProcedure
    .input(knowledgeRetryInput)
    .mutation(({ ctx, input }) =>
      retryFailedKnowledge(ctx.db, input, ctx.security),
    ),
});

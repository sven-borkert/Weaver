import { authedProcedure, createTRPCRouter } from "~/server/api/trpc";
import { searchKnowledgeInput } from "~/server/api/schemas/search";
import { searchKnowledge } from "@weaver/core/services/search";

export const searchRouter = createTRPCRouter({
  query: authedProcedure
    .input(searchKnowledgeInput)
    .query(({ ctx, input }) => searchKnowledge(ctx.db, input, ctx.security)),
});

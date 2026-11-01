import {
  backgroundWorkListInput,
  backgroundWorkMarkSeenInput,
} from "~/server/api/schemas/backgroundWork";
import { authedProcedure, createTRPCRouter } from "~/server/api/trpc";
import {
  listBackgroundWork,
  getBackgroundWorkSummary,
  markBackgroundWorkSeen,
} from "@weaver/core/services/backgroundWork";
export const backgroundWorkRouter = createTRPCRouter({
  list: authedProcedure
    .input(backgroundWorkListInput)
    .query(({ ctx, input }) => listBackgroundWork(ctx.db, ctx.security, input)),
  summary: authedProcedure.query(({ ctx }) =>
    getBackgroundWorkSummary(ctx.db, ctx.security),
  ),
  markSeen: authedProcedure
    .input(backgroundWorkMarkSeenInput)
    .mutation(({ ctx, input }) =>
      markBackgroundWorkSeen(ctx.db, ctx.security, input),
    ),
});

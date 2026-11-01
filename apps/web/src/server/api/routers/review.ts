import { listDueInput, listRecentInput } from "~/server/api/schemas/review";
import { authedProcedure, createTRPCRouter } from "~/server/api/trpc";
import * as review from "@weaver/core/services/documentReview";
import { actorOf } from "~/server/api/actor";

export const reviewRouter = createTRPCRouter({
  listDue: authedProcedure
    .input(listDueInput)
    .query(({ ctx, input }) =>
      review.listDocumentsToReview(ctx.db, input, actorOf(ctx)),
    ),
  listRecent: authedProcedure
    .input(listRecentInput)
    .query(({ ctx, input }) =>
      review.listRecentlyReviewed(ctx.db, input, actorOf(ctx)),
    ),
  dueCount: authedProcedure.query(async ({ ctx }) => {
    const actor = actorOf(ctx);
    const [count, isReviewer] = await Promise.all([
      review.countDocumentsToReview(ctx.db, actor),
      review.isReviewerAnywhere(ctx.db, actor),
    ]);
    return { count, isReviewer };
  }),
});

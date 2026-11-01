import {
  createGroupInput,
  groupInput,
  projectInput,
  renameGroupInput,
  setDefaultsInput,
  setGroupMembersInput,
} from "~/server/api/schemas/review";
import { authedProcedure, createTRPCRouter } from "~/server/api/trpc";
import * as groups from "@weaver/core/services/reviewerGroups";
import { actorOf } from "~/server/api/actor";

export const reviewerGroupRouter = createTRPCRouter({
  list: authedProcedure
    .input(projectInput)
    .query(({ ctx, input }) =>
      groups.listReviewerGroups(ctx.db, input, actorOf(ctx)),
    ),
  create: authedProcedure
    .input(createGroupInput)
    .mutation(({ ctx, input }) =>
      groups.createReviewerGroup(ctx.db, input, actorOf(ctx)),
    ),
  rename: authedProcedure
    .input(renameGroupInput)
    .mutation(({ ctx, input }) =>
      groups.renameReviewerGroup(ctx.db, input, actorOf(ctx)),
    ),
  setMembers: authedProcedure
    .input(setGroupMembersInput)
    .mutation(({ ctx, input }) =>
      groups.setReviewerGroupMembers(ctx.db, input, actorOf(ctx)),
    ),
  delete: authedProcedure
    .input(groupInput)
    .mutation(({ ctx, input }) =>
      groups.deleteReviewerGroup(ctx.db, input, actorOf(ctx)),
    ),
  getDefaults: authedProcedure
    .input(projectInput)
    .query(({ ctx, input }) =>
      groups.getReviewDefaults(ctx.db, input, actorOf(ctx)),
    ),
  setDefaults: authedProcedure
    .input(setDefaultsInput)
    .mutation(({ ctx, input }) =>
      groups.setReviewDefaults(ctx.db, input, actorOf(ctx)),
    ),
});

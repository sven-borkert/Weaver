import {
  getContentAppearance,
  setContentAppearance,
} from "@weaver/core/services/contentAppearance";
import { actorOf } from "~/server/api/actor";
import {
  getAppearanceInput,
  setAppearanceInput,
} from "~/server/api/schemas/appearance";
import { authedProcedure, createTRPCRouter } from "~/server/api/trpc";

export const appearanceRouter = createTRPCRouter({
  get: authedProcedure
    .input(getAppearanceInput)
    .query(({ ctx, input }) =>
      getContentAppearance(ctx.db, input.target, actorOf(ctx)),
    ),
  set: authedProcedure
    .input(setAppearanceInput)
    .mutation(({ ctx, input }) =>
      setContentAppearance(ctx.db, input, actorOf(ctx)),
    ),
});

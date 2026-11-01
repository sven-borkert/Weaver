import {
  getRecentContent,
  listDashboardActivity,
  getReportShortcuts,
  getProjectOverview,
  listProjectPinCandidates,
  pinProjectContent,
  unpinProjectContent,
} from "@weaver/core/services/dashboard";
import {
  activityInput,
  recentContentInput,
  projectOverviewInput,
  reportsInput,
  pinCandidatesInput,
  pinContentInput,
  unpinContentInput,
} from "~/server/api/schemas/dashboard";
import { authedProcedure, createTRPCRouter } from "~/server/api/trpc";

export const dashboardRouter = createTRPCRouter({
  recentContent: authedProcedure
    .input(recentContentInput)
    .query(({ ctx, input }) => getRecentContent(ctx.db, ctx.security, input)),
  activity: authedProcedure
    .input(activityInput)
    .query(({ ctx, input }) =>
      listDashboardActivity(ctx.db, ctx.security, input),
    ),
  reports: authedProcedure
    .input(reportsInput)
    .query(({ ctx, input }) => getReportShortcuts(ctx.db, ctx.security, input)),
  projectOverview: authedProcedure
    .input(projectOverviewInput)
    .query(({ ctx, input }) => getProjectOverview(ctx.db, ctx.security, input)),
  pinCandidates: authedProcedure
    .input(pinCandidatesInput)
    .query(({ ctx, input }) =>
      listProjectPinCandidates(ctx.db, ctx.security, input),
    ),
  pin: authedProcedure
    .input(pinContentInput)
    .mutation(({ ctx, input }) =>
      pinProjectContent(ctx.db, ctx.security, input),
    ),
  unpin: authedProcedure
    .input(unpinContentInput)
    .mutation(({ ctx, input }) =>
      unpinProjectContent(ctx.db, ctx.security, input),
    ),
});

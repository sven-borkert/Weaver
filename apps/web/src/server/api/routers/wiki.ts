import { authedProcedure, createTRPCRouter } from "~/server/api/trpc";
import * as wiki from "@weaver/core/services/wikiSettings";
import {
  approveWikiGuideInput,
  resolveWikiSuggestionInput,
  setWikiGuideDocumentInput,
  updateWikiSettingsInput,
  wikiProjectInput as projectInput,
  wikiRevisionInput as revisionInput,
} from "~/server/api/schemas/wiki";

export const wikiRouter = createTRPCRouter({
  settings: authedProcedure
    .input(projectInput)
    .query(({ ctx, input }) =>
      wiki.getWikiSettings(ctx.db, ctx.security, input.projectId),
    ),
  enable: authedProcedure
    .input(revisionInput)
    .mutation(({ ctx, input }) => wiki.enableWiki(ctx.db, ctx.security, input)),
  disable: authedProcedure
    .input(revisionInput)
    .mutation(({ ctx, input }) =>
      wiki.disableWiki(ctx.db, ctx.security, input),
    ),
  revokeAgent: authedProcedure
    .input(revisionInput)
    .mutation(({ ctx, input }) =>
      wiki.revokeAgent(ctx.db, ctx.security, input),
    ),
  update: authedProcedure
    .input(updateWikiSettingsInput)
    .mutation(({ ctx, input }) =>
      wiki.updateWikiSettings(ctx.db, ctx.security, input),
    ),
  setGuideDocument: authedProcedure
    .input(setWikiGuideDocumentInput)
    .mutation(({ ctx, input }) =>
      wiki.setGuideDocument(ctx.db, ctx.security, input),
    ),
  reviewGuide: authedProcedure
    .input(projectInput)
    .query(({ ctx, input }) =>
      wiki.reviewGuide(ctx.db, ctx.security, input.projectId),
    ),
  approveGuide: authedProcedure
    .input(approveWikiGuideInput)
    .mutation(({ ctx, input }) =>
      wiki.approveGuide(ctx.db, ctx.security, input),
    ),
  suggestions: authedProcedure
    .input(projectInput)
    .query(({ ctx, input }) =>
      wiki.listGuideSuggestions(ctx.db, ctx.security, input.projectId),
    ),
  resolveSuggestion: authedProcedure
    .input(resolveWikiSuggestionInput)
    .mutation(({ ctx, input }) =>
      wiki.resolveGuideSuggestion(ctx.db, ctx.security, input),
    ),
});

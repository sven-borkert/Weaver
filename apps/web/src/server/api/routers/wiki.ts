import { authedProcedure, createTRPCRouter } from "~/server/api/trpc";
import * as wiki from "@weaver/core/services/wikiSettings";
import * as inputs from "@weaver/core/services/wikiInputs";
import { cancelRun } from "@weaver/core/services/wikiRuns";
import {
  acceptClassifyPlan,
  rejectClassifyPlan,
  startClassify,
} from "@weaver/core/services/wikiClassify";
import { startMaintenance } from "@weaver/core/services/wikiLint";
import { wikiSaveTarget } from "@weaver/core/services/wikiSaveTarget";
import { startRevert } from "@weaver/core/services/wikiRevert";
import {
  getRun,
  listRuns,
  wikiUsageSummary,
} from "@weaver/core/services/wikiRunViews";
import { env } from "~/env";
import {
  acceptWikiClassifyInput,
  addWikiFilesInput,
  addWikiTextInput,
  cancelWikiRunInput,
  confirmWikiInput,
  listWikiRunsInput,
  processWikiInputs,
  wikiInputItemInput,
  approveWikiGuideInput,
  resolveWikiSuggestionInput,
  setWikiGuideDocumentInput,
  updateWikiSettingsInput,
  wikiProjectInput as projectInput,
  wikiRevisionInput as revisionInput,
} from "~/server/api/schemas/wiki";

const inputRouter = createTRPCRouter({
  list: authedProcedure
    .input(projectInput)
    .query(({ ctx, input }) => inputs.listInputs(ctx.db, ctx.security, input)),
  addText: authedProcedure
    .input(addWikiTextInput)
    .mutation(({ ctx, input }) =>
      inputs.addTextInput(ctx.db, ctx.security, input),
    ),
  addFiles: authedProcedure
    .input(addWikiFilesInput)
    .mutation(({ ctx, input }) =>
      inputs.addFileInputs(ctx.db, ctx.security, input, {
        dataDir: env.WEAVER_DATA_DIR,
        maxFileBytes: env.WEAVER_INGESTION_MAX_FILE_BYTES,
      }),
    ),
  process: authedProcedure
    .input(processWikiInputs)
    .mutation(({ ctx, input }) =>
      inputs.processInputs(ctx.db, ctx.security, input),
    ),
  retry: authedProcedure
    .input(wikiInputItemInput)
    .mutation(({ ctx, input }) =>
      inputs.retryInput(ctx.db, ctx.security, input),
    ),
  confirm: authedProcedure
    .input(confirmWikiInput)
    .mutation(({ ctx, input }) =>
      inputs.confirmInput(ctx.db, ctx.security, input),
    ),
  remove: authedProcedure
    .input(wikiInputItemInput)
    .mutation(({ ctx, input }) =>
      inputs.removeInput(ctx.db, ctx.security, input),
    ),
  unlinkArtifact: authedProcedure
    .input(wikiInputItemInput)
    .mutation(({ ctx, input }) =>
      inputs.unlinkInputArtifact(ctx.db, ctx.security, input),
    ),
});

export const wikiRouter = createTRPCRouter({
  input: inputRouter,
  cancelRun: authedProcedure
    .input(cancelWikiRunInput)
    .mutation(({ ctx, input }) => cancelRun(ctx.db, ctx.security, input)),
  runs: authedProcedure
    .input(listWikiRunsInput)
    .query(({ ctx, input }) => listRuns(ctx.db, ctx.security, input)),
  run: authedProcedure
    .input(cancelWikiRunInput)
    .query(({ ctx, input }) => getRun(ctx.db, ctx.security, input)),
  usage: authedProcedure
    .input(projectInput)
    .query(({ ctx, input }) => wikiUsageSummary(ctx.db, ctx.security, input)),
  revertRun: authedProcedure
    .input(cancelWikiRunInput)
    .mutation(({ ctx, input }) => startRevert(ctx.db, ctx.security, input)),
  runMaintenance: authedProcedure
    .input(projectInput)
    .mutation(({ ctx, input }) =>
      startMaintenance(ctx.db, ctx.security, input),
    ),
  classify: authedProcedure
    .input(projectInput)
    .mutation(({ ctx, input }) => startClassify(ctx.db, ctx.security, input)),
  acceptClassify: authedProcedure
    .input(acceptWikiClassifyInput)
    .mutation(({ ctx, input }) =>
      acceptClassifyPlan(ctx.db, ctx.security, input),
    ),
  rejectClassify: authedProcedure
    .input(cancelWikiRunInput)
    .mutation(({ ctx, input }) =>
      rejectClassifyPlan(ctx.db, ctx.security, input),
    ),
  saveTarget: authedProcedure
    .input(projectInput)
    .query(({ ctx, input }) => wikiSaveTarget(ctx.db, ctx.security, input)),
  clearLintPause: authedProcedure
    .input(revisionInput)
    .mutation(({ ctx, input }) =>
      wiki.clearLintPause(ctx.db, ctx.security, input),
    ),
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

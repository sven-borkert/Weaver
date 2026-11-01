import {
  acceptDraft,
  rejectDraft,
} from "@weaver/core/services/ingestionAccept";
import { actorOf } from "~/server/api/actor";
import { env } from "~/env";
import { CoreError } from "@weaver/core/errors";
import { requestKnowledgeJob } from "@weaver/core/jobs/queue";
import { parseKnowledgeConfig } from "@weaver/core/knowledge/config";
import * as ingestion from "@weaver/core/services/ingestion";
import {
  acceptDraftInput,
  batchIdInput,
  fileIdInput,
  listBatchesInput,
  updateDraftInput,
} from "~/server/api/schemas/ingestion";
import { authedProcedure, createTRPCRouter } from "~/server/api/trpc";

const retryPublicationError = () =>
  new CoreError(
    "INTERNAL_SERVER_ERROR",
    "retry was stored but job publication failed",
  );

export const ingestionRouter = createTRPCRouter({
  listBatches: authedProcedure
    .input(listBatchesInput)
    .query(({ ctx, input }) =>
      ingestion.listBatches(ctx.db, ctx.security, input),
    ),
  getBatch: authedProcedure
    .input(batchIdInput)
    .query(({ ctx, input }) => ingestion.getBatch(ctx.db, ctx.security, input)),
  getFile: authedProcedure
    .input(fileIdInput)
    .query(({ ctx, input }) => ingestion.getFile(ctx.db, ctx.security, input)),
  updateDraft: authedProcedure
    .input(updateDraftInput)
    .mutation(({ ctx, input }) =>
      ingestion.updateDraft(ctx.db, ctx.security, input),
    ),
  accept: authedProcedure
    .input(acceptDraftInput)
    .mutation(({ ctx, input }) => acceptDraft(ctx.db, actorOf(ctx), input)),
  reject: authedProcedure
    .input(fileIdInput)
    .mutation(({ ctx, input }) => rejectDraft(ctx.db, ctx.security, input)),
  retry: authedProcedure.input(fileIdInput).mutation(async ({ ctx, input }) => {
    if (!parseKnowledgeConfig(process.env).jobsEnabled) {
      throw new CoreError(
        "PRECONDITION_FAILED",
        "background jobs are disabled",
      );
    }
    const result = await ingestion.retryFile(ctx.db, ctx.security, input);
    let jobId: string | null;
    try {
      jobId = await requestKnowledgeJob(
        ingestion.INGESTION_STAGE_JOBS[result.stage],
        {
          fileId: result.fileId,
          projectId: result.projectId,
          contentDigest: result.contentDigest,
          baseAttemptCount: result.attemptCount,
        },
      );
    } catch {
      throw retryPublicationError();
    }
    if (jobId === null) throw retryPublicationError();
    return result;
  }),
  deleteBatch: authedProcedure
    .input(batchIdInput)
    .mutation(async ({ ctx, input }) => {
      return ingestion.deleteBatch(ctx.db, ctx.security, input, {
        dataDir: env.WEAVER_DATA_DIR,
      });
    }),
});

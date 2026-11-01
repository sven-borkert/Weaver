import * as folderReview from "@weaver/core/services/folderReview";
import { createTRPCRouter, authedProcedure } from "~/server/api/trpc";
import {
  createFolderInput,
  folderReviewTargetInput,
  folderReviewInput,
  setFolderReviewInput,
  clearFolderReviewInput,
  deleteFolderInput,
  folderTreeInput,
  moveFolderInput,
  renameFolderInput,
} from "~/server/api/schemas/folder";
import * as folders from "@weaver/core/services/folders";
import { actorOf } from "~/server/api/actor";

export const folderRouter = createTRPCRouter({
  reviewDefaults: authedProcedure
    .input(folderReviewTargetInput)
    .query(({ ctx, input }) =>
      folderReview.getFolderReviewDefaults(ctx.db, input, actorOf(ctx)),
    ),
  previewReview: authedProcedure
    .input(folderReviewInput)
    .query(({ ctx, input }) =>
      folderReview.previewFolderReview(ctx.db, input, actorOf(ctx)),
    ),
  setReviewRecursively: authedProcedure
    .input(setFolderReviewInput)
    .mutation(({ ctx, input }) =>
      folderReview.setFolderReviewRecursively(ctx.db, input, actorOf(ctx)),
    ),
  clearReviewDefault: authedProcedure
    .input(clearFolderReviewInput)
    .mutation(({ ctx, input }) =>
      folderReview.clearFolderReviewDefault(ctx.db, input, actorOf(ctx)),
    ),
  previewMarkReviewed: authedProcedure
    .input(folderReviewTargetInput)
    .query(({ ctx, input }) =>
      folderReview.previewFolderMarkReviewed(ctx.db, input, actorOf(ctx)),
    ),
  markReviewedRecursively: authedProcedure
    .input(clearFolderReviewInput)
    .mutation(({ ctx, input }) =>
      folderReview.markFolderReviewed(ctx.db, input, actorOf(ctx)),
    ),
  tree: authedProcedure
    .input(folderTreeInput)
    .query(({ ctx, input }) => folders.getTree(ctx.db, input, actorOf(ctx))),
  create: authedProcedure
    .input(createFolderInput)
    .mutation(({ ctx, input }) =>
      folders.createFolder(ctx.db, input, actorOf(ctx)),
    ),
  rename: authedProcedure
    .input(renameFolderInput)
    .mutation(({ ctx, input }) =>
      folders.renameFolder(ctx.db, input, actorOf(ctx)),
    ),
  move: authedProcedure
    .input(moveFolderInput)
    .mutation(({ ctx, input }) =>
      folders.moveFolder(ctx.db, input, actorOf(ctx)),
    ),
  delete: authedProcedure
    .input(deleteFolderInput)
    .mutation(({ ctx, input }) =>
      folders.deleteFolder(ctx.db, input, actorOf(ctx)),
    ),
});

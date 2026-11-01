import type { JSONContent } from "@tiptap/core";
import {
  createDocumentInput,
  diffInput,
  documentIdInput,
  documentBacklinksInput,
  historyInput,
  importFileInput,
  listDocumentsInput,
  moveDocumentInput,
  rebuildIndexInput,
  resolveRefsInput,
  restoreInput,
  updateDocumentInput,
} from "~/server/api/schemas/document";
import { markReviewedInput, setReviewInput } from "~/server/api/schemas/review";
import { authedProcedure, createTRPCRouter } from "~/server/api/trpc";
import * as documents from "@weaver/core/services/documents";
import type { DocumentContentInput } from "@weaver/core/services/documents";
import { saveDocumentAndQueueSummary } from "@weaver/core/services/documentChangeSummaries";
import * as review from "@weaver/core/services/documentReview";
import { importDocumentFile } from "@weaver/core/services/documentImport";
import { actorOf } from "~/server/api/actor";

export const documentRouter = createTRPCRouter({
  rebuildIndex: authedProcedure
    .input(rebuildIndexInput)
    .mutation(({ ctx, input }) =>
      documents.rebuildIndex(ctx.db, input, actorOf(ctx)),
    ),
  list: authedProcedure
    .input(listDocumentsInput)
    .query(({ ctx, input }) =>
      documents.listDocuments(ctx.db, input, actorOf(ctx)),
    ),
  get: authedProcedure
    .input(documentIdInput)
    .query(({ ctx, input }) =>
      documents.getDocument(ctx.db, input, actorOf(ctx)),
    ),
  create: authedProcedure
    .input(createDocumentInput)
    .mutation(({ ctx, input: { contentJson, ...input } }) =>
      documents.createDocument(
        ctx.db,
        {
          ...input,
          content: {
            kind: "markdown",
            contentJson: contentJson as JSONContent,
          },
        },
        actorOf(ctx),
      ),
    ),
  importFile: authedProcedure
    .input(importFileInput)
    .mutation(({ ctx, input }) =>
      importDocumentFile(ctx.db, input, actorOf(ctx)),
    ),
  update: authedProcedure
    .input(updateDocumentInput)
    .mutation(({ ctx, input }) =>
      saveDocumentAndQueueSummary(
        ctx.db,
        { ...input, content: input.content as DocumentContentInput },
        actorOf(ctx),
      ),
    ),
  markReviewed: authedProcedure
    .input(markReviewedInput)
    .mutation(({ ctx, input }) =>
      review.markDocumentReviewed(ctx.db, input, actorOf(ctx)),
    ),
  setReview: authedProcedure
    .input(setReviewInput)
    .mutation(({ ctx, input }) =>
      review.setDocumentReview(ctx.db, input, actorOf(ctx)),
    ),
  reviewPermissions: authedProcedure
    .input(documentIdInput)
    .query(({ ctx, input }) =>
      review.reviewPermissions(
        ctx.db,
        input.projectId,
        input.documentId,
        actorOf(ctx),
      ),
    ),
  history: authedProcedure
    .input(historyInput)
    .query(({ ctx, input }) =>
      documents.getHistory(ctx.db, input, actorOf(ctx)),
    ),
  diff: authedProcedure
    .input(diffInput)
    .query(({ ctx, input }) => documents.getDiff(ctx.db, input, actorOf(ctx))),
  restore: authedProcedure
    .input(restoreInput)
    .mutation(({ ctx, input }) =>
      documents.restoreDocument(ctx.db, input, actorOf(ctx)),
    ),
  move: authedProcedure
    .input(moveDocumentInput)
    .mutation(({ ctx, input }) =>
      documents.moveDocument(ctx.db, input, actorOf(ctx)),
    ),
  delete: authedProcedure
    .input(documentIdInput)
    .mutation(({ ctx, input }) =>
      documents.deleteDocument(ctx.db, input, actorOf(ctx)),
    ),
  resolveRefs: authedProcedure
    .input(resolveRefsInput)
    .query(({ ctx, input }) =>
      documents.resolveRefs(ctx.db, input, actorOf(ctx)),
    ),
  backlinks: authedProcedure
    .input(documentBacklinksInput)
    .query(({ ctx, input }) =>
      documents.getBacklinks(ctx.db, input, actorOf(ctx)),
    ),
});

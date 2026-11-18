import {
  createLocalDocumentEntry,
  deleteLocalDocumentEntry,
  getLocalDocumentEntry,
  listLocalDocumentEntries,
  updateLocalDocumentEntry,
} from "@weaver/core/services/localDocuments";
import {
  createLocalDocumentInput,
  deleteLocalDocumentInput,
  localDocumentIdInput,
  updateLocalDocumentInput,
} from "~/server/api/schemas/localDocument";
import { projectIdInput } from "~/server/api/schemas/project";
import { authedProcedure, createTRPCRouter } from "~/server/api/trpc";

export const localDocumentRouter = createTRPCRouter({
  list: authedProcedure
    .input(projectIdInput)
    .query(({ ctx, input }) =>
      listLocalDocumentEntries(ctx.db, input, ctx.security),
    ),
  get: authedProcedure
    .input(localDocumentIdInput)
    .query(({ ctx, input: { projectId, entryId } }) =>
      getLocalDocumentEntry(ctx.db, { projectId, id: entryId }, ctx.security),
    ),
  create: authedProcedure
    .input(createLocalDocumentInput)
    .mutation(({ ctx, input }) =>
      createLocalDocumentEntry(ctx.db, input, ctx.security),
    ),
  update: authedProcedure
    .input(updateLocalDocumentInput)
    .mutation(({ ctx, input: { entryId, revision, ...input } }) =>
      updateLocalDocumentEntry(
        ctx.db,
        { ...input, id: entryId, expectedRevision: revision },
        ctx.security,
      ),
    ),
  delete: authedProcedure
    .input(deleteLocalDocumentInput)
    .mutation(({ ctx, input: { projectId, entryId, revision } }) =>
      deleteLocalDocumentEntry(
        ctx.db,
        { projectId, id: entryId, expectedRevision: revision },
        ctx.security,
      ),
    ),
});

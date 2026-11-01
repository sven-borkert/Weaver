import { authedProcedure, createTRPCRouter } from "~/server/api/trpc";
import * as remote from "@weaver/core/services/projectGitRemote";
import {
  projectGitRemoteInput as projectInput,
  projectGitRemoteRevisionInput as revisionInput,
  saveProjectGitRemoteInput,
  uploadProjectGitRemoteKeyInput,
} from "~/server/api/schemas/projectGitRemote";

export const projectGitRemoteRouter = createTRPCRouter({
  get: authedProcedure
    .input(projectInput)
    .query(({ ctx, input }) =>
      remote.getProjectGitRemote(ctx.db, ctx.security, input.projectId),
    ),
  save: authedProcedure
    .input(saveProjectGitRemoteInput)
    .mutation(({ ctx, input }) =>
      remote.saveProjectGitRemote(ctx.db, ctx.security, input),
    ),
  uploadKey: authedProcedure
    .input(uploadProjectGitRemoteKeyInput)
    .mutation(({ ctx, input }) =>
      remote.uploadProjectGitRemoteKey(
        { db: ctx.db, ring: ctx.encryptionKeys },
        ctx.security,
        input,
      ),
    ),
  deleteKey: authedProcedure
    .input(revisionInput)
    .mutation(({ ctx, input }) =>
      remote.deleteProjectGitRemoteKey(ctx.db, ctx.security, input),
    ),
  remove: authedProcedure
    .input(revisionInput)
    .mutation(({ ctx, input }) =>
      remote.removeProjectGitRemote(ctx.db, ctx.security, input),
    ),
  pushNow: authedProcedure
    .input(projectInput)
    .mutation(({ ctx, input }) =>
      remote.requestProjectGitRemotePush(ctx.db, ctx.security, input.projectId),
    ),
  pull: authedProcedure
    .input(projectInput)
    .mutation(({ ctx, input }) =>
      remote.requestProjectGitRemotePull(ctx.db, ctx.security, input.projectId),
    ),
});

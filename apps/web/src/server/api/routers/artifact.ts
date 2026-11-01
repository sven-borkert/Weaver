import {
  deleteArtifact,
  listArtifacts,
  renameArtifact,
} from "@weaver/core/services/artifacts";
import {
  artifactIdInput,
  listArtifactsInput,
  renameArtifactInput,
} from "~/server/api/schemas/artifact";
import { authedProcedure, createTRPCRouter } from "~/server/api/trpc";
import { env } from "~/env";

export const artifactRouter = createTRPCRouter({
  list: authedProcedure
    .input(listArtifactsInput)
    .query(({ ctx, input }) => listArtifacts(ctx.db, ctx.security, input)),
  rename: authedProcedure
    .input(renameArtifactInput)
    .mutation(({ ctx, input }) => renameArtifact(ctx.db, ctx.security, input)),
  delete: authedProcedure.input(artifactIdInput).mutation(({ ctx, input }) =>
    deleteArtifact(ctx.db, ctx.security, input, {
      dataDir: env.WEAVER_DATA_DIR,
    }),
  ),
});

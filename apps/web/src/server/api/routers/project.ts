import { authedProcedure, createTRPCRouter } from "~/server/api/trpc";
import {
  createProjectInput,
  projectIdInput,
  updateProjectInput,
} from "~/server/api/schemas/project";
import {
  createProject,
  getProjectForActor,
  listProjectsForUser,
  softDeleteProject,
  updateProject,
} from "@weaver/core/services/projects";

export const projectRouter = createTRPCRouter({
  list: authedProcedure.query(({ ctx }) =>
    listProjectsForUser(ctx.db, ctx.security),
  ),

  get: authedProcedure
    .input(projectIdInput)
    .query(({ ctx, input }) =>
      getProjectForActor(ctx.db, input.projectId, ctx.security),
    ),

  create: authedProcedure
    .input(createProjectInput)
    .mutation(({ ctx, input }) => createProject(ctx.db, ctx.security, input)),

  update: authedProcedure.input(updateProjectInput).mutation(({ ctx, input }) =>
    updateProject(ctx.db, input.projectId, ctx.security, {
      name: input.name,
      description: input.description,
    }),
  ),

  delete: authedProcedure
    .input(projectIdInput)
    .mutation(({ ctx, input }) =>
      softDeleteProject(ctx.db, input.projectId, ctx.security),
    ),
});

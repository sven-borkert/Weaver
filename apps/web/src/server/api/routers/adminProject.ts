import {
  adminProjectIdInput,
  listAdminProjectsInput,
} from "~/server/api/schemas/adminProject";
import { adminProcedure, createTRPCRouter } from "~/server/api/trpc";
import {
  getAdminProject,
  listAdminProjects,
} from "@weaver/core/services/adminProjects";

export const adminProjectRouter = createTRPCRouter({
  list: adminProcedure
    .input(listAdminProjectsInput)
    .query(({ ctx, input }) => listAdminProjects(ctx.db, ctx.security, input)),

  get: adminProcedure
    .input(adminProjectIdInput)
    .query(({ ctx, input }) =>
      getAdminProject(ctx.db, ctx.security, input.projectId),
    ),
});

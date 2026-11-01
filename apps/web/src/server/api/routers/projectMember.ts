import { setTrainingRole } from "@weaver/core/services/projectTraining";
import { setTrainingRoleInput } from "~/server/api/schemas/projectMember";
import { authedProcedure, createTRPCRouter } from "~/server/api/trpc";
import {
  addMemberInput,
  listMembersInput,
  removeMemberInput,
  updateMemberRoleInput,
} from "~/server/api/schemas/projectMember";
import {
  addMember,
  listMembers,
  removeMember,
  updateMemberRole,
} from "@weaver/core/services/projectMembers";

export const projectMemberRouter = createTRPCRouter({
  setTrainingRole: authedProcedure
    .input(setTrainingRoleInput)
    .mutation(({ ctx, input }) => setTrainingRole(ctx.db, ctx.security, input)),
  list: authedProcedure
    .input(listMembersInput)
    .query(({ ctx, input }) =>
      listMembers(ctx.db, input.projectId, ctx.security),
    ),

  add: authedProcedure
    .input(addMemberInput)
    .mutation(({ ctx, input }) =>
      addMember(
        ctx.db,
        { projectId: input.projectId, email: input.email, role: input.role },
        ctx.security,
      ),
    ),

  updateRole: authedProcedure
    .input(updateMemberRoleInput)
    .mutation(({ ctx, input }) =>
      updateMemberRole(
        ctx.db,
        { projectId: input.projectId, userId: input.userId, role: input.role },
        ctx.security,
      ),
    ),

  remove: authedProcedure
    .input(removeMemberInput)
    .mutation(({ ctx, input }) =>
      removeMember(
        ctx.db,
        { projectId: input.projectId, userId: input.userId },
        ctx.security,
      ),
    ),
});

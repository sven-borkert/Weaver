import {
  createUserInput,
  deactivateUserInput,
  listUsersInput,
  resetPasswordInput,
  setMembershipInput,
  setUserRoleInput,
  userIdInput,
} from "~/server/api/schemas/user";
import { adminProcedure, createTRPCRouter } from "~/server/api/trpc";
import {
  createUser,
  deactivateUser,
  getUser,
  listProjectsForAdmin,
  listUsers,
  reactivateUser,
  resetUserPassword,
  revokeUserSessions,
  setUserMembership,
  setUserRole,
} from "@weaver/core/services/users";

export const userRouter = createTRPCRouter({
  list: adminProcedure
    .input(listUsersInput)
    .query(({ ctx, input }) => listUsers(ctx.db, ctx.security, input)),

  get: adminProcedure
    .input(userIdInput)
    .query(({ ctx, input }) => getUser(ctx.db, ctx.security, input.userId)),

  listProjects: adminProcedure.query(({ ctx }) =>
    listProjectsForAdmin(ctx.db, ctx.security),
  ),

  create: adminProcedure
    .input(createUserInput)
    .mutation(({ ctx, input }) =>
      createUser(ctx.db, ctx.security, input, ctx.userAdministrator),
    ),

  setRole: adminProcedure
    .input(setUserRoleInput)
    .mutation(({ ctx, input }) =>
      setUserRole(ctx.db, ctx.security, input, ctx.userAdministrator),
    ),

  deactivate: adminProcedure
    .input(deactivateUserInput)
    .mutation(({ ctx, input }) =>
      deactivateUser(ctx.db, ctx.security, input, ctx.userAdministrator),
    ),

  reactivate: adminProcedure
    .input(userIdInput)
    .mutation(({ ctx, input }) =>
      reactivateUser(ctx.db, ctx.security, input.userId, ctx.userAdministrator),
    ),

  resetPassword: adminProcedure
    .input(resetPasswordInput)
    .mutation(({ ctx, input }) =>
      resetUserPassword(ctx.db, ctx.security, input, ctx.userAdministrator),
    ),

  revokeSessions: adminProcedure
    .input(userIdInput)
    .mutation(({ ctx, input }) =>
      revokeUserSessions(
        ctx.db,
        ctx.security,
        input.userId,
        ctx.userAdministrator,
      ),
    ),

  setMembership: adminProcedure
    .input(setMembershipInput)
    .mutation(({ ctx, input }) =>
      setUserMembership(ctx.db, ctx.security, input),
    ),
});

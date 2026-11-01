import { z } from "zod";

import { CoreError } from "@weaver/core/errors";
import { changeOwnPassword } from "@weaver/core/services/users";
import {
  recordLastOpenedProject,
  resolveLandingProjectId,
} from "@weaver/core/services/landingProject";

import { actorOf } from "~/server/api/actor";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "~/server/api/schemas/user";
import { authedProcedure, createTRPCRouter } from "~/server/api/trpc";

/**
 * Structural match, not `instanceof` — mirrors
 * `isDuplicateEmailAdministratorError` in packages/core/src/services/users.ts:
 * packages/core doesn't take a dependency on better-auth's error class for a
 * value @weaver/auth already treats as internal, and neither does this thin
 * router. Verified against better-auth's changePassword endpoint
 * (better-auth/dist/api/routes/update-user.mjs): a wrong current password
 * throws `APIError.from("BAD_REQUEST", BASE_ERROR_CODES.INVALID_PASSWORD)`.
 */
function isInvalidCurrentPasswordError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { name, status, body } = error as {
    name?: unknown;
    status?: unknown;
    body?: unknown;
  };
  if (name !== "APIError" || status !== "BAD_REQUEST") return false;
  if (typeof body !== "object" || body === null) return false;
  return (body as { code?: unknown }).code === "INVALID_PASSWORD";
}

// The session was revoked (for example by an admin reset) while this waited.
function isSessionGoneError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { name, status } = error as { name?: unknown; status?: unknown };
  return name === "APIError" && status === "UNAUTHORIZED";
}

export const accountRouter = createTRPCRouter({
  me: authedProcedure.query(({ ctx }) => ({
    id: ctx.session.user.id,
    email: ctx.session.user.email,
    name: ctx.session.user.name,
    role: ctx.session.user.role,
  })),

  landingProject: authedProcedure.query(async ({ ctx }) => ({
    projectId: await resolveLandingProjectId(ctx.db, ctx.session.user.id),
  })),

  recordLastOpenedProject: authedProcedure
    .input(z.object({ projectId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      recordLastOpenedProject(ctx.db, actorOf(ctx), input.projectId),
    ),

  changePassword: authedProcedure
    .input(
      z.object({
        currentPassword: z.string().min(1).max(200),
        newPassword: z
          .string()
          .min(PASSWORD_MIN_LENGTH)
          .max(PASSWORD_MAX_LENGTH),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      let setCookies: string[];
      try {
        ({ setCookies } = await changeOwnPassword(
          ctx.db,
          ctx.session.user.id,
          () =>
            ctx.passwordChanger.change({
              headers: ctx.headers,
              currentPassword: input.currentPassword,
              newPassword: input.newPassword,
            }),
        ));
      } catch (error) {
        if (isSessionGoneError(error)) {
          throw new CoreError("UNAUTHORIZED", "Sign in again to continue");
        }
        if (isInvalidCurrentPasswordError(error)) {
          throw new CoreError("BAD_REQUEST", "Current password is incorrect", {
            field: "currentPassword",
          });
        }
        throw error;
      }
      for (const cookie of setCookies) {
        ctx.resHeaders?.append("set-cookie", cookie);
      }
    }),
});

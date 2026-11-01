import { createLocalAccountIssuer } from "@better-auth/core/db";
import type { GlobalRole, WeaverAuth } from "./index";

/**
 * Better Auth's admin plugin only types `role` from `opts.roles` (a custom
 * AccessControl map); with just `adminRoles`/`defaultRole` strings (this
 * repo's config) it falls back to `"user" | "admin"` regardless of their
 * actual value, so `GlobalRole` ("Admin" | "User") never matches statically.
 * The endpoint's runtime schema is a plain `z.string()` and the value is
 * written through unchanged (`better-auth/dist/plugins/admin/routes.mjs`),
 * so this alias documents the gap instead of asserting to `any`/`never`.
 */
type CreateUserRole = NonNullable<
  NonNullable<Parameters<WeaverAuth["api"]["createUser"]>[0]>["body"]["role"]
>;

export type UserAdministrator = {
  create(input: {
    email: string;
    name: string;
    password: string;
    role: GlobalRole;
    mustChangePassword: boolean;
  }): Promise<{ id: string }>;
  setRole(input: { userId: string; role: GlobalRole }): Promise<void>;
  ban(input: { userId: string; reason: string }): Promise<void>;
  unban(input: { userId: string }): Promise<void>;
  setPassword(input: { userId: string; password: string }): Promise<void>;
  revokeSessions(input: { userId: string }): Promise<void>;
};

/**
 * Wraps Better Auth's admin surface; Weaver supplies the authorization in
 * core-services. The plugin's HTTP routes stay disabled.
 *
 * `create` calls `auth.api.createUser` directly: that handler only rejects a
 * missing session when `ctx.request`/`ctx.headers` are set, so a server call
 * with just `{ body }` is treated as trusted, exactly like
 * `createApiKeyIssuer`'s `auth.api.createApiKey` call.
 *
 * The other five methods are NOT reachable the same way. Their handlers
 * (`/admin/set-role`, `/admin/ban-user`, `/admin/unban-user`,
 * `/admin/set-user-password`, `/admin/revoke-user-sessions`) run behind
 * `adminMiddleware`, which unconditionally throws UNAUTHORIZED when there is
 * no session -- headers or not -- and `/admin/set-role` also sets
 * `requireHeaders: true`, which rejects a headerless call before the session
 * check even runs. Verified empirically: calling `auth.api.setRole({ body })`
 * with no headers throws "Headers is required"; `auth.api.banUser({ body })`
 * throws `APIError UNAUTHORIZED`. So they go around the admin plugin's HTTP-
 * endpoint-shaped API and operate on the same `internalAdapter`/`password`
 * primitives the plugin itself uses (mirrored from
 * `better-auth/dist/plugins/admin/routes.mjs`), the same way
 * `createCredentialUser` in `./users.ts` bypasses the plugin for user
 * creation. This still never touches a disabled `/admin/*` route and adds no
 * authorization of its own -- only the mechanical write.
 */
export function createUserAdministrator(auth: WeaverAuth): UserAdministrator {
  return {
    async create(input) {
      const created = await auth.api.createUser({
        body: {
          email: input.email.toLowerCase(),
          name: input.name,
          password: input.password,
          role: input.role as unknown as CreateUserRole,
          data: { mustChangePassword: input.mustChangePassword },
        },
      });
      return { id: created.user.id };
    },
    async setRole(input) {
      const context = await auth.$context;
      await context.internalAdapter.updateUser(input.userId, {
        role: input.role,
      });
    },
    async ban(input) {
      const context = await auth.$context;
      await context.internalAdapter.updateUser(input.userId, {
        banned: true,
        banReason: input.reason,
        banExpires: null,
        updatedAt: new Date(),
      });
      await context.internalAdapter.deleteUserSessions(input.userId);
    },
    async unban(input) {
      const context = await auth.$context;
      await context.internalAdapter.updateUser(input.userId, {
        banned: false,
        banExpires: null,
        banReason: null,
        updatedAt: new Date(),
      });
    },
    async setPassword(input) {
      const context = await auth.$context;
      const hashed = await context.password.hash(input.password);
      const existing = await context.internalAdapter.findCredentialAccount(
        input.userId,
      );
      if (existing) {
        await context.internalAdapter.updatePassword(input.userId, hashed);
      } else {
        await context.internalAdapter.createAccount({
          userId: input.userId,
          providerId: "credential",
          issuer: createLocalAccountIssuer("credential"),
          accountId: input.userId,
          password: hashed,
        });
      }
    },
    async revokeSessions(input) {
      const context = await auth.$context;
      await context.internalAdapter.deleteUserSessions(input.userId);
    },
  };
}

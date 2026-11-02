import type { UserSecurityContext } from "@weaver/core/security/context";

export const actorOf = (ctx: {
  security: UserSecurityContext;
  session: { user: { email?: string | null; name?: string | null } };
}) => ({
  ...ctx.security,
  name: ctx.session.user.name ?? null,
  email: ctx.session.user.email ?? "unknown@local",
});

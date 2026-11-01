import {
  getCurrentAdapter,
  runWithTransaction,
} from "@better-auth/core/context";
import { createLocalAccountIssuer } from "@better-auth/core/db";
import type { WeaverAuth } from "./index";
import { createCredentialUser } from "./users";

export type BootstrapAdminInput = {
  email: string;
  password: string;
  name: string;
  recoverInterrupted?: boolean;
};

// Single-operator bootstrap; legacy orphan recovery requires an explicit option.
export async function bootstrapAdmin(
  auth: WeaverAuth,
  input: BootstrapAdminInput,
): Promise<{ id: string; created: boolean } | { skipped: "users-exist" }> {
  const ctx = await auth.$context;
  return runWithTransaction(ctx.adapter, async () => {
    const adapter = await getCurrentAdapter(ctx.adapter);
    const total = await adapter.count({ model: "user" });
    if (total === 0)
      return createCredentialUser(auth, { ...input, role: "Admin" });
    if (!input.recoverInterrupted || total !== 1)
      return { skipped: "users-exist" as const };
    const existing = await ctx.internalAdapter.findUserByEmail(
      input.email.toLowerCase(),
    );
    const user = existing?.user;
    if (
      !user?.emailVerified ||
      !("role" in user) ||
      user.role !== "Admin" ||
      ("banned" in user && user.banned)
    )
      return { skipped: "users-exist" as const };
    for (const model of ["account", "session", "member"]) {
      if (
        await adapter.count({
          model,
          where: [{ field: "userId", value: user.id }],
        })
      )
        return { skipped: "users-exist" as const };
    }
    const password = await ctx.password.hash(input.password);
    const account = await ctx.internalAdapter.linkAccount({
      userId: user.id,
      providerId: "credential",
      issuer: createLocalAccountIssuer("credential"),
      accountId: user.id,
      password,
    });
    if (!account) throw new Error("Credential account creation was rejected");
    return { id: user.id, created: false };
  });
}

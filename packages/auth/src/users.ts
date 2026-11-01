import { runWithTransaction } from "@better-auth/core/context";
import { createLocalAccountIssuer } from "@better-auth/core/db";
import type { GlobalRole, WeaverAuth } from "./index";

export type CredentialUserInput = {
  email: string;
  password: string;
  name: string;
  role: GlobalRole;
};

// Seed and production bootstrap share Better Auth hashing and transactional hooks.
export async function createCredentialUser(
  auth: WeaverAuth,
  input: CredentialUserInput,
): Promise<{ id: string; created: boolean }> {
  const context = await auth.$context;
  const email = input.email.toLowerCase();
  const existing = await context.internalAdapter.findUserByEmail(email);
  if (existing) return { id: existing.user.id, created: false };

  const password = await context.password.hash(input.password);
  return runWithTransaction(context.adapter, async () => {
    const user = await context.internalAdapter.createUser(
      {
        email,
        name: input.name,
        emailVerified: true,
        role: input.role,
      },
      { method: "email-password" },
    );
    const account = await context.internalAdapter.linkAccount({
      userId: user.id,
      providerId: "credential",
      issuer: createLocalAccountIssuer("credential"),
      accountId: user.id,
      password,
    });
    if (!account) throw new Error("Credential account creation was rejected");
    return { id: user.id, created: true };
  });
}

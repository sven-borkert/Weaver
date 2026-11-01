import { createLocalAccountIssuer } from "@better-auth/core/db";
import { describe, expect, it, vi } from "vitest";
import type { WeaverAuth } from "./index";
import { createCredentialUser } from "./users";

function fakeAuth(existing: { user: { id: string } } | null) {
  const hash = vi.fn(async (password: string) => `hashed:${password}`);
  const createUser = vi.fn(
    async (user: Record<string, unknown>, _source: { method: string }) => ({
      id: "11111111-1111-4111-8111-111111111111",
      ...user,
    }),
  );
  const linkAccount = vi.fn(async (): Promise<{ id: string } | null> => ({
    id: "account-id",
  }));
  const findUserByEmail = vi.fn(async () => existing);
  const auth = {
    $context: Promise.resolve({
      adapter: {
        transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
      },
      password: { hash },
      internalAdapter: { createUser, linkAccount, findUserByEmail },
    }),
  } as unknown as WeaverAuth;
  return { auth, hash, createUser, linkAccount, findUserByEmail };
}

describe("createCredentialUser", () => {
  it("creates the user and links a hashed credential account", async () => {
    const fake = fakeAuth(null);

    const result = await createCredentialUser(fake.auth, {
      email: "Ada@Weaver.local",
      password: "password12345",
      name: "Ada",
      role: "Admin",
    });

    expect(result).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      created: true,
    });
    expect(fake.createUser).toHaveBeenCalledWith(
      {
        email: "ada@weaver.local",
        name: "Ada",
        emailVerified: true,
        role: "Admin",
      },
      { method: "email-password" },
    );
    expect(fake.hash).toHaveBeenCalledWith("password12345");
    // Guards against drift between this helper and Better Auth's own issuer constant.
    expect(createLocalAccountIssuer("credential")).toBe("local:credential");
    expect(fake.linkAccount).toHaveBeenCalledWith({
      userId: "11111111-1111-4111-8111-111111111111",
      providerId: "credential",
      issuer: createLocalAccountIssuer("credential"),
      accountId: "11111111-1111-4111-8111-111111111111",
      password: "hashed:password12345",
    });
  });

  it("leaves no user when password hashing fails", async () => {
    const fake = fakeAuth(null);
    fake.hash.mockRejectedValueOnce(new Error("hash failed"));
    await expect(
      createCredentialUser(fake.auth, {
        email: "root@test.local",
        password: "password12345",
        name: "Root",
        role: "Admin",
      }),
    ).rejects.toThrow("hash failed");
    expect(fake.createUser).not.toHaveBeenCalled();
  });

  it("refuses a credential hook veto instead of reporting a usable account", async () => {
    const fake = fakeAuth(null);
    fake.linkAccount.mockResolvedValueOnce(null);
    await expect(
      createCredentialUser(fake.auth, {
        email: "root@test.local",
        password: "password12345",
        name: "Root",
        role: "Admin",
      }),
    ).rejects.toThrow("Credential account creation was rejected");
  });

  it("returns the existing user without touching credentials", async () => {
    const fake = fakeAuth({ user: { id: "existing-id" } });

    const result = await createCredentialUser(fake.auth, {
      email: "ada@weaver.local",
      password: "password12345",
      name: "Ada",
      role: "User",
    });

    expect(result).toEqual({ id: "existing-id", created: false });
    expect(fake.createUser).not.toHaveBeenCalled();
    expect(fake.linkAccount).not.toHaveBeenCalled();
  });
});

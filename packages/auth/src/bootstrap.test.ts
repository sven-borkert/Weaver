import { describe, expect, it, vi } from "vitest";
import type { WeaverAuth } from "./index";
import { bootstrapAdmin } from "./bootstrap";

function fakeAuth(userCount: number) {
  const count = vi.fn(async () => userCount);
  const createUser = vi.fn(async (user: Record<string, unknown>) => ({
    id: "admin-id",
    ...user,
  }));
  const auth = {
    $context: Promise.resolve({
      adapter: {
        count,
        transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({ count }),
      },
      password: { hash: async (p: string) => `hashed:${p}` },
      internalAdapter: {
        createUser,
        linkAccount: vi.fn(async () => ({ id: "account-id" })),
        findUserByEmail: vi.fn(async () => null),
      },
    }),
  } as unknown as WeaverAuth;
  return { auth, count, createUser };
}

describe("bootstrapAdmin", () => {
  it("creates the first global Admin when the user table is empty", async () => {
    const { auth, count, createUser } = fakeAuth(0);
    const result = await bootstrapAdmin(auth, {
      email: "Root@Weaver.local",
      password: "correct-horse-battery",
      name: "Root",
    });
    expect(result).toEqual({ id: "admin-id", created: true });
    expect(count).toHaveBeenCalledWith({ model: "user" });
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: "root@weaver.local", role: "Admin" }),
      expect.anything(),
    );
  });

  it("does nothing once any user exists", async () => {
    const { auth, createUser } = fakeAuth(3);
    expect(
      await bootstrapAdmin(auth, {
        email: "x@y.z",
        password: "correct-horse-battery",
        name: "X",
      }),
    ).toEqual({ skipped: "users-exist" });
    expect(createUser).not.toHaveBeenCalled();
  });
});

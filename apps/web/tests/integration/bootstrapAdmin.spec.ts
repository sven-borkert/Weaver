import { beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapAdmin } from "@weaver/auth";
import {
  getPrisma,
  makeUser,
  resetDb,
  TEST_PASSWORD,
  testAuth,
} from "./_harness";

describe("bootstrapAdmin", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("creates a signed-in-capable global Admin on an empty database, once", async () => {
    const first = await bootstrapAdmin(testAuth(), {
      email: "root@test.local",
      password: TEST_PASSWORD,
      name: "Root",
    });
    expect(first).toMatchObject({ created: true });
    const user = await getPrisma().user.findUniqueOrThrow({
      where: { email: "root@test.local" },
    });
    expect(user.role).toBe("Admin");
    await expect(
      testAuth().api.signInEmail({
        body: { email: "root@test.local", password: TEST_PASSWORD },
      }),
    ).resolves.toBeTruthy();

    expect(
      await bootstrapAdmin(testAuth(), {
        email: "second@test.local",
        password: TEST_PASSWORD,
        name: "Two",
      }),
    ).toEqual({ skipped: "users-exist" });
  });

  it("rolls back the first user when credential insertion fails and permits rerun", async () => {
    const auth = testAuth();
    const ctx = await auth.$context;
    const link = vi
      .spyOn(ctx.internalAdapter, "linkAccount")
      .mockRejectedValueOnce(new Error("injected account failure"));
    const input = {
      email: "root@test.local",
      password: TEST_PASSWORD,
      name: "Root",
    };
    try {
      await expect(bootstrapAdmin(auth, input)).rejects.toThrow(
        "injected account failure",
      );
      expect(await getPrisma().user.count()).toBe(0);
    } finally {
      link.mockRestore();
    }
    await expect(bootstrapAdmin(auth, input)).resolves.toMatchObject({
      created: true,
    });
    await expect(
      auth.api.signInEmail({
        body: { email: input.email, password: input.password },
      }),
    ).resolves.toBeTruthy();
  });

  it("rolls back a credential hook veto instead of leaving an orphan Admin", async () => {
    const auth = testAuth();
    const ctx = await auth.$context;
    const link = vi
      .spyOn(ctx.internalAdapter, "linkAccount")
      .mockResolvedValueOnce(null as never);
    try {
      await expect(
        bootstrapAdmin(auth, {
          email: "veto@test.local",
          password: TEST_PASSWORD,
          name: "Root",
        }),
      ).rejects.toThrow("Credential account creation was rejected");
      expect(await getPrisma().user.count()).toBe(0);
    } finally {
      link.mockRestore();
    }
  });

  it("recovers only an explicitly requested sole matching orphan Admin", async () => {
    const input = {
      email: "root@test.local",
      password: TEST_PASSWORD,
      name: "Root",
    };
    const ctx = await testAuth().$context;
    const orphan = await ctx.internalAdapter.createUser(
      {
        email: input.email,
        name: input.name,
        emailVerified: true,
        role: "Admin",
      },
      { method: "email-password" },
    );
    expect(await bootstrapAdmin(testAuth(), input)).toEqual({
      skipped: "users-exist",
    });
    expect(
      await bootstrapAdmin(testAuth(), {
        ...input,
        email: "other@test.local",
        recoverInterrupted: true,
      }),
    ).toEqual({ skipped: "users-exist" });
    expect(
      await bootstrapAdmin(testAuth(), { ...input, recoverInterrupted: true }),
    ).toEqual({ id: orphan.id, created: false });
    await expect(
      testAuth().api.signInEmail({
        body: { email: input.email, password: input.password },
      }),
    ).resolves.toBeTruthy();
    expect(
      await bootstrapAdmin(testAuth(), { ...input, recoverInterrupted: true }),
    ).toEqual({ skipped: "users-exist" });
  });

  it("refuses when any user already exists", async () => {
    await makeUser("User", "bs1");
    expect(
      await bootstrapAdmin(testAuth(), {
        email: "root@test.local",
        password: TEST_PASSWORD,
        name: "Root",
      }),
    ).toEqual({ skipped: "users-exist" });
  });
});

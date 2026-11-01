import { beforeEach, describe, expect, it } from "vitest";
import { createUserAdministrator } from "@weaver/auth";
import { getPrisma, resetDb, testAuth } from "./_harness";

describe("createUserAdministrator", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("setPassword links a fresh credential account for a user with none, and the new password signs in", async () => {
    const db = getPrisma();
    // Built directly with Prisma, not createCredentialUser: a half-created
    // account row with zero `account` rows, the state bootstrapAdmin's
    // recoverInterrupted path guards against (packages/auth/src/bootstrap.ts).
    const user = await db.user.create({
      data: {
        email: "halfcreated-sp1@test.local",
        name: "Half Created",
        emailVerified: true,
        role: "User",
      },
    });
    expect(await db.account.count({ where: { userId: user.id } })).toBe(0);

    const admin = createUserAdministrator(testAuth());
    await admin.setPassword({ userId: user.id, password: "brandnew12345" });

    const account = await db.account.findFirstOrThrow({
      where: { userId: user.id, providerId: "credential" },
    });
    expect(account.password).toBeTruthy();

    const signIn = await testAuth().api.signInEmail({
      body: { email: "halfcreated-sp1@test.local", password: "brandnew12345" },
    });
    expect(signIn.user.id).toBe(user.id);
  });
});

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { callerFor, makeUser, resetDb } from "./_harness";

describe("account.me", () => {
  beforeAll(async () => {
    await resetDb();
  });
  beforeEach(async () => {
    await resetDb();
  });

  it("returns the session user's profile", async () => {
    const user = await makeUser("Admin", "a1");
    const caller = callerFor(user);
    const me = await caller.account.me();
    expect(me).toMatchObject({ id: user.id, email: user.email, role: "Admin" });
  });
});

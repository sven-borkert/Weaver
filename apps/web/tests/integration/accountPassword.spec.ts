import { createPasswordChanger, createUserAdministrator } from "@weaver/auth";
import {
  changeOwnPassword,
  resetUserPassword,
} from "@weaver/core/services/users";
import { beforeEach, describe, expect, it } from "vitest";

import {
  callerFor,
  getPrisma,
  makeUser,
  resetDb,
  securityContextFor,
  TEST_PASSWORD,
  testAuth,
} from "./_harness";

/**
 * account.changePassword calls Better Auth's real /change-password endpoint,
 * which re-resolves the caller's session from a cookie in the request
 * headers (not from the fabricated SecurityContext) — so these tests sign in
 * for real and forward the resulting session cookie as caller headers.
 */
async function signInHeaders(email: string): Promise<Headers> {
  const response = await testAuth().api.signInEmail({
    body: { email, password: TEST_PASSWORD },
    asResponse: true,
  });
  const setCookie = response.headers.get("set-cookie") ?? "";
  const pair = setCookie.split(";")[0] ?? "";
  expect(pair).toMatch(/session_token=/);
  return new Headers({ cookie: pair });
}

describe("account password", () => {
  it("revokes personal keys after a self-service password change", async () => {
    const user = await makeUser("User", "own-containment");
    const issued = await callerFor(user).apiKey.create({ name: "Old key" });
    const headers = await signInHeaders(user.email);
    await callerFor(user, { headers }).account.changePassword({
      currentPassword: TEST_PASSWORD,
      newPassword: "a-fresh-password-1",
    });
    expect(
      await getPrisma().apiKey.findUnique({ where: { id: issued.key.id } }),
    ).toBeNull();
  });
  beforeEach(async () => {
    await resetDb();
  });

  it("blocks an ordinary procedure but allows both allowlisted ones while flagged", async () => {
    const user = await makeUser("User", "forced");
    await getPrisma().user.update({
      where: { id: user.id },
      data: { mustChangePassword: true },
    });
    const headers = await signInHeaders(user.email);
    const caller = callerFor(
      { ...user, mustChangePassword: true },
      { headers },
    );

    await expect(caller.account.me()).resolves.toMatchObject({ id: user.id });
    await expect(caller.project.list()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      caller.account.changePassword({
        currentPassword: TEST_PASSWORD,
        newPassword: "a-fresh-password-1",
      }),
    ).resolves.toBeUndefined();
  });

  it("clears the flag when the user sets a new password", async () => {
    const user = await makeUser("User", "change");
    await getPrisma().user.update({
      where: { id: user.id },
      data: { mustChangePassword: true },
    });
    const headers = await signInHeaders(user.email);
    const caller = callerFor(
      { ...user, mustChangePassword: true },
      { headers },
    );

    await caller.account.changePassword({
      currentPassword: TEST_PASSWORD,
      newPassword: "a-fresh-password-2",
    });

    const row = await getPrisma().user.findUniqueOrThrow({
      where: { id: user.id },
      select: { mustChangePassword: true },
    });
    expect(row.mustChangePassword).toBe(false);
  });

  it("rejects the wrong current password with a field-pinned BAD_REQUEST", async () => {
    const user = await makeUser("User", "wrongpw");
    const headers = await signInHeaders(user.email);
    const caller = callerFor(user, { headers });

    await expect(
      caller.account.changePassword({
        currentPassword: "not-the-right-password",
        newPassword: "a-fresh-password-3",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      cause: { field: "currentPassword" },
    });
  });

  it("actually changes the password, verified by signing in with the new one", async () => {
    const user = await makeUser("User", "proof");
    const headers = await signInHeaders(user.email);
    const caller = callerFor(user, { headers });

    await caller.account.changePassword({
      currentPassword: TEST_PASSWORD,
      newPassword: "a-fresh-password-4",
    });

    await expect(
      testAuth().api.signInEmail({
        body: { email: user.email, password: "a-fresh-password-4" },
      }),
    ).resolves.toBeDefined();
  });

  it("makes an admin reset wait for an in-flight change, and the reset wins", async () => {
    const db = getPrisma();
    const admin = await makeUser("Admin", "race-admin");
    const user = await makeUser("User", "race-user");
    const headers = await signInHeaders(user.email);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => (started = resolve));

    const change = changeOwnPassword(db, user.id, async () => {
      started();
      await gate;
      return createPasswordChanger(testAuth()).change({
        headers,
        currentPassword: TEST_PASSWORD,
        newPassword: "the-callers-choice-1",
      });
    });
    await inFlight;

    let resetDone = false;
    const reset = resetUserPassword(
      db,
      securityContextFor(admin),
      { userId: user.id, password: "the-admins-choice-1" },
      createUserAdministrator(testAuth()),
    ).then(() => (resetDone = true));
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const [row] = await db.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
      `;
      if ((row?.count ?? 0) > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(resetDone).toBe(false);

    release();
    await change;
    await reset;

    await expect(
      testAuth().api.signInEmail({
        body: { email: user.email, password: "the-callers-choice-1" },
      }),
    ).rejects.toBeDefined();
    expect(
      await db.user.findUniqueOrThrow({
        where: { id: user.id },
        select: { mustChangePassword: true },
      }),
    ).toEqual({ mustChangePassword: true });
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
    await expect(
      testAuth().api.signInEmail({
        body: { email: user.email, password: "the-admins-choice-1" },
      }),
    ).resolves.toBeDefined();
  });

  it("rejects passwords outside the shared 12 to 128 character policy", async () => {
    const user = await makeUser("User", "bounds");
    const caller = callerFor(user, {
      headers: await signInHeaders(user.email),
    });
    for (const newPassword of ["x".repeat(11), "x".repeat(129)]) {
      await expect(
        caller.account.changePassword({
          currentPassword: TEST_PASSWORD,
          newPassword,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    await expect(
      caller.account.changePassword({
        currentPassword: TEST_PASSWORD,
        newPassword: "x".repeat(128),
      }),
    ).resolves.toBeUndefined();
  });
});

import { beforeEach, describe, expect, it } from "vitest";

import {
  getPrisma,
  makeUser,
  makeProject,
  addMembership,
  resetDb,
  TEST_PASSWORD,
  testAuth,
} from "./_harness";

function sessionCookie(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  const pair = header.split(";")[0] ?? "";
  expect(pair).toMatch(/session_token=/);
  return pair;
}

describe("better auth", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("signs in with email/password, resolves the session user, and records the login", async () => {
    const user = await makeUser("User", "ba1");

    const response = await testAuth().api.signInEmail({
      body: { email: user.email, password: TEST_PASSWORD },
      asResponse: true,
    });
    expect(response.status).toBe(200);

    const session = await testAuth().api.getSession({
      headers: new Headers({ cookie: sessionCookie(response) }),
    });
    expect(session?.user).toMatchObject({
      id: user.id,
      email: user.email,
      role: "User",
    });
    const stored = await getPrisma().user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(stored.lastLoginAt).toBeInstanceOf(Date);
  });

  it("blocks and revokes live sessions after a database ban", async () => {
    const user = await makeUser("User", "live-ban");
    const login = await testAuth().api.signInEmail({
      body: { email: user.email, password: TEST_PASSWORD },
      asResponse: true,
    });
    const headers = new Headers({ cookie: sessionCookie(login) });
    await getPrisma().user.update({
      where: { id: user.id },
      data: { banned: true },
    });
    await expect(testAuth().api.listSessions({ headers })).rejects.toThrow();
    expect(
      await getPrisma().session.count({ where: { userId: user.id } }),
    ).toBe(0);
  });

  it("rejects wrong passwords and banned users", async () => {
    const user = await makeUser("User", "ba2");

    await expect(
      testAuth().api.signInEmail({
        body: { email: user.email, password: "not-the-password" },
      }),
    ).rejects.toThrow();

    await getPrisma().user.update({
      where: { id: user.id },
      data: { banned: true },
    });
    await expect(
      testAuth().api.signInEmail({
        body: { email: user.email, password: TEST_PASSWORD },
      }),
    ).rejects.toThrow();
  });

  it("blocks generic organization metadata reads after a project is soft deleted", async () => {
    const user = await makeUser("User", "deleted-org");
    const { id } = await makeProject("Deleted private project");
    const project = await getPrisma().project.findUniqueOrThrow({
      where: { id },
    });
    await addMembership(project.id, user.id, "Viewer");
    await getPrisma().project.update({
      where: { id: project.id },
      data: { deletedAt: new Date() },
    });
    const login = await testAuth().api.signInEmail({
      body: { email: user.email, password: TEST_PASSWORD },
      asResponse: true,
    });
    const cookie = sessionCookie(login);
    for (const path of [
      "list",
      "get-organization",
      "get-full-organization",
      "list-members",
      "get-active-member",
      "get-active-member-role",
      "list-invitations",
      "list-user-invitations",
    ]) {
      const response = await testAuth().handler(
        new Request(
          `http://localhost:3000/api/auth/organization/${path}?organizationId=${project.organizationId}`,
          { headers: { cookie } },
        ),
      );
      expect(response.status, path).toBe(404);
    }
  });

  it("disables public sign-up and organization mutation endpoints", async () => {
    await expect(
      testAuth().api.signUpEmail({
        body: {
          email: "intruder@test.local",
          password: TEST_PASSWORD,
          name: "Intruder",
        },
      }),
    ).rejects.toThrow();

    const response = await testAuth().handler(
      new Request("http://localhost:3000/api/auth/organization/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Rogue", slug: "rogue" }),
      }),
    );
    expect(response.status).toBe(404);
    expect(await getPrisma().organization.count()).toBe(0);

    const impersonateResponse = await testAuth().handler(
      new Request("http://localhost:3000/api/auth/admin/impersonate-user", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "does-not-matter" }),
      }),
    );
    expect(impersonateResponse.status).toBe(404);
  });
});

import { beforeEach, describe, expect, it } from "vitest";

import { openProjectRepo } from "@weaver/git-store";
import { createBearerVerifiers, createUserAdministrator } from "@weaver/auth";
import {
  createUser,
  deactivateUser,
  getUser,
  listProjectsForAdmin,
  listUsers,
  reactivateUser,
  resetUserPassword,
  revokeUserSessions,
  setUserMembership,
  setUserRole,
} from "@weaver/core/services/users";
import {
  callerFor,
  ensureOAuthResource,
  getPrisma,
  makeProject,
  makeUser,
  addMembership,
  resetDb,
  securityContextFor,
  testAuth,
  TEST_ISSUER,
  TEST_MCP_RESOURCE,
  TEST_PASSWORD,
} from "./_harness";
import {
  exchangeRefreshToken,
  insertOAuthClient,
  obtainAccessToken,
  sessionCookieFor,
} from "./_oauth";

async function committedMembers(projectId: string) {
  const repo = await openProjectRepo(projectId);
  const file = await repo!.readCommittedFile("project.json");
  const parsed = JSON.parse(file!.content) as {
    members: Array<{ userId: string; email: string; role: string }>;
  };
  return parsed.members.map(({ userId, email, role }) => ({
    userId,
    email,
    role,
  }));
}

describe("user administration", () => {
  it("permanently revokes API keys and OAuth grants on deactivation", async () => {
    const admin = await makeUser("Admin", "containment-admin");
    const user = await makeUser("User", "containment-user");
    const issued = await callerFor(user).apiKey.create({ name: "Old key" });
    await ensureOAuthResource();
    await insertOAuthClient();
    await obtainAccessToken(
      await sessionCookieFor(user.email),
      "mcp:use content:read offline_access",
    );
    await deactivateUser(
      getPrisma(),
      securityContextFor(admin),
      { userId: user.id, reason: "compromised" },
      createUserAdministrator(testAuth()),
    );
    await reactivateUser(
      getPrisma(),
      securityContextFor(admin),
      user.id,
      createUserAdministrator(testAuth()),
    );
    expect(
      await getPrisma().apiKey.findUnique({ where: { id: issued.key.id } }),
    ).toBeNull();
    expect(
      await getPrisma().oauthConsent.count({ where: { userId: user.id } }),
    ).toBe(0);
  });
  beforeEach(async () => {
    await resetDb();
  });

  it("lists users for an Admin and refuses a non-Admin", async () => {
    const admin = await makeUser("Admin", "list");
    const member = await makeUser("User", "list");

    const listed = await callerFor(admin).user.list({});
    expect(listed.users.map((u) => u.email).sort()).toEqual(
      [admin.email, member.email].sort(),
    );
    expect(listed.users.find((u) => u.email === member.email)).toMatchObject({
      role: "User",
      active: true,
      mustChangePassword: false,
    });

    await expect(callerFor(member).user.list({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("rejects a non-Admin at the service layer directly, not just through the router", async () => {
    const user = await makeUser("User", "guard");
    const target = await makeUser("User", "guard-target");
    const actor = securityContextFor(user);
    const db = getPrisma();

    await expect(listUsers(db, actor, {})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(getUser(db, actor, user.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      createUser(
        db,
        actor,
        {
          email: "guard-target-create@test.local",
          name: "Guard Target",
          role: "User",
          password: "initial-password-1",
        },
        createUserAdministrator(testAuth()),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      setUserRole(
        db,
        actor,
        { userId: target.id, role: "Admin" },
        createUserAdministrator(testAuth()),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      deactivateUser(
        db,
        actor,
        { userId: target.id, reason: "guard check" },
        createUserAdministrator(testAuth()),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      reactivateUser(db, actor, target.id, createUserAdministrator(testAuth())),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      resetUserPassword(
        db,
        actor,
        { userId: target.id, password: "brand-new-password-1" },
        createUserAdministrator(testAuth()),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      revokeUserSessions(
        db,
        actor,
        target.id,
        createUserAdministrator(testAuth()),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      setUserMembership(db, actor, {
        userId: target.id,
        projectId: "00000000-0000-0000-0000-000000000000",
        role: "Owner",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listProjectsForAdmin(db, actor)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("filters by search term, matching either email or name", async () => {
    const admin = await makeUser("Admin", "search");
    const member = await makeUser("User", "findme");

    const byEmail = await callerFor(admin).user.list({ search: "findme" });
    expect(byEmail.users).toHaveLength(1);
    expect(byEmail.users[0]?.email).toContain("findme");

    // "User findme" (a space) is not a substring of the lowercased, hyphenated
    // email "user-findme@test.local" — this can only match via the name field.
    const byName = await callerFor(admin).user.list({
      search: "User findme",
    });
    expect(byName.users).toHaveLength(1);
    expect(byName.users[0]?.id).toBe(member.id);
  });

  it("paginates with a cursor", async () => {
    const admin = await makeUser("Admin", "page");
    const first = await makeUser("User", "page-a");
    const second = await makeUser("User", "page-b");
    const caller = callerFor(admin);

    const page1 = await caller.user.list({ limit: 2 });
    expect(page1.users).toHaveLength(2);
    expect(page1.nextCursor).toEqual(expect.any(String));

    const page2 = await caller.user.list({
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.users).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();

    expect([...page1.users, ...page2.users].map((u) => u.id).sort()).toEqual(
      [admin.id, first.id, second.id].sort(),
    );
  });

  it("returns a user with their project memberships, excluding soft-deleted projects", async () => {
    const admin = await makeUser("Admin", "detail");
    const member = await makeUser("User", "detail");
    const project = await makeProject("Detail Project");
    await addMembership(project.id, member.id, "Editor");

    const deletedProject = await makeProject("Deleted Project");
    await addMembership(deletedProject.id, member.id, "Viewer");
    await getPrisma().project.update({
      where: { id: deletedProject.id },
      data: { deletedAt: new Date() },
    });

    const detail = await callerFor(admin).user.get({ userId: member.id });
    expect(detail.memberships).toEqual([
      { projectId: project.id, projectName: "Detail Project", role: "Editor" },
    ]);
  });

  it("returns NOT_FOUND for an unknown user", async () => {
    const admin = await makeUser("Admin", "missing");
    await expect(
      callerFor(admin).user.get({
        userId: "00000000-0000-0000-0000-000000000000",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("creates a user who must change their password", async () => {
    const admin = await makeUser("Admin", "create");

    const created = await callerFor(admin).user.create({
      email: "New.Person@test.local",
      name: "New Person",
      role: "User",
      password: "initial-password-1",
    });

    expect(created.password).toBe("initial-password-1");
    expect(created.user).toMatchObject({
      email: "new.person@test.local",
      name: "New Person",
      role: "User",
      active: true,
      mustChangePassword: true,
    });

    const workspace = await getPrisma().project.findFirst({
      where: { personalOwnerId: created.user.id },
      select: { name: true },
    });
    expect(workspace).toEqual({ name: "New Person's workspace" });
  });

  it("rejects a duplicate email and a short password", async () => {
    const admin = await makeUser("Admin", "dupe");

    await expect(
      callerFor(admin).user.create({
        email: admin.email,
        name: "Clash",
        role: "User",
        password: "initial-password-1",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", cause: { field: "email" } });

    await expect(
      callerFor(admin).user.create({
        email: "short@test.local",
        name: "Short",
        role: "User",
        password: "tooshort",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("remaps a race-condition duplicate email from the administrator to a field-pinned CONFLICT", async () => {
    // Simulates the window between createUser's own findUnique pre-check and
    // administrator.create(...) committing: the pre-check passes (no row
    // yet), but the write still collides. Better Auth's own admin
    // createUser route does the identical racy check-then-insert internally
    // and, on collision, throws its own APIError (status "BAD_REQUEST",
    // body.code "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL") rather than a raw
    // Prisma unique-constraint error — verified empirically against
    // weaver_test by firing two concurrent auth.api.createUser calls for the
    // same address. This stub reproduces that exact shape without needing a
    // real race.
    const admin = await makeUser("Admin", "race");
    const racyAdministrator = {
      ...createUserAdministrator(testAuth()),
      create: async () => {
        throw Object.assign(
          new Error("User already exists. Use another email."),
          {
            name: "APIError",
            status: "BAD_REQUEST",
            statusCode: 400,
            body: {
              message: "User already exists. Use another email.",
              code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
            },
          },
        );
      },
    };

    await expect(
      createUser(
        getPrisma(),
        securityContextFor(admin),
        {
          email: "race-target@test.local",
          name: "Race Target",
          role: "User",
          password: "initial-password-1",
        },
        racyAdministrator,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT", details: { field: "email" } });
  });

  it("changes a global role", async () => {
    const admin = await makeUser("Admin", "role");
    const member = await makeUser("User", "role");

    const updated = await callerFor(admin).user.setRole({
      userId: member.id,
      role: "Admin",
    });
    expect(updated.role).toBe("Admin");
  });

  it("refuses to change your own role", async () => {
    const admin = await makeUser("Admin", "selfrole");

    // Match the self-guard's specific message, not just the error code: the
    // last-Admin guard (assertNotLastActiveAdmin) throws the same
    // PRECONDITION_FAILED code, and this must fail for the self-guard's own
    // reason, not because it happens to be the sole Admin.
    await expect(
      callerFor(admin).user.setRole({ userId: admin.id, role: "User" }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "You cannot change your own global role",
    });
  });

  it("keeps at least one active Admin when two Admins demote each other concurrently", async () => {
    // The last-Admin guard's count check excludes the target and cannot fire
    // sequentially here (the actor is always still an active Admin, and the
    // self-guard already blocks target === actor). The real risk is
    // concurrent: two Admins demoting each other at once can each pass their
    // own count check under READ COMMITTED before either write lands,
    // leaving zero active Admins. assertNotLastActiveAdmin is guarded by a
    // global advisory lock (lockGlobalAdminRoster) that serializes the
    // count-and-mutate section across both calls, so this must never happen
    // — regardless of which call wins the race.
    const admin1 = await makeUser("Admin", "race-a");
    const admin2 = await makeUser("Admin", "race-b");

    const [result1, result2] = await Promise.allSettled([
      callerFor(admin1).user.setRole({ userId: admin2.id, role: "User" }),
      callerFor(admin2).user.setRole({ userId: admin1.id, role: "User" }),
    ]);

    // The invariant under test: never zero active Admins. Which call wins
    // the lock is an implementation detail and is deliberately not asserted.
    const remainingAdmins = await getPrisma().user.count({
      where: {
        role: "Admin",
        banned: false,
        id: { in: [admin1.id, admin2.id] },
      },
    });
    expect(remainingAdmins).toBeGreaterThanOrEqual(1);

    // With exactly two Admins mutually demoting each other, the lock
    // guarantees exactly one winner: whoever acquires the lock first always
    // still sees the other as Admin (assertNotLastActiveAdmin passes), and
    // the loser always then sees zero other active Admins (the winner just
    // demoted them). A test that only checked remainingAdmins >= 1 would
    // pass even if the guard/lock became over-strict and both calls
    // rejected — asserting one success proves a demotion actually happened.
    const results = [result1, result2];
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    // A rejected call must fail with the guard's own error, not a crash or an
    // unrelated failure (e.g. a lock timeout or deadlock).
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({ code: "PRECONDITION_FAILED" });
      }
    }
  });

  it("deactivates a user and stops their API keys, then reactivates them", async () => {
    const admin = await makeUser("Admin", "deact");
    const member = await makeUser("User", "deact");
    const project = await makeProject("Deact Project");
    await addMembership(project.id, member.id, "Editor");

    const created = await callerFor(member).apiKey.create({
      name: "kill-switch",
      // content:read is a DEFAULT_API_KEY_CAPABILITIES entry, not a
      // grantable one — createApiKeyInput rejects it here explicitly.
      capabilities: [],
      projectIds: [project.id],
      expiresInDays: null,
      rateLimitPerMinute: null,
    });

    const { resolveApiKeySecurityContext } =
      await import("@weaver/core/security/bearer");
    const verifiers = createBearerVerifiers(testAuth(), {
      issuer: TEST_ISSUER,
      audience: TEST_MCP_RESOURCE,
    });

    // Positive control: the key must resolve BEFORE deactivation, or the
    // later rejection could be passing for an unrelated reason (a malformed
    // key, a wrong verifier, ...) instead of the banned-user check.
    await expect(
      resolveApiKeySecurityContext(
        getPrisma(),
        verifiers,
        `Bearer ${created.secret}`,
      ),
    ).resolves.toBeDefined();

    const deactivated = await callerFor(admin).user.deactivate({
      userId: member.id,
      reason: "left the company",
    });
    expect(deactivated).toMatchObject({
      active: false,
      banReason: "left the company",
    });

    // The security-relevant claim: a banned user's API key must stop
    // resolving, not just get a cosmetic "active: false" on the user row.
    await expect(
      resolveApiKeySecurityContext(
        getPrisma(),
        verifiers,
        `Bearer ${created.secret}`,
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const reactivated = await callerFor(admin).user.reactivate({
      userId: member.id,
    });
    expect(reactivated).toMatchObject({ active: true, banReason: null });
  });

  it("deactivates a user and stops their OAuth tokens", async () => {
    // The API-key test above proves the banned-user check for
    // resolveApiKeySecurityContext; this proves the same for the MCP/OAuth
    // path (resolveMcpPrincipal), which shares the check via
    // resolveVerifiedCredentialContext but is exercised through a
    // completely different credential kind and code path in production.
    const admin = await makeUser("Admin", "deact-oauth");
    const member = await makeUser("User", "deact-oauth");
    await ensureOAuthResource();
    await insertOAuthClient();
    const cookie = await sessionCookieFor(member.email);
    const tokens = await obtainAccessToken(cookie, "mcp:use content:read");

    const { resolveMcpPrincipal } =
      await import("@weaver/core/security/bearer");
    const verifiers = createBearerVerifiers(testAuth(), {
      issuer: TEST_ISSUER,
      audience: TEST_MCP_RESOURCE,
    });
    const request = {
      authorizationHeader: `Bearer ${tokens.access_token}`,
      dpopProofJwt: null,
      method: "POST",
      url: TEST_MCP_RESOURCE,
    };

    // Positive control: the token must resolve BEFORE deactivation.
    await expect(
      resolveMcpPrincipal(getPrisma(), verifiers, request),
    ).resolves.toBeDefined();

    await callerFor(admin).user.deactivate({
      userId: member.id,
      reason: "left the company",
    });

    await expect(
      resolveMcpPrincipal(getPrisma(), verifiers, request),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("refuses to deactivate yourself", async () => {
    const admin = await makeUser("Admin", "selfdeact");
    await makeUser("Admin", "spare");
    await expect(
      callerFor(admin).user.deactivate({ userId: admin.id, reason: "oops" }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "You cannot deactivate your own account",
    });
  });

  it("returns NOT_FOUND when deactivating or reactivating an unknown user", async () => {
    const admin = await makeUser("Admin", "deact-missing");
    await expect(
      callerFor(admin).user.deactivate({
        userId: "00000000-0000-0000-0000-000000000000",
        reason: "gone",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      callerFor(admin).user.reactivate({
        userId: "00000000-0000-0000-0000-000000000000",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps at least one active Admin when one Admin demotes another while the other deactivates the first", async () => {
    // The dangerous interleaving crosses operations, not just two calls to
    // the same one: Admin A demotes Admin B (setRole) while Admin B
    // deactivates Admin A (deactivate), fired at once. Both guards share
    // lockGlobalAdminRoster, so whichever transaction wins the lock commits
    // first and the loser's count then reflects that commit.
    const admin1 = await makeUser("Admin", "cross-a");
    const admin2 = await makeUser("Admin", "cross-b");

    const [result1, result2] = await Promise.allSettled([
      callerFor(admin1).user.setRole({ userId: admin2.id, role: "User" }),
      callerFor(admin2).user.deactivate({
        userId: admin1.id,
        reason: "cross-operation race",
      }),
    ]);

    const remainingAdmins = await getPrisma().user.count({
      where: {
        role: "Admin",
        banned: false,
        id: { in: [admin1.id, admin2.id] },
      },
    });
    expect(remainingAdmins).toBeGreaterThanOrEqual(1);

    // Asserting the invariant alone would pass vacuously if both calls
    // rejected for unrelated reasons — assert one side actually won the
    // race and mutated state.
    const results = [result1, result2];
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({ code: "PRECONDITION_FAILED" });
      }
    }
  });

  it("resets a password: the old password stops signing in, the new one does, and it forces a change and revokes sessions", async () => {
    const admin = await makeUser("Admin", "reset");
    const member = await makeUser("User", "reset");

    await testAuth().api.signInEmail({
      body: { email: member.email, password: TEST_PASSWORD },
    });
    // Positive control: a real session must exist before the reset, or the
    // zero-count assertion below would pass vacuously.
    expect(
      await getPrisma().session.count({ where: { userId: member.id } }),
    ).toBeGreaterThan(0);

    const result = await callerFor(admin).user.resetPassword({
      userId: member.id,
      password: "brand-new-password-1",
    });
    expect(result.password).toBe("brand-new-password-1");
    expect(result.user.mustChangePassword).toBe(true);

    // resetUserPassword revokes sessions itself, distinct from the
    // dedicated revokeUserSessions test below — a future edit that dropped
    // or mis-targeted that internal call would otherwise pass the suite.
    expect(
      await getPrisma().session.count({ where: { userId: member.id } }),
    ).toBe(0);

    // The negative case alone would pass even if the reset broke sign-in
    // entirely, so also assert the new password actually works.
    await expect(
      testAuth().api.signInEmail({
        body: { email: member.email, password: TEST_PASSWORD },
      }),
    ).rejects.toThrow();

    const signIn = await testAuth().api.signInEmail({
      body: { email: member.email, password: "brand-new-password-1" },
    });
    expect(signIn.user.id).toBe(member.id);
  });

  it("resets a password and revokes the user's API keys and OAuth grants, which stay revoked after the forced change", async () => {
    const admin = await makeUser("Admin", "reset-creds");
    const member = await makeUser("User", "reset-creds");
    const project = await makeProject("Reset Creds Project");
    await addMembership(project.id, member.id, "Editor");
    await ensureOAuthResource();
    await insertOAuthClient();

    const created = await callerFor(member).apiKey.create({
      name: "pre-reset",
      capabilities: [],
      projectIds: [project.id],
      expiresInDays: null,
      rateLimitPerMinute: null,
    });
    const cookie = await sessionCookieFor(member.email);
    const tokens = await obtainAccessToken(
      cookie,
      "mcp:use content:read offline_access",
    );
    expect(tokens.refresh_token).toBeTruthy();

    const { resolveApiKeySecurityContext, resolveMcpPrincipal } =
      await import("@weaver/core/security/bearer");
    const verifiers = createBearerVerifiers(testAuth(), {
      issuer: TEST_ISSUER,
      audience: TEST_MCP_RESOURCE,
    });
    const keyHeader = `Bearer ${created.secret}`;
    const request = {
      authorizationHeader: `Bearer ${tokens.access_token}`,
      dpopProofJwt: null,
      method: "POST",
      url: TEST_MCP_RESOURCE,
    };

    // Positive controls: both credentials resolve before the reset, and the
    // grant exists, so the rejections below can only come from the reset.
    await expect(
      resolveApiKeySecurityContext(getPrisma(), verifiers, keyHeader),
    ).resolves.toBeDefined();
    await expect(
      resolveMcpPrincipal(getPrisma(), verifiers, request),
    ).resolves.toBeDefined();
    expect(
      await getPrisma().oauthConsent.count({ where: { userId: member.id } }),
    ).toBe(1);

    await callerFor(admin).user.resetPassword({
      userId: member.id,
      password: "brand-new-password-1",
    });

    await expect(
      resolveApiKeySecurityContext(getPrisma(), verifiers, keyHeader),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      resolveMcpPrincipal(getPrisma(), verifiers, request),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      details: { reason: "invalid" },
    });
    expect(
      await getPrisma().apiKey.count({ where: { referenceId: member.id } }),
    ).toBe(0);
    expect(
      await getPrisma().oauthConsent.count({ where: { userId: member.id } }),
    ).toBe(0);
    const refresh = await getPrisma().oauthRefreshToken.findMany({
      where: { userId: member.id },
    });
    expect(refresh.length).toBeGreaterThan(0);
    expect(refresh.every((row) => row.revoked !== null)).toBe(true);
    const refreshed = await exchangeRefreshToken(tokens.refresh_token!);
    expect(refreshed.status).toBe(400);

    // Revoked, not suspended: completing the forced change must not bring
    // either credential back — the point of a reset as containment.
    const headers = new Headers({
      cookie: await sessionCookieFor(member.email, "brand-new-password-1"),
    });
    await callerFor(
      { ...member, mustChangePassword: true },
      { headers },
    ).account.changePassword({
      currentPassword: "brand-new-password-1",
      newPassword: "another-new-password-1",
    });
    expect(
      (
        await getPrisma().user.findUniqueOrThrow({
          where: { id: member.id },
          select: { mustChangePassword: true },
        })
      ).mustChangePassword,
    ).toBe(false);
    await expect(
      resolveApiKeySecurityContext(getPrisma(), verifiers, keyHeader),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      resolveMcpPrincipal(getPrisma(), verifiers, request),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("refuses to reset your own password from the admin surface", async () => {
    const admin = await makeUser("Admin", "selfreset");
    await expect(
      callerFor(admin).user.resetPassword({
        userId: admin.id,
        password: "brand-new-password-1",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("revokes another user's sessions, dropping a live session count to zero", async () => {
    const admin = await makeUser("Admin", "revoke");
    const member = await makeUser("User", "revoke");

    await testAuth().api.signInEmail({
      body: { email: member.email, password: TEST_PASSWORD },
    });
    // Positive control: a real session must exist before revocation, or the
    // zero-count assertion below would pass vacuously.
    expect(
      await getPrisma().session.count({ where: { userId: member.id } }),
    ).toBeGreaterThan(0);

    await expect(
      callerFor(admin).user.revokeSessions({ userId: member.id }),
    ).resolves.toBeUndefined();

    expect(
      await getPrisma().session.count({ where: { userId: member.id } }),
    ).toBe(0);
  });

  it("returns NOT_FOUND when resetting a password or revoking sessions for an unknown user", async () => {
    const admin = await makeUser("Admin", "reset-missing");
    await expect(
      callerFor(admin).user.resetPassword({
        userId: "00000000-0000-0000-0000-000000000000",
        password: "brand-new-password-1",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      callerFor(admin).user.revokeSessions({
        userId: "00000000-0000-0000-0000-000000000000",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("lists every non-deleted project for an Admin, including ones they don't belong to, and refuses a non-Admin", async () => {
    const admin = await makeUser("Admin", "list-projects");
    const member = await makeUser("User", "list-projects");
    const belongsTo = await makeProject("Admin's Own Project");
    await addMembership(belongsTo.id, admin.id, "Owner");
    // The scenario listProjectsForAdmin exists for: the picker behind
    // setUserMembership's orphaned-project rescue (spec §6.1) must be able
    // to find a project the Admin is not themselves a member of.
    const orphaned = await makeProject("Orphaned Project For Picker");
    const deleted = await makeProject("Deleted Project");
    await getPrisma().project.update({
      where: { id: deleted.id },
      data: { deletedAt: new Date() },
    });

    const projects = await callerFor(admin).user.listProjects();
    // id/name only, per spec — anything else on the row would break this.
    expect(projects).toContainEqual({
      id: belongsTo.id,
      name: "Admin's Own Project",
    });
    expect(projects).toContainEqual({
      id: orphaned.id,
      name: "Orphaned Project For Picker",
    });
    expect(projects.map((p) => p.id)).not.toContain(deleted.id);

    await expect(callerFor(member).user.listProjects()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("prevents the admin rescue path from removing or demoting the last Owner", async () => {
    const admin = await makeUser("Admin", "last-owner-admin");
    const owner = await makeUser("User", "last-owner");
    const project = await makeProject("last-owner");
    await addMembership(project.id, owner.id, "Owner");
    for (const role of [null, "Viewer"] as const) {
      await expect(
        callerFor(admin).user.setMembership({
          userId: owner.id,
          projectId: project.id,
          role,
        }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    }
    expect(
      await getPrisma().member.count({
        where: { userId: owner.id, role: "owner" },
      }),
    ).toBe(1);
  });

  it("refuses to demote or remove a personal workspace's owner, but still lets other members change", async () => {
    const admin = await makeUser("Admin", "personal-owner-admin");
    const owner = await makeUser("User", "personal-owner");
    const { projectId } = await callerFor(owner).account.landingProject();
    expect(projectId).toBeTruthy();

    for (const role of [null, "Viewer"] as const) {
      await expect(
        callerFor(admin).user.setMembership({
          userId: owner.id,
          projectId: projectId!,
          role,
        }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    }
    expect(
      await getPrisma().member.count({
        where: { userId: owner.id, role: "owner" },
      }),
    ).toBe(1);

    const other = await makeUser("User", "personal-owner-other");
    const changed = await callerFor(admin).user.setMembership({
      userId: other.id,
      projectId: projectId!,
      role: "Editor",
    });
    expect(changed.memberships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ projectId, role: "Editor" }),
      ]),
    );
  });

  it("lets an Admin grant, then remove, membership on a project they do not belong to", async () => {
    const admin = await makeUser("Admin", "grant");
    const member = await makeUser("User", "grant");
    const project = await makeProject("Orphaned Project");

    const granted = await callerFor(admin).user.setMembership({
      userId: member.id,
      projectId: project.id,
      role: "Owner",
    });
    // The intermediate state, not just the end state: a "grant then remove"
    // test that only checks the final empty list would pass even if the
    // grant itself silently no-opped.
    expect(granted.memberships).toEqual([
      { projectId: project.id, projectName: "Orphaned Project", role: "Owner" },
    ]);
    // The scenario this narrowing exists for: an Admin who is not a member
    // still leaves the project's committed project.json reflecting current
    // DB truth, exactly as every ordinary membership write does.
    expect(await committedMembers(project.id)).toEqual([
      { userId: member.id, email: member.email, role: "Owner" },
    ]);

    const replacement = await makeUser("User", "replacement-owner");
    await addMembership(project.id, replacement.id, "Owner");
    await getPrisma().projectTrainingRole.create({
      data: { projectId: project.id, userId: member.id, role: "trainer" },
    });
    const removed = await callerFor(admin).user.setMembership({
      userId: member.id,
      projectId: project.id,
      role: null,
    });
    expect(removed.memberships).toEqual([]);
    expect(
      await getPrisma().projectTrainingRole.count({
        where: { projectId: project.id, userId: member.id },
      }),
    ).toBe(0);
  });

  it("lets an Admin change an existing member's role on a project they do not belong to", async () => {
    const admin = await makeUser("Admin", "change");
    const member = await makeUser("User", "change");
    const project = await makeProject("Reassigned Project");
    await addMembership(project.id, member.id, "Viewer");

    const changed = await callerFor(admin).user.setMembership({
      userId: member.id,
      projectId: project.id,
      role: "Maintainer",
    });
    expect(changed.memberships).toEqual([
      {
        projectId: project.id,
        projectName: "Reassigned Project",
        role: "Maintainer",
      },
    ]);
  });

  it("refuses to let an Admin grant, change, or remove their own project membership", async () => {
    const admin = await makeUser("Admin", "selfmembership");
    const project = await makeProject("Self Membership Project");

    // Grant: the Admin holds no membership on this project yet — the exact
    // capability the narrowing exists for, refused only because the target
    // is the actor.
    await expect(
      callerFor(admin).user.setMembership({
        userId: admin.id,
        projectId: project.id,
        role: "Owner",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // An Admin can still acquire ordinary project membership through the
    // normal invite path (a Maintainer+ of the project adding them by
    // email), entirely independent of setMembership. That makes change and
    // remove reachable self-escalation vectors too, not just grant.
    await addMembership(project.id, admin.id, "Viewer");

    await expect(
      callerFor(admin).user.setMembership({
        userId: admin.id,
        projectId: project.id,
        role: "Owner",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await expect(
      callerFor(admin).user.setMembership({
        userId: admin.id,
        projectId: project.id,
        role: null,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Prove the guard rejects before mutating anything, not just after a
    // partial write: the pre-existing Viewer membership must be untouched.
    const detail = await callerFor(admin).user.get({ userId: admin.id });
    expect(detail.memberships).toEqual([
      {
        projectId: project.id,
        projectName: "Self Membership Project",
        role: "Viewer",
      },
    ]);
  });

  it("returns NOT_FOUND for an unknown project, an unknown user, and a soft-deleted project", async () => {
    const admin = await makeUser("Admin", "membership-missing");
    const member = await makeUser("User", "membership-missing");
    const project = await makeProject("Membership Missing Project");

    await expect(
      callerFor(admin).user.setMembership({
        userId: member.id,
        projectId: "00000000-0000-0000-0000-000000000000",
        role: "Owner",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(
      callerFor(admin).user.setMembership({
        userId: "00000000-0000-0000-0000-000000000000",
        projectId: project.id,
        role: "Owner",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // The project must genuinely exist and genuinely be soft-deleted, or the
    // NOT_FOUND below would arrive for the wrong reason (a bad projectId).
    await getPrisma().project.update({
      where: { id: project.id },
      data: { deletedAt: new Date() },
    });
    await expect(
      callerFor(admin).user.setMembership({
        userId: member.id,
        projectId: project.id,
        role: "Owner",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

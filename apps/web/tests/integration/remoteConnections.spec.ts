import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBearerVerifiers } from "@weaver/auth";
import { remoteEndpoints } from "@weaver/core/remotes/urls";
import {
  beginRemoteConnection,
  createRemoteInstance,
  disconnectRemoteInstance,
  listRemoteInstancesForUser,
  syncRemoteOauthClient,
  withRemoteToken,
} from "@weaver/core/services/remoteInstances";
import type { RemoteRuntimeDeps } from "@weaver/core/services/remoteInstances/types";
import { getSessionUser, type SessionUser } from "~/server/auth";
import { getBearerVerifiers } from "~/server/auth/bearer";
import { handleRemoteCallback } from "~/app/api/remotes/callback/route";
import {
  ensureOAuthResource,
  getPrisma,
  makeUser,
  resetDb,
  securityContextFor,
  testAuth,
  testEncryptionKeys,
  TEST_ISSUER,
  TEST_MCP_RESOURCE,
  TEST_PASSWORD,
} from "./_harness";
import { redirectTargetOf, sessionCookieFor } from "./_oauth";
import { testRemoteFetch } from "./_remoteFetch";

vi.mock("~/server/auth/bearer", () => ({ getBearerVerifiers: vi.fn() }));

const B = "http://localhost:3000"; // the test instance plays the remote
const A = "http://localhost:3000/a"; // this instance's own identity, distinct from B

function deps(now = () => new Date()): RemoteRuntimeDeps {
  return {
    db: getPrisma(),
    ring: testEncryptionKeys(),
    fetchImpl: testRemoteFetch(),
    now,
    selfBaseUrl: A,
    mcpResourceUrl: TEST_MCP_RESOURCE,
    allowedOrigins: [],
    pinOutbound: false,
  };
}

async function resolveTestSession(
  headers: Headers,
): Promise<SessionUser | null> {
  const session = await testAuth().api.getSession({ headers });
  if (!session || session.user.banned) return null;
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role === "Admin" ? "Admin" : "User",
    sessionId: session.session.id,
    mustChangePassword: session.user.mustChangePassword === true,
  };
}

/** Drives B's authorize + consent with the user's cookie and returns the callback URL B redirects to. */
async function authorizeOnRemote(
  authorizeUrl: string,
  cookie: string,
): Promise<URL> {
  const first = await testAuth().handler(
    new Request(authorizeUrl, { headers: { cookie } }),
  );
  const target = await redirectTargetOf(first);
  if (target.includes("/consent")) {
    const consent = await testAuth().handler(
      new Request(`${B}/api/auth/oauth2/consent`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: B },
        body: JSON.stringify({
          accept: true,
          oauth_query: new URL(target, B).search.slice(1),
        }),
      }),
    );
    return new URL(await redirectTargetOf(consent), B);
  }
  return new URL(target, B);
}

async function connectedFixture(suffix: string) {
  const db = getPrisma();
  const admin = securityContextFor(
    await makeUser("Admin", `rc-${suffix}-admin`),
  );
  const user = await makeUser("User", `rc-${suffix}-user`);
  const remote = await createRemoteInstance(deps(), admin, {
    name: "B",
    baseUrl: B,
  });
  // B's admin registered A; both instances share this test database.
  await db.$transaction((tx) =>
    syncRemoteOauthClient(
      tx,
      { name: "A", baseUrl: A, enabled: true },
      TEST_MCP_RESOURCE,
    ),
  );
  const cookie = await sessionCookieFor(user.email, TEST_PASSWORD);
  const { authorizeUrl } = await beginRemoteConnection(
    deps(),
    securityContextFor(user),
    { remoteInstanceId: remote.id },
  );
  const callback = await authorizeOnRemote(authorizeUrl, cookie);
  return { db, user, remote, cookie, callback, authorizeUrl };
}

describe("remote connections", () => {
  beforeEach(async () => {
    await resetDb();
    await ensureOAuthResource();
    vi.mocked(getSessionUser).mockImplementation(resolveTestSession);
    vi.mocked(getBearerVerifiers).mockImplementation(() =>
      createBearerVerifiers(testAuth(), {
        issuer: TEST_ISSUER,
        audience: TEST_MCP_RESOURCE,
      }),
    );
  });
  afterEach(() =>
    vi.mocked(getSessionUser).mockImplementation(() => Promise.resolve(null)),
  );

  it("connects through B's authorize, consent and token endpoints and stores encrypted tokens", async () => {
    const { db, user, remote, cookie, callback, authorizeUrl } =
      await connectedFixture("ok");
    const url = new URL(authorizeUrl);
    expect(url.origin + url.pathname).toBe(remoteEndpoints(B).authorize);
    expect(url.searchParams.get("client_id")).toBe(`weaver-instance:${A}`);
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${A}/api/remotes/callback`,
    );
    expect(url.searchParams.get("resource")).toBe(`${B}/api/mcp`);
    expect(callback.origin + callback.pathname).toBe(
      `${A}/api/remotes/callback`,
    );

    const response = await handleRemoteCallback(
      new Request(callback, { headers: { cookie } }),
      deps(),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `${A}/account/remote-instances?connected=${remote.id}`,
    );
    const row = await db.remoteInstanceConnection.findUniqueOrThrow({
      where: {
        remoteInstanceId_userId: {
          remoteInstanceId: remote.id,
          userId: user.id,
        },
      },
    });
    expect(row.remoteUserId).toBe(user.id);
    expect(await db.remoteInstanceAuthorization.count()).toBe(0);
    const listed = await listRemoteInstancesForUser(
      db,
      securityContextFor(user),
    );
    // makeUser names a user "<role> <suffix>".
    expect(listed[0]?.connection?.remoteUserName).toBe("User rc-ok-user");

    let accessToken = "";
    const who = await withRemoteToken(
      deps(),
      { userId: user.id, remoteInstanceId: remote.id },
      async (token, r, fetchImpl) => {
        accessToken = token;
        const res = await fetchImpl(
          remoteEndpoints(r.baseUrl).transfer("whoami"),
          { headers: { authorization: `Bearer ${token}` } },
        );
        return (await res.json()) as { userId: string };
      },
    );
    expect(who.userId).toBe(user.id);
    // The JWT never reaches the row in clear, neither as text nor as decoded bytes.
    expect(accessToken).toMatch(/^ey/);
    expect(JSON.stringify(row)).not.toContain(accessToken);
    expect(
      Buffer.from(row.tokensCiphertext, "base64").toString("latin1"),
    ).not.toContain(accessToken);
  });

  it("rejects a callback for another user's state or an expired one", async () => {
    const { callback, remote, db, cookie } = await connectedFixture("state");
    const stranger = await makeUser("User", "rc-state-stranger");
    const strangerCookie = await sessionCookieFor(
      stranger.email,
      TEST_PASSWORD,
    );
    const wrongUser = await handleRemoteCallback(
      new Request(callback, { headers: { cookie: strangerCookie } }),
      deps(),
    );
    expect(wrongUser.headers.get("location")).toBe(
      `${A}/account/remote-instances?error=state`,
    );
    expect(await db.remoteInstanceConnection.count()).toBe(0);

    await db.remoteInstanceAuthorization.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const late = await handleRemoteCallback(
      new Request(callback, { headers: { cookie } }),
      deps(),
    );
    expect(late.headers.get("location")).toBe(
      `${A}/account/remote-instances?error=state`,
    );
    expect(
      await db.remoteInstanceConnection.count({
        where: { remoteInstanceId: remote.id },
      }),
    ).toBe(0);
    expect(await db.remoteInstanceAuthorization.count()).toBe(0);
    expect(
      (await handleRemoteCallback(new Request(callback), deps())).status,
    ).toBe(401);
  });

  it("refreshes an expiring token, and asks to reconnect when the refresh is refused", async () => {
    const { db, user, remote, cookie, callback } =
      await connectedFixture("refresh");
    await handleRemoteCallback(
      new Request(callback, { headers: { cookie } }),
      deps(),
    );
    const before = await db.remoteInstanceConnection.findFirstOrThrow({
      where: { userId: user.id },
    });
    const later = () =>
      new Date(before.accessTokenExpiresAt.getTime() - 30_000);
    await withRemoteToken(
      deps(later),
      { userId: user.id, remoteInstanceId: remote.id },
      async () => undefined,
    );
    const after = await db.remoteInstanceConnection.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(after.tokensCiphertext).not.toBe(before.tokensCiphertext);
    expect(after.accessTokenExpiresAt.getTime()).toBeGreaterThan(
      before.accessTokenExpiresAt.getTime(),
    );

    await db.oauthRefreshToken.deleteMany({});
    await expect(
      withRemoteToken(
        deps(() => new Date(after.accessTokenExpiresAt.getTime() + 1)),
        { userId: user.id, remoteInstanceId: remote.id },
        async () => undefined,
      ),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Reconnect to B",
    });
  });

  it("reports an unreachable remote instead of asking to reconnect", async () => {
    const { db, user, remote, cookie, callback } =
      await connectedFixture("unreachable");
    await handleRemoteCallback(
      new Request(callback, { headers: { cookie } }),
      deps(),
    );
    const before = await db.remoteInstanceConnection.findFirstOrThrow({
      where: { userId: user.id },
    });
    const later = () =>
      new Date(before.accessTokenExpiresAt.getTime() - 30_000);
    const offline: RemoteRuntimeDeps = {
      ...deps(later),
      fetchImpl: (() =>
        Promise.reject(new TypeError("fetch failed"))) as typeof fetch,
    };
    await expect(
      withRemoteToken(
        offline,
        { userId: user.id, remoteInstanceId: remote.id },
        async () => undefined,
      ),
    ).rejects.toMatchObject({ name: "TypeError", message: "fetch failed" });
    const after = await db.remoteInstanceConnection.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(after.tokensCiphertext).toBe(before.tokensCiphertext);
  });

  it("stores nothing when B refuses the authorization code", async () => {
    const { db, cookie, callback } = await connectedFixture("badcode");
    const forged = new URL(callback);
    forged.searchParams.set("code", "not-a-code");
    const response = await handleRemoteCallback(
      new Request(forged, { headers: { cookie } }),
      deps(),
    );
    expect(response.headers.get("location")).toBe(
      `${A}/account/remote-instances?error=token`,
    );
    expect(await db.remoteInstanceConnection.count()).toBe(0);
  });

  it("serialises concurrent refreshes so B's reuse detection keeps the grant", async () => {
    const { db, user, remote, cookie, callback } =
      await connectedFixture("race");
    await handleRemoteCallback(
      new Request(callback, { headers: { cookie } }),
      deps(),
    );
    const row = await db.remoteInstanceConnection.findFirstOrThrow({
      where: { userId: user.id },
    });
    const expiring = () =>
      new Date(row.accessTokenExpiresAt.getTime() - 30_000);
    const whoami = () =>
      withRemoteToken(
        deps(expiring),
        { userId: user.id, remoteInstanceId: remote.id },
        async (token, r, fetchImpl) => {
          const res = await fetchImpl(
            remoteEndpoints(r.baseUrl).transfer("whoami"),
            { headers: { authorization: `Bearer ${token}` } },
          );
          return res.status;
        },
      );
    expect(await Promise.all([whoami(), whoami()])).toEqual([200, 200]);
    // A rotated-out refresh token presented twice would have revoked every token of the grant.
    expect(
      await withRemoteToken(
        deps(),
        { userId: user.id, remoteInstanceId: remote.id },
        async (token, r, fetchImpl) =>
          (
            await fetchImpl(remoteEndpoints(r.baseUrl).transfer("whoami"), {
              headers: { authorization: `Bearer ${token}` },
            })
          ).status,
      ),
    ).toBe(200);
  });

  it("refuses a disabled remote and forgets tokens on disconnect", async () => {
    const { db, user, remote, cookie, callback } =
      await connectedFixture("disable");
    await handleRemoteCallback(
      new Request(callback, { headers: { cookie } }),
      deps(),
    );
    await db.remoteInstance.update({
      where: { id: remote.id },
      data: { enabled: false },
    });
    await expect(
      withRemoteToken(
        deps(),
        { userId: user.id, remoteInstanceId: remote.id },
        async () => undefined,
      ),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("disabled"),
    });
    await db.remoteInstance.update({
      where: { id: remote.id },
      data: { enabled: true },
    });
    await disconnectRemoteInstance(db, securityContextFor(user), {
      remoteInstanceId: remote.id,
    });
    expect(await db.remoteInstanceConnection.count()).toBe(0);
    await expect(
      withRemoteToken(
        deps(),
        { userId: user.id, remoteInstanceId: remote.id },
        async () => undefined,
      ),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Reconnect to B",
    });
  });
});

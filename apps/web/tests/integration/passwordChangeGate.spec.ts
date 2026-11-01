import { beforeEach, describe, expect, it } from "vitest";

import { denyFlaggedConsent } from "~/app/(auth)/consent/mustChangePasswordGate";

import {
  ensureOAuthResource,
  getPrisma,
  makeUser,
  resetDb,
  TEST_PASSWORD,
  testAuth,
} from "./_harness";
import {
  authorizeUrl,
  insertOAuthClient,
  obtainAccessToken,
  pkce,
  redirectTargetOf,
  sessionCookieFor,
  TEST_OAUTH_REDIRECT_URI,
  TEST_ORIGIN,
  toSearchParams,
} from "./_oauth";

const SCOPE = "mcp:use content:read content:write";

async function setFlag(userId: string, mustChangePassword: boolean) {
  await getPrisma().user.update({
    where: { id: userId },
    data: { mustChangePassword },
  });
}

/** Drives a real /oauth2/authorize request and returns where it sends the browser. */
async function authorizeTarget(cookie: string): Promise<string> {
  const authorize = await testAuth().handler(
    new Request(authorizeUrl(pkce().challenge, SCOPE), { headers: { cookie } }),
  );
  return redirectTargetOf(authorize);
}

function signedQueryOf(target: string): string {
  return new URL(target, TEST_ORIGIN).search.slice(1);
}

async function postConsent(
  cookie: string,
  oauthQuery: string,
  accept: boolean,
): Promise<Response> {
  return testAuth().handler(
    new Request(`${TEST_ORIGIN}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: TEST_ORIGIN,
      },
      body: JSON.stringify({ accept, oauth_query: oauthQuery }),
    }),
  );
}

async function authRequest(
  path: string,
  cookie: string,
  init?: { method?: string; body?: Record<string, unknown> },
): Promise<Response> {
  return testAuth().handler(
    new Request(`${TEST_ORIGIN}/api/auth${path}`, {
      method: init?.method ?? "GET",
      headers: {
        cookie,
        origin: TEST_ORIGIN,
        ...(init?.body ? { "content-type": "application/json" } : {}),
      },
      ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
    }),
  );
}

describe("Better Auth forced password change gate", () => {
  beforeEach(async () => {
    await resetDb();
    await ensureOAuthResource();
    await insertOAuthClient();
  });

  it("sends a flagged user with a prior consent to the consent page instead of straight to a code", async () => {
    const user = await makeUser("User", "returning");
    const cookie = await sessionCookieFor(user.email);
    await obtainAccessToken(cookie, SCOPE);

    // Positive control, and the gap itself: with a consent on file, an
    // unflagged returning client gets a code without the consent page ever
    // rendering.
    const direct = await authorizeTarget(cookie);
    expect(direct.startsWith(TEST_OAUTH_REDIRECT_URI)).toBe(true);
    expect(new URL(direct).searchParams.get("code")).toBeTruthy();

    await setFlag(user.id, true);
    const gated = await authorizeTarget(cookie);
    expect(gated).toContain("/consent?");
    expect(new URL(gated, TEST_ORIGIN).searchParams.get("code")).toBeNull();

    // The page then aborts it cleanly, exactly as it does for a first consent.
    const denied = await denyFlaggedConsent(
      testAuth(),
      toSearchParams(new URL(gated, TEST_ORIGIN)),
      new Headers({ cookie }),
    );
    expect(denied.startsWith(TEST_OAUTH_REDIRECT_URI)).toBe(true);
    expect(new URL(denied).searchParams.get("error")).toBe("access_denied");
    expect(new URL(denied).searchParams.get("code")).toBeNull();
  });

  it("rejects a direct consent acceptance while flagged but still lets the page deny", async () => {
    const user = await makeUser("User", "replay");
    const cookie = await sessionCookieFor(user.email);

    // Positive control: the raw POST is what mints a code for an unflagged
    // user, so a later rejection cannot be blamed on a malformed replay.
    const openQuery = signedQueryOf(await authorizeTarget(cookie));
    const accepted = await postConsent(cookie, openQuery, true);
    expect(
      new URL(await redirectTargetOf(accepted)).searchParams.get("code"),
    ).toBeTruthy();
    expect(
      await getPrisma().oauthConsent.count({ where: { userId: user.id } }),
    ).toBe(1);
    await getPrisma().oauthConsent.deleteMany({ where: { userId: user.id } });

    await setFlag(user.id, true);
    const gatedQuery = signedQueryOf(await authorizeTarget(cookie));
    const replay = await postConsent(cookie, gatedQuery, true);
    expect(replay.status).toBe(403);
    expect(
      await getPrisma().oauthConsent.count({ where: { userId: user.id } }),
    ).toBe(0);

    const deny = await postConsent(cookie, gatedQuery, false);
    const target = await redirectTargetOf(deny);
    expect(target.startsWith(TEST_OAUTH_REDIRECT_URI)).toBe(true);
    expect(new URL(target).searchParams.get("error")).toBe("access_denied");
  });

  it("keeps sign-in, session lookup, and sign-out reachable while blocking every other cookie route", async () => {
    const user = await makeUser("User", "routes");
    const cookie = await sessionCookieFor(user.email);
    // Positive control: the route the gate blocks is otherwise reachable.
    expect((await authRequest("/list-sessions", cookie)).status).toBe(200);

    await setFlag(user.id, true);
    expect((await authRequest("/list-sessions", cookie)).status).toBe(403);

    const session = await authRequest("/get-session", cookie);
    expect(session.status).toBe(200);
    expect(
      (
        (await session.json()) as {
          user: { id: string; mustChangePassword: boolean };
        }
      ).user,
    ).toMatchObject({ id: user.id, mustChangePassword: true });

    // A browser still carrying the flagged cookie must be able to sign in again.
    const signIn = await authRequest("/sign-in/email", cookie, {
      method: "POST",
      body: { email: user.email, password: TEST_PASSWORD },
    });
    expect(signIn.status).toBe(200);

    // Password changes only run in process, under the credential lock
    // (accountPassword.spec.ts covers that path while flagged).
    const changed = await authRequest("/change-password", cookie, {
      method: "POST",
      body: {
        currentPassword: TEST_PASSWORD,
        newPassword: "a-fresh-password-1",
      },
    });
    expect(changed.status).toBe(404);

    // Clearing the flag is account.changePassword's job (the tRPC layer), not
    // Better Auth's; clear it by hand to prove the hook reads the live value.
    await setFlag(user.id, false);
    expect((await authRequest("/list-sessions", cookie)).status).toBe(200);
    expect(
      (await authRequest("/sign-out", cookie, { method: "POST" })).status,
    ).toBe(200);
  });
});

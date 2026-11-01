import { beforeEach, describe, expect, it } from "vitest";

import {
  buildQueryString,
  denyFlaggedConsent,
} from "~/app/(auth)/consent/mustChangePasswordGate";
import { ACCOUNT_PASSWORD_PATH } from "~/lib/passwordChangeGate";

import {
  ensureOAuthResource,
  getPrisma,
  makeUser,
  resetDb,
  testAuth,
} from "./_harness";
import {
  authorizeUrl,
  insertOAuthClient,
  obtainAccessToken,
  pkce,
  redirectTargetOf,
  sessionCookieFor,
  TEST_ORIGIN,
  TEST_OAUTH_REDIRECT_URI,
  toSearchParams,
} from "./_oauth";

/** Drives a real /oauth2/authorize request and returns the /consent redirect's query, Next-shaped. */
async function reachConsent(cookie: string, scope: string) {
  const { challenge } = pkce();
  const authorize = await testAuth().handler(
    new Request(authorizeUrl(challenge, scope), { headers: { cookie } }),
  );
  const target = await redirectTargetOf(authorize);
  expect(target).toContain("/consent?");
  return toSearchParams(new URL(target, TEST_ORIGIN));
}

describe("consent page — forced password change gate", () => {
  beforeEach(async () => {
    await resetDb();
    await ensureOAuthResource();
    await insertOAuthClient();
  });

  it("denies a flagged user's in-flight authorization instead of letting the form approve it", async () => {
    const user = await makeUser("User", "flagged-consent");
    await getPrisma().user.update({
      where: { id: user.id },
      data: { mustChangePassword: true },
    });
    const cookie = await sessionCookieFor(user.email);
    const params = await reachConsent(
      cookie,
      "mcp:use content:read content:write",
    );

    const target = await denyFlaggedConsent(
      testAuth(),
      params,
      new Headers({ cookie }),
    );

    // Proves the deny path ran (Better Auth's access_denied redirect shape),
    // not merely that something went wrong: a thrown/malformed-query fallback
    // would land on ACCOUNT_PASSWORD_PATH, never on the client's redirect_uri
    // with this error shape.
    const deniedUrl = new URL(target);
    expect(target.startsWith(TEST_OAUTH_REDIRECT_URI)).toBe(true);
    expect(deniedUrl.searchParams.get("error")).toBe("access_denied");
    expect(deniedUrl.searchParams.get("code")).toBeNull();
  });

  it("does not affect a non-flagged user's normal consent flow (same client, same scope)", async () => {
    const user = await makeUser("User", "normal-consent");
    const cookie = await sessionCookieFor(user.email);

    const tokens = await obtainAccessToken(
      cookie,
      "mcp:use content:read content:write",
    );

    expect(tokens.access_token).toBeTruthy();
  });

  it("falls back to the account password page without throwing on a malformed oauth_query", async () => {
    const user = await makeUser("User", "malformed-consent");
    const cookie = await sessionCookieFor(user.email);

    const target = await denyFlaggedConsent(
      testAuth(),
      { client_id: "not-a-real-client", scope: "content:write" },
      new Headers({ cookie }),
    );

    expect(target).toBe(ACCOUNT_PASSWORD_PATH);
  });

  it("falls back to the account password page when there is no oauth_query at all", async () => {
    const user = await makeUser("User", "empty-consent");
    const cookie = await sessionCookieFor(user.email);
    expect(buildQueryString({})).toBe("");

    const target = await denyFlaggedConsent(
      testAuth(),
      {},
      new Headers({ cookie }),
    );

    expect(target).toBe(ACCOUNT_PASSWORD_PATH);
  });
});

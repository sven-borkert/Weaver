import { createHash, randomBytes } from "node:crypto";
import { expect } from "vitest";
import { OAUTH_SCOPES } from "@weaver/auth";
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
} from "jose";
import {
  getPrisma,
  TEST_MCP_RESOURCE,
  TEST_PASSWORD,
  testAuth,
} from "./_harness";

export const TEST_ORIGIN = "http://localhost:3000";
export const TEST_OAUTH_REDIRECT_URI = "http://127.0.0.1:9/callback";
export const TEST_OAUTH_CLIENT_ID = "weaver-test-mcp-client";

export async function sessionCookieFor(
  email: string,
  password: string = TEST_PASSWORD,
): Promise<string> {
  const response = await testAuth().api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const pair = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  expect(pair).toMatch(/session_token=/);
  return pair;
}

/** A pre-registered public native client with a loopback redirect (CIMD needs HTTPS, which the harness has no host for). */
export async function insertOAuthClient(options?: {
  dpopBoundAccessTokens?: boolean;
}): Promise<void> {
  const now = new Date();
  await getPrisma().oauthClient.create({
    data: {
      clientId: TEST_OAUTH_CLIENT_ID,
      name: "Test MCP client",
      redirectUris: [TEST_OAUTH_REDIRECT_URI],
      scopes: [...OAUTH_SCOPES],
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      tokenEndpointAuthMethod: "none",
      applicationType: "native",
      requirePKCE: true,
      disabled: false,
      skipConsent: false,
      dpopBoundAccessTokens: options?.dpopBoundAccessTokens ?? false,
      createdAt: now,
      updatedAt: now,
    },
  });
  await getPrisma().oauthClientResource.create({
    data: {
      clientId: TEST_OAUTH_CLIENT_ID,
      resourceId: TEST_MCP_RESOURCE,
      createdAt: now,
    },
  });
}

export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Better Auth answers browser navigations with 302 and JSON callers with { url }. */
export async function redirectTargetOf(response: Response): Promise<string> {
  if (response.status >= 300 && response.status < 400) {
    return response.headers.get("location") ?? "";
  }
  const body = (await response.json()) as {
    url?: string;
    redirect_uri?: string;
  };
  return body.url ?? body.redirect_uri ?? "";
}

/**
 * Rebuilds the `Record<string, string | string[] | undefined>` Next.js's
 * `searchParams` prop would hand the consent page — repeated keys (Better
 * Auth's signed query carries a repeated `ba_param`) become arrays, not the
 * last-write-wins map a plain Object.fromEntries would produce.
 */
export function toSearchParams(
  url: URL,
): Record<string, string | string[] | undefined> {
  const result: Record<string, string | string[] | undefined> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    result[key] = values.length > 1 ? values : values[0];
  }
  return result;
}

export function authorizeUrl(challenge: string, scope: string): string {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: TEST_OAUTH_CLIENT_ID,
    redirect_uri: TEST_OAUTH_REDIRECT_URI,
    scope,
    state: "state-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: TEST_MCP_RESOURCE,
  });
  return `${TEST_ORIGIN}/api/auth/oauth2/authorize?${query}`;
}

export async function obtainAuthorizationCode(
  cookie: string,
  scope: string,
  expectConsent = true,
): Promise<{ code: string; verifier: string }> {
  const { verifier, challenge } = pkce();
  const authorize = await testAuth().handler(
    new Request(authorizeUrl(challenge, scope), { headers: { cookie } }),
  );
  let target = await redirectTargetOf(authorize);
  if (expectConsent) expect(target).toContain("/consent?");
  if (target.includes("/consent?")) {
    const consent = await testAuth().handler(
      new Request(`${TEST_ORIGIN}/api/auth/oauth2/consent`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          origin: TEST_ORIGIN,
        },
        body: JSON.stringify({
          accept: true,
          oauth_query: new URL(target, TEST_ORIGIN).search.slice(1),
        }),
      }),
    );
    target = await redirectTargetOf(consent);
  }
  const code = new URL(target).searchParams.get("code");
  expect(code).toBeTruthy();
  return { code: code!, verifier };
}

export async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
): Promise<Response> {
  return testAuth().handler(
    new Request(`${TEST_ORIGIN}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: TEST_OAUTH_REDIRECT_URI,
        client_id: TEST_OAUTH_CLIENT_ID,
        code_verifier: verifier,
        resource: TEST_MCP_RESOURCE,
      }),
    }),
  );
}

export async function obtainAccessToken(
  cookie: string,
  scope = "mcp:use content:read content:write offline_access",
  expectConsent = true,
): Promise<{ access_token: string; refresh_token?: string; scope: string }> {
  const { code, verifier } = await obtainAuthorizationCode(
    cookie,
    scope,
    expectConsent,
  );
  const token = await exchangeAuthorizationCode(code, verifier);
  expect(token.status).toBe(200);
  return (await token.json()) as never;
}

export async function exchangeRefreshToken(
  refreshToken: string,
  scope?: string,
): Promise<Response> {
  return testAuth().handler(
    new Request(`${TEST_ORIGIN}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: TEST_OAUTH_CLIENT_ID,
        resource: TEST_MCP_RESOURCE,
        ...(scope ? { scope } : {}),
      }),
    }),
  );
}

export type DpopKey = { privateKey: CryptoKey; jwk: JWK; jkt: string };

export async function generateDpopKey(): Promise<DpopKey> {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  return { privateKey, jwk, jkt: await calculateJwkThumbprint(jwk) };
}

/** RFC 9449 §4.2 proof; `ath` is set when an access token is presented. */
export async function dpopProofFor(
  key: DpopKey,
  input: { htm: string; htu: string; accessToken?: string; nonce?: string },
): Promise<string> {
  const claims: Record<string, unknown> = {
    htm: input.htm,
    htu: input.htu,
    jti: randomBytes(16).toString("base64url"),
    ...(input.nonce ? { nonce: input.nonce } : {}),
  };
  if (input.accessToken) {
    claims.ath = createHash("sha256")
      .update(input.accessToken)
      .digest("base64url");
  }
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: key.jwk })
    .setIssuedAt()
    .sign(key.privateKey);
}

/**
 * Same code flow as obtainAccessToken, but the token request carries a DPoP
 * proof so the AS binds the token to `key` (RFC 9449 §5). Retries once with
 * the server nonce when the AS asks for one (`use_dpop_nonce`).
 */
export async function obtainDpopBoundToken(
  cookie: string,
  key: DpopKey,
  scope = "mcp:use content:read",
): Promise<{ access_token: string; token_type: string }> {
  const { verifier, challenge } = pkce();
  const authorize = await testAuth().handler(
    new Request(authorizeUrl(challenge, scope), { headers: { cookie } }),
  );
  let target = await redirectTargetOf(authorize);
  if (target.includes("/consent?")) {
    const consent = await testAuth().handler(
      new Request(`${TEST_ORIGIN}/api/auth/oauth2/consent`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          origin: TEST_ORIGIN,
        },
        body: JSON.stringify({
          accept: true,
          oauth_query: new URL(target, TEST_ORIGIN).search.slice(1),
        }),
      }),
    );
    target = await redirectTargetOf(consent);
  }
  const code = new URL(target).searchParams.get("code");
  expect(code).toBeTruthy();
  const tokenUrl = `${TEST_ORIGIN}/api/auth/oauth2/token`;
  const exchange = (nonce?: string) =>
    dpopProofFor(key, { htm: "POST", htu: tokenUrl, nonce }).then((proof) =>
      testAuth().handler(
        new Request(tokenUrl, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            dpop: proof,
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: code!,
            redirect_uri: TEST_OAUTH_REDIRECT_URI,
            client_id: TEST_OAUTH_CLIENT_ID,
            code_verifier: verifier,
            resource: TEST_MCP_RESOURCE,
          }),
        }),
      ),
    );
  let response = await exchange();
  if (response.status === 400) {
    const nonce = response.headers.get("dpop-nonce");
    if (nonce) response = await exchange(nonce);
  }
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    access_token: string;
    token_type: string;
  };
  expect(body.token_type).toBe("DPoP");
  return body;
}

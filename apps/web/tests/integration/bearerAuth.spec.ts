import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { oauthIssuerUrl } from "@weaver/config/publicUrls";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createWeaverAuth,
  createBearerVerifiers,
  DISABLED_API_KEY_PATHS,
  OAUTH_SCOPES,
} from "@weaver/auth";
import {
  resolveBearerSecurityContext,
  resolveMcpPrincipal,
} from "@weaver/core/security/bearer";
import {
  addMembership,
  callerFor,
  callerWithSecurity,
  ensureOAuthResource,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  TEST_ISSUER,
  TEST_MCP_RESOURCE,
  TEST_PASSWORD,
  testAuth,
} from "./_harness";
import {
  authorizeUrl,
  exchangeRefreshToken,
  insertOAuthClient,
  obtainAccessToken,
  pkce,
  redirectTargetOf,
  sessionCookieFor,
  TEST_OAUTH_CLIENT_ID,
  TEST_OAUTH_REDIRECT_URI,
  TEST_ORIGIN,
} from "./_oauth";
import { withAuthRequestBasePath } from "~/server/auth/requestBasePath";

const verifiers = () =>
  createBearerVerifiers(testAuth(), {
    issuer: TEST_ISSUER,
    audience: TEST_MCP_RESOURCE,
  });

describe("bearer credentials", () => {
  beforeEach(async () => {
    await resetDb();
    await ensureOAuthResource();
  });

  describe("personal API keys", () => {
    it("resolves a restricted key to an apiKey SecurityContext and records last use", async () => {
      const user = await makeUser("Admin", "ba1");
      const project = await makeProject("Scoped");
      await addMembership(project.id, user.id, "Owner");
      const created = await callerFor(user).apiKey.create({
        name: "Scoped",
        projectIds: [project.id],
      });

      const context = await resolveBearerSecurityContext(
        getPrisma(),
        verifiers(),
        `Bearer ${created.secret}`,
      );
      expect(context).toMatchObject({
        userId: user.id,
        globalRole: "Admin",
        authenticationMethod: "apiKey",
        credentialId: created.key.id,
      });
      expect([...context.capabilities].sort()).toEqual([
        "content:read",
        "mcp:use",
      ]);
      expect(context.allowedProjectIds).toEqual(new Set([project.id]));

      const stored = await getPrisma().apiKey.findUniqueOrThrow({
        where: { id: created.key.id },
      });
      expect(stored.lastRequest).toBeInstanceOf(Date);
      expect(
        (await callerFor(user).apiKey.list())[0]?.lastUsedAt,
      ).toBeInstanceOf(Date);

      // The context works end to end through the routers.
      await expect(
        callerWithSecurity(user, context).project.get({
          projectId: project.id,
        }),
      ).resolves.toMatchObject({ id: project.id });
      await expect(
        callerWithSecurity(user, context).project.update({
          projectId: project.id,
          name: "x",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("never widens a key that is revoked or edited between verification and policy resolution", async () => {
      const user = await makeUser("User", "ba-race");
      const projectA = await makeProject("Race A");
      const projectB = await makeProject("Race B");
      await addMembership(projectA.id, user.id, "Owner");
      await addMembership(projectB.id, user.id, "Owner");
      const caller = callerFor(user);
      const created = await caller.apiKey.create({
        name: "Race",
        projectIds: [projectA.id],
        capabilities: ["content:write"],
      });
      const real = verifiers();
      const after = (change: () => Promise<unknown>) => ({
        ...real,
        verifyApiKey: async (secret: string) => {
          const verified = await real.verifyApiKey(secret);
          await change();
          return verified;
        },
      });

      const edited = await resolveBearerSecurityContext(
        getPrisma(),
        after(() =>
          caller.apiKey.update({
            keyId: created.key.id,
            name: "Race",
            projectIds: [projectB.id],
          }),
        ),
        `Bearer ${created.secret}`,
      );
      expect(edited.capabilities.has("content:write")).toBe(false);
      expect(edited.allowedProjectIds).toEqual(new Set([projectB.id]));

      await expect(
        resolveBearerSecurityContext(
          getPrisma(),
          after(() => caller.apiKey.revoke({ keyId: created.key.id })),
          `Bearer ${created.secret}`,
        ),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });

    it("rejects unknown, revoked, and banned-user keys as UNAUTHORIZED", async () => {
      const user = await makeUser("User", "ba2");
      const created = await callerFor(user).apiKey.create({ name: "Temp" });

      await expect(
        resolveBearerSecurityContext(
          getPrisma(),
          verifiers(),
          "Bearer wvr_not_a_real_key",
        ),
      ).rejects.toMatchObject({
        code: "UNAUTHORIZED",
        message: "Invalid bearer credential",
      });
      await expect(
        resolveBearerSecurityContext(getPrisma(), verifiers(), null),
      ).rejects.toMatchObject({
        code: "UNAUTHORIZED",
        message: "Invalid bearer credential",
      });

      await getPrisma().user.update({
        where: { id: user.id },
        data: { banned: true },
      });
      await expect(
        resolveBearerSecurityContext(
          getPrisma(),
          verifiers(),
          `Bearer ${created.secret}`,
        ),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await getPrisma().user.update({
        where: { id: user.id },
        data: { banned: false },
      });

      await callerFor(user).apiKey.revoke({ keyId: created.key.id });
      await expect(
        resolveBearerSecurityContext(
          getPrisma(),
          verifiers(),
          `Bearer ${created.secret}`,
        ),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });

    it("enforces the key's own rate limit as TOO_MANY_REQUESTS", async () => {
      const user = await makeUser("User", "ba3");
      const created = await callerFor(user).apiKey.create({
        name: "Limited",
        rateLimitPerMinute: 2,
      });
      const header = `Bearer ${created.secret}`;
      await resolveBearerSecurityContext(getPrisma(), verifiers(), header);
      await resolveBearerSecurityContext(getPrisma(), verifiers(), header);
      await expect(
        resolveBearerSecurityContext(getPrisma(), verifiers(), header),
      ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    });

    it("rejects an expired key", async () => {
      const user = await makeUser("User", "ba4");
      const created = await callerFor(user).apiKey.create({
        name: "Old",
        expiresInDays: 1,
      });
      await getPrisma().apiKey.update({
        where: { id: created.key.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      await expect(
        resolveBearerSecurityContext(
          getPrisma(),
          verifiers(),
          `Bearer ${created.secret}`,
        ),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });

    it("never emulates a session for an API key (enableSessionForAPIKeys: false)", async () => {
      const user = await makeUser("User", "ba6");
      const created = await callerFor(user).apiKey.create({
        name: "NoSession",
      });
      const session = await testAuth().api.getSession({
        headers: new Headers({ "x-api-key": created.secret }),
      });
      expect(session).toBeNull();
    });

    it("keeps the plugin's HTTP key routes closed", async () => {
      const user = await makeUser("User", "ba5");
      const cookie = await sessionCookieFor(user.email);
      for (const path of DISABLED_API_KEY_PATHS) {
        const response = await testAuth().handler(
          new Request(`${TEST_ORIGIN}/api/auth${path}`, {
            method:
              path === "/api-key/get" || path === "/api-key/list"
                ? "GET"
                : "POST",
            headers: {
              "content-type": "application/json",
              cookie,
              origin: TEST_ORIGIN,
            },
            body:
              path === "/api-key/get" || path === "/api-key/list"
                ? undefined
                : JSON.stringify({ name: "x", key: "x" }),
          }),
        );
        expect(response.status, path).toBe(404);
      }
    });
  });

  describe("MCP OAuth 2.1", () => {
    it("advertises the public issuer under a base path while still matching /api/auth (spec §26.6)", async () => {
      const auth2 = createWeaverAuth({
        db: getPrisma(),
        secret: process.env.AUTH_SECRET!,
        baseURL: oauthIssuerUrl({ NEXT_PUBLIC_BASE_PATH: "/knowledge" }),
        mcp: {
          resource: "http://localhost:3000/knowledge/api/mcp",
          loginPage: "/knowledge/login",
          consentPage: "/knowledge/consent",
        },
      });
      const metadata = await oauthProviderAuthServerMetadata(auth2)(
        new Request(
          "http://localhost:3000/.well-known/oauth-authorization-server/knowledge/api/auth",
        ),
      );
      expect(metadata.status).toBe(200);
      const body = (await metadata.json()) as Record<string, unknown>;
      expect(body.issuer).toBe("http://localhost:3000/knowledge/api/auth");
      expect(body.authorization_endpoint).toBe(
        "http://localhost:3000/knowledge/api/auth/oauth2/authorize",
      );
      expect(body.token_endpoint).toBe(
        "http://localhost:3000/knowledge/api/auth/oauth2/token",
      );
      // Next strips the prefix before its route handler; the web adapter
      // restores it so Better Auth can match its public baseURL path.
      const ok = await auth2.handler(
        withAuthRequestBasePath(
          new Request("http://localhost:3000/api/auth/ok"),
          "/knowledge",
        ),
      );
      expect(ok.status).toBe(200);
    });

    it("redirects anonymous authorization requests to the login page with a signed query", async () => {
      await insertOAuthClient();
      const response = await testAuth().handler(
        new Request(authorizeUrl(pkce().challenge, "mcp:use content:read")),
      );
      const target = await redirectTargetOf(response);
      expect(target).toMatch(/^\/login\?/);
      const params = new URL(target, TEST_ORIGIN).searchParams;
      expect(params.get("client_id")).toBe(TEST_OAUTH_CLIENT_ID);
      expect(params.get("sig")).toBeTruthy();
    });

    it("issues an audience-bound JWT after consent and resolves it to an oauth SecurityContext", async () => {
      await insertOAuthClient();
      const user = await makeUser("User", "oa1");
      const project = await makeProject("P");
      await addMembership(project.id, user.id, "Editor");
      const cookie = await sessionCookieFor(user.email);

      const tokens = await obtainAccessToken(cookie);
      expect(tokens.scope.split(" ").sort()).toEqual(
        ["content:read", "content:write", "mcp:use", "offline_access"].sort(),
      );
      expect(tokens.refresh_token).toBeTruthy();

      const header = `Bearer ${tokens.access_token}`;
      const context = await resolveBearerSecurityContext(
        getPrisma(),
        verifiers(),
        header,
      );
      expect(context).toMatchObject({
        userId: user.id,
        authenticationMethod: "oauth",
        allowedProjectIds: "all-accessible",
      });
      expect(typeof context.credentialId).toBe("string");
      expect([...context.capabilities].sort()).toEqual([
        "content:read",
        "content:write",
        "mcp:use",
      ]);
      await expect(
        callerWithSecurity(user, context).project.update({
          projectId: project.id,
          name: "Via OAuth",
        }),
      ).resolves.toMatchObject({ name: "Via OAuth" });

      // Consent is remembered: the next authorization skips the consent page.
      const { challenge } = pkce();
      const again = await testAuth().handler(
        new Request(
          authorizeUrl(
            challenge,
            "mcp:use content:read content:write offline_access",
          ),
          {
            headers: { cookie },
          },
        ),
      );
      expect(await redirectTargetOf(again)).toMatch(
        /^http:\/\/127\.0\.0\.1:9\/callback\?code=/,
      );
    });

    it("rotates refresh tokens, replays an identical retry, and rejects changed reuse", async () => {
      await insertOAuthClient();
      const user = await makeUser("User", "oa-refresh");
      const cookie = await sessionCookieFor(user.email);
      const initial = await obtainAccessToken(cookie);
      expect(initial.refresh_token).toBeTruthy();

      const rotatedResponse = await exchangeRefreshToken(
        initial.refresh_token!,
      );
      expect(rotatedResponse.status).toBe(200);
      const rotated = (await rotatedResponse.json()) as {
        access_token: string;
        refresh_token: string;
      };
      expect(rotated.access_token).toBeTruthy();
      expect(rotated.refresh_token).toBeTruthy();
      expect(rotated.refresh_token).not.toBe(initial.refresh_token);

      const replayResponse = await exchangeRefreshToken(initial.refresh_token!);
      expect(replayResponse.status).toBe(200);
      await expect(replayResponse.json()).resolves.toMatchObject(rotated);

      const changedReuse = await exchangeRefreshToken(
        initial.refresh_token!,
        "mcp:use",
      );
      expect(changedReuse.status).toBe(400);
      await expect(changedReuse.json()).resolves.toMatchObject({
        error: "invalid_grant",
      });
    });

    it("rejects tokens for another audience or issuer and denied consent", async () => {
      await insertOAuthClient();
      const user = await makeUser("User", "oa2");
      const cookie = await sessionCookieFor(user.email);
      const tokens = await obtainAccessToken(cookie, "mcp:use content:read");

      const wrongAudience = createBearerVerifiers(testAuth(), {
        issuer: TEST_ISSUER,
        audience: "http://localhost:3000/api/other",
      });
      await expect(
        resolveBearerSecurityContext(
          getPrisma(),
          wrongAudience,
          `Bearer ${tokens.access_token}`,
        ),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      const wrongIssuer = createBearerVerifiers(testAuth(), {
        issuer: "http://evil.example/api/auth",
        audience: TEST_MCP_RESOURCE,
      });
      await expect(
        resolveBearerSecurityContext(
          getPrisma(),
          wrongIssuer,
          `Bearer ${tokens.access_token}`,
        ),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

      // Denying consent sends the client an access_denied error instead of a code.
      const other = await makeUser("User", "oa2b");
      const otherCookie = await sessionCookieFor(other.email);
      const authorize = await testAuth().handler(
        new Request(authorizeUrl(pkce().challenge, "mcp:use content:read"), {
          headers: { cookie: otherCookie },
        }),
      );
      const consentTarget = await redirectTargetOf(authorize);
      const denied = await testAuth().handler(
        new Request(`${TEST_ORIGIN}/api/auth/oauth2/consent`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: otherCookie,
            origin: TEST_ORIGIN,
          },
          body: JSON.stringify({
            accept: false,
            oauth_query: new URL(consentTarget, TEST_ORIGIN).search.slice(1),
          }),
        }),
      );
      expect(await redirectTargetOf(denied)).toContain("error=access_denied");
    });

    it("publishes discovery metadata and keeps registration closed", async () => {
      const metadata =
        (await testAuth().api.getOAuthServerConfig()) as unknown as Record<
          string,
          unknown
        >;
      expect(metadata).toMatchObject({
        issuer: TEST_ISSUER,
        authorization_endpoint: `${TEST_ISSUER}/oauth2/authorize`,
        token_endpoint: `${TEST_ISSUER}/oauth2/token`,
        jwks_uri: `${TEST_ISSUER}/jwks`,
        code_challenge_methods_supported: ["S256"],
      });
      expect(metadata.scopes_supported).toEqual([...OAUTH_SCOPES]);

      const resourceMetadata = await testAuth().handler(
        new Request(
          `${TEST_ORIGIN}/.well-known/oauth-protected-resource/api/mcp`,
        ),
      );
      expect(resourceMetadata.status).toBe(200);
      expect(await resourceMetadata.json()).toMatchObject({
        resource: TEST_MCP_RESOURCE,
        authorization_servers: [TEST_ISSUER],
        scopes_supported: [
          "mcp:use",
          "content:read",
          "content:propose",
          "content:write",
          "external:use",
          "external:manage",
        ],
      });

      const register = await testAuth().handler(
        new Request(`${TEST_ORIGIN}/api/auth/oauth2/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            redirect_uris: [TEST_OAUTH_REDIRECT_URI],
          }),
        }),
      );
      expect(register.status).toBe(404);
      const sessionJwt = await testAuth().handler(
        new Request(`${TEST_ORIGIN}/api/auth/token`, {
          headers: {
            cookie: await sessionCookieFor(
              (await makeUser("User", "oa3")).email,
            ),
          },
        }),
      );
      expect(sessionJwt.status).toBe(404);
    });

    it("resumes an authorization after signing in with the signed query", async () => {
      await insertOAuthClient();
      const user = await makeUser("User", "oa4");
      const authorize = await testAuth().handler(
        new Request(authorizeUrl(pkce().challenge, "mcp:use content:read")),
      );
      const loginTarget = await redirectTargetOf(authorize);
      const signIn = await testAuth().handler(
        new Request(`${TEST_ORIGIN}/api/auth/sign-in/email`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: TEST_ORIGIN,
          },
          body: JSON.stringify({
            email: user.email,
            password: TEST_PASSWORD,
            oauth_query: new URL(loginTarget, TEST_ORIGIN).search.slice(1),
          }),
        }),
      );
      expect(signIn.status).toBe(200);
      const body = (await signIn.json()) as {
        redirect?: boolean;
        url?: string;
      };
      expect(body.redirect).toBe(true);
      expect(body.url).toMatch(/\/consent\?/);
    });
  });
});

describe("MCP principal (spec §26.7)", () => {
  const request = (authorizationHeader: string) => ({
    authorizationHeader,
    dpopProofJwt: null,
    method: "POST",
    url: TEST_MCP_RESOURCE,
  });

  beforeEach(async () => {
    await resetDb();
    await ensureOAuthResource();
    await insertOAuthClient();
  });

  it("resolves an API key with the user's profile and no client id", async () => {
    const user = await makeUser("User", "principal-key");
    const created = await callerFor(user).apiKey.create({ name: "Laptop" });
    const principal = await resolveMcpPrincipal(
      getPrisma(),
      verifiers(),
      request(`Bearer ${created.secret}`),
    );
    expect(principal.security.authenticationMethod).toBe("apiKey");
    expect(principal.security.credentialId).toBe(created.key.id);
    expect(principal.profile).toEqual({
      name: "User principal-key",
      email: user.email,
    });
    expect(principal.clientId).toBeNull();
  });

  it("keeps API-key project restrictions identical on legacy and MCP paths", async () => {
    const user = await makeUser("User", "principal-key-scope");
    const project = await makeProject("Principal key scope");
    await addMembership(project.id, user.id, "Owner");
    const created = await callerFor(user).apiKey.create({
      name: "Scoped laptop",
      projectIds: [project.id],
    });
    const header = `Bearer ${created.secret}`;

    const legacy = await resolveBearerSecurityContext(
      getPrisma(),
      verifiers(),
      header,
    );
    const principal = await resolveMcpPrincipal(
      getPrisma(),
      verifiers(),
      request(header),
    );

    expect(legacy.allowedProjectIds).toEqual(new Set([project.id]));
    expect(principal.security.allowedProjectIds).toEqual(new Set([project.id]));
  });

  it("rejects banned API-key users through both public contracts", async () => {
    const user = await makeUser("User", "principal-key-banned");
    const created = await callerFor(user).apiKey.create({ name: "Banned key" });
    const header = `Bearer ${created.secret}`;
    await getPrisma().user.update({
      where: { id: user.id },
      data: { banned: true },
    });

    await expect(
      resolveBearerSecurityContext(getPrisma(), verifiers(), header),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "Invalid bearer credential",
      details: undefined,
    });
    await expect(
      resolveMcpPrincipal(getPrisma(), verifiers(), request(header)),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "Invalid bearer credential",
      details: { reason: "invalid" },
    });
  });

  it("resolves an OAuth token with its client id", async () => {
    const user = await makeUser("User", "principal-oauth");
    const cookie = await sessionCookieFor(user.email);
    const tokens = await obtainAccessToken(cookie, "mcp:use content:read");
    const principal = await resolveMcpPrincipal(
      getPrisma(),
      verifiers(),
      request(`Bearer ${tokens.access_token}`),
    );
    expect(principal.security.authenticationMethod).toBe("oauth");
    expect(principal.clientId).toBe(TEST_OAUTH_CLIENT_ID);
    expect([...principal.security.capabilities].sort()).toEqual([
      "content:read",
      "mcp:use",
    ]);
  });

  it("requires mcp:use and names it in the insufficient_scope failure", async () => {
    const user = await makeUser("User", "principal-scope");
    const cookie = await sessionCookieFor(user.email);
    const tokens = await obtainAccessToken(cookie, "content:read");
    await expect(
      resolveMcpPrincipal(
        getPrisma(),
        verifiers(),
        request(`Bearer ${tokens.access_token}`),
      ),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { reason: "insufficient_scope", scope: "mcp:use" },
    });
  });

  it("rejects an unexpired token immediately when its OAuth client is disabled", async () => {
    const user = await makeUser("User", "disabled-client");
    const tokens = await obtainAccessToken(
      await sessionCookieFor(user.email),
      "mcp:use content:read",
    );
    await getPrisma().oauthClient.update({
      where: { clientId: TEST_OAUTH_CLIENT_ID },
      data: { disabled: true },
    });
    await expect(
      resolveMcpPrincipal(
        getPrisma(),
        verifiers(),
        request(`Bearer ${tokens.access_token}`),
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("stops accepting a token once the consent behind it is revoked", async () => {
    const user = await makeUser("User", "principal-revoke");
    const cookie = await sessionCookieFor(user.email);
    const tokens = await obtainAccessToken(cookie, "mcp:use content:read");
    await getPrisma().oauthConsent.deleteMany({
      where: { userId: user.id, clientId: TEST_OAUTH_CLIENT_ID },
    });
    await expect(
      resolveMcpPrincipal(
        getPrisma(),
        verifiers(),
        request(`Bearer ${tokens.access_token}`),
      ),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      details: { reason: "consent_revoked" },
    });
  });

  it("maps a missing or foreign credential to UNAUTHORIZED with the rejection reason", async () => {
    await expect(
      resolveMcpPrincipal(
        getPrisma(),
        verifiers(),
        request("Bearer not-a-token"),
      ),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      details: { reason: "invalid" },
    });
  });
});

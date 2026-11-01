import { describe, expect, it, vi } from "vitest";
import { validateCimdMetadata } from "@better-auth/cimd";
import {
  API_KEY_PREFIX,
  AUTH_COOKIE_PREFIX,
  CIMD_ORIGIN_BOUND_FIELDS,
  createWeaverAuth,
  DISABLED_ACCOUNT_PATHS,
  DISABLED_ADMIN_PATHS,
  DISABLED_API_KEY_PATHS,
  DISABLED_JWT_PATHS,
  DISABLED_OAUTH_MANAGEMENT_PATHS,
  DISABLED_ORGANIZATION_PATHS,
  OAUTH_SCOPES,
  SESSION_MAX_AGE_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
} from "./index";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./constants";

const secret = "s".repeat(32);
const mcp = {
  resource: "http://localhost:3000/api/mcp",
  loginPage: "/login",
  consentPage: "/consent",
};

describe("createWeaverAuth", () => {
  it("configures email/password sessions without public sign-up", () => {
    const auth = createWeaverAuth({
      db: {},
      secret,
      baseURL: "http://localhost:3000",
    });
    expect(auth.options.basePath).toBe("/api/auth");
    expect(auth.options.emailAndPassword).toMatchObject({
      enabled: true,
      disableSignUp: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
    });
    expect([PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH]).toEqual([12, 128]);
    expect(auth.options.session).toMatchObject({
      expiresIn: SESSION_MAX_AGE_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
    });
    expect(auth.options.advanced?.database?.generateId).toBe("uuid");
  });

  it("mounts admin, organization, jwt, and api-key plugins without an MCP resource", () => {
    const auth = createWeaverAuth({ db: {}, secret });
    expect(auth.options.plugins?.map((plugin) => plugin.id)).toEqual([
      "admin",
      "organization",
      "jwt",
      "api-key",
    ]);
  });

  it("adds the MCP OAuth provider and CIMD discovery when a resource is configured", () => {
    const auth = createWeaverAuth({ db: {}, secret, mcp });
    expect(auth.options.plugins?.map((plugin) => plugin.id)).toEqual([
      "admin",
      "organization",
      "jwt",
      "api-key",
      "oauth-provider",
      "cimd",
    ]);
  });

  it("origin-binds CIMD redirect URIs while preserving native loopback redirects", () => {
    const metadata = {
      client_id: "https://client.example/metadata.json",
      client_name: "Test client",
      redirect_uris: ["https://attacker.example/callback"],
    };

    expect(
      validateCimdMetadata(metadata.client_id, metadata, {
        metadataProfile: "mcp-2026-07-28",
        originBoundFields: CIMD_ORIGIN_BOUND_FIELDS,
      }),
    ).toMatchObject({ valid: false });
    expect(
      validateCimdMetadata(
        metadata.client_id,
        { ...metadata, redirect_uris: ["http://127.0.0.1:43123/callback"] },
        {
          metadataProfile: "mcp-2026-07-28",
          originBoundFields: CIMD_ORIGIN_BOUND_FIELDS,
        },
      ),
    ).toMatchObject({ valid: true });
  });

  it("disables every Better Auth route that would bypass Weaver policy", () => {
    const auth = createWeaverAuth({ db: {}, secret, mcp });
    expect(auth.options.disabledPaths).toEqual([
      ...DISABLED_ORGANIZATION_PATHS,
      ...DISABLED_ADMIN_PATHS,
      ...DISABLED_API_KEY_PATHS,
      ...DISABLED_OAUTH_MANAGEMENT_PATHS,
      ...DISABLED_JWT_PATHS,
      ...DISABLED_ACCOUNT_PATHS,
    ]);
    expect(DISABLED_ACCOUNT_PATHS).toContain("/change-password");
    expect(DISABLED_ACCOUNT_PATHS).toContain("/update-user");
    expect(DISABLED_API_KEY_PATHS).toContain("/api-key/create");
    expect(DISABLED_OAUTH_MANAGEMENT_PATHS).toContain("/oauth2/register");
    for (const path of [
      "get-consent",
      "get-consents",
      "update-consent",
      "delete-consent",
      "end-session",
      "end-session/confirm",
    ]) {
      expect(auth.options.disabledPaths).toContain(`/oauth2/${path}`);
    }
    expect(auth.options.advanced?.ipAddress?.ipAddressHeaders).toEqual([]);
    expect(auth.options.advanced?.ipAddress?.disableIpTracking).toBe(false);
    expect(DISABLED_JWT_PATHS).toContain("/token");
    expect(DISABLED_ADMIN_PATHS).toContain("/admin/impersonate-user");
  });

  it("trusts only a proxy-written real IP when explicitly enabled", () => {
    const auth = createWeaverAuth({ db: {}, secret, trustProxy: true });
    expect(auth.options.advanced?.ipAddress?.ipAddressHeaders).toEqual([
      "x-real-ip",
    ]);
  });

  it("namespaces session cookies and scopes them to the app base path", async () => {
    const scoped = createWeaverAuth({
      db: {},
      secret,
      baseURL: "https://apps.example/weaver/api/auth",
      cookiePath: "/weaver",
    });
    const { authCookies } = await scoped.$context;
    expect(AUTH_COOKIE_PREFIX).toBe("weaver");
    expect(authCookies.sessionToken.name).toBe("__Secure-weaver.session_token");
    expect(authCookies.sessionToken.attributes).toMatchObject({
      path: "/weaver",
      secure: true,
      httpOnly: true,
    });

    const local = createWeaverAuth({ db: {}, secret });
    const localCookies = (await local.$context).authCookies;
    expect(localCookies.sessionToken.name).toBe("weaver.session_token");
    expect(localCookies.sessionToken.attributes.path).toBe("/");
  });

  it("exposes the key prefix and scope list", () => {
    expect(API_KEY_PREFIX).toBe("wvr_");
    expect([...OAUTH_SCOPES]).toEqual([
      "mcp:use",
      "content:read",
      "content:propose",
      "content:write",
      "external:use",
      "external:manage",
      "offline_access",
    ]);
  });

  it("appends runtime plugins after the shared ones", () => {
    const auth = createWeaverAuth({
      db: {},
      secret,
      plugins: [{ id: "runtime-cookies" }],
    });
    expect(auth.options.plugins?.at(-1)?.id).toBe("runtime-cookies");
  });

  it("overrides Better Auth's rate limiter when explicitly disabled", () => {
    const auth = createWeaverAuth({ db: {}, secret, rateLimitEnabled: false });
    expect(auth.options.rateLimit?.enabled).toBe(false);
  });

  it("leaves Better Auth's default rate-limit behavior untouched when unset", () => {
    const auth = createWeaverAuth({ db: {}, secret });
    expect(auth.options.rateLimit).toBeUndefined();
  });

  it("reports asynchronous auth initialization failures", async () => {
    const onInitializationError = vi.fn();
    createWeaverAuth({ db: {}, secret, mcp, onInitializationError });

    await vi.waitFor(() =>
      expect(onInitializationError).toHaveBeenCalledWith(expect.any(Error)),
    );
  });

  it("keeps a non-critical sign-in observer failure from rejecting session creation", async () => {
    const onSignInError = vi.fn();
    const auth = createWeaverAuth({
      db: {},
      secret,
      onSignIn: vi.fn().mockRejectedValue(new Error("database unavailable")),
      onSignInError,
    });
    const hook = auth.options.databaseHooks?.session?.create?.after;

    await expect(hook?.({ userId: "user" } as never)).resolves.toBeUndefined();
    expect(onSignInError).toHaveBeenCalledOnce();
  });

  it("declares mustChangePassword as a non-input user field", () => {
    const auth = createWeaverAuth({ db: {}, secret });
    expect(
      auth.options.user?.additionalFields?.mustChangePassword,
    ).toMatchObject({
      type: "boolean",
      defaultValue: false,
      input: false,
    });
  });

  it("keeps every admin HTTP path disabled", () => {
    expect(DISABLED_ADMIN_PATHS).toContain("/admin/create-user");
    expect(DISABLED_ADMIN_PATHS).toContain("/admin/set-role");
    expect(DISABLED_ADMIN_PATHS).toContain("/admin/impersonate-user");
    const auth = createWeaverAuth({ db: {}, secret: "x".repeat(32) });
    for (const path of DISABLED_ADMIN_PATHS) {
      expect(auth.options.disabledPaths).toContain(path);
    }
  });
});

it("throttles direct sign-in requests without trusting forwarded addresses", async () => {
  const auth = createWeaverAuth({
    db: {},
    secret,
    baseURL: "http://localhost:3000",
    rateLimitEnabled: true,
    trustProxy: false,
  });
  const responses = [];
  for (let i = 0; i < 12; i++)
    responses.push(
      await auth.handler(
        new Request("http://localhost:3000/api/auth/sign-in/email", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-real-ip": `198.51.100.${i}`,
          },
          body: JSON.stringify({ email: "invalid", password: "short" }),
        }),
      ),
    );
  expect(responses.some((response) => response.status === 429)).toBe(true);
});

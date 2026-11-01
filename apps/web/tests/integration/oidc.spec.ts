import { updateOidcSettings } from "@weaver/core/services/oidcSettings";
import { resolveOidcRuntime } from "@weaver/core/services/oidc/runtime";
import {
  assertOidcSecretsDecryptable,
  rotateOidcSecrets,
} from "@weaver/core/services/oidc/credentials";
import { parseEncryptionKeyRing } from "@weaver/config/encryptionKeys";
import { securityContextFor, testEncryptionKeys } from "./_harness";
import { createHash, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  createUserAdministrator,
  createWeaverAuth,
  type WeaverAuth,
} from "@weaver/auth";
import {
  ensureOAuthResource,
  getPrisma,
  makeUser,
  resetDb,
  TEST_MCP_RESOURCE,
  TEST_PASSWORD,
} from "./_harness";
import {
  authorizeUrl,
  insertOAuthClient,
  pkce,
  redirectTargetOf,
} from "./_oauth";

const origin = "http://localhost:3000";
const basePath = "/weaver";
const authUrl = `${origin}${basePath}/api/auth`;
const clientId = "weaver-test";
const clientSecret = "oidc-test-secret";
const codes = new Map<
  string,
  {
    url: URL;
    claims: Record<string, unknown>;
    omitIdToken?: boolean;
    badSignature?: boolean;
  }
>();
let issuer: string;
let auth: WeaverAuth;
let staticAuth: WeaverAuth;
let tokenRequests = 0;
const tokenAuthentications: string[] = [];
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let wrongKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwk: Awaited<ReturnType<typeof exportJWK>>;

async function handleProviderRequest(
  req: IncomingMessage,
  res: ServerResponse,
) {
  res.setHeader("content-type", "application/json");
  if (req.url === "/hanging-discovery") return;
  if (
    req.url === "/.well-known/openid-configuration" ||
    req.url === "/no-jwks" ||
    req.url === "/basic-discovery"
  ) {
    res.end(
      JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        ...(req.url !== "/no-jwks" ? { jwks_uri: `${issuer}/jwks` } : {}),
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: [
          req.url === "/basic-discovery"
            ? "client_secret_basic"
            : "client_secret_post",
        ],
      }),
    );
    return;
  }
  if (req.url === "/jwks") {
    res.end(
      JSON.stringify({
        keys: [{ ...jwk, kid: "test", alg: "RS256", use: "sig" }],
      }),
    );
    return;
  }
  if (req.url === "/token" && req.method === "POST") {
    tokenRequests += 1;
    let body = "";
    for await (const chunk of req) body += chunk;
    const params = new URLSearchParams(body);
    const entry = codes.get(params.get("code") ?? "");
    const basic = req.headers.authorization?.startsWith("Basic ")
      ? Buffer.from(req.headers.authorization.slice(6), "base64")
          .toString()
          .split(":")
          .map(decodeURIComponent)
      : undefined;
    tokenAuthentications.push(basic ? "basic" : "post");
    const challenge = createHash("sha256")
      .update(params.get("code_verifier") ?? "")
      .digest("base64url");
    if (
      !entry ||
      (basic?.[0] ?? params.get("client_id")) !== clientId ||
      (basic?.[1] ?? params.get("client_secret")) !== clientSecret ||
      params.get("redirect_uri") !== `${authUrl}/callback/oidc` ||
      params.get("grant_type") !== "authorization_code" ||
      challenge !== entry.url.searchParams.get("code_challenge")
    ) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "invalid_grant" }));
      return;
    }
    codes.delete(params.get("code")!);
    const idToken = await new SignJWT({
      email: "new@oidc.test",
      email_verified: true,
      name: "OIDC user",
      nonce: entry.url.searchParams.get("nonce"),
      role: "Admin",
      mustChangePassword: true,
      ...entry.claims,
    })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(issuer)
      .setAudience(clientId)
      .setSubject("subject-1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(entry.badSignature ? wrongKeys.privateKey : keys.privateKey);
    res.end(
      JSON.stringify({
        access_token: "upstream-access-token",
        refresh_token: "upstream-refresh-token",
        token_type: "Bearer",
        expires_in: 300,
        ...(!entry.omitIdToken ? { id_token: idToken } : {}),
      }),
    );
    return;
  }
  res.statusCode = 404;
  res.end("{}");
}

const server = createServer((req, res) => {
  void handleProviderRequest(req, res).catch(() => {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "fixture_failure" }));
  });
});

function cookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}

async function begin(extra: Record<string, unknown> = {}) {
  const response = await auth.handler(
    new Request(`${authUrl}/sign-in/social`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({
        provider: "oidc",
        callbackURL: `${origin}${basePath}/projects`,
        errorCallbackURL: `${origin}${basePath}/login`,
        disableRedirect: true,
        ...extra,
      }),
    }),
  );
  expect(response.status).toBe(200);
  const data = (await response.json()) as { url: string };
  const url = new URL(data.url);
  expect(url.searchParams.get("redirect_uri")).toBe(`${authUrl}/callback/oidc`);
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("scope")?.split(" ")).toEqual(
    expect.arrayContaining(["openid", "profile", "email"]),
  );
  expect(url.searchParams.get("nonce")).toBeTruthy();
  return { url, cookie: cookies(response) };
}

async function finish(
  flow: Awaited<ReturnType<typeof begin>>,
  options: {
    claims?: Record<string, unknown>;
    omitIdToken?: boolean;
    badSignature?: boolean;
    state?: string;
  } = {},
) {
  const code = randomUUID();
  codes.set(code, { url: flow.url, claims: options.claims ?? {}, ...options });
  const callback = new URL(`${authUrl}/callback/oidc`);
  callback.searchParams.set("code", code);
  callback.searchParams.set(
    "state",
    options.state ?? flow.url.searchParams.get("state")!,
  );
  callback.searchParams.set("iss", issuer);
  return auth.handler(
    new Request(callback, {
      headers: { cookie: flow.cookie, accept: "text/html" },
    }),
  );
}

async function session(response: Response) {
  return auth.api.getSession({
    headers: new Headers({ cookie: cookies(response) }),
  });
}

describe("OIDC login", () => {
  beforeAll(async () => {
    keys = await generateKeyPair("RS256");
    wrongKeys = await generateKeyPair("RS256");
    jwk = await exportJWK(keys.publicKey);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing fixture port");
    issuer = `http://127.0.0.1:${address.port}`;
    auth = createWeaverAuth({
      db: getPrisma(),
      secret: process.env.AUTH_SECRET!,
      baseURL: authUrl,
      cookiePath: basePath,
      oidc: {
        discoveryUrl: `${issuer}/.well-known/openid-configuration`,
        clientId,
        clientSecret,
        displayName: "Authentik",
      },
      mcp: {
        resource: TEST_MCP_RESOURCE,
        loginPage: `${basePath}/login`,
        consentPage: `${basePath}/consent`,
      },
      onSignIn: async (userId) => {
        await getPrisma().user.update({
          where: { id: userId },
          data: { lastLoginAt: new Date() },
        });
      },
    });
  });
  beforeAll(() => {
    staticAuth = auth;
  });
  beforeEach(async () => {
    auth = staticAuth;
    tokenRequests = 0;
    tokenAuthentications.length = 0;
    codes.clear();
    await resetDb();
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("creates a normal user with no shared project memberships and reuses its stable identity", async () => {
    const response = await finish(await begin());
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `${origin}${basePath}/projects`,
    );
    expect(response.headers.get("set-cookie")).toContain("Path=/weaver");
    const signedIn = await session(response);
    expect(signedIn?.user).toMatchObject({
      email: "new@oidc.test",
      role: "User",
      mustChangePassword: false,
    });
    const stored = await getPrisma().user.findUniqueOrThrow({
      where: { id: signedIn!.user.id },
    });
    expect(stored.lastLoginAt).toBeInstanceOf(Date);
    expect(
      await getPrisma().member.count({ where: { userId: stored.id } }),
    ).toBe(0);
    const account = await getPrisma().account.findFirstOrThrow({
      where: { userId: stored.id, providerId: "oidc" },
    });
    expect(account).toMatchObject({
      issuer,
      accountId: "subject-1",
      password: null,
    });
    expect(account.accessToken).not.toBe("upstream-access-token");
    expect(account.refreshToken).not.toBe("upstream-refresh-token");
    expect((await session(await finish(await begin())))?.user.id).toBe(
      stored.id,
    );
    expect(await getPrisma().user.count()).toBe(1);
  });

  it("links verified matching email to an existing user without replacing profile or permissions", async () => {
    const user = await makeUser("Admin", "oidc-existing");
    const response = await finish(await begin(), {
      claims: { email: user.email, name: "Provider name" },
    });
    expect((await session(response))?.user).toMatchObject({
      id: user.id,
      name: "Admin oidc-existing",
      role: "Admin",
    });
    expect(await getPrisma().user.count()).toBe(1);
    expect(
      await getPrisma().account.count({ where: { userId: user.id } }),
    ).toBe(2);
  });

  it("links an admin-created account whose local email was not separately verified", async () => {
    const { id } = await createUserAdministrator(auth).create({
      email: "admin-created@oidc.test",
      name: "Managed user",
      password: TEST_PASSWORD,
      role: "User",
      mustChangePassword: true,
    });
    expect(
      (await getPrisma().user.findUniqueOrThrow({ where: { id } }))
        .emailVerified,
    ).toBe(false);
    const response = await finish(await begin(), {
      claims: { email: "admin-created@oidc.test" },
    });
    expect((await session(response))?.user).toMatchObject({
      id,
      name: "Managed user",
      role: "User",
      mustChangePassword: true,
    });
    expect(await getPrisma().user.count()).toBe(1);
    expect(await getPrisma().account.count({ where: { userId: id } })).toBe(2);
  });

  it.each([false, "true", undefined])(
    "rejects an unverified email (%s) without provisioning or linking",
    async (emailVerified) => {
      const user = await makeUser("Admin", "oidc-unverified");
      const before = await getPrisma().session.count();
      const response = await finish(await begin(), {
        claims: { email: user.email, email_verified: emailVerified },
      });
      expect((await session(response))?.user).toBeUndefined();
      expect(
        new URL(response.headers.get("location")!).searchParams.has("error"),
      ).toBe(true);
      expect(
        await getPrisma().account.count({ where: { userId: user.id } }),
      ).toBe(1);
      expect(await getPrisma().session.count()).toBe(before);
    },
  );

  it.each([false, "true", undefined])(
    "does not provision a new account for an unverified email (%s)",
    async (emailVerified) => {
      const response = await finish(await begin(), {
        claims: { email_verified: emailVerified },
      });
      expect((await session(response))?.user).toBeUndefined();
      expect(await getPrisma().user.count()).toBe(0);
      expect(await getPrisma().account.count()).toBe(0);
    },
  );

  it.each(["state", "nonce", "signature", "missing-id-token"])(
    "rejects an invalid %s without creating an account",
    async (invalid) => {
      const response = await finish(await begin(), {
        state: invalid === "state" ? "wrong-state" : undefined,
        claims: invalid === "nonce" ? { nonce: "wrong-nonce" } : {},
        badSignature: invalid === "signature",
        omitIdToken: invalid === "missing-id-token",
      });
      expect((await session(response))?.user).toBeUndefined();
      expect(await getPrisma().user.count()).toBe(0);
      expect(await getPrisma().account.count()).toBe(0);
    },
  );

  it("refuses banned users signing in through OIDC", async () => {
    const user = await makeUser("User", "oidc-banned");
    await getPrisma().user.update({
      where: { id: user.id },
      data: { banned: true },
    });
    const response = await finish(await begin(), {
      claims: { email: user.email },
    });
    expect((await session(response))?.user).toBeUndefined();
    expect(
      new URL(response.headers.get("location")!).searchParams.get("error"),
    ).toBe("BANNED_USER");
  });

  it("keeps public password sign-up disabled when OIDC provisioning is enabled", async () => {
    const response = await auth.handler(
      new Request(`${authUrl}/sign-up/email`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Intruder",
          email: "intruder@oidc.test",
          password: "password12345",
        }),
      }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await getPrisma().user.count()).toBe(0);
  });

  it("resumes an MCP authorization through OIDC and reaches Weaver consent", async () => {
    await ensureOAuthResource();
    await insertOAuthClient();
    const authorize = authorizeUrl(pkce().challenge, "mcp:use content:read");
    const response = await auth.handler(
      new Request(authorize.replace(`${origin}/api/auth`, authUrl), {
        headers: { accept: "text/html" },
      }),
    );
    expect(response.status).toBeLessThan(400);
    const login = new URL(await redirectTargetOf(response), origin);
    expect(login.pathname).toBe(`${basePath}/login`);
    const callback = await finish(
      await begin({ oauth_query: login.search.slice(1) }),
    );
    const consent = new URL(await redirectTargetOf(callback), origin);
    expect(consent.pathname).toBe(`${basePath}/consent`);
    expect((await session(callback))?.user.email).toBe("new@oidc.test");
  });

  it("preserves a required password change on an existing linked account", async () => {
    const user = await makeUser("User", "oidc-password-gate");
    await getPrisma().user.update({
      where: { id: user.id },
      data: { mustChangePassword: true },
    });
    const response = await finish(await begin(), {
      claims: { email: user.email, mustChangePassword: false },
    });
    expect((await session(response))?.user.mustChangePassword).toBe(true);
  });

  async function configureRuntime(
    discoveryPath = ".well-known/openid-configuration",
    oidcFetch?: typeof fetch,
  ) {
    const admin = await makeUser("Admin", "oidc-runtime-admin");
    const deps = {
      ring: testEncryptionKeys(),
      fetchImpl: fetch,
      callbackUrl: `${authUrl}/callback/oidc`,
    };
    const values = {
      expectedRevision: null,
      enabled: true,
      displayName: "Company",
      discoveryUrl: `${issuer}/${discoveryPath}`,
      clientId,
      clientSecret,
    };
    const saved = await updateOidcSettings(
      getPrisma(),
      securityContextFor(admin),
      values,
      deps,
    );
    auth = createWeaverAuth({
      db: getPrisma(),
      secret: process.env.AUTH_SECRET!,
      baseURL: authUrl,
      cookiePath: basePath,
      oidcResolver: () => resolveOidcRuntime(getPrisma(), deps),
      oidcFetch,
    });
    return { admin, deps, values, saved };
  }

  it("activates persisted settings and disables them on the same auth instance", async () => {
    const { admin, deps, values, saved } = await configureRuntime();
    expect((await session(await finish(await begin())))?.user.role).toBe(
      "User",
    );
    await updateOidcSettings(
      getPrisma(),
      securityContextFor(admin),
      { ...values, enabled: false, expectedRevision: saved.revision },
      deps,
    );
    const response = await auth.api.signInSocial({
      body: { provider: "oidc", callbackURL: `${origin}${basePath}/projects` },
      asResponse: true,
    });
    expect(response.status).toBe(404);
    expect(await resolveOidcRuntime(getPrisma(), { ...deps })).toBeNull();
    const localLogin = await auth.api.signInEmail({
      body: { email: admin.email, password: TEST_PASSWORD },
      asResponse: true,
    });
    expect(localLogin.status).toBe(200);
  });

  it("rejects an old-flow code before token exchange after a material edit", async () => {
    const { admin, deps, values, saved } = await configureRuntime();
    const flow = await begin({ additionalData: { oidcGeneration: "forged" } });
    await updateOidcSettings(
      getPrisma(),
      securityContextFor(admin),
      {
        ...values,
        expectedRevision: saved.revision,
        clientSecret: "replacement-secret",
      },
      deps,
    );
    const response = await finish(flow);
    expect(response.headers.get("location")).toContain("/weaver/login");
    expect(tokenRequests).toBe(0);
  });

  it("preserves an admitted login through a label edit and encryption rotation", async () => {
    const { admin, deps, values, saved } = await configureRuntime();
    const flow = await begin();
    await updateOidcSettings(
      getPrisma(),
      securityContextFor(admin),
      {
        ...values,
        expectedRevision: saved.revision,
        displayName: "Renamed",
        clientSecret: "",
      },
      deps,
    );
    const key = createHash("sha256")
      .update("runtime-rotation-test")
      .digest("base64");
    const ring = parseEncryptionKeyRing(
      [...deps.ring.keys.entries()]
        .map(([v, k]) => `${v}:${Buffer.from(k).toString("base64")}`)
        .concat(`${deps.ring.activeVersion + 1}:${key}`)
        .join(","),
    )!;
    await rotateOidcSecrets(getPrisma(), ring);
    deps.ring = ring;
    expect((await session(await finish(flow)))?.user.email).toBe(
      "new@oidc.test",
    );
  });

  it("preserves an old flow when a label save only reorders advertised capabilities", async () => {
    const { admin, deps, values, saved } = await configureRuntime();
    deps.fetchImpl = async (url, init) => {
      const response = await fetch(url, init);
      if ((url instanceof Request ? url.url : url.toString()).endsWith("/jwks"))
        return response;
      return Response.json({
        ...(await response.json()),
        id_token_signing_alg_values_supported: ["PS256", "RS256"],
        scopes_supported: ["profile", "openid", "email"],
        token_endpoint_auth_methods_supported: [
          "client_secret_basic",
          "client_secret_post",
        ],
      });
    };
    const expanded = await updateOidcSettings(
      getPrisma(),
      securityContextFor(admin),
      { ...values, expectedRevision: saved.revision },
      deps,
    );
    const admitted = await begin();
    const orderedFetch = deps.fetchImpl;
    deps.fetchImpl = async (url, init) => {
      const response = await orderedFetch(url, init);
      if ((url instanceof Request ? url.url : url.toString()).endsWith("/jwks"))
        return response;
      return Response.json({
        ...(await response.json()),
        id_token_signing_alg_values_supported: ["RS256", "PS256"],
        scopes_supported: ["email", "openid", "profile"],
        token_endpoint_auth_methods_supported: [
          "client_secret_post",
          "client_secret_basic",
        ],
      });
    };
    await updateOidcSettings(
      getPrisma(),
      securityContextFor(admin),
      {
        ...values,
        expectedRevision: expanded.revision,
        displayName: "New label",
      },
      deps,
    );
    expect((await session(await finish(admitted)))?.user.email).toBe(
      "new@oidc.test",
    );
  });

  it("invalidates environment flows on first database save with refreshed endpoints", async () => {
    const admin = await makeUser("Admin", "oidc-env-takeover");
    const fallback = {
      discoveryUrl: `${issuer}/.well-known/openid-configuration`,
      clientId,
      clientSecret,
      displayName: "Environment",
    };
    const deps = {
      ring: testEncryptionKeys(),
      fetchImpl: fetch,
      callbackUrl: `${authUrl}/callback/oidc`,
      fallback,
    };
    const createAuth = () =>
      createWeaverAuth({
        db: getPrisma(),
        secret: process.env.AUTH_SECRET!,
        baseURL: authUrl,
        cookiePath: basePath,
        oidcResolver: () => resolveOidcRuntime(getPrisma(), deps),
      });
    auth = createAuth();
    const oldFlow = await begin();
    const otherFlow = await begin();
    deps.fetchImpl = async (url, init) => {
      const response = await fetch(url, init);
      if ((url instanceof Request ? url.url : url.toString()).endsWith("/jwks"))
        return response;
      return Response.json({
        ...(await response.json()),
        token_endpoint: `${issuer}/new-token`,
      });
    };
    await updateOidcSettings(
      getPrisma(),
      securityContextFor(admin),
      { ...fallback, enabled: true, expectedRevision: null },
      deps,
    );
    expect((await finish(oldFlow)).headers.get("location")).toContain(
      "/weaver/login",
    );
    auth = createAuth();
    expect((await finish(otherFlow)).headers.get("location")).toContain(
      "/weaver/login",
    );
    expect(tokenRequests).toBe(0);
    expect(
      await getPrisma().account.count({ where: { providerId: "oidc" } }),
    ).toBe(0);
  });

  it("starts with malformed non-secret settings while preserving key checks and password login", async () => {
    const { admin, deps } = await configureRuntime();
    const row = await getPrisma().systemSetting.findUniqueOrThrow({
      where: { key: "auth.oidc" },
    });
    await getPrisma().systemSetting.update({
      where: { key: "auth.oidc" },
      data: {
        value: { ...(row.value as object), discovery: { invalid: true } },
      },
    });
    await expect(
      assertOidcSecretsDecryptable(getPrisma(), deps.ring),
    ).resolves.toBeUndefined();
    await expect(
      assertOidcSecretsDecryptable(getPrisma(), null),
    ).rejects.toThrow("WEAVER_ENCRYPTION_KEYS");
    await expect(resolveOidcRuntime(getPrisma(), deps)).rejects.toThrow(
      "invalid",
    );
    const response = await auth.api.signInEmail({
      body: { email: admin.email, password: TEST_PASSWORD },
      asResponse: true,
    });
    expect(response.status).toBe(200);
    expect((await session(response))?.user.id).toBe(admin.id);
    expect(
      (
        await auth.api.signInSocial({
          body: { provider: "oidc" },
          asResponse: true,
        })
      ).status,
    ).toBe(404);
  });

  it("rejects an admitted old-issuer callback if replacement commits before its first account insert", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { admin, deps, values, saved } = await configureRuntime(
      undefined,
      async (url, init) => {
        if (
          (url instanceof Request ? url.url : url.toString()).endsWith("/jwks")
        ) {
          entered();
          await gate;
        }
        return fetch(url, init);
      },
    );
    const flow = await begin();
    const completing = finish(flow);
    await reached;
    try {
      deps.fetchImpl = async (url, init) => {
        if (
          (url instanceof Request ? url.url : url.toString()).endsWith("/jwks")
        )
          return fetch(`${issuer}/jwks`, init);
        return Response.json({
          issuer: `${issuer}/replacement`,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
        });
      };
      await updateOidcSettings(
        getPrisma(),
        securityContextFor(admin),
        {
          ...values,
          expectedRevision: saved.revision,
          discoveryUrl: `${issuer}/replacement-discovery`,
        },
        deps,
      );
    } finally {
      release();
    }
    const response = await completing;
    expect(await session(response)).toBeNull();
    expect(
      await getPrisma().account.count({ where: { providerId: "oidc" } }),
    ).toBe(0);
  });

  it("uses basic client authentication when that is the advertised method", async () => {
    await configureRuntime("basic-discovery");
    expect((await session(await finish(await begin())))?.user.email).toBe(
      "new@oidc.test",
    );
    expect(tokenAuthentications).toEqual(["basic"]);
  });

  it("rejects missing server-controlled generation without exchanging the code", async () => {
    await configureRuntime();
    const flow = await begin();
    const identifier = flow.url.searchParams.get("state")!;
    const verification = await getPrisma().verification.findFirstOrThrow({
      where: { identifier },
    });
    const state = JSON.parse(verification.value) as Record<string, unknown>;
    delete state.serverContext;
    await getPrisma().verification.update({
      where: { id: verification.id },
      data: { value: JSON.stringify(state) },
    });
    const response = await finish(flow);
    expect(response.headers.get("location")).toContain("/weaver/login");
    expect(tokenRequests).toBe(0);
  });

  it("keeps concurrent provider snapshots out of the shared auth context", async () => {
    const { deps } = await configureRuntime();
    const first = (await resolveOidcRuntime(getPrisma(), deps))!;
    const second = {
      ...first,
      clientId: "second-client",
      generation: "second-generation",
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    auth = createWeaverAuth({
      db: getPrisma(),
      secret: process.env.AUTH_SECRET!,
      baseURL: authUrl,
      oidcResolver: async () => {
        if (++calls === 1) {
          await gate;
          return first;
        }
        return second;
      },
    });
    const firstRequest = begin();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const other = await begin();
    release();
    const original = await firstRequest;
    expect(original.url.searchParams.get("client_id")).toBe(clientId);
    expect(other.url.searchParams.get("client_id")).toBe("second-client");
    expect(
      (await auth.$context).socialProviders.some(
        (provider) => provider.id === "oidc",
      ),
    ).toBe(false);
  });

  it("refuses direct ID-token sign-in outside a state-bound code flow", async () => {
    await configureRuntime();
    const response = await auth.handler(
      new Request(`${authUrl}/sign-in/social`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({
          provider: "oidc",
          idToken: { token: "untrusted" },
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(tokenRequests).toBe(0);
  });

  it.each(["no-discovery", "no-jwks", "hanging-discovery"])(
    "keeps password login available with unusable OIDC discovery (%s)",
    async (discoveryPath) => {
      const user = await makeUser("User", "oidc-unavailable");
      const unavailable = createWeaverAuth({
        db: getPrisma(),
        secret: process.env.AUTH_SECRET!,
        baseURL: origin,
        oidc: {
          discoveryUrl: `${issuer}/${discoveryPath}`,
          clientId,
          clientSecret,
          displayName: "Authentik",
        },
      });
      const response = await unavailable.api.signInEmail({
        body: { email: user.email, password: TEST_PASSWORD },
        asResponse: true,
      });
      expect(response.status).toBe(200);
      expect(
        (
          await unavailable.api.getSession({
            headers: new Headers({ cookie: cookies(response) }),
          })
        )?.user.id,
      ).toBe(user.id);
    },
    10_000,
  );
});

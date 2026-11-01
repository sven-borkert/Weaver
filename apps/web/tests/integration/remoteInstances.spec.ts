import { beforeEach, describe, expect, it } from "vitest";
import { OAUTH_SCOPES } from "@weaver/auth";
import { remoteClientId } from "@weaver/core/remotes/urls";
import {
  createRemoteInstance,
  deleteRemoteInstance,
  listRemoteInstances,
  testRemoteInstance,
  updateRemoteInstance,
} from "@weaver/core/services/remoteInstances";
import type { RemoteRuntimeDeps } from "@weaver/core/services/remoteInstances/types";
import {
  callerFor,
  ensureOAuthResource,
  getPrisma,
  makeUser,
  resetDb,
  securityContextFor,
  testEncryptionKeys,
  TEST_MCP_RESOURCE,
} from "./_harness";

const SELF = "http://localhost:3000";

/** Answers B's health and OAuth metadata like a Weaver instance would. */
function fakeRemoteFetch(
  overrides: Partial<Record<string, () => Response>> = {},
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const custom = overrides[url.pathname];
    if (custom) return custom();
    if (url.pathname.endsWith("/api/health"))
      return Response.json({ status: "ok", version: "0.1.147" });
    if (url.pathname.endsWith("/.well-known/oauth-authorization-server"))
      return Response.json({
        issuer: `${url.origin}${url.pathname.replace(/\/\.well-known.*$/, "")}`,
        authorization_endpoint: `${url.origin}/api/auth/oauth2/authorize`,
        token_endpoint: `${url.origin}/api/auth/oauth2/token`,
        code_challenge_methods_supported: ["S256"],
      });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function deps(fetchImpl: typeof fetch = fakeRemoteFetch()): RemoteRuntimeDeps {
  return {
    db: getPrisma(),
    ring: testEncryptionKeys(),
    fetchImpl,
    now: () => new Date(),
    selfBaseUrl: SELF,
    mcpResourceUrl: TEST_MCP_RESOURCE,
    allowedOrigins: [],
    pinOutbound: false,
  };
}

describe("remote instance registry", () => {
  beforeEach(async () => {
    await resetDb();
    await ensureOAuthResource();
  });

  it("creates a remote and its OAuth client row, updates and deletes them together", async () => {
    const admin = securityContextFor(await makeUser("Admin", "remotes-admin"));
    const db = getPrisma();
    const created = await createRemoteInstance(deps(), admin, {
      name: "Second instance",
      baseUrl: "https://b.example.com/weaver/",
    });
    expect(created.baseUrl).toBe("https://b.example.com/weaver");
    const clientId = remoteClientId("https://b.example.com/weaver");
    const client = await db.oauthClient.findUniqueOrThrow({
      where: { clientId },
    });
    expect(client).toMatchObject({
      redirectUris: ["https://b.example.com/weaver/api/remotes/callback"],
      tokenEndpointAuthMethod: "none",
      requirePKCE: true,
      disabled: false,
      skipConsent: false,
      dpopBoundAccessTokens: false,
      scopes: [...OAUTH_SCOPES],
    });
    expect(
      await db.oauthClientResource.findFirst({
        where: { clientId, resourceId: TEST_MCP_RESOURCE },
      }),
    ).not.toBeNull();

    const updated = await updateRemoteInstance(deps(), admin, {
      id: created.id,
      expectedRevision: created.revision,
      patch: { baseUrl: "https://c.example.com" },
    });
    expect(updated.revision).toBe(created.revision + 1);
    expect(await db.oauthClient.findUnique({ where: { clientId } })).toBeNull();
    expect(
      await db.oauthClient.findUnique({
        where: { clientId: remoteClientId("https://c.example.com") },
      }),
    ).toMatchObject({
      redirectUris: ["https://c.example.com/api/remotes/callback"],
    });

    await expect(
      updateRemoteInstance(deps(), admin, {
        id: created.id,
        expectedRevision: created.revision,
        patch: { name: "x" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await deleteRemoteInstance(deps(), admin, {
      id: created.id,
      expectedRevision: updated.revision,
    });
    expect(await listRemoteInstances(db, admin)).toEqual([]);
    expect(await db.oauthClient.count()).toBe(0);
  });

  it("disabling a remote disables its OAuth client", async () => {
    const admin = securityContextFor(
      await makeUser("Admin", "remotes-disable"),
    );
    const created = await createRemoteInstance(deps(), admin, {
      name: "B",
      baseUrl: "https://b.example.com",
    });
    await updateRemoteInstance(deps(), admin, {
      id: created.id,
      expectedRevision: 1,
      patch: { enabled: false },
    });
    expect(
      await getPrisma().oauthClient.findUniqueOrThrow({
        where: { clientId: remoteClientId("https://b.example.com") },
      }),
    ).toMatchObject({ disabled: true });
  });

  it("rejects non-admins, duplicate names and duplicate base URLs", async () => {
    const admin = securityContextFor(
      await makeUser("Admin", "remotes-dup-admin"),
    );
    const user = securityContextFor(await makeUser("User", "remotes-dup-user"));
    await createRemoteInstance(deps(), admin, {
      name: "B",
      baseUrl: "https://b.example.com",
    });
    await expect(
      createRemoteInstance(deps(), user, {
        name: "C",
        baseUrl: "https://c.example.com",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listRemoteInstances(getPrisma(), user)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      createRemoteInstance(deps(), admin, {
        name: "B",
        baseUrl: "https://d.example.com",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", details: { field: "name" } });
    await expect(
      createRemoteInstance(deps(), admin, {
        name: "E",
        baseUrl: "https://b.example.com/",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { field: "baseUrl" },
    });
    await expect(
      createRemoteInstance(deps(), admin, { name: "Self", baseUrl: SELF }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("tests a remote and records the outcome", async () => {
    const admin = securityContextFor(await makeUser("Admin", "remotes-test"));
    const created = await createRemoteInstance(deps(), admin, {
      name: "B",
      baseUrl: "https://b.example.com",
    });
    const ok = await testRemoteInstance(deps(), admin, { id: created.id });
    expect(ok.status).toBe("ok");
    expect(ok.remote.checkStatus).toBe("ok");
    expect(ok.remote.lastCheckedAt).not.toBeNull();

    const notWeaver = await testRemoteInstance(
      deps(
        fakeRemoteFetch({ "/api/health": () => Response.json({ hello: 1 }) }),
      ),
      admin,
      { id: created.id },
    );
    expect(notWeaver.status).toBe("not_weaver");

    const noOauth = await testRemoteInstance(
      deps(
        fakeRemoteFetch({
          "/api/auth/.well-known/oauth-authorization-server": () =>
            new Response("", { status: 404 }),
        }),
      ),
      admin,
      { id: created.id },
    );
    expect(noOauth.status).toBe("oauth_unavailable");

    const down = await testRemoteInstance(
      deps((async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch),
      admin,
      { id: created.id },
    );
    expect(down.status).toBe("unreachable");
    expect(down.remote.checkErrorSummary).toContain("fetch failed");
  });

  it("exposes the registry to Admins through tRPC and hides it from users", async () => {
    const admin = await makeUser("Admin", "remotes-trpc-admin");
    const user = await makeUser("User", "remotes-trpc-user");
    const created = await callerFor(admin).remoteInstance.create({
      name: "B",
      baseUrl: "https://b.example.com",
    });
    expect(
      (await callerFor(admin).remoteInstance.list()).map((r) => r.id),
    ).toEqual([created.id]);
    await expect(callerFor(user).remoteInstance.list()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

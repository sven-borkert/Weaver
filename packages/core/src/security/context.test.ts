import { describe, expect, it } from "vitest";
import {
  API_KEY_CAPABILITIES,
  apiKeyPermissionsFromCapabilities,
  assertSystemAdmin,
  capabilitiesFromApiKeyPermissions,
  capabilitiesFromScopes,
  createApiKeySecurityContext,
  createOAuthSecurityContext,
  createSessionSecurityContext,
  createTaskSecurityContext,
  DEFAULT_API_KEY_CAPABILITIES,
  hasCapability,
  mayAccessProject,
  OAUTH_SCOPES,
  requiredCapabilityForRole,
} from "./context";

describe("system:admin", () => {
  it("grants Admin sessions system:admin and llm:admin", () => {
    const admin = createSessionSecurityContext({
      userId: "u1",
      globalRole: "Admin",
      sessionId: "s1",
    });
    expect(admin.capabilities.has("system:admin")).toBe(true);
    expect(admin.capabilities.has("llm:admin")).toBe(true);
    const user = createSessionSecurityContext({
      userId: "u2",
      globalRole: "User",
      sessionId: "s2",
    });
    expect(user.capabilities.has("system:admin")).toBe(false);
  });

  it("admits a key's system:admin only while the owner is an Admin", () => {
    const permissions = { mcp: ["use"], content: ["read"], system: ["admin"] };
    const active = createApiKeySecurityContext({
      userId: "u1",
      globalRole: "Admin",
      keyId: "k1",
      permissions,
      projectIds: [],
    });
    expect(active.capabilities.has("system:admin")).toBe(true);
    expect(active.capabilities.has("llm:admin")).toBe(true);
    const demoted = createApiKeySecurityContext({
      userId: "u1",
      globalRole: "User",
      keyId: "k1",
      permissions,
      projectIds: [],
    });
    expect(demoted.capabilities.has("system:admin")).toBe(false);
    expect(demoted.capabilities.has("llm:admin")).toBe(false);
    expect(demoted.capabilities.has("content:read")).toBe(true);
  });

  it("never derives system:admin from OAuth scopes", () => {
    expect(OAUTH_SCOPES).not.toContain("system:admin");
    expect(
      capabilitiesFromScopes("mcp:use content:read system:admin").has(
        "system:admin",
      ),
    ).toBe(false);
  });

  it("assertSystemAdmin throws FORBIDDEN without the capability", () => {
    const user = createSessionSecurityContext({
      userId: "u2",
      globalRole: "User",
      sessionId: "s2",
    });
    expect(() => assertSystemAdmin(user)).toThrowError(
      /System administration required/,
    );
    const admin = createSessionSecurityContext({
      userId: "u1",
      globalRole: "Admin",
      sessionId: "s1",
    });
    expect(() => assertSystemAdmin(admin)).not.toThrow();
  });
});

describe("session security context", () => {
  it("grants content and assistant capabilities to every session", () => {
    const context = createSessionSecurityContext({
      userId: "11111111-1111-4111-8111-111111111111",
      globalRole: "User",
      sessionId: "session-1",
    });

    expect(context).toMatchObject({
      authenticationMethod: "session",
      credentialId: "session-1",
      allowedProjectIds: "all-accessible",
    });
    expect([...context.capabilities].sort()).toEqual([
      "assistant:use",
      "content:propose",
      "content:read",
      "content:write",
      "external:manage",
    ]);
    expect(hasCapability(context, "mcp:use")).toBe(false);
    expect(Object.isFrozen(context)).toBe(true);
  });

  it("adds llm:admin for global Admins only", () => {
    const admin = createSessionSecurityContext({
      userId: "11111111-1111-4111-8111-111111111111",
      globalRole: "Admin",
      sessionId: "session-2",
    });
    expect(hasCapability(admin, "llm:admin")).toBe(true);
  });

  it("restricts project access only when a credential lists projects", () => {
    const unrestricted = createSessionSecurityContext({
      userId: "u",
      globalRole: "User",
      sessionId: "s",
    });
    const restricted = { ...unrestricted, allowedProjectIds: new Set(["p1"]) };

    expect(mayAccessProject(unrestricted, "anything")).toBe(true);
    expect(mayAccessProject(restricted, "p1")).toBe(true);
    expect(mayAccessProject(restricted, "p2")).toBe(false);
  });

  it("maps minimum roles to the capability they require", () => {
    expect(requiredCapabilityForRole("Viewer")).toBe("content:read");
    expect(requiredCapabilityForRole("Editor")).toBe("content:write");
    expect(requiredCapabilityForRole("Owner")).toBe("content:write");
  });
});

describe("api key permissions", () => {
  it("always grants the read defaults and never assistant/admin capabilities", () => {
    expect([...DEFAULT_API_KEY_CAPABILITIES]).toEqual([
      "mcp:use",
      "content:read",
    ]);
    expect(apiKeyPermissionsFromCapabilities([])).toEqual({
      mcp: ["use"],
      content: ["read"],
    });
    expect(
      apiKeyPermissionsFromCapabilities([
        "content:write",
        "llm:admin",
        "assistant:use",
        "bogus",
      ]),
    ).toEqual({ mcp: ["use"], content: ["read", "write"] });
  });

  it("maps permissions back to capabilities, ignoring unknown statements", () => {
    expect(
      [
        ...capabilitiesFromApiKeyPermissions({
          content: ["propose"],
          other: ["x"],
        }),
      ].sort(),
    ).toEqual(["content:propose", "content:read", "mcp:use"]);
    expect([...capabilitiesFromApiKeyPermissions(null)].sort()).toEqual([
      "content:read",
      "mcp:use",
    ]);
  });

  it("round-trips every grantable capability", () => {
    const all = apiKeyPermissionsFromCapabilities(API_KEY_CAPABILITIES);
    expect([...capabilitiesFromApiKeyPermissions(all)].sort()).toEqual(
      [...API_KEY_CAPABILITIES].sort(),
    );
  });
});

describe("oauth scopes", () => {
  it("lists the capability scopes plus offline_access", () => {
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

  it("maps a space-separated scope claim to capabilities only", () => {
    expect(
      [
        ...capabilitiesFromScopes("mcp:use content:read offline_access openid"),
      ].sort(),
    ).toEqual(["content:read", "mcp:use"]);
    expect([...capabilitiesFromScopes(undefined)]).toEqual([]);
    expect([...capabilitiesFromScopes(["content:write"])]).toEqual([
      "content:write",
    ]);
  });
});

describe("credential security contexts", () => {
  it("builds a restricted api key context without admin capabilities", () => {
    const context = createApiKeySecurityContext({
      userId: "u1",
      globalRole: "Admin",
      keyId: "k1",
      permissions: { content: ["read", "write"], mcp: ["use"] },
      projectIds: ["p1", "p2"],
    });
    expect(context).toMatchObject({
      authenticationMethod: "apiKey",
      credentialId: "k1",
      globalRole: "Admin",
    });
    expect([...context.capabilities].sort()).toEqual([
      "content:read",
      "content:write",
      "mcp:use",
    ]);
    expect(hasCapability(context, "llm:admin")).toBe(false);
    expect(mayAccessProject(context, "p1")).toBe(true);
    expect(mayAccessProject(context, "p3")).toBe(false);
    expect(Object.isFrozen(context)).toBe(true);
  });

  it("treats an empty restriction list as all accessible projects", () => {
    const context = createApiKeySecurityContext({
      userId: "u1",
      globalRole: "User",
      keyId: "k1",
      permissions: null,
      projectIds: [],
    });
    expect(context.allowedProjectIds).toBe("all-accessible");
  });

  it("builds an oauth context from the scope claim", () => {
    const context = createOAuthSecurityContext({
      userId: "u1",
      globalRole: "User",
      tokenId: "jti-1",
      scopes: "mcp:use content:read content:propose offline_access",
    });
    expect(context).toMatchObject({
      authenticationMethod: "oauth",
      credentialId: "jti-1",
      allowedProjectIds: "all-accessible",
    });
    expect([...context.capabilities].sort()).toEqual([
      "content:propose",
      "content:read",
      "mcp:use",
    ]);
  });
});

describe("ingest:external (Phase 5 spec §8)", () => {
  it("is grantable on API keys only and never derived from sessions or OAuth scopes", () => {
    expect(API_KEY_CAPABILITIES).toContain("ingest:external");
    expect(DEFAULT_API_KEY_CAPABILITIES).not.toContain("ingest:external");
    expect(OAUTH_SCOPES).not.toContain("ingest:external");

    const adminSession = createSessionSecurityContext({
      userId: "u1",
      globalRole: "Admin",
      sessionId: "s1",
    });
    expect(hasCapability(adminSession, "ingest:external")).toBe(false);
    expect(
      capabilitiesFromScopes("mcp:use content:write ingest:external").has(
        "ingest:external",
      ),
    ).toBe(false);
  });

  it("round-trips through Better Auth permission statements without implying content:write", () => {
    const permissions = apiKeyPermissionsFromCapabilities(["ingest:external"]);
    expect(permissions).toEqual({
      mcp: ["use"],
      content: ["read"],
      ingest: ["external"],
    });
    const key = createApiKeySecurityContext({
      userId: "u1",
      globalRole: "User",
      keyId: "k1",
      permissions,
      projectIds: [],
    });
    expect(hasCapability(key, "ingest:external")).toBe(true);
    expect(hasCapability(key, "content:write")).toBe(false);
    expect(hasCapability(key, "content:read")).toBe(true);
  });
});

describe("external:use", () => {
  it("grants external:use only when explicitly requested", () => {
    expect(DEFAULT_API_KEY_CAPABILITIES).not.toContain("external:use");
    expect(
      capabilitiesFromApiKeyPermissions(
        apiKeyPermissionsFromCapabilities([]),
      ).has("external:use"),
    ).toBe(false);
    expect(
      capabilitiesFromApiKeyPermissions(
        apiKeyPermissionsFromCapabilities(["external:use"]),
      ).has("external:use"),
    ).toBe(true);
    expect(
      capabilitiesFromScopes("mcp:use external:use").has("external:use"),
    ).toBe(true);
  });
});

describe("external:manage", () => {
  it("is opt-in for keys and OAuth, on for sessions, never for tasks", () => {
    expect(DEFAULT_API_KEY_CAPABILITIES).not.toContain("external:manage");
    expect(
      capabilitiesFromApiKeyPermissions(
        apiKeyPermissionsFromCapabilities(["external:manage"]),
      ).has("external:manage"),
    ).toBe(true);
    expect(
      apiKeyPermissionsFromCapabilities(["external:use", "external:manage"])
        .external,
    ).toEqual(["use", "manage"]);
    expect(
      capabilitiesFromScopes("mcp:use external:manage").has("external:manage"),
    ).toBe(true);
    expect(
      hasCapability(
        createSessionSecurityContext({
          userId: "u1",
          globalRole: "User",
          sessionId: "s1",
        }),
        "external:manage",
      ),
    ).toBe(true);
    expect(
      hasCapability(
        createTaskSecurityContext({
          userId: "u1",
          globalRole: "User",
          runId: "r1",
        }),
        "external:manage",
      ),
    ).toBe(false);
  });
});

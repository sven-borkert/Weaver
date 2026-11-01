import { DPOP_ALGS } from "./responses";
import { describe, expect, it } from "vitest";
import { CoreError } from "@weaver/core/errors";
import type { McpPrincipal } from "@weaver/core/security/bearer";
import {
  CHALLENGE_SCOPE,
  challengeFor,
  principalFromAuthInfo,
  tokenFreeAuthInfo,
} from "./gate";

const principal: McpPrincipal = {
  security: {
    userId: "u1",
    globalRole: "User",
    authenticationMethod: "apiKey",
    credentialId: "k1",
    capabilities: new Set(["mcp:use", "content:read"]),
    allowedProjectIds: "all-accessible",
  },
  profile: { name: "U", email: "u@example.test" },
  clientId: null,
};

describe("MCP bearer gate", () => {
  it("passes only token-free authentication metadata to the SDK", () => {
    const authInfo = tokenFreeAuthInfo(principal, "request-1");

    expect(authInfo).toMatchObject({
      token: "",
      clientId: "apiKey:k1",
      scopes: ["mcp:use", "content:read"],
      extra: { requestId: "request-1" },
    });
    expect(principalFromAuthInfo(authInfo)).toBe(principal);
  });

  it("emits discovery, insufficient-scope, and DPoP challenges", async () => {
    const metadataUrl =
      "https://weaver.example/.well-known/oauth-protected-resource/api/mcp";
    const missing = challengeFor(
      new CoreError("UNAUTHORIZED", "missing", { reason: "missing" }),
      { metadataUrl },
    );
    expect(missing.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${metadataUrl}", scope="${CHALLENGE_SCOPE}", DPoP algs="${DPOP_ALGS}"`,
    );

    const scope = challengeFor(
      new CoreError("FORBIDDEN", "scope", { scope: "content:write" }),
      { metadataUrl },
    );
    expect(scope.status).toBe(403);
    expect(await scope.json()).toMatchObject({ error: "insufficient_scope" });

    const dpop = challengeFor(
      new CoreError("UNAUTHORIZED", "dpop", { reason: "dpop" }),
      { metadataUrl },
    );
    expect(dpop.headers.get("www-authenticate")).toContain(
      'DPoP algs="EdDSA ES256 ES512 PS256 RS256"',
    );
  });
});

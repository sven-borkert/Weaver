import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApiKeySecurityContext } from "@weaver/core/security/context";
vi.mock("@weaver/db", () => ({ db: {} }));
vi.mock("~/env", () => ({
  env: {
    AUTH_URL: "http://localhost:3000",
    WEAVER_MCP_RATE_LIMIT_PER_MINUTE: 2,
  },
}));
vi.mock("~/server/auth/bearer", () => ({ getBearerVerifiers: () => ({}) }));
vi.mock("@weaver/core/security/bearer", () => ({
  resolveMcpPrincipal: vi.fn(),
}));
import { resolveMcpPrincipal } from "@weaver/core/security/bearer";
import { resolveTransferActor } from "./actor";

describe("transfer credential admission", () => {
  beforeEach(() => vi.clearAllMocks());
  it("shares a credential's limit across transfer endpoints and leaves other credentials available", async () => {
    const principal = (id: string) => ({
      security: createApiKeySecurityContext({
        userId: "user",
        globalRole: "User",
        keyId: id,
        permissions: { mcp: ["use"], content: ["read"] },
        projectIds: [],
      }),
      profile: { name: "User", email: "user@example.com" },
      clientId: null,
    });
    vi.mocked(resolveMcpPrincipal).mockResolvedValue(principal("first"));
    await resolveTransferActor(
      new Request("http://localhost/api/transfer/documents"),
    );
    await resolveTransferActor(
      new Request("http://localhost/api/transfer/tables"),
    );
    await expect(
      resolveTransferActor(new Request("http://localhost/api/transfer/whoami")),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    vi.mocked(resolveMcpPrincipal).mockResolvedValue(principal("second"));
    await expect(
      resolveTransferActor(
        new Request("http://localhost/api/transfer/documents"),
      ),
    ).resolves.toMatchObject({ credentialId: "second" });
  });
});

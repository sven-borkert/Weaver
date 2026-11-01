import { describe, expect, it, vi } from "vitest";
import type { WeaverAuth } from "./index";
import { createApiKeyIssuer } from "./apiKeys";

function fakeAuth() {
  const createApiKey = vi.fn(async () => ({ id: "key-id", key: "wvr_secret" }));
  return {
    auth: { api: { createApiKey } } as unknown as WeaverAuth,
    createApiKey,
  };
}

describe("createApiKeyIssuer", () => {
  it("keeps the plugin's default rate limit when no per-key limit is set", async () => {
    const { auth, createApiKey } = fakeAuth();
    const issued = await createApiKeyIssuer(auth).issue({
      userId: "u1",
      name: "CI",
      permissions: { content: ["read"], mcp: ["use"] },
      expiresInSeconds: null,
      rateLimit: null,
    });
    expect(issued).toEqual({ id: "key-id", key: "wvr_secret" });
    expect(createApiKey).toHaveBeenCalledWith({
      body: {
        userId: "u1",
        name: "CI",
        permissions: { content: ["read"], mcp: ["use"] },
        expiresIn: null,
      },
    });
  });

  it("passes expiry and per-key rate limits through", async () => {
    const { auth, createApiKey } = fakeAuth();
    await createApiKeyIssuer(auth).issue({
      userId: "u1",
      name: "Bot",
      permissions: { content: ["read"], mcp: ["use"] },
      expiresInSeconds: 86_400,
      rateLimit: { maxRequests: 60, windowMs: 60_000 },
    });
    expect(createApiKey).toHaveBeenCalledWith({
      body: {
        userId: "u1",
        name: "Bot",
        permissions: { content: ["read"], mcp: ["use"] },
        expiresIn: 86_400,
        rateLimitEnabled: true,
        rateLimitMax: 60,
        rateLimitTimeWindow: 60_000,
      },
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  baseUrlFromClientId,
  normalizeRemoteBaseUrl,
  remoteClientId,
  remoteEndpoints,
} from "./urls";

describe("normalizeRemoteBaseUrl", () => {
  it("normalises and rejects base URLs", () => {
    expect(normalizeRemoteBaseUrl("https://Apps.Example.com/weaver/")).toBe(
      "https://apps.example.com/weaver",
    );
    expect(normalizeRemoteBaseUrl("https://apps.example.com")).toBe(
      "https://apps.example.com",
    );
    expect(normalizeRemoteBaseUrl("http://localhost:3000/")).toBe(
      "http://localhost:3000",
    );
    for (const bad of [
      "http://apps.example.com", // http on a non-loopback host
      "https://apps.example.com/weaver/api/auth", // Weaver's own route suffix
      "https://user:pw@apps.example.com",
      "https://apps.example.com/?x=1",
      "https://apps.example.com/#f",
      "ftp://apps.example.com",
      "not a url",
    ])
      expect(() => normalizeRemoteBaseUrl(bad), bad).toThrow();
    expect(() =>
      normalizeRemoteBaseUrl("http://localhost:3000", { production: true }),
    ).toThrow();
  });
});

describe("remoteClientId", () => {
  it("round-trips through the client id", () => {
    const id = remoteClientId("https://apps.example.com/weaver");
    expect(id).toBe("weaver-instance:https://apps.example.com/weaver");
    expect(baseUrlFromClientId(id)).toBe("https://apps.example.com/weaver");
    expect(baseUrlFromClientId("weaver-test-mcp-client")).toBeNull();
    expect(
      baseUrlFromClientId("weaver-instance:javascript:alert(1)"),
    ).toBeNull();
  });
});

describe("remoteEndpoints", () => {
  it("derives Weaver's fixed layout from the base URL", () => {
    const e = remoteEndpoints("https://apps.example.com/weaver");
    expect(e.issuer).toBe("https://apps.example.com/weaver/api/auth");
    expect(e.authorize).toBe(
      "https://apps.example.com/weaver/api/auth/oauth2/authorize",
    );
    expect(e.token).toBe(
      "https://apps.example.com/weaver/api/auth/oauth2/token",
    );
    expect(e.metadata).toBe(
      "https://apps.example.com/weaver/api/auth/.well-known/oauth-authorization-server",
    );
    expect(e.resource).toBe("https://apps.example.com/weaver/api/mcp");
    expect(e.health).toBe("https://apps.example.com/weaver/api/health");
    expect(e.callback).toBe(
      "https://apps.example.com/weaver/api/remotes/callback",
    );
    expect(e.transfer("documents")).toBe(
      "https://apps.example.com/weaver/api/transfer/documents",
    );
  });
});

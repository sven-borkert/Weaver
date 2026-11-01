import { describe, expect, it } from "vitest";
import {
  appPublicUrl,
  mcpResourceUrl,
  normalizeBasePath,
  oauthIssuerUrl,
  protectedResourceMetadataPath,
} from "./publicUrls";

describe("public URLs (spec §26.2 items 5–6)", () => {
  it("defaults to the local origin without a base path", () => {
    expect(mcpResourceUrl({})).toBe("http://localhost:3000/api/mcp");
    expect(oauthIssuerUrl({})).toBe("http://localhost:3000/api/auth");
  });

  it("uses only the AUTH_URL origin and applies the base path", () => {
    const env = {
      AUTH_URL: "https://host.example/ignored",
      NEXT_PUBLIC_BASE_PATH: "/knowledge",
    };
    expect(mcpResourceUrl(env)).toBe("https://host.example/knowledge/api/mcp");
    expect(oauthIssuerUrl(env)).toBe("https://host.example/knowledge/api/auth");
  });

  it("honours explicit overrides and removes non-root trailing slashes", () => {
    expect(
      mcpResourceUrl({ WEAVER_MCP_RESOURCE_URL: "http://127.0.0.1:3200/mcp/" }),
    ).toBe("http://127.0.0.1:3200/mcp");
    expect(
      oauthIssuerUrl({ WEAVER_OAUTH_ISSUER: "https://auth.example/api/auth/" }),
    ).toBe("https://auth.example/api/auth");
  });

  it("normalizes base paths", () => {
    expect(normalizeBasePath(undefined)).toBe("");
    expect(normalizeBasePath("/")).toBe("");
    expect(normalizeBasePath("knowledge/")).toBe("/knowledge");
    expect(normalizeBasePath("/knowledge")).toBe("/knowledge");
  });

  it("derives the RFC 9728 path-inserted metadata location", () => {
    expect(
      protectedResourceMetadataPath("https://host.example/knowledge/api/mcp"),
    ).toBe("/.well-known/oauth-protected-resource/knowledge/api/mcp");
    expect(protectedResourceMetadataPath("http://127.0.0.1:3200/mcp")).toBe(
      "/.well-known/oauth-protected-resource/mcp",
    );
    expect(protectedResourceMetadataPath("http://127.0.0.1:3200/")).toBe(
      "/.well-known/oauth-protected-resource",
    );
  });
});

describe("appPublicUrl", () => {
  it("joins the AUTH_URL origin and the base path without a trailing slash", () => {
    expect(
      appPublicUrl({
        AUTH_URL: "https://apps.example.com/x?y",
        NEXT_PUBLIC_BASE_PATH: "/weaver",
      }),
    ).toBe("https://apps.example.com/weaver");
    expect(appPublicUrl({})).toBe("http://localhost:3000");
  });
});

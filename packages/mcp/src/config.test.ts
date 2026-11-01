import { describe, expect, it } from "vitest";
import { mcpRuntimeConfigFromEnv } from "./config";

const limits = {
  WEAVER_MCP_MAX_BODY_BYTES: 1_024,
  WEAVER_MCP_MAX_RESOURCE_CHARS: 1_000,
  WEAVER_MCP_TOOL_TIMEOUT_MS: 1_000,
  WEAVER_MCP_RATE_LIMIT_PER_MINUTE: 600,
  WEAVER_MCP_ANON_RATE_LIMIT_PER_MINUTE: 60,
};

describe("MCP runtime config", () => {
  it("derives public paths and development loopback allowlists", () => {
    const config = mcpRuntimeConfigFromEnv(
      {
        NODE_ENV: "development",
        AUTH_URL: "https://weaver.example",
        ...limits,
      },
      { basePath: "/weaver/", version: "1.2.3" },
    );

    expect(config).toMatchObject({
      resourceUrl: "https://weaver.example/weaver/api/mcp",
      issuer: "https://weaver.example/weaver/api/auth",
      mcpPath: "/weaver/api/mcp",
      metadataPath: "/.well-known/oauth-protected-resource/weaver/api/mcp",
      version: "1.2.3",
      production: false,
    });
    expect(config.allowedHosts).toContain("127.0.0.1");
    expect(config.allowedOrigins).toContain("localhost");
  });

  it("canonicalizes trailing-slash overrides with a deployment base path", () => {
    const config = mcpRuntimeConfigFromEnv(
      {
        NODE_ENV: "production",
        AUTH_URL: "https://ignored.example",
        WEAVER_MCP_RESOURCE_URL: "https://weaver.example/knowledge/mcp/",
        WEAVER_OAUTH_ISSUER: "https://weaver.example/knowledge/auth/",
        ...limits,
      },
      { basePath: "/knowledge/", version: "1.2.3" },
    );

    expect(config).toMatchObject({
      resourceUrl: "https://weaver.example/knowledge/mcp",
      issuer: "https://weaver.example/knowledge/auth",
      mcpPath: "/knowledge/mcp",
      metadataPath: "/.well-known/oauth-protected-resource/knowledge/mcp",
    });
  });
});

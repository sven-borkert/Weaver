import {
  mcpResourceUrl,
  oauthIssuerUrl,
  protectedResourceMetadataPath,
} from "@weaver/config/publicUrls";
import type { ServerEnv } from "@weaver/config/server";

export type McpRuntimeConfig = {
  resourceUrl: string;
  issuer: string;
  /** Path the MCP endpoint is served at: the resource URL's path. */
  mcpPath: string;
  /** RFC 9728 path-inserted well-known location for the resource. */
  metadataPath: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  maxBodyBytes: number;
  maxResourceChars: number;
  toolTimeoutMs: number;
  rateLimitPerMinute: number;
  anonRateLimitPerMinute: number;
  version: string;
  production: boolean;
};

const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function mcpRuntimeConfigFromEnv(
  env: Pick<
    ServerEnv,
    | "NODE_ENV"
    | "AUTH_URL"
    | "WEAVER_MCP_RESOURCE_URL"
    | "WEAVER_OAUTH_ISSUER"
    | "WEAVER_MCP_ALLOWED_HOSTS"
    | "WEAVER_MCP_ALLOWED_ORIGINS"
    | "WEAVER_MCP_MAX_BODY_BYTES"
    | "WEAVER_MCP_MAX_RESOURCE_CHARS"
    | "WEAVER_MCP_TOOL_TIMEOUT_MS"
    | "WEAVER_MCP_RATE_LIMIT_PER_MINUTE"
    | "WEAVER_MCP_ANON_RATE_LIMIT_PER_MINUTE"
  >,
  extra: { basePath?: string; version: string },
): McpRuntimeConfig {
  const urlEnv = {
    AUTH_URL: env.AUTH_URL,
    NEXT_PUBLIC_BASE_PATH: extra.basePath,
    WEAVER_MCP_RESOURCE_URL: env.WEAVER_MCP_RESOURCE_URL,
    WEAVER_OAUTH_ISSUER: env.WEAVER_OAUTH_ISSUER,
  };
  const resourceUrl = mcpResourceUrl(urlEnv);
  const issuer = oauthIssuerUrl(urlEnv);
  const resource = new URL(resourceUrl);
  const production = env.NODE_ENV === "production";
  const hosts = new Set([
    resource.hostname,
    new URL(issuer).hostname,
    ...csv(env.WEAVER_MCP_ALLOWED_HOSTS),
  ]);
  const origins = new Set([
    resource.hostname,
    new URL(issuer).hostname,
    ...csv(env.WEAVER_MCP_ALLOWED_ORIGINS),
  ]);
  if (!production) {
    for (const host of LOOPBACK) {
      hosts.add(host);
      origins.add(host);
    }
  }
  return {
    resourceUrl,
    issuer,
    mcpPath: resource.pathname.replace(/\/+$/, "") || "/",
    metadataPath: protectedResourceMetadataPath(resourceUrl),
    allowedHosts: [...hosts],
    allowedOrigins: [...origins],
    maxBodyBytes: env.WEAVER_MCP_MAX_BODY_BYTES,
    maxResourceChars: env.WEAVER_MCP_MAX_RESOURCE_CHARS,
    toolTimeoutMs: env.WEAVER_MCP_TOOL_TIMEOUT_MS,
    rateLimitPerMinute: env.WEAVER_MCP_RATE_LIMIT_PER_MINUTE,
    anonRateLimitPerMinute: env.WEAVER_MCP_ANON_RATE_LIMIT_PER_MINUTE,
    version: extra.version,
    production,
  };
}

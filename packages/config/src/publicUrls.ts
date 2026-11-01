const LOCAL_ORIGIN = "http://localhost:3000";

export type PublicUrlEnv = {
  AUTH_URL?: string;
  NEXT_PUBLIC_BASE_PATH?: string;
  WEAVER_MCP_RESOURCE_URL?: string;
  WEAVER_OAUTH_ISSUER?: string;
};

export function normalizeBasePath(value: string | undefined): string {
  const raw = value?.trim();
  if (!raw || raw === "/") return "";
  const withLeadingSlash = raw.startsWith("/") ? raw : `/${raw}`;
  return withLeadingSlash.replace(/\/+$/, "");
}

function publicPrefix(env: PublicUrlEnv): string {
  const origin = new URL(env.AUTH_URL ?? LOCAL_ORIGIN).origin;
  return `${origin}${normalizeBasePath(env.NEXT_PUBLIC_BASE_PATH)}`;
}

/** This instance's public base URL: what other Weaver instances register it as. */
export function appPublicUrl(env: PublicUrlEnv): string {
  return publicPrefix(env);
}

function canonicalEndpointUrl(value: string): string {
  const url = new URL(value);
  if (url.pathname !== "/") {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.href;
}

/** Spec §9/§26: the audience access tokens are bound to and the path the MCP runtime serves. */
export function mcpResourceUrl(env: PublicUrlEnv): string {
  return canonicalEndpointUrl(
    env.WEAVER_MCP_RESOURCE_URL ?? `${publicPrefix(env)}/api/mcp`,
  );
}

/** Better Auth's public mount and therefore the JWT `iss` (spec §26.6). */
export function oauthIssuerUrl(env: PublicUrlEnv): string {
  return canonicalEndpointUrl(
    env.WEAVER_OAUTH_ISSUER ?? `${publicPrefix(env)}/api/auth`,
  );
}

/** RFC 9728 §3.1: the well-known document sits at the origin root with the resource path inserted after it. */
export function protectedResourceMetadataPath(resourceUrl: string): string {
  const { pathname } = new URL(resourceUrl);
  const suffix = pathname.replace(/\/+$/, "");
  return `/.well-known/oauth-protected-resource${suffix}`;
}

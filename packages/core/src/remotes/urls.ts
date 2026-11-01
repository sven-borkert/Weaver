import { CoreError } from "../errors";

export const REMOTE_SCOPES =
  "mcp:use content:read content:write offline_access";
const CLIENT_ID_PREFIX = "weaver-instance:";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
// Weaver's own route roots; a base URL must stop before them.
const RESERVED_SUFFIX =
  /\/(api|\.well-known|projects|admin|account|login)(\/|$)/;

const invalid = (message: string) =>
  new CoreError("BAD_REQUEST", message, { field: "baseUrl" });

export function normalizeRemoteBaseUrl(
  raw: string,
  options: { production?: boolean } = {},
): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw invalid("Base URL must be an absolute https URL");
  }
  if (url.username || url.password || url.search || url.hash)
    throw invalid(
      "Base URL must not contain credentials, a query or a fragment",
    );
  const production =
    options.production ?? process.env.NODE_ENV === "production";
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && loopback && !production)
  )
    throw invalid(
      "Base URL must use https (http is allowed for localhost outside production)",
    );
  const path = url.pathname.replace(/\/+$/, "");
  if (RESERVED_SUFFIX.test(`${path}/`))
    throw invalid(
      "Base URL must be the instance root or its base path, not a route below it",
    );
  return `${url.origin}${path}`;
}

export function remoteClientId(baseUrl: string): string {
  return `${CLIENT_ID_PREFIX}${baseUrl}`;
}

export function baseUrlFromClientId(clientId: string): string | null {
  if (!clientId.startsWith(CLIENT_ID_PREFIX)) return null;
  const base = clientId.slice(CLIENT_ID_PREFIX.length);
  try {
    return normalizeRemoteBaseUrl(base, { production: false }) === base
      ? base
      : null;
  } catch {
    return null;
  }
}

export function remoteEndpoints(baseUrl: string) {
  const issuer = `${baseUrl}/api/auth`;
  return {
    issuer,
    authorize: `${issuer}/oauth2/authorize`,
    token: `${issuer}/oauth2/token`,
    metadata: `${issuer}/.well-known/oauth-authorization-server`,
    resource: `${baseUrl}/api/mcp`,
    health: `${baseUrl}/api/health`,
    callback: `${baseUrl}/api/remotes/callback`,
    transfer: (path: string) => `${baseUrl}/api/transfer/${path}`,
  };
}

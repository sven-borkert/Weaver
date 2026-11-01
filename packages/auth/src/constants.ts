export const GLOBAL_ROLES = ["Admin", "User"] as const;
export type GlobalRole = (typeof GLOBAL_ROLES)[number];
// One policy for Better Auth, the services and the forms; 128 is the provider's
// own ceiling, so a longer value could be set by an admin but never changed.
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const API_KEY_NAME_MAX_LENGTH = 80;
export const API_KEY_MAX_EXPIRY_DAYS = 365;
export const API_KEY_MAX_RATE_LIMIT_PER_MINUTE = 10_000;
export const OAUTH_SCOPES = [
  "mcp:use",
  "content:read",
  "content:propose",
  "content:write",
  "external:use",
  "external:manage",
  "offline_access",
] as const;
export const OIDC_PROVIDER_ID = "oidc";

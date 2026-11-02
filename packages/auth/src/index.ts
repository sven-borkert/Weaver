import { createPinnedFetch } from "@weaver/config/outboundFetch";
import type { OidcResolver } from "@weaver/config/oidc";
import { revokeSelfContainedToken } from "./oauthRevocation";
import { oidcPlugin, type WeaverOidcOptions } from "./oidc";
import {
  isAllowedWhilePasswordChangeRequired,
  isPasswordChangeRequired,
} from "./passwordChangeGate";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import { consentGuardedAdapter } from "./oauthConsentAdapter";
import { admin, jwt, organization } from "better-auth/plugins";
import { apiKey } from "@better-auth/api-key";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";

import {
  API_KEY_NAME_MAX_LENGTH,
  API_KEY_MAX_EXPIRY_DAYS,
  API_KEY_MAX_RATE_LIMIT_PER_MINUTE,
  isReservedEmail,
  OAUTH_SCOPES,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "./constants";
export {
  GLOBAL_ROLES,
  type GlobalRole,
  API_KEY_NAME_MAX_LENGTH,
  API_KEY_MAX_EXPIRY_DAYS,
  API_KEY_MAX_RATE_LIMIT_PER_MINUTE,
  OAUTH_SCOPES,
} from "./constants";

export const ORGANIZATION_ROLES = [
  "owner",
  "maintainer",
  "editor",
  "viewer",
] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
export const SESSION_UPDATE_AGE_SECONDS = 24 * 60 * 60;
// Distinct cookie names keep Weaver sessions apart from other apps on a shared host.
export const AUTH_COOKIE_PREFIX = "weaver";

// Core services enforce live-project access for every organization operation.
export const DISABLED_ORGANIZATION_PATHS = [
  "/organization/list",
  "/organization/has-permission",
  "/organization/get-organization",
  "/organization/get-full-organization",
  "/organization/list-members",
  "/organization/get-active-member",
  "/organization/get-active-member-role",
  "/organization/get-invitation",
  "/organization/list-invitations",
  "/organization/list-user-invitations",
  "/organization/set-active",
  "/organization/check-slug",
  "/organization/create",
  "/organization/update",
  "/organization/delete",
  "/organization/invite-member",
  "/organization/accept-invitation",
  "/organization/reject-invitation",
  "/organization/cancel-invitation",
  "/organization/update-member-role",
  "/organization/remove-member",
  "/organization/leave",
] as const;

// The admin plugin is kept only for its `role`/`banned` user fields; every
// HTTP route it registers (including /admin/impersonate-user, which would
// reinstate the removed global-Admin content bypass) stays disabled until a
// later phase opens specific admin endpoints.
export const DISABLED_ADMIN_PATHS = [
  "/admin/set-role",
  "/admin/get-user",
  "/admin/create-user",
  "/admin/update-user",
  "/admin/list-users",
  "/admin/list-user-sessions",
  "/admin/unban-user",
  "/admin/ban-user",
  "/admin/impersonate-user",
  "/admin/stop-impersonating",
  "/admin/revoke-user-session",
  "/admin/revoke-user-sessions",
  "/admin/remove-user",
  "/admin/set-user-password",
  "/admin/has-permission",
] as const;

/** Identifiable prefix for personal API keys (spec §8). */
export const API_KEY_PREFIX = "wvr_";
/** Stored prefix of each key shown in the UI (includes `wvr_`). */
export const API_KEY_START_LENGTH = 8;

/** Private JWT claim binding an access token to one consent generation. */
export const OAUTH_AUTHORIZATION_ID_CLAIM = "weaver_authorization_id";

export const CIMD_ORIGIN_BOUND_FIELDS = [
  "redirect_uris",
  "post_logout_redirect_uris",
  "client_uri",
] as const;

// Keys are minted/listed/revoked through Weaver's tRPC layer so project
// restrictions are validated; the plugin's own HTTP surface stays closed.
export const DISABLED_API_KEY_PATHS = [
  "/api-key/create",
  "/api-key/get",
  "/api-key/update",
  "/api-key/delete",
  "/api-key/list",
  // Server-only today; retain a deny entry if a future plugin makes it routable.
  "/api-key/verify",
] as const;

// No dynamic client registration (spec §9) and no self-service client CRUD
// until the Phase 7 admin area; CIMD discovery is the only registration path.
export const DISABLED_OAUTH_MANAGEMENT_PATHS = [
  "/oauth2/register",
  "/oauth2/get-consent",
  "/oauth2/get-consents",
  "/oauth2/update-consent",
  "/oauth2/delete-consent",
  "/oauth2/end-session",
  "/oauth2/end-session/confirm",
  "/oauth2/create-client",
  "/oauth2/update-client",
  "/oauth2/delete-client",
  "/oauth2/client/rotate-secret",
  "/oauth2/get-clients",
  "/admin/oauth2/create-client",
  "/admin/oauth2/update-client",
  "/admin/oauth2/resources",
] as const;

// Session holders must not mint bearer JWTs; only the OAuth token endpoint does.
export const DISABLED_JWT_PATHS = ["/token"] as const;

// Password changes use the serialized account service; profiles remain admin-managed.
export const DISABLED_ACCOUNT_PATHS = [
  "/change-password",
  "/update-user",
  "/link-social",
  "/unlink-account",
  "/get-access-token",
  "/refresh-token",
] as const;

export type WeaverMcpOptions = {
  /** Canonical MCP protected-resource URL; access tokens are audience-bound to it. */
  resource: string;
  /** Base-path-aware paths the OAuth flow redirects to. */
  loginPage: string;
  consentPage: string;
};

export type WeaverAuthOptions = {
  /** Prisma client; typed opaquely so this package never imports @weaver/db. */
  db: object;
  secret: string;
  baseURL?: string;
  /** Route mount path as seen by the server after Next strips any app base path. */
  basePath?: string;
  /** Runs after every successful sign-in (session creation). */
  onSignIn?: (userId: string) => Promise<void>;
  /** The consumer must summarize before logging: this error is unsanitized. */
  onSignInError?: (error: unknown) => void;
  /** The consumer must summarize before logging: this error is unsanitized. */
  onInitializationError?: (error: unknown) => void;
  /** Runtime-specific plugins (e.g. nextCookies()); appended last. */
  plugins?: BetterAuthPlugin[];
  /** Overrides Better Auth's default, which enables rate limiting only in production. */
  rateLimitEnabled?: boolean;
  /** Only enable forwarding headers behind a proxy that replaces client-supplied values. */
  trustProxy?: boolean;
  /** Mounts the MCP OAuth 2.1 provider + CIMD discovery. Omit for seeds/scripts. */
  mcp?: WeaverMcpOptions;
  /** JWT `iss`; defaults to Better Auth's baseURL + basePath. */
  issuer?: string;
  /** Public app base path; scopes auth cookies to it. Defaults to "/". */
  cookiePath?: string;
  /** Optional external OIDC login; password sign-up remains disabled. */
  oidc?: WeaverOidcOptions;
  oidcResolver?: OidcResolver;
  oidcFetch?: typeof fetch;
};

export function createWeaverAuth(options: WeaverAuthOptions) {
  if (options.oidc && options.oidcResolver)
    throw new Error("Configure either static OIDC options or an OIDC resolver");
  const scopes = [...OAUTH_SCOPES];
  const auth = betterAuth({
    appName: "Weaver",
    secret: options.secret,
    baseURL: options.baseURL,
    basePath: options.basePath ?? "/api/auth",
    trustedOrigins: options.baseURL ? [new URL(options.baseURL).origin] : [],
    database: consentGuardedAdapter(options.db),
    advanced: {
      database: { generateId: "uuid" },
      useSecureCookies: options.baseURL?.startsWith("https://") ?? false,
      cookiePrefix: AUTH_COOKIE_PREFIX,
      defaultCookieAttributes: { path: options.cookiePath ?? "/" },
      ipAddress: {
        ipAddressHeaders: options.trustProxy ? ["x-real-ip"] : [],
        disableIpTracking: false,
      },
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
    },
    account: {
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        trustedProviders: [],
        // The OIDC profile gate verifies email; admin-created local emails start unverified.
        requireLocalEmailVerified: false,
        allowDifferentEmails: false,
        updateUserInfoOnLink: false,
      },
    },
    session: {
      expiresIn: SESSION_MAX_AGE_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
    },
    user: {
      additionalFields: {
        mustChangePassword: {
          type: "boolean",
          defaultValue: false,
          input: false,
        },
      },
    },
    hooks: {
      after: revokeSelfContainedToken,
      before: createAuthMiddleware(async (ctx) => {
        if (!ctx.headers?.get("cookie")) return;
        const session = await getSessionFromCtx(ctx, {
          disableCookieCache: true,
          disableRefresh: true,
        });
        const user = session?.user as
          | {
              id: string;
              banned?: boolean;
              banExpires?: Date | null;
              mustChangePassword?: unknown;
            }
          | undefined;
        if (
          user?.banned &&
          (!user.banExpires || user.banExpires > new Date())
        ) {
          await ctx.context.internalAdapter.deleteUserSessions(user.id);
          throw new APIError("FORBIDDEN", { message: "Account is banned" });
        }
        // Mirrors the web app's requireActiveUser for every Better Auth route.
        if (
          isPasswordChangeRequired(user) &&
          !isAllowedWhilePasswordChangeRequired(ctx.path, ctx.body)
        ) {
          throw new APIError("FORBIDDEN", {
            message: "Password change required",
          });
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          // Every creation path ends here: admin create, bootstrap, seed, OIDC.
          before: async (user) => {
            if (isReservedEmail(user.email))
              throw new APIError("BAD_REQUEST", {
                message: "This email domain is reserved",
              });
            return { data: user };
          },
        },
      },
      session: {
        create: {
          after: async (session) => {
            try {
              await options.onSignIn?.(session.userId);
            } catch (error) {
              try {
                options.onSignInError?.(error);
              } catch {}
            }
          },
        },
      },
    },
    disabledPaths: [
      ...DISABLED_ORGANIZATION_PATHS,
      ...DISABLED_ADMIN_PATHS,
      ...DISABLED_API_KEY_PATHS,
      ...DISABLED_OAUTH_MANAGEMENT_PATHS,
      ...DISABLED_JWT_PATHS,
      ...DISABLED_ACCOUNT_PATHS,
    ],
    ...(options.rateLimitEnabled === undefined
      ? {}
      : { rateLimit: { enabled: options.rateLimitEnabled } }),
    plugins: [
      admin({ adminRoles: ["Admin"], defaultRole: "User" }),
      organization({ allowUserToCreateOrganization: false }),
      ...(options.oidc || options.oidcResolver
        ? [
            oidcPlugin({
              provider: options.oidc,
              resolve: options.oidcResolver,
              fetchImpl: options.oidcFetch ?? createPinnedFetch(),
              onUnavailable: options.onInitializationError,
            }),
          ]
        : []),
      jwt({
        disableSettingJwtHeader: true,
        ...(options.issuer ? { jwt: { issuer: options.issuer } } : {}),
      }),
      apiKey({
        defaultPrefix: API_KEY_PREFIX,
        requireName: true,
        maximumNameLength: API_KEY_NAME_MAX_LENGTH,
        startingCharactersConfig: {
          shouldStore: true,
          charactersLength: API_KEY_START_LENGTH,
        },
        keyExpiration: {
          defaultExpiresIn: null,
          minExpiresIn: 1,
          maxExpiresIn: API_KEY_MAX_EXPIRY_DAYS,
        },
        // Plugin-level gate must stay on; per-key rateLimitEnabled/Max/Window rows override this default.
        rateLimit: {
          enabled: true,
          timeWindow: 60_000,
          maxRequests: API_KEY_MAX_RATE_LIMIT_PER_MINUTE,
        },
        enableMetadata: false,
        enableSessionForAPIKeys: false,
        schema: { apikey: { modelName: "apiKey" } },
      }),
      ...(options.mcp
        ? [
            mcp({
              resource: options.mcp.resource,
              loginPage: options.mcp.loginPage,
              consentPage: options.mcp.consentPage,
              scopes,
              // Explicit allowedScopes: the plugin would otherwise seed NULL,
              // which Prisma rejects for a String[] column.
              resources: [
                {
                  identifier: options.mcp.resource,
                  name: "Weaver MCP",
                  allowedScopes: scopes,
                },
              ],
              clientRegistrationDefaultScopes: scopes,
              customAccessTokenClaims: ({ referenceId }) =>
                referenceId
                  ? { [OAUTH_AUTHORIZATION_ID_CLAIM]: referenceId }
                  : {},
              allowDynamicClientRegistration: false,
              allowUnauthenticatedClientRegistration: false,
              storeClientSecret: "hashed",
              // Runs before the existing-consent shortcut, so a flagged user's
              // authorization always lands on the consent page, which denies it.
              postLogin: {
                page: options.mcp.consentPage,
                // Consent generations are assigned by a database trigger.
                consentReferenceId: () => undefined,
                shouldRedirect: ({ user }) => isPasswordChangeRequired(user),
              },
            }),
            cimd({
              fetchClientMetadataResource,
              metadataProfile: "mcp-2026-07-28",
              originBoundFields: CIMD_ORIGIN_BOUND_FIELDS,
            }),
          ]
        : []),
      ...(options.plugins ?? []),
    ],
  });
  // Plugin init seeds resources eagerly; avoid an unhandled rejection with a fake db in tests.
  auth.$context.catch((error: unknown) => {
    try {
      options.onInitializationError?.(error);
    } catch {}
  });
  return auth;
}

export type WeaverAuth = ReturnType<typeof createWeaverAuth>;

export { createCredentialUser } from "./users";
export { bootstrapAdmin, type BootstrapAdminInput } from "./bootstrap";
export {
  createApiKeyIssuer,
  type ApiKeyIssuer,
  type IssueApiKeyInput,
  type IssuedApiKey,
} from "./apiKeys";
export { createUserAdministrator, type UserAdministrator } from "./adminUsers";
export { createPasswordChanger, type PasswordChanger } from "./passwordChange";
export {
  isAllowedWhilePasswordChangeRequired,
  isPasswordChangeRequired,
  PASSWORD_CHANGE_ALLOWED_PATHS,
} from "./passwordChangeGate";
export {
  createBearerVerifiers,
  parseBearerToken,
  parsePermissions,
  resolveBearerCredential,
  type BearerRejection,
  type BearerVerification,
  type BearerVerifierOptions,
  type BearerVerifiers,
  type ResourceRequestInput,
  type VerifiedAccessToken,
  type VerifiedApiKey,
} from "./bearer";

export { oauthRevocationIdentifier } from "./oauthRevocation";

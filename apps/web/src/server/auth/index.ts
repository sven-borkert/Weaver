import { cache } from "react";
import { createWeaverAuth } from "@weaver/auth";
import { mcpResourceUrl, oauthIssuerUrl } from "@weaver/config/publicUrls";
import { db } from "@weaver/db";
import { resolveWebOidcProvider } from "~/server/oidc";
import type { Role } from "@weaver/db/client";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";

import { env } from "~/env";
import { normalizeBasePath, withBasePath } from "~/lib/basePath";
import { captureError } from "@weaver/core/diagnostics/writer";

export const MCP_RESOURCE_URL = mcpResourceUrl(env);
/** Public auth mount, base path included: the JWT `iss` and advertised endpoints (spec §26.6). */
export const OAUTH_ISSUER_URL = oauthIssuerUrl(env);

// Better Auth matches the baseURL path; the route adapter restores Next's
// stripped app prefix while the browser client adds it (lib/authClient.ts).
export const auth = createWeaverAuth({
  db,
  secret: env.AUTH_SECRET,
  oidcResolver: resolveWebOidcProvider,
  baseURL: OAUTH_ISSUER_URL,
  basePath: "/api/auth",
  cookiePath: normalizeBasePath(env.NEXT_PUBLIC_BASE_PATH) || "/",
  trustProxy: env.WEAVER_AUTH_TRUST_PROXY,
  rateLimitEnabled:
    env.WEAVER_AUTH_RATE_LIMIT_ENABLED === undefined
      ? undefined
      : env.WEAVER_AUTH_RATE_LIMIT_ENABLED === "true",
  // Redirect targets are browser paths, so they carry the app base path.
  mcp: {
    resource: MCP_RESOURCE_URL,
    loginPage: withBasePath("/login"),
    consentPage: withBasePath("/consent"),
  },
  onSignIn: async (userId) => {
    await db.user.update({
      where: { id: userId },
      data: { lastLoginAt: new Date() },
    });
  },
  onSignInError: (error) =>
    captureError({
      event: "auth.plugin.failed",
      severity: "warn",
      message: "Failed to record successful sign-in",
      error,
      details: { hook: "onSignIn" },
    }),
  onInitializationError: (error) => {
    captureError({
      event: "auth.plugin.failed",
      severity: "warn",
      message: "Better Auth plugin initialization failed",
      error,
      details: { hook: "initialization" },
    });
    console.error("Better Auth plugin initialization failed");
  },
  plugins: [nextCookies()],
});

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  sessionId: string;
  mustChangePassword: boolean;
};

export const getSessionUser = cache(async function getSessionUser(
  headers: Headers,
): Promise<SessionUser | null> {
  const result = await auth.api
    .getSession({ headers })
    .catch((error: unknown) => {
      if (error instanceof APIError && error.status === "FORBIDDEN")
        return null;
      throw error;
    });
  if (
    !result ||
    (result.user.banned &&
      (!result.user.banExpires || result.user.banExpires > new Date()))
  )
    return null;
  return {
    id: result.user.id,
    email: result.user.email,
    name: result.user.name,
    role: result.user.role === "Admin" ? "Admin" : "User",
    sessionId: result.session.id,
    mustChangePassword: result.user.mustChangePassword === true,
  };
});

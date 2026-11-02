import {
  API_KEY_PREFIX,
  oauthRevocationIdentifier,
  parseBearerToken,
  parsePermissions,
  resolveBearerCredential,
  type BearerRejection,
  type BearerVerification,
  type BearerVerifiers,
  type ResourceRequestInput,
} from "@weaver/auth";
import { emitDiagnostic } from "../diagnostics/writer";
import { CoreError } from "@weaver/core/errors";
import {
  createApiKeySecurityContext,
  createOAuthSecurityContext,
  hasCapability,
  type UserSecurityContext,
} from "@weaver/core/security/context";
import { Prisma, type PrismaClient } from "@weaver/db/client";

function rejected(
  reason: BearerRejection,
  credentialPrefix: string | null,
): void {
  emitDiagnostic({
    event: "auth.bearer.rejected",
    severity: "warn",
    message: `authentication rejected: ${reason}`,
    outcome: "denied",
    details: { reason, prefix: credentialPrefix?.slice(0, 8) ?? null },
  });
}

/**
 * Turns an `Authorization` header into a constrained UserSecurityContext (spec §8, §9).
 * UNAUTHORIZED covers missing/invalid/expired/revoked credentials and banned or
 * deleted users; TOO_MANY_REQUESTS covers a key's own rate limit.
 */
export async function resolveBearerSecurityContext(
  db: PrismaClient,
  verifiers: BearerVerifiers,
  authorizationHeader: string | null | undefined,
): Promise<UserSecurityContext> {
  const verification = await resolveBearerCredential(
    verifiers,
    authorizationHeader,
  );
  const token = parseBearerToken(authorizationHeader);
  return (
    await resolveVerifiedCredentialContext(db, verification, {
      includeRejectionReason: false,
      credentialPrefix: token?.slice(0, 8) ?? null,
    })
  ).security;
}

/** Resolves only personal API-key bearer credentials for non-MCP HTTP endpoints. */
export async function resolveApiKeySecurityContext(
  db: PrismaClient,
  verifiers: BearerVerifiers,
  authorizationHeader: string | null | undefined,
): Promise<UserSecurityContext> {
  if (!authorizationHeader) {
    rejected("missing", null);
    throw new CoreError("UNAUTHORIZED", "A personal API key is required");
  }
  const token = parseBearerToken(authorizationHeader);
  if (!token) {
    rejected("malformed", null);
    throw new CoreError("UNAUTHORIZED", "A personal API key is required");
  }
  const credentialPrefix = token.slice(0, 8);
  if (!token.startsWith(API_KEY_PREFIX)) {
    rejected("invalid", credentialPrefix);
    throw new CoreError("UNAUTHORIZED", "A personal API key is required");
  }
  const verification = await verifiers.verifyApiKey(token);
  return (
    await resolveVerifiedCredentialContext(db, verification, {
      includeRejectionReason: false,
      credentialPrefix,
    })
  ).security;
}

export type McpPrincipal = {
  security: UserSecurityContext;
  profile: { name: string; email: string };
  /** OAuth client id for audit rows; null for API keys. */
  clientId: string | null;
};

async function resolveVerifiedCredentialContext(
  db: PrismaClient,
  verification: BearerVerification,
  options: {
    includeRejectionReason: boolean;
    credentialPrefix: string | null;
  },
): Promise<McpPrincipal> {
  if (!verification.ok) {
    rejected(verification.reason, options.credentialPrefix);
    if (verification.reason === "rate_limited") {
      throw new CoreError("TOO_MANY_REQUESTS", "API key rate limit exceeded");
    }
    throw new CoreError(
      "UNAUTHORIZED",
      "Invalid bearer credential",
      options.includeRejectionReason
        ? { reason: verification.reason }
        : undefined,
    );
  }
  const { credential } = verification;
  const user = await db.user.findUnique({
    where: { id: credential.userId },
    select: {
      id: true,
      role: true,
      banned: true,
      mustChangePassword: true,
      banExpires: true,
      name: true,
      email: true,
    },
  });
  if (
    !user ||
    user.mustChangePassword ||
    (user.banned && (!user.banExpires || user.banExpires > new Date()))
  ) {
    rejected("invalid", options.credentialPrefix);
    throw new CoreError(
      "UNAUTHORIZED",
      "Invalid bearer credential",
      options.includeRejectionReason ? { reason: "invalid" } : undefined,
    );
  }

  let security: UserSecurityContext;
  let clientId: string | null = null;
  if (credential.kind === "apiKey") {
    // One statement, one snapshot: a key revoked or edited after verification
    // must not leave old permissions paired with new (or vanished) restrictions.
    const [policy] = await db.$queryRaw<
      Array<{
        permissions: string | null;
        enabled: boolean | null;
        referenceId: string;
        projectIds: string[];
      }>
    >(Prisma.sql`
      SELECT
        k."permissions",
        k."enabled",
        k."referenceId"::text AS "referenceId",
        COALESCE(
          array_agg(p."projectId"::text) FILTER (WHERE p."projectId" IS NOT NULL),
          '{}'
        ) AS "projectIds"
      FROM "ApiKey" k
      LEFT JOIN "ApiKeyProject" p ON p."apiKeyId" = k."id"
      WHERE k."id" = ${credential.keyId}::uuid
      GROUP BY k."id"
    `);
    if (!policy || policy.enabled === false || policy.referenceId !== user.id) {
      rejected("revoked", options.credentialPrefix);
      throw new CoreError(
        "UNAUTHORIZED",
        "Invalid bearer credential",
        options.includeRejectionReason ? { reason: "revoked" } : undefined,
      );
    }
    security = createApiKeySecurityContext({
      userId: user.id,
      globalRole: user.role,
      keyId: credential.keyId,
      permissions: parsePermissions(policy.permissions),
      projectIds: policy.projectIds,
    });
  } else {
    clientId = credential.clientId;
    security = createOAuthSecurityContext({
      userId: user.id,
      globalRole: user.role,
      tokenId: credential.tokenId,
      scopes: credential.scopes,
    });
  }
  return {
    security,
    profile: { name: user.name, email: user.email },
    clientId,
  };
}

/**
 * The MCP boundary (spec §26.7). UNAUTHORIZED carries `details.reason` (a
 * BearerRejection; "dpop" needs the RFC 9449 challenge),
 * FORBIDDEN carries `details.scope` for an insufficient_scope challenge, and
 * TOO_MANY_REQUESTS is a key's own rate limit.
 */
export async function resolveMcpPrincipal(
  db: PrismaClient,
  verifiers: BearerVerifiers,
  input: ResourceRequestInput,
): Promise<McpPrincipal> {
  const verification = await verifiers.verifyResourceRequest(input);
  const principal = await resolveVerifiedCredentialContext(db, verification, {
    includeRejectionReason: true,
    credentialPrefix: null,
  });

  if (principal.clientId !== null) {
    const revokedToken = await db.verification.findFirst({
      where: {
        identifier: oauthRevocationIdentifier(principal.security.credentialId),
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    if (revokedToken) {
      rejected("revoked", null);
      throw new CoreError("UNAUTHORIZED", "Access token was revoked", {
        reason: "revoked",
      });
    }
    const authorizationId =
      verification.ok && verification.credential.kind === "oauth"
        ? verification.credential.authorizationId
        : null;
    const credentialScopes =
      verification.ok && verification.credential.kind === "oauth"
        ? verification.credential.scopes
        : [];
    const consent = await db.oauthConsent.findFirst({
      where: {
        clientId: principal.clientId,
        userId: principal.security.userId,
        referenceId: authorizationId ?? "",
        client: { disabled: false },
      },
      select: { id: true, resources: true, scopes: true },
    });
    const consentScopes = new Set(consent?.scopes ?? []);
    if (
      !consent ||
      credentialScopes.some((scope) => !consentScopes.has(scope))
    ) {
      rejected("consent_revoked", null);
      throw new CoreError(
        "UNAUTHORIZED",
        "Consent for this client was revoked",
        {
          reason: "consent_revoked",
        },
      );
    }
    if (!consent.resources.includes(input.url)) {
      rejected("resource_mismatch", null);
      throw new CoreError(
        "UNAUTHORIZED",
        "Authorize this client with the MCP resource parameter",
        { reason: "resource_mismatch" },
      );
    }
    if (consentScopes.has("offline_access")) {
      const liveFamily = await db.oauthRefreshToken.findFirst({
        where: {
          clientId: principal.clientId,
          userId: principal.security.userId,
          referenceId: authorizationId ?? "",
          revoked: null,
          expiresAt: { gt: new Date() },
        },
        select: { id: true },
      });
      const revokedFamily = await db.oauthRefreshToken.findFirst({
        where: {
          clientId: principal.clientId,
          userId: principal.security.userId,
          referenceId: authorizationId ?? "",
          revoked: { not: null },
          rotatedAt: null,
        },
        select: { id: true },
      });
      if (!liveFamily || revokedFamily) {
        rejected("revoked", null);
        throw new CoreError(
          "UNAUTHORIZED",
          "Refresh authorization was revoked",
          { reason: "revoked" },
        );
      }
    }
  }
  if (!hasCapability(principal.security, "mcp:use")) {
    rejected("insufficient_scope", null);
    throw new CoreError("FORBIDDEN", "The mcp:use scope is required", {
      reason: "insufficient_scope",
      scope: "mcp:use",
    });
  }
  return principal;
}

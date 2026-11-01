import type { AuthInfo } from "@modelcontextprotocol/server";
import type { BearerVerifiers } from "@weaver/auth";
import { isCoreError, type CoreError } from "@weaver/core/errors";
import {
  resolveMcpPrincipal,
  type McpPrincipal,
} from "@weaver/core/security/bearer";
import type { PrismaClient } from "@weaver/db/client";
import {
  DPOP_ALGS,
  bearerChallenge,
  dpopChallenge,
  jsonRpcError,
  oauthError,
} from "./responses";

export const MCP_SCOPES = [
  "mcp:use",
  "content:read",
  "content:propose",
  "content:write",
  "external:use",
  "external:manage",
] as const;

/** What a 401 asks a client to request first (spec authorization §3). */
export const CHALLENGE_SCOPE = "mcp:use content:read";

export type GateDeps = {
  db: PrismaClient;
  verifiers: BearerVerifiers;
  /** The canonical MCP endpoint; DPoP `htu` is checked against it, never against proxy headers. */
  resourceUrl: string;
  metadataUrl: string;
};

export type GateResult =
  | { ok: true; principal: McpPrincipal; authInfo: AuthInfo }
  | { ok: false; response: Response; reason: string };

const authenticatedPrincipals = new WeakSet<object>();

/** Spec §26.7: the SDK sees an AuthInfo without the bearer value. */
export function tokenFreeAuthInfo(
  principal: McpPrincipal,
  requestId: string,
): AuthInfo {
  authenticatedPrincipals.add(principal);
  return {
    token: "",
    clientId: principal.clientId ?? `apiKey:${principal.security.credentialId}`,
    scopes: [...principal.security.capabilities],
    extra: { principal, requestId },
  };
}

export function principalFromAuthInfo(
  authInfo: AuthInfo | undefined,
): McpPrincipal {
  const principal = authInfo?.extra?.principal;
  if (!isAuthenticatedPrincipal(principal))
    throw new Error("mcp request reached the factory unauthenticated");
  return principal;
}

function isAuthenticatedPrincipal(value: unknown): value is McpPrincipal {
  return (
    typeof value === "object" &&
    value !== null &&
    authenticatedPrincipals.has(value)
  );
}

function reasonOf(error: CoreError): string {
  const reason = error.details?.reason;
  return typeof reason === "string" ? reason : "invalid";
}

export function challengeFor(
  error: CoreError,
  deps: Pick<GateDeps, "metadataUrl">,
): Response {
  if (error.code === "TOO_MANY_REQUESTS") {
    return jsonRpcError(429, -32000, "rate limit exceeded", {
      "retry-after": "60",
    });
  }
  if (error.code === "FORBIDDEN") {
    const scope =
      typeof error.details?.scope === "string"
        ? error.details.scope
        : "mcp:use";
    return oauthError(
      403,
      bearerChallenge({
        error: "insufficient_scope",
        scope,
        resource_metadata: deps.metadataUrl,
      }),
      "insufficient_scope",
      error.message,
    );
  }
  const reason = reasonOf(error);
  if (reason === "dpop" || reason === "dpop_token") {
    return oauthError(
      401,
      dpopChallenge(
        deps.metadataUrl,
        reason === "dpop_token" ? "invalid_token" : "invalid_dpop_proof",
      ),
      "invalid_token",
      "a valid DPoP proof is required for this token",
    );
  }
  if (reason === "missing") {
    return oauthError(
      401,
      `${bearerChallenge({ resource_metadata: deps.metadataUrl, scope: CHALLENGE_SCOPE })}, DPoP algs="${DPOP_ALGS}"`,
      null,
      "authentication required",
    );
  }
  return oauthError(
    401,
    bearerChallenge({
      error: "invalid_token",
      resource_metadata: deps.metadataUrl,
      scope: CHALLENGE_SCOPE,
    }),
    "invalid_token",
    error.message,
  );
}

export async function authenticate(
  deps: GateDeps,
  request: Request,
  requestId: string,
): Promise<GateResult> {
  try {
    const principal = await resolveMcpPrincipal(deps.db, deps.verifiers, {
      authorizationHeader: request.headers.get("authorization"),
      dpopProofJwt: request.headers.get("dpop"),
      method: request.method,
      url: deps.resourceUrl,
    });
    return {
      ok: true,
      principal,
      authInfo: tokenFreeAuthInfo(principal, requestId),
    };
  } catch (error) {
    if (!isCoreError(error)) throw error;
    return {
      ok: false,
      response: challengeFor(error, deps),
      reason:
        error.code === "FORBIDDEN" ? "insufficient_scope" : reasonOf(error),
    };
  }
}

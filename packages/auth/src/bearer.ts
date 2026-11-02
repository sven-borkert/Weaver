import { createHash } from "node:crypto";
import { isAPIError } from "better-auth/api";
import {
  createDpopReplayStore,
  enforceDpopBinding,
  isDpopBindingError,
  parseAccessTokenAuthorization,
  verifyJwsAccessToken,
  type DpopReplayReservations,
  type DpopReplayStore,
  type ResourceRequestInput,
} from "better-auth/oauth2";
import {
  decodeProtectedHeader,
  errors as joseErrors,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";
import {
  API_KEY_PREFIX,
  OAUTH_AUTHORIZATION_ID_CLAIM,
  type WeaverAuth,
} from "./index";

export type { ResourceRequestInput } from "better-auth/oauth2";

export type VerifiedApiKey = {
  kind: "apiKey";
  keyId: string;
  userId: string;
  permissions: Record<string, string[]> | null;
};

export type VerifiedAccessToken = {
  kind: "oauth";
  /** JWT `jti`; becomes UserSecurityContext.credentialId. */
  tokenId: string;
  userId: string;
  clientId: string;
  scopes: string[];
  authorizationId: string | null;
};

export type BearerRejection =
  | "missing"
  | "malformed"
  | "invalid"
  | "expired"
  | "revoked"
  | "rate_limited"
  | "consent_revoked"
  | "resource_mismatch"
  | "insufficient_scope"
  /** RFC 9449 sender-constraint failure: answer with the DPoP challenge. */
  | "dpop"
  | "dpop_token";

export type BearerVerification =
  | { ok: true; credential: VerifiedApiKey | VerifiedAccessToken }
  | { ok: false; reason: BearerRejection };

export type BearerVerifiers = {
  verifyApiKey(key: string): Promise<BearerVerification>;
  /** Compatibility API; sender-bound tokens still require full request verification. */
  verifyAccessToken(token: string): Promise<BearerVerification>;
  /** Spec §26.7: bearer or DPoP-bound token with the request context RFC 9449 needs. */
  verifyResourceRequest(
    input: ResourceRequestInput,
  ): Promise<BearerVerification>;
};

export type BearerVerifierOptions = {
  /** Expected `iss` (Better Auth baseURL + basePath unless `issuer` was configured). */
  issuer: string;
  /** Expected `aud`: the MCP resource URL. */
  audience: string;
  /** Override for a remote resource server; defaults to the instance's own JWKS. */
  getJwks?: () => Promise<JSONWebKeySet>;
};

export const DPOP_RESERVATION_PREFIX = "dpop-proof:";

export function parseBearerToken(
  header: string | null | undefined,
): string | null {
  if (!header) return null;
  const match = /^\s*bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

export function parsePermissions(
  value: unknown,
): Record<string, string[]> | null {
  if (typeof value === "string") {
    try {
      return parsePermissions(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, string[]>)
    : null;
}

function rejectionForApiKeyCode(code: string | undefined): BearerRejection {
  switch (code) {
    case "KEY_EXPIRED":
      return "expired";
    // Plugin throws "RATE_LIMITED" at runtime; USAGE_EXCEEDED is quota exhaustion.
    case "RATE_LIMIT_EXCEEDED":
    case "RATE_LIMITED":
    case "USAGE_EXCEEDED":
      return "rate_limited";
    case "KEY_DISABLED":
      return "revoked";
    default:
      return "invalid";
  }
}

function credentialFromPayload(payload: JWTPayload): BearerVerification {
  const clientId =
    typeof payload.client_id === "string"
      ? payload.client_id
      : typeof payload.azp === "string"
        ? payload.azp
        : null;
  if (
    typeof payload.sub !== "string" ||
    typeof payload.jti !== "string" ||
    typeof payload.scope !== "string" ||
    clientId === null
  ) {
    return { ok: false, reason: "invalid" };
  }
  return {
    ok: true,
    credential: {
      kind: "oauth",
      tokenId: payload.jti,
      userId: payload.sub,
      clientId,
      scopes: payload.scope.split(" ").filter(Boolean),
      authorizationId:
        typeof payload[OAUTH_AUTHORIZATION_ID_CLAIM] === "string" &&
        payload[OAUTH_AUTHORIZATION_ID_CLAIM].length > 0
          ? payload[OAUTH_AUTHORIZATION_ID_CLAIM]
          : null,
    },
  };
}

function dpopReservationId(identifier: string): string {
  // Better Auth's base64url reservation IDs cannot inhabit Weaver's UUID verification key.
  const digest = createHash("sha256")
    .update(`reserve:${identifier}`)
    .digest("hex");
  const variant = ["8", "9", "a", "b"][Number.parseInt(digest[16]!, 16) % 4]!;
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

async function dpopReplayReservations(
  auth: WeaverAuth,
): Promise<DpopReplayReservations> {
  const context = await auth.$context;
  return {
    async reserveVerificationValue(data) {
      await context.adapter.deleteMany({
        model: "verification",
        where: [
          {
            field: "identifier",
            value: DPOP_RESERVATION_PREFIX,
            operator: "starts_with",
          },
          {
            field: "expiresAt",
            value: new Date(),
            operator: "lt",
          },
        ],
      });
      const id = dpopReservationId(data.identifier);
      try {
        await context.adapter.create({
          model: "verification",
          data: {
            id,
            identifier: data.identifier,
            value: data.value,
            expiresAt: data.expiresAt,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          forceAllowId: true,
        });
      } catch (error) {
        const existing = await context.adapter.findOne<{ id: string }>({
          model: "verification",
          where: [{ field: "id", value: id }],
        });
        if (existing) return false;
        throw error;
      }
      return true;
    },
  };
}

export function createBearerVerifiers(
  auth: WeaverAuth,
  options: BearerVerifierOptions,
): BearerVerifiers {
  // Read per call: keys rotate, and tests truncate the jwks table between specs.
  const getJwks = options.getJwks ?? (async () => await auth.api.getJwks());
  // Better Auth caches a function source under a stable key with the same TTL
  // and kid-miss refetch rules it applies to a JWKS URL (spec §26.7 "bounded cache").
  const jwksCacheKey = {};
  const jwksFetch = async () => await getJwks();
  let replayStore: Promise<DpopReplayStore> | undefined;
  const getReplayStore = () =>
    (replayStore ??= dpopReplayReservations(auth).then(createDpopReplayStore));

  const verifiers: BearerVerifiers = {
    async verifyApiKey(key) {
      let result;
      try {
        result = await auth.api.verifyApiKey({ body: { key } });
      } catch (error) {
        if (isAPIError(error) && error.statusCode < 500)
          return { ok: false, reason: "invalid" };
        throw error;
      }
      if (!result.valid || !result.key) {
        return {
          ok: false,
          reason: rejectionForApiKeyCode(result.error?.code),
        };
      }
      return {
        ok: true,
        credential: {
          kind: "apiKey",
          keyId: result.key.id,
          userId: result.key.referenceId,
          permissions: parsePermissions(result.key.permissions),
        },
      };
    },

    async verifyAccessToken(token) {
      return verifiers.verifyResourceRequest({
        authorizationHeader: `Bearer ${token}`,
        dpopProofJwt: null,
        method: "POST",
        url: options.audience,
      });
    },

    async verifyResourceRequest(input) {
      if (!input.authorizationHeader) return { ok: false, reason: "missing" };
      const authorization = parseAccessTokenAuthorization(
        input.authorizationHeader,
      );
      if (
        !authorization ||
        authorization.scheme === "Unknown" ||
        !authorization.token
      ) {
        return { ok: false, reason: "malformed" };
      }
      if (authorization.token.startsWith(API_KEY_PREFIX)) {
        if (authorization.scheme !== "Bearer") {
          return { ok: false, reason: "malformed" };
        }
        return verifiers.verifyApiKey(authorization.token);
      }
      try {
        decodeProtectedHeader(authorization.token);
      } catch {
        return { ok: false, reason: "invalid" };
      }
      let payload: JWTPayload;
      try {
        payload = await verifyJwsAccessToken(authorization.token, {
          jwksFetch,
          jwksCacheKey,
          verifyOptions: {
            issuer: options.issuer,
            audience: options.audience,
            typ: "at+jwt",
            algorithms: ["EdDSA"],
            requiredClaims: ["exp", "jti", "sub", "scope"],
          },
        });
      } catch (error) {
        if (
          !(error instanceof joseErrors.JOSEError) ||
          error instanceof joseErrors.JWKSTimeout ||
          error instanceof joseErrors.JWKSInvalid ||
          error instanceof joseErrors.JWKInvalid
        )
          throw error;
        return {
          ok: false,
          reason:
            error instanceof joseErrors.JWTExpired ? "expired" : "invalid",
        };
      }
      try {
        // Returns normally for a plain bearer token; a cnf-bound token needs
        // the DPoP scheme plus a proof matching method, URL, ath, and jkt.
        await enforceDpopBinding({
          payload,
          authorization,
          proofJwt: input.dpopProofJwt,
          method: input.method,
          url: input.url,
          replayStore: await getReplayStore(),
        });
      } catch (error) {
        if (isDpopBindingError(error))
          return {
            ok: false,
            reason: error.code === "invalid_token" ? "dpop_token" : "dpop",
          };
        throw error;
      }
      return credentialFromPayload(payload);
    },
  };
  return verifiers;
}

/** Selects key vs. token verification by the `wvr_` prefix (spec §9). */
export async function resolveBearerCredential(
  verifiers: BearerVerifiers,
  authorizationHeader: string | null | undefined,
): Promise<BearerVerification> {
  if (!authorizationHeader) return { ok: false, reason: "missing" };
  const token = parseBearerToken(authorizationHeader);
  if (!token) return { ok: false, reason: "malformed" };
  return token.startsWith(API_KEY_PREFIX)
    ? verifiers.verifyApiKey(token)
    : verifiers.verifyAccessToken(token);
}

import { createPublicKey, type JsonWebKey } from "node:crypto";
import { z } from "zod";
import {
  OIDC_MAX_RESPONSE_BYTES,
  OIDC_SIGNING_ALGORITHMS,
  OIDC_TIMEOUT_MS,
  oidcMetadataSchema,
  oidcUrlSchema,
  type OidcDiscoveryResult,
} from "./oidc";

type Reason =
  | "invalid_url"
  | "network"
  | "policy"
  | "timeout"
  | "http"
  | "redirect"
  | "too_large"
  | "invalid_metadata"
  | "invalid_jwks";
export class OidcDiscoveryError extends Error {
  constructor(readonly reason: Reason) {
    super(`OIDC request failed (${reason})`);
  }
}
export type OidcDiscoveryDeps = { fetchImpl: typeof fetch };

async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        abort = () => reject(new OidcDiscoveryError("timeout"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export async function oidcJsonRequest(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<unknown> {
  if (!oidcUrlSchema.safeParse(url).success)
    throw new OidcDiscoveryError("invalid_url");
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await abortable(
      fetchImpl(url, {
        ...init,
        signal,
        redirect: "manual",
        credentials: "omit",
      }),
      signal,
    );
    if (response.status >= 300 && response.status < 400)
      throw new OidcDiscoveryError("redirect");
    if (!response.ok) throw new OidcDiscoveryError("http");
    if (
      Number(response.headers.get("content-length")) > OIDC_MAX_RESPONSE_BYTES
    )
      throw new OidcDiscoveryError("too_large");
    reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader)
      for (;;) {
        const { done, value } = await abortable(reader.read(), signal);
        if (done) break;
        size += value.length;
        if (size > OIDC_MAX_RESPONSE_BYTES)
          throw new OidcDiscoveryError("too_large");
        chunks.push(value);
      }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw new OidcDiscoveryError("invalid_metadata");
    }
  } catch (error) {
    if (error instanceof OidcDiscoveryError) throw error;
    if (signal.aborted) throw new OidcDiscoveryError("timeout");
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "OUTBOUND_NOT_ALLOWED"
    )
      throw new OidcDiscoveryError("policy");
    throw new OidcDiscoveryError("network");
  } finally {
    if (reader) void reader.cancel().catch(() => undefined);
  }
}

function usableKey(
  key: Record<string, unknown>,
  algorithms: string[],
): boolean {
  if (["d", "p", "q", "dp", "dq", "qi", "k"].some((field) => field in key))
    return false;
  if (key.use !== undefined && key.use !== "sig") return false;
  if (
    key.key_ops !== undefined &&
    (!Array.isArray(key.key_ops) || !key.key_ops.includes("verify"))
  )
    return false;
  if (
    key.alg !== undefined &&
    (typeof key.alg !== "string" || !algorithms.includes(key.alg))
  )
    return false;
  if (!(
    (key.kty === "RSA" && algorithms.some((alg) => /^(RS|PS)/.test(alg))) ||
    (key.kty === "EC" && algorithms.some((alg) => alg.startsWith("ES"))) ||
    (key.kty === "OKP" && algorithms.includes("EdDSA"))
  ))
    return false;
  try {
    const publicKey = createPublicKey({
      key: key as JsonWebKey,
      format: "jwk",
    });
    const permitted = typeof key.alg === "string" ? [key.alg] : algorithms;
    if (key.kty === "RSA")
      return (
        (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048 &&
        permitted.some((alg) => /^(RS|PS)/.test(alg))
      );
    if (key.kty === "EC")
      return permitted.some(
        (alg) =>
          ({ ES256: "P-256", ES384: "P-384", ES512: "P-521" })[
            alg as "ES256" | "ES384" | "ES512"
          ] === key.crv,
      );
    return (
      key.kty === "OKP" &&
      permitted.includes("EdDSA") &&
      ["ed25519", "ed448"].includes(publicKey.asymmetricKeyType ?? "")
    );
  } catch {
    return false;
  }
}

export async function discoverOidcProvider(
  discoveryUrl: string,
  deps: OidcDiscoveryDeps,
): Promise<OidcDiscoveryResult> {
  const signal = AbortSignal.timeout(OIDC_TIMEOUT_MS);
  const parsed = oidcMetadataSchema.safeParse(
    await oidcJsonRequest(
      deps.fetchImpl,
      discoveryUrl,
      { method: "GET" },
      signal,
    ),
  );
  if (!parsed.success) throw new OidcDiscoveryError("invalid_metadata");
  const metadata = parsed.data;
  const signingAlgorithms = OIDC_SIGNING_ALGORITHMS.filter((alg) =>
    metadata.id_token_signing_alg_values_supported.includes(alg),
  );
  const issues: string[] = [];
  const warnings: string[] = [];
  if (!signingAlgorithms.length)
    issues.push(
      "No supported asymmetric ID-token signing algorithm is advertised.",
    );
  for (const [values, required, label] of [
    [metadata.code_challenge_methods_supported, "S256", "PKCE methods"],
    [metadata.response_types_supported, "code", "response types"],
    [metadata.grant_types_supported, "authorization_code", "grant types"],
    [metadata.scopes_supported, "openid", "scopes"],
  ] as const) {
    if (values && !values.includes(required))
      issues.push(
        `The provider does not advertise ${required} in its ${label}.`,
      );
    if (!values)
      warnings.push(
        `${label} are not advertised; verify provider support during sign-in.`,
      );
  }
  const methods = metadata.token_endpoint_auth_methods_supported;
  const tokenEndpointAuthMethod = !methods
    ? "client_secret_basic"
    : methods.includes("client_secret_post")
      ? "client_secret_post"
      : methods.includes("client_secret_basic")
        ? "client_secret_basic"
        : null;
  if (!methods)
    warnings.push(
      "Client authentication methods are not advertised; using client_secret_basic.",
    );
  if (!tokenEndpointAuthMethod)
    issues.push(
      "No supported confidential-client authentication method is advertised.",
    );
  const rawKeys = await oidcJsonRequest(
    deps.fetchImpl,
    metadata.jwks_uri,
    { method: "GET" },
    signal,
  );
  const jwks = z
    .object({
      keys: z.array(z.record(z.string(), z.unknown())).min(1).max(100),
    })
    .safeParse(rawKeys);
  if (
    !jwks.success ||
    (signingAlgorithms.length > 0 &&
      !jwks.data.keys.some((key) => usableKey(key, signingAlgorithms)))
  )
    throw new OidcDiscoveryError("invalid_jwks");
  return {
    metadata,
    compatible: issues.length === 0,
    issues,
    warnings,
    signingAlgorithms,
    tokenEndpointAuthMethod,
  };
}

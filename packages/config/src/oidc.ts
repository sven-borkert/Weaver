import { z } from "zod";

export const OIDC_TIMEOUT_MS = 5_000;
export const OIDC_MAX_RESPONSE_BYTES = 262_144;
export const OIDC_SIGNING_ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
] as const;

export function isOidcUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.hash &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}
export const oidcUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine(
    isOidcUrl,
    "Use an HTTPS URL without credentials or a fragment (HTTP is allowed on loopback).",
  );
const list = z.array(z.string().min(1).max(200)).max(100);
export const oidcMetadataSchema = z.object({
  issuer: oidcUrlSchema,
  authorization_endpoint: oidcUrlSchema,
  token_endpoint: oidcUrlSchema,
  jwks_uri: oidcUrlSchema,
  userinfo_endpoint: oidcUrlSchema.optional(),
  id_token_signing_alg_values_supported: list.min(1),
  scopes_supported: list.optional(),
  response_types_supported: list.optional(),
  grant_types_supported: list.optional(),
  code_challenge_methods_supported: list.optional(),
  token_endpoint_auth_methods_supported: list.optional(),
});
export type OidcMetadata = z.infer<typeof oidcMetadataSchema>;
export const oidcDiscoveryResultSchema = z.object({
  metadata: oidcMetadataSchema,
  compatible: z.boolean(),
  issues: z.array(z.string().max(500)).max(20),
  warnings: z.array(z.string().max(500)).max(20),
  signingAlgorithms: z.array(z.enum(OIDC_SIGNING_ALGORITHMS)).max(12),
  tokenEndpointAuthMethod: z
    .enum(["client_secret_post", "client_secret_basic"])
    .nullable(),
});
export type OidcDiscoveryResult = z.infer<typeof oidcDiscoveryResultSchema>;
export type OidcProviderOptions = {
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  displayName: string;
};
export type OidcRuntimeSnapshot = OidcProviderOptions & {
  generation: string;
  discovery: OidcDiscoveryResult;
};
export type OidcResolver = () => Promise<OidcRuntimeSnapshot | null>;

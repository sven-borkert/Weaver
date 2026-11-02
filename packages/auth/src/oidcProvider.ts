import {
  authorizationCodeRequest,
  createAuthorizationURL,
  getOAuth2Tokens,
  verifyProviderIdToken,
  type OAuthProvider,
} from "@better-auth/core/oauth2";
import { getOAuthState } from "better-auth/api";
import { createRemoteJWKSet, customFetch, decodeJwt } from "jose";
import { OIDC_TIMEOUT_MS, type OidcRuntimeSnapshot } from "@weaver/config/oidc";
import { oidcJsonRequest } from "@weaver/config/oidcDiscovery";
import { isReservedEmail, OIDC_PROVIDER_ID } from "./constants";

export const OIDC_GENERATION_STATE_KEY = "weaverOidcGeneration";
export function createOidcProvider(
  snapshot: OidcRuntimeSnapshot,
  deps: { fetchImpl: typeof fetch },
): OAuthProvider {
  if (
    !snapshot.discovery.compatible ||
    !snapshot.discovery.tokenEndpointAuthMethod ||
    !snapshot.discovery.signingAlgorithms.length
  )
    throw new Error("OIDC configuration is incompatible");
  const { metadata, signingAlgorithms, tokenEndpointAuthMethod } =
    snapshot.discovery;
  const jwks = createRemoteJWKSet(new URL(metadata.jwks_uri), {
    [customFetch]: async (url) =>
      Response.json(
        await oidcJsonRequest(
          deps.fetchImpl,
          String(url),
          { method: "GET" },
          AbortSignal.timeout(OIDC_TIMEOUT_MS),
        ),
      ),
  });
  const options = {
    clientId: snapshot.clientId,
    clientSecret: snapshot.clientSecret,
  };
  const provider: OAuthProvider = {
    id: OIDC_PROVIDER_ID,
    name: snapshot.displayName,
    issuer: metadata.issuer,
    accountIssuer: metadata.issuer,
    accountSubject: ({ profile }) =>
      "sub" in profile && typeof profile.sub === "string" ? profile.sub : "",
    requiresIdTokenNonce: true,
    disableSignUp: false,
    idToken: {
      jwks,
      issuer: metadata.issuer,
      audience: snapshot.clientId,
      algorithms: signingAlgorithms,
    },
    options,
    createAuthorizationURL: (data) =>
      createAuthorizationURL({
        id: OIDC_PROVIDER_ID,
        options,
        authorizationEndpoint: metadata.authorization_endpoint,
        state: data.state,
        codeVerifier: data.codeVerifier,
        redirectURI: data.redirectURI,
        scopes: ["openid", "profile", "email"],
        nonce: data.idTokenNonce,
      }),
    validateAuthorizationCode: async (data) => {
      const state = await getOAuthState();
      if (
        state?.serverContext?.[OIDC_GENERATION_STATE_KEY] !==
        snapshot.generation
      )
        throw new Error("OIDC configuration changed. Please sign in again.");
      const { body, headers } = await authorizationCodeRequest({
        ...data,
        options,
        tokenEndpoint: metadata.token_endpoint,
        tokenEndpointAuth: { method: tokenEndpointAuthMethod },
      });
      const raw = await oidcJsonRequest(
        deps.fetchImpl,
        metadata.token_endpoint,
        { method: "POST", body, headers },
        AbortSignal.timeout(OIDC_TIMEOUT_MS),
      );
      if (
        !raw ||
        typeof raw !== "object" ||
        Array.isArray(raw) ||
        !("id_token" in raw) ||
        typeof raw.id_token !== "string"
      )
        return null;
      return getOAuth2Tokens(raw);
    },
    getUserInfo: async (tokens) => {
      if (
        !tokens.idToken ||
        !tokens.expectedIdTokenNonce ||
        !(await verifyProviderIdToken(
          provider,
          tokens.idToken,
          tokens.expectedIdTokenNonce,
        ))
      )
        return null;
      const claims = decodeJwt(tokens.idToken);
      if (
        typeof claims.sub !== "string" ||
        !claims.sub ||
        typeof claims.email !== "string" ||
        !claims.email.trim() ||
        claims.email_verified !== true ||
        isReservedEmail(claims.email)
      )
        return null;
      const name =
        typeof claims.name === "string" && claims.name.trim()
          ? claims.name.trim()
          : claims.email;
      return {
        user: { email: claims.email, emailVerified: true, name },
        data: {
          sub: claims.sub,
          email: claims.email,
          email_verified: true,
          name,
        },
      };
    },
    createEndSessionURL: () => null,
  };
  return provider;
}

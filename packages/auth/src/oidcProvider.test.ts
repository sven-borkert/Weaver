import { describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createOidcProvider } from "./oidcProvider";

describe("OIDC provider adapter", () => {
  it("binds redirects to PKCE and nonce and verifies the profile before returning it", async () => {
    const keys = await generateKeyPair("RS256");
    const jwk = await exportJWK(keys.publicKey);
    const provider = createOidcProvider(
      {
        discoveryUrl: "https://idp.example.test/discovery",
        clientId: "weaver",
        clientSecret: "secret",
        displayName: "SSO",
        generation: "generation",
        discovery: {
          compatible: true,
          issues: [],
          warnings: [],
          signingAlgorithms: ["RS256"],
          tokenEndpointAuthMethod: "client_secret_post",
          metadata: {
            issuer: "https://idp.example.test",
            authorization_endpoint: "https://idp.example.test/auth",
            token_endpoint: "https://idp.example.test/token",
            jwks_uri: "https://idp.example.test/keys",
            id_token_signing_alg_values_supported: ["RS256"],
          },
        },
      },
      {
        fetchImpl: async () =>
          Response.json({ keys: [{ ...jwk, kid: "fixture" }] }),
      },
    );
    const url = await provider.createAuthorizationURL({
      state: "state",
      codeVerifier: "test-verifier",
      idTokenNonce: "nonce",
      redirectURI: "https://weaver.example.test/weaver/api/auth/callback/oidc",
    });
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("nonce")).toBe("nonce");
    const token = (emailVerified: boolean) =>
      new SignJWT({
        email: "user@example.test",
        email_verified: emailVerified,
        nonce: "nonce",
        role: "Admin",
      })
        .setProtectedHeader({ alg: "RS256", kid: "fixture" })
        .setIssuer("https://idp.example.test")
        .setAudience("weaver")
        .setSubject("stable-subject")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(keys.privateKey);
    expect(
      await provider.getUserInfo({
        idToken: await token(true),
        expectedIdTokenNonce: "nonce",
      }),
    ).toMatchObject({
      user: { email: "user@example.test", emailVerified: true },
      data: { sub: "stable-subject" },
    });
    expect(
      await provider.getUserInfo({
        idToken: await token(false),
        expectedIdTokenNonce: "nonce",
      }),
    ).toBeNull();
    expect(
      await provider.getUserInfo({
        idToken: await token(true),
        expectedIdTokenNonce: "wrong",
      }),
    ).toBeNull();
    const reserved = await new SignJWT({
      email: "bot@weaver.invalid",
      email_verified: true,
      nonce: "nonce",
    })
      .setProtectedHeader({ alg: "RS256", kid: "fixture" })
      .setIssuer("https://idp.example.test")
      .setAudience("weaver")
      .setSubject("stable-subject")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keys.privateKey);
    expect(
      await provider.getUserInfo({
        idToken: reserved,
        expectedIdTokenNonce: "nonce",
      }),
    ).toBeNull();
  });
});

import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverOidcProvider, oidcJsonRequest } from "./oidcDiscovery";

const origin = "https://idp.example.test";
const metadata = {
  issuer: origin,
  authorization_endpoint: `${origin}/authorize`,
  token_endpoint: `${origin}/token`,
  jwks_uri: `${origin}/jwks`,
  id_token_signing_alg_values_supported: ["RS256"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["client_secret_post"],
};
const keys = {
  keys: [
    {
      ...generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({
        format: "jwk",
      }),
      use: "sig",
      alg: "RS256",
    },
  ],
};
function transport(document: unknown = metadata, jwks: unknown = keys) {
  return vi.fn<typeof fetch>(async (input, init) => {
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(new Headers(init?.headers).has("cookie")).toBe(false);
    return Response.json(
      (input instanceof Request ? input.url : input.toString()).endsWith(
        "/jwks",
      )
        ? jwks
        : document,
    );
  });
}
afterEach(() => vi.useRealTimers());

describe("OIDC discovery", () => {
  it("fetches discovery and signing keys without credentials", async () => {
    const fetchImpl = transport();
    const result = await discoverOidcProvider(`${origin}/discovery`, {
      fetchImpl,
    });
    expect(result.metadata.issuer).toBe(origin);
    expect(result.compatible).toBe(true);
    expect(result.tokenEndpointAuthMethod).toBe("client_secret_post");
    expect(
      fetchImpl.mock.calls.map(([url]) =>
        url instanceof Request ? url.url : url.toString(),
      ),
    ).toEqual([`${origin}/discovery`, `${origin}/jwks`]);
  });
  it("defaults omitted client authentication metadata to basic", async () => {
    const { token_endpoint_auth_methods_supported: _, ...document } = metadata;
    const result = await discoverOidcProvider(`${origin}/discovery`, {
      fetchImpl: transport(document),
    });
    expect(result.tokenEndpointAuthMethod).toBe("client_secret_basic");
    expect(result.warnings.length).toBeGreaterThan(0);
  });
  it.each([
    { code_challenge_methods_supported: ["plain"] },
    { response_types_supported: ["token"] },
    { grant_types_supported: ["client_credentials"] },
    { scopes_supported: ["profile"] },
    { token_endpoint_auth_methods_supported: ["none"] },
    { id_token_signing_alg_values_supported: ["HS256"] },
  ])("reports incompatible advertised capabilities: %j", async (patch) => {
    const result = await discoverOidcProvider(`${origin}/discovery`, {
      fetchImpl: transport({ ...metadata, ...patch }),
    });
    expect(result.compatible).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });
  it.each([
    "http://remote.example.test/discovery",
    "https://user:password@idp.example.test/discovery",
    `${origin}/discovery#fragment`,
  ])("rejects unsafe discovery URL %s", async (url) => {
    await expect(
      discoverOidcProvider(url, { fetchImpl: transport() }),
    ).rejects.toMatchObject({ reason: "invalid_url" });
  });
  it("rejects missing verification metadata", async () => {
    await expect(
      discoverOidcProvider(`${origin}/discovery`, {
        fetchImpl: transport({ issuer: origin }),
      }),
    ).rejects.toMatchObject({ reason: "invalid_metadata" });
  });
  it("rejects signing keys too small for the advertised algorithm", async () => {
    await expect(
      discoverOidcProvider(`${origin}/discovery`, {
        fetchImpl: transport(metadata, {
          keys: [{ kty: "RSA", n: "AQAB", e: "AQAB", alg: "RS256" }],
        }),
      }),
    ).rejects.toMatchObject({ reason: "invalid_jwks" });
  });
  it("rejects invalid or private signing keys", async () => {
    await expect(
      discoverOidcProvider(`${origin}/discovery`, {
        fetchImpl: transport(metadata, { keys: [{ kty: "oct", k: "SECRET" }] }),
      }),
    ).rejects.toMatchObject({ reason: "invalid_jwks" });
  });
  it("refuses redirects and hides remote response bodies", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response("SECRET", {
          status: 302,
          headers: { location: `${origin}/other` },
        }),
    );
    await expect(
      discoverOidcProvider(`${origin}/discovery`, { fetchImpl }),
    ).rejects.toMatchObject({ reason: "redirect" });
    const failing = vi.fn<typeof fetch>(
      async () => new Response("SECRET", { status: 500 }),
    );
    await expect(
      discoverOidcProvider(`${origin}/discovery`, { fetchImpl: failing }),
    ).rejects.toMatchObject({ reason: "http" });
  });
  it("bounds chunked responses even without Content-Length", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(262145));
              controller.close();
            },
          }),
        ),
    );
    await expect(
      oidcJsonRequest(
        fetchImpl,
        `${origin}/discovery`,
        {},
        AbortSignal.timeout(1000),
      ),
    ).rejects.toMatchObject({ reason: "too_large" });
  });
  it("enforces its deadline during a hanging body read", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(new ReadableStream()),
    );
    await expect(
      oidcJsonRequest(
        fetchImpl,
        `${origin}/discovery`,
        {},
        AbortSignal.timeout(20),
      ),
    ).rejects.toMatchObject({ reason: "timeout" });
  });
  it("rejects non-JSON metadata", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response("<html>error</html>"),
    );
    await expect(
      discoverOidcProvider(`${origin}/discovery`, { fetchImpl }),
    ).rejects.toMatchObject({ reason: "invalid_metadata" });
  });
});

import { createHash, randomUUID } from "node:crypto";
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JSONWebKeySet,
  type JWK,
} from "jose";
import { describe, expect, it, vi } from "vitest";
import type { WeaverAuth } from "./index";
import {
  createBearerVerifiers,
  parseBearerToken,
  resolveBearerCredential,
} from "./bearer";

describe("parseBearerToken", () => {
  it("accepts a case-insensitive Bearer scheme and rejects everything else", () => {
    expect(parseBearerToken("Bearer abc")).toBe("abc");
    expect(parseBearerToken("bearer   abc ")).toBe("abc");
    expect(parseBearerToken("Basic abc")).toBeNull();
    expect(parseBearerToken("Bearer")).toBeNull();
    expect(parseBearerToken(null)).toBeNull();
  });
});

describe("api key verification mapping", () => {
  function verifiers(result: unknown) {
    const verifyApiKey = vi.fn(async () => result);
    const auth = {
      api: { verifyApiKey, getJwks: vi.fn() },
    } as unknown as WeaverAuth;
    return createBearerVerifiers(auth, {
      issuer: "http://localhost:3000/api/auth",
      audience: "http://localhost:3000/api/mcp",
    });
  }

  it("returns the owning user and permissions for a valid key", async () => {
    const result = await verifiers({
      valid: true,
      error: null,
      key: {
        id: "k1",
        referenceId: "u1",
        permissions: { content: ["read"], mcp: ["use"] },
      },
    }).verifyApiKey("wvr_x");
    expect(result).toEqual({
      ok: true,
      credential: {
        kind: "apiKey",
        keyId: "k1",
        userId: "u1",
        permissions: { content: ["read"], mcp: ["use"] },
      },
    });
  });

  it("maps Better Auth error codes to rejection reasons", async () => {
    for (const [code, reason] of [
      ["KEY_EXPIRED", "expired"],
      ["RATE_LIMIT_EXCEEDED", "rate_limited"],
      ["USAGE_EXCEEDED", "rate_limited"],
      ["KEY_DISABLED", "revoked"],
      ["KEY_NOT_FOUND", "invalid"],
      ["INVALID_API_KEY", "invalid"],
    ] as const) {
      const result = await verifiers({
        valid: false,
        error: { code, message: code },
        key: null,
      }).verifyApiKey("wvr_x");
      expect(result).toEqual({ ok: false, reason });
    }
  });
});

describe("resolveBearerCredential", () => {
  it("routes wvr_ keys to the key verifier and everything else to the token verifier", async () => {
    const verifyApiKey = vi.fn(async () => ({
      ok: true,
      credential: { kind: "apiKey" },
    }));
    const verifyAccessToken = vi.fn(async () => ({
      ok: true,
      credential: { kind: "oauth" },
    }));
    const verifiers = { verifyApiKey, verifyAccessToken } as never;

    await resolveBearerCredential(verifiers, "Bearer wvr_abc");
    await resolveBearerCredential(verifiers, "Bearer eyJhbGciOi.payload.sig");
    expect(verifyApiKey).toHaveBeenCalledWith("wvr_abc");
    expect(verifyAccessToken).toHaveBeenCalledWith("eyJhbGciOi.payload.sig");
    expect(await resolveBearerCredential(verifiers, null)).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(await resolveBearerCredential(verifiers, "Basic x")).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});

const ISSUER = "http://localhost:3000/api/auth";
const AUDIENCE = "http://localhost:3000/api/mcp";
const MCP_URL = "http://localhost:3200/mcp";

async function issuerKeys() {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
  });
  const jwk: JWK = {
    ...(await exportJWK(publicKey)),
    kid: "k-test",
    alg: "EdDSA",
    use: "sig",
  };
  return { privateKey, jwks: { keys: [jwk] } satisfies JSONWebKeySet };
}

function mintAccessToken(
  privateKey: CryptoKey,
  claims: Record<string, unknown> = {},
) {
  return new SignJWT({
    scope: "mcp:use content:read",
    client_id: "client-1",
    ...claims,
  })
    .setProtectedHeader({ alg: "EdDSA", kid: "k-test", typ: "at+jwt" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject("u1")
    .setJti("jti-1")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

async function dpopKey() {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  return { privateKey, jwk, jkt: await calculateJwkThumbprint(jwk) };
}

function dpopProof(
  key: { privateKey: CryptoKey; jwk: JWK },
  input: { htm: string; htu: string; accessToken: string; jti?: string },
) {
  const ath = createHash("sha256")
    .update(input.accessToken)
    .digest("base64url");
  return new SignJWT({
    htm: input.htm,
    htu: input.htu,
    ath,
    jti: input.jti ?? randomUUID(),
  })
    .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: key.jwk })
    .setIssuedAt()
    .sign(key.privateKey);
}

function resourceAuth(
  jwks: JSONWebKeySet,
  reserve: () => Promise<boolean> = async () => true,
) {
  const verifyApiKey = vi.fn(async () => ({
    valid: true,
    error: null,
    key: { id: "k1", referenceId: "u1", permissions: { mcp: ["use"] } },
  }));
  const auth = {
    api: { verifyApiKey, getJwks: vi.fn(async () => jwks) },
    $context: Promise.resolve({
      adapter: {
        deleteMany: vi.fn(async () => 0),
        create: vi.fn(async () => {
          if (!(await reserve())) throw new Error("duplicate reservation");
        }),
        findOne: vi.fn(async () => ({ id: "reserved" })),
      },
    }),
  } as unknown as WeaverAuth;
  return {
    verifiers: createBearerVerifiers(auth, {
      issuer: ISSUER,
      audience: AUDIENCE,
    }),
    verifyApiKey,
  };
}

describe("verifyResourceRequest (spec §26.7)", () => {
  it.each([
    new Error("database unavailable"),
    new TypeError("JWKS transport unavailable"),
  ])(
    "propagates infrastructure errors instead of rejecting valid credentials: %s",
    async (failure) => {
      const auth = {
        api: {
          verifyApiKey: async () => {
            throw failure;
          },
          getJwks: async () => {
            throw failure;
          },
        },
      } as unknown as WeaverAuth;
      const verifiers = createBearerVerifiers(auth, {
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      await expect(verifiers.verifyApiKey("wvr_x")).rejects.toBe(failure);
      const { privateKey } = await issuerKeys();
      await expect(
        verifiers.verifyAccessToken(await mintAccessToken(privateKey)),
      ).rejects.toBe(failure);
    },
  );
  it("rejects malformed JWT headers before consulting the JWKS source", async () => {
    const getJwks = vi.fn(async () => {
      throw new TypeError("JWKS unavailable");
    });
    const auth = { api: { getJwks } } as unknown as WeaverAuth;
    const verifiers = createBearerVerifiers(auth, {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    for (const token of [
      "not-a-token",
      "invalid.payload.signature",
      "e30.payload.signature.extra",
    ]) {
      await expect(verifiers.verifyAccessToken(token)).resolves.toEqual({
        ok: false,
        reason: "invalid",
      });
    }
    expect(getJwks).not.toHaveBeenCalled();
  });
  it("rejects sender-bound tokens through the legacy bearer API", async () => {
    const { privateKey, jwks } = await issuerKeys();
    const { verifiers } = resourceAuth(jwks);
    await expect(
      verifiers.verifyAccessToken(
        await mintAccessToken(privateKey, { cnf: { jkt: "bound" } }),
      ),
    ).resolves.toEqual({ ok: false, reason: "dpop_token" });
  });
  it("requires exp even for a correctly signed token", async () => {
    const { privateKey, jwks } = await issuerKeys();
    const token = await new SignJWT({ scope: "mcp:use", client_id: "client-1" })
      .setProtectedHeader({ alg: "EdDSA", kid: "k-test", typ: "at+jwt" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("u1")
      .setJti("jti-1")
      .sign(privateKey);
    await expect(
      resourceAuth(jwks).verifiers.verifyAccessToken(token),
    ).resolves.toEqual({ ok: false, reason: "invalid" });
  });
  it("accepts a plain bearer token that carries no cnf", async () => {
    const { privateKey, jwks } = await issuerKeys();
    const token = await mintAccessToken(privateKey);
    const { verifiers } = resourceAuth(jwks);
    const result = await verifiers.verifyResourceRequest({
      authorizationHeader: `Bearer ${token}`,
      dpopProofJwt: null,
      method: "POST",
      url: MCP_URL,
    });
    expect(result).toEqual({
      ok: true,
      credential: {
        kind: "oauth",
        tokenId: "jti-1",
        userId: "u1",
        clientId: "client-1",
        scopes: ["mcp:use", "content:read"],
        authorizationId: null,
      },
    });
  });

  it("routes wvr_ keys to key verification regardless of the JWKS", async () => {
    const { jwks } = await issuerKeys();
    const { verifiers, verifyApiKey } = resourceAuth(jwks);
    const result = await verifiers.verifyResourceRequest({
      authorizationHeader: "Bearer wvr_abc",
      dpopProofJwt: null,
      method: "POST",
      url: MCP_URL,
    });
    expect(result.ok).toBe(true);
    expect(verifyApiKey).toHaveBeenCalledWith({ body: { key: "wvr_abc" } });
  });

  it("rejects a cnf-bound token presented as a bearer token", async () => {
    const { privateKey, jwks } = await issuerKeys();
    const key = await dpopKey();
    const token = await mintAccessToken(privateKey, { cnf: { jkt: key.jkt } });
    const { verifiers } = resourceAuth(jwks);
    await expect(
      verifiers.verifyResourceRequest({
        authorizationHeader: `Bearer ${token}`,
        dpopProofJwt: null,
        method: "POST",
        url: MCP_URL,
      }),
    ).resolves.toEqual({ ok: false, reason: "dpop_token" });
  });

  it("accepts a cnf-bound token with a matching DPoP proof and rejects a replay", async () => {
    const { privateKey, jwks } = await issuerKeys();
    const key = await dpopKey();
    const token = await mintAccessToken(privateKey, { cnf: { jkt: key.jkt } });
    const seen = new Set<string>();
    const { verifiers } = resourceAuth(jwks, async () => true);
    const proof = await dpopProof(key, {
      htm: "POST",
      htu: MCP_URL,
      accessToken: token,
      jti: "proof-1",
    });
    const first = await verifiers.verifyResourceRequest({
      authorizationHeader: `DPoP ${token}`,
      dpopProofJwt: proof,
      method: "POST",
      url: `${MCP_URL}?ignored=1`,
    });
    expect(first.ok).toBe(true);

    const replaying = resourceAuth(jwks, async () => {
      const fresh = !seen.has("proof-1");
      seen.add("proof-1");
      return fresh;
    });
    expect(
      (
        await replaying.verifiers.verifyResourceRequest({
          authorizationHeader: `DPoP ${token}`,
          dpopProofJwt: proof,
          method: "POST",
          url: MCP_URL,
        })
      ).ok,
    ).toBe(true);
    await expect(
      replaying.verifiers.verifyResourceRequest({
        authorizationHeader: `DPoP ${token}`,
        dpopProofJwt: proof,
        method: "POST",
        url: MCP_URL,
      }),
    ).resolves.toEqual({ ok: false, reason: "dpop" });
  });

  it("prunes only expired DPoP reservations before storing a new proof", async () => {
    const { privateKey, jwks } = await issuerKeys();
    const key = await dpopKey();
    const token = await mintAccessToken(privateKey, { cnf: { jkt: key.jkt } });
    const now = Date.now();
    const rows: Array<{
      id: string;
      identifier: string;
      value: string;
      expiresAt: Date;
    }> = [
      {
        id: "expired-dpop",
        identifier: "dpop-proof:expired",
        value: "expired",
        expiresAt: new Date(now - 60_000),
      },
      {
        id: "live-dpop",
        identifier: "dpop-proof:live",
        value: "live",
        expiresAt: new Date(now + 60_000),
      },
      {
        id: "expired-other",
        identifier: "password-reset:expired",
        value: "other",
        expiresAt: new Date(now - 60_000),
      },
    ];
    const adapter = {
      async deleteMany(input: {
        where: Array<{
          field: string;
          value: unknown;
          operator?: string;
        }>;
      }) {
        const prefix = input.where.find(
          (clause) => clause.field === "identifier",
        )?.value;
        const cutoff = input.where.find(
          (clause) => clause.field === "expiresAt",
        )?.value;
        const kept = rows.filter(
          (row) =>
            !(
              typeof prefix === "string" &&
              row.identifier.startsWith(prefix) &&
              cutoff instanceof Date &&
              row.expiresAt < cutoff
            ),
        );
        const count = rows.length - kept.length;
        rows.splice(0, rows.length, ...kept);
        return count;
      },
      async create(input: { data: (typeof rows)[number] }) {
        if (rows.some((row) => row.id === input.data.id)) {
          throw new Error("duplicate");
        }
        rows.push(input.data);
        return input.data;
      },
      async findOne(input: { where: Array<{ value: string }> }) {
        return rows.find((row) => row.id === input.where[0]?.value) ?? null;
      },
    };
    const auth = {
      api: { verifyApiKey: vi.fn(), getJwks: vi.fn(async () => jwks) },
      $context: Promise.resolve({ adapter, internalAdapter: {} }),
    } as unknown as WeaverAuth;
    const proof = await dpopProof(key, {
      htm: "POST",
      htu: MCP_URL,
      accessToken: token,
      jti: "cleanup-proof",
    });

    await expect(
      createBearerVerifiers(auth, {
        issuer: ISSUER,
        audience: AUDIENCE,
      }).verifyResourceRequest({
        authorizationHeader: `DPoP ${token}`,
        dpopProofJwt: proof,
        method: "POST",
        url: MCP_URL,
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(rows.map((row) => row.id)).not.toContain("expired-dpop");
    expect(rows.map((row) => row.id)).toEqual(
      expect.arrayContaining(["live-dpop", "expired-other"]),
    );
    expect(
      rows.filter((row) => row.identifier.startsWith("dpop-proof:")),
    ).toHaveLength(2);
  });

  it("rejects a proof for another method or URL", async () => {
    const { privateKey, jwks } = await issuerKeys();
    const key = await dpopKey();
    const token = await mintAccessToken(privateKey, { cnf: { jkt: key.jkt } });
    const { verifiers } = resourceAuth(jwks);
    const proof = await dpopProof(key, {
      htm: "GET",
      htu: MCP_URL,
      accessToken: token,
    });
    await expect(
      verifiers.verifyResourceRequest({
        authorizationHeader: `DPoP ${token}`,
        dpopProofJwt: proof,
        method: "POST",
        url: MCP_URL,
      }),
    ).resolves.toEqual({ ok: false, reason: "dpop" });
  });

  it("rejects the wrong audience, a missing header, and an unknown scheme", async () => {
    const { privateKey, jwks } = await issuerKeys();
    const { verifiers } = resourceAuth(jwks);
    const foreign = await new SignJWT({ scope: "mcp:use", client_id: "c" })
      .setProtectedHeader({ alg: "EdDSA", kid: "k-test", typ: "at+jwt" })
      .setIssuer(ISSUER)
      .setAudience("http://elsewhere.example/mcp")
      .setSubject("u1")
      .setJti("jti-2")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const base = { dpopProofJwt: null, method: "POST", url: MCP_URL };
    await expect(
      verifiers.verifyResourceRequest({
        ...base,
        authorizationHeader: `Bearer ${foreign}`,
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid" });
    await expect(
      verifiers.verifyResourceRequest({ ...base, authorizationHeader: null }),
    ).resolves.toEqual({ ok: false, reason: "missing" });
    await expect(
      verifiers.verifyResourceRequest({
        ...base,
        authorizationHeader: "Basic abc",
      }),
    ).resolves.toEqual({ ok: false, reason: "malformed" });
  });

  it("reads the JWKS through one cached source", async () => {
    const { privateKey, jwks } = await issuerKeys();
    const token = await mintAccessToken(privateKey);
    const getJwks = vi.fn(async () => jwks);
    const auth = {
      api: { verifyApiKey: vi.fn(), getJwks },
      $context: Promise.resolve({
        adapter: {
          deleteMany: vi.fn(async () => 0),
          create: vi.fn(async () => ({})),
        },
      }),
    } as unknown as WeaverAuth;
    const verifiers = createBearerVerifiers(auth, {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    const input = {
      authorizationHeader: `Bearer ${token}`,
      dpopProofJwt: null,
      method: "POST",
      url: MCP_URL,
    };
    await verifiers.verifyResourceRequest(input);
    await verifiers.verifyResourceRequest(input);
    await verifiers.verifyResourceRequest(input);
    expect(getJwks.mock.calls.length).toBeLessThan(3);
  });
});

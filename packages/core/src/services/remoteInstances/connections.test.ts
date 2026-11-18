import { describe, expect, it, vi } from "vitest";
import { parseEncryptionKeyRing } from "@weaver/config/encryptionKeys";
import type { PrismaClient } from "@weaver/db/client";
import { remoteEndpoints } from "../../remotes/urls";
import { encryptSecret, secretAad } from "../../security/encryption";
import { completeRemoteConnection, withRemoteToken } from "./connections";

const ring = parseEncryptionKeyRing(
  `1:${Buffer.alloc(32, 1).toString("base64")}`,
)!;
const now = new Date("2026-11-18T08:00:00Z");
const userId = "11111111-1111-4111-8111-111111111111";
const remoteId = "22222222-2222-4222-8222-222222222222";
const connectionId = "33333333-3333-4333-8333-333333333333";
const currentRemote = {
  id: remoteId,
  name: "Peer",
  baseUrl: "https://peer.example.test/weaver",
  enabled: true,
  endpointGeneration: 2,
};

function fixture(authorizationGeneration = 1) {
  let remote = currentRemote;
  const sealed = encryptSecret(
    ring,
    JSON.stringify({ accessToken: "test-token", refreshToken: null }),
    secretAad("remote-instance-connection", connectionId),
  );
  const connection = {
    id: connectionId,
    remoteInstanceId: remoteId,
    endpointGeneration: currentRemote.endpointGeneration,
    accessTokenExpiresAt: new Date(now.getTime() + 120_000),
    tokensCiphertext: Buffer.from(sealed.ciphertext).toString("base64"),
    tokensKeyVersion: sealed.keyVersion,
    tokensIv: Buffer.from(sealed.nonce).toString("base64"),
    tokensTag: Buffer.from(sealed.tag).toString("base64"),
  };
  const state = {
    userId,
    remoteInstanceId: remoteId,
    endpointGeneration: authorizationGeneration,
    codeVerifier: "test-verifier",
    expiresAt: new Date(now.getTime() + 120_000),
  };
  const db = {
    remoteInstance: {
      findUnique: vi.fn(async () => remote),
    },
    remoteInstanceAuthorization: {
      findUnique: vi.fn(async () => state),
    },
    remoteInstanceConnection: {
      findUnique: vi.fn(async () => connection),
      updateMany: vi.fn(),
    },
    $queryRaw: vi.fn(async () => [remote]),
    $transaction: (run: (tx: unknown) => unknown) => run(db),
  };
  const fetchImpl = vi.fn<typeof fetch>(async () =>
    Response.json({ ok: true }),
  );
  return {
    deps: {
      db: db as unknown as PrismaClient,
      ring,
      fetchImpl,
      now: () => now,
      selfBaseUrl: "https://local.example.test",
      mcpResourceUrl: "https://local.example.test/api/mcp",
      pinOutbound: false,
    },
    fetchImpl,
    replaceEndpoint: () => {
      remote = { ...remote, endpointGeneration: 3 };
    },
  };
}

describe("remote endpoint generation", () => {
  it("rejects a callback from a prior generation without requesting a token", async () => {
    const { deps, fetchImpl } = fixture();
    await expect(
      completeRemoteConnection(deps, {
        userId,
        state: "test-state",
        code: "test-code",
      }),
    ).rejects.toMatchObject({ details: { field: "state" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("discards a token response if the authorization generation changes during exchange", async () => {
    const { deps, fetchImpl, replaceEndpoint } = fixture(
      currentRemote.endpointGeneration,
    );
    fetchImpl.mockImplementationOnce(async () => {
      replaceEndpoint();
      return Response.json({ access_token: "test-token", expires_in: 3600 });
    });
    await expect(
      completeRemoteConnection(deps, {
        userId,
        state: "test-state",
        code: "test-code",
      }),
    ).rejects.toMatchObject({ details: { field: "state" } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("stops a prepared request when the endpoint generation changes before dispatch", async () => {
    const { deps, replaceEndpoint, fetchImpl } = fixture();
    await expect(
      withRemoteToken(
        deps,
        { userId, remoteInstanceId: remoteId },
        async (_token, remote, fetch) => {
          replaceEndpoint();
          await fetch(remoteEndpoints(remote.baseUrl).transfer("whoami"));
        },
      ),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      details: { field: "remoteInstanceId" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("dispatches a current credential to its bound endpoint", async () => {
    const { deps, fetchImpl } = fixture();
    const target = remoteEndpoints(currentRemote.baseUrl).transfer("whoami");
    await withRemoteToken(
      deps,
      { userId, remoteInstanceId: remoteId },
      async (token, remote, fetch) => {
        await fetch(remoteEndpoints(remote.baseUrl).transfer("whoami"), {
          headers: { authorization: `Bearer ${token}` },
        });
      },
    );
    expect(fetchImpl).toHaveBeenCalledWith(target, {
      headers: { authorization: "Bearer test-token" },
    });
  });
});

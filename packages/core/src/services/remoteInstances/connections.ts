import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@weaver/db/client";
import { CoreError } from "../../errors";
import { generatePkce, randomState } from "../../remotes/pkce";
import { remoteJson, RemoteHttpError } from "../../remotes/http";
import {
  REMOTE_SCOPES,
  remoteClientId,
  remoteEndpoints,
} from "../../remotes/urls";
import {
  decryptSecret,
  encryptSecret,
  missingKeyVersions,
  secretAad,
  type EncryptionKeyRing,
} from "../../security/encryption";
import type { SecurityContext } from "../../security/context";
import { fetchForRemote, REMOTE_INSTANCE_SELECT } from "./registry";
import type { RemoteRuntimeDeps } from "./types";

export const REMOTE_AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
const REFRESH_LEEWAY_MS = 60_000;
const DEFAULT_EXPIRES_IN_S = 3600;
const MAX_EXPIRES_IN_S = 86_400;
const AAD_KIND = "remote-instance-connection";

type Tokens = { accessToken: string; refreshToken: string | null };
type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
};

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

function sealTokens(
  ring: EncryptionKeyRing,
  connectionId: string,
  tokens: Tokens,
) {
  const sealed = encryptSecret(
    ring,
    JSON.stringify(tokens),
    secretAad(AAD_KIND, connectionId),
  );
  return {
    tokensCiphertext: b64(sealed.ciphertext),
    tokensKeyVersion: sealed.keyVersion,
    tokensIv: b64(sealed.nonce),
    tokensTag: b64(sealed.tag),
  };
}

function openTokens(
  ring: EncryptionKeyRing,
  row: {
    id: string;
    tokensCiphertext: string;
    tokensKeyVersion: number;
    tokensIv: string;
    tokensTag: string;
  },
): Tokens {
  const text = decryptSecret(
    ring,
    {
      ciphertext: Buffer.from(row.tokensCiphertext, "base64"),
      nonce: Buffer.from(row.tokensIv, "base64"),
      tag: Buffer.from(row.tokensTag, "base64"),
      keyVersion: row.tokensKeyVersion,
    },
    secretAad(AAD_KIND, row.id),
  );
  return JSON.parse(text) as Tokens;
}

const reconnect = (name: string) =>
  new CoreError("PRECONDITION_FAILED", `Reconnect to ${name}`, {
    field: "remoteInstanceId",
  });

async function requireEnabledRemote(db: PrismaClient, id: string) {
  const remote = await db.remoteInstance.findUnique({
    where: { id },
    select: REMOTE_INSTANCE_SELECT,
  });
  if (!remote) throw new CoreError("NOT_FOUND", "Remote instance not found");
  if (!remote.enabled)
    throw new CoreError(
      "PRECONDITION_FAILED",
      `${remote.name} is disabled by an administrator`,
    );
  return remote;
}

export async function beginRemoteConnection(
  deps: RemoteRuntimeDeps,
  actor: SecurityContext,
  input: { remoteInstanceId: string },
): Promise<{ authorizeUrl: string }> {
  const remote = await requireEnabledRemote(deps.db, input.remoteInstanceId);
  const now = deps.now();
  await deps.db.remoteInstanceAuthorization.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: now } },
        { userId: actor.userId, remoteInstanceId: remote.id },
      ],
    },
  });
  const { verifier, challenge } = generatePkce();
  const state = randomState();
  await deps.db.remoteInstanceAuthorization.create({
    data: {
      state,
      remoteInstanceId: remote.id,
      userId: actor.userId,
      codeVerifier: verifier,
      expiresAt: new Date(now.getTime() + REMOTE_AUTHORIZATION_TTL_MS),
    },
  });
  const url = new URL(remoteEndpoints(remote.baseUrl).authorize);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: remoteClientId(deps.selfBaseUrl),
    redirect_uri: remoteEndpoints(deps.selfBaseUrl).callback,
    scope: REMOTE_SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: remoteEndpoints(remote.baseUrl).resource,
  }).toString();
  return { authorizeUrl: url.toString() };
}

/** Rejects a reply without a usable access token; clamps the lifetime to a sane range. */
function readTokenResponse(body: unknown): TokenResponse {
  const value = (body ?? {}) as Record<string, unknown>;
  if (typeof value.access_token !== "string" || !value.access_token)
    throw new Error("token response without an access token");
  const expiresIn =
    typeof value.expires_in === "number" &&
    Number.isFinite(value.expires_in) &&
    value.expires_in > 0
      ? Math.min(value.expires_in, MAX_EXPIRES_IN_S)
      : DEFAULT_EXPIRES_IN_S;
  return {
    access_token: value.access_token,
    refresh_token:
      typeof value.refresh_token === "string" && value.refresh_token
        ? value.refresh_token
        : undefined,
    expires_in: expiresIn,
    scope: typeof value.scope === "string" ? value.scope : undefined,
  };
}

async function tokenRequest(
  deps: RemoteRuntimeDeps,
  remote: { baseUrl: string },
  form: Record<string, string>,
): Promise<TokenResponse> {
  const endpoints = remoteEndpoints(remote.baseUrl);
  const body = await remoteJson<unknown>(
    fetchForRemote(deps, remote.baseUrl),
    endpoints.token,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        ...form,
        client_id: remoteClientId(deps.selfBaseUrl),
        resource: endpoints.resource,
      }).toString(),
    },
  );
  return readTokenResponse(body);
}

export async function completeRemoteConnection(
  deps: RemoteRuntimeDeps,
  input: { userId: string; state: string; code: string },
): Promise<{ remoteInstanceId: string; remoteName: string }> {
  const now = deps.now();
  const pending = await deps.db.remoteInstanceAuthorization.findUnique({
    where: { state: input.state },
  });
  if (pending?.userId !== input.userId)
    throw new CoreError(
      "BAD_REQUEST",
      "This sign-in attempt is unknown or belongs to another account",
      { field: "state" },
    );
  if (pending.expiresAt < now) {
    await deps.db.remoteInstanceAuthorization.deleteMany({
      where: { state: input.state },
    });
    throw new CoreError(
      "BAD_REQUEST",
      "This sign-in attempt expired; connect again",
      { field: "state" },
    );
  }
  const remote = await requireEnabledRemote(deps.db, pending.remoteInstanceId);
  let token: TokenResponse;
  try {
    token = await tokenRequest(deps, remote, {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: remoteEndpoints(deps.selfBaseUrl).callback,
      code_verifier: pending.codeVerifier,
    });
  } catch (error) {
    throw new CoreError(
      "BAD_REQUEST",
      error instanceof RemoteHttpError
        ? `${remote.name} refused the authorization code`
        : `${remote.name} could not be reached`,
      { field: "code" },
    );
  }
  // Only labels the connection; a failed lookup leaves the names empty.
  const whoami = await remoteJson<{ userId?: unknown; name?: unknown }>(
    fetchForRemote(deps, remote.baseUrl),
    remoteEndpoints(remote.baseUrl).transfer("whoami"),
    {
      headers: { authorization: `Bearer ${token.access_token}` },
    },
  ).catch((): { userId?: unknown; name?: unknown } => ({}));
  const id = randomUUID();
  const expiresAt = new Date(now.getTime() + token.expires_in * 1000);
  const tokens: Tokens = {
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? null,
  };
  await deps.db.$transaction(async (tx) => {
    const existing = await tx.remoteInstanceConnection.findUnique({
      where: {
        remoteInstanceId_userId: {
          remoteInstanceId: remote.id,
          userId: input.userId,
        },
      },
      select: { id: true },
    });
    const connectionId = existing?.id ?? id;
    const data = {
      remoteUserId:
        typeof whoami.userId === "string" ? whoami.userId.slice(0, 64) : null,
      remoteUserName:
        typeof whoami.name === "string" ? whoami.name.slice(0, 200) : null,
      accessTokenExpiresAt: expiresAt,
      scope: (token.scope ?? REMOTE_SCOPES).slice(0, 200),
      ...sealTokens(deps.ring, connectionId, tokens),
    };
    if (existing)
      await tx.remoteInstanceConnection.update({
        where: { id: existing.id },
        data,
      });
    else
      await tx.remoteInstanceConnection.create({
        data: {
          id,
          remoteInstanceId: remote.id,
          userId: input.userId,
          ...data,
        },
      });
    await tx.remoteInstanceAuthorization.delete({
      where: { state: input.state },
    });
  });
  return { remoteInstanceId: remote.id, remoteName: remote.name };
}

/**
 * Refreshes under a row lock and re-reads first: B rotates refresh tokens and
 * treats a second use of the old one as theft, revoking the whole grant.
 */
async function refreshConnectionTokens(
  deps: RemoteRuntimeDeps,
  remote: { name: string; baseUrl: string },
  connectionId: string,
  now: Date,
): Promise<Tokens> {
  return deps.db.$transaction(
    async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "RemoteInstanceConnection" WHERE "id" = ${connectionId}::uuid FOR UPDATE`;
      const row = await tx.remoteInstanceConnection.findUnique({
        where: { id: connectionId },
      });
      if (!row) throw reconnect(remote.name);
      const current = openTokens(deps.ring, row);
      if (
        row.accessTokenExpiresAt.getTime() - now.getTime() >=
        REFRESH_LEEWAY_MS
      )
        return current;
      if (!current.refreshToken) throw reconnect(remote.name);
      let refreshed: TokenResponse;
      try {
        refreshed = await tokenRequest(deps, remote, {
          grant_type: "refresh_token",
          refresh_token: current.refreshToken,
        });
      } catch (error) {
        // Only B refusing the grant asks for a reconnect; an unreachable B does not.
        if (
          error instanceof RemoteHttpError &&
          (error.status === 400 || error.status === 401)
        )
          throw reconnect(remote.name);
        throw error;
      }
      const tokens: Tokens = {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token ?? current.refreshToken,
      };
      await tx.remoteInstanceConnection.update({
        where: { id: row.id },
        data: {
          accessTokenExpiresAt: new Date(
            now.getTime() + refreshed.expires_in * 1000,
          ),
          ...sealTokens(deps.ring, row.id, tokens),
        },
      });
      return tokens;
    },
    // Outlives remoteJson's 15-second request timeout, including a queued refresh.
    { maxWait: 10_000, timeout: 45_000 },
  );
}

type RemoteRef = { id: string; name: string; baseUrl: string };

/** `onError` receives token-refresh and `fn` failures together with the remote they concern. */
export async function withRemoteToken<T>(
  deps: RemoteRuntimeDeps,
  input: { userId: string; remoteInstanceId: string },
  fn: (
    accessToken: string,
    remote: RemoteRef,
    fetchImpl: typeof fetch,
  ) => Promise<T>,
  onError?: (error: unknown, remote: RemoteRef) => never,
): Promise<T> {
  const remote = await requireEnabledRemote(deps.db, input.remoteInstanceId);
  const row = await deps.db.remoteInstanceConnection.findUnique({
    where: {
      remoteInstanceId_userId: {
        remoteInstanceId: remote.id,
        userId: input.userId,
      },
    },
  });
  if (!row) throw reconnect(remote.name);
  const now = deps.now();
  const ref: RemoteRef = {
    id: remote.id,
    name: remote.name,
    baseUrl: remote.baseUrl,
  };
  const call = async () => {
    const tokens =
      row.accessTokenExpiresAt.getTime() - now.getTime() < REFRESH_LEEWAY_MS
        ? await refreshConnectionTokens(deps, remote, row.id, now)
        : openTokens(deps.ring, row);
    return fn(tokens.accessToken, ref, fetchForRemote(deps, remote.baseUrl));
  };
  const result = await (onError
    ? call().catch((error: unknown) => onError(error, ref))
    : call());
  // updateMany: a disconnect while fn ran must not turn its success into an error.
  await deps.db.remoteInstanceConnection.updateMany({
    where: { id: row.id },
    data: { lastUsedAt: now },
  });
  return result;
}

export async function listRemoteInstancesForUser(
  db: PrismaClient,
  actor: SecurityContext,
) {
  const remotes = await db.remoteInstance.findMany({
    where: { enabled: true },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      baseUrl: true,
      connections: {
        where: { userId: actor.userId },
        select: { remoteUserName: true, createdAt: true, lastUsedAt: true },
      },
    },
  });
  return remotes.map(({ connections, ...remote }) => ({
    ...remote,
    connection: connections[0]
      ? {
          remoteUserName: connections[0].remoteUserName,
          connectedAt: connections[0].createdAt,
          lastUsedAt: connections[0].lastUsedAt,
        }
      : null,
  }));
}

export async function disconnectRemoteInstance(
  db: PrismaClient,
  actor: SecurityContext,
  input: { remoteInstanceId: string },
): Promise<void> {
  await db.remoteInstanceConnection.deleteMany({
    where: { remoteInstanceId: input.remoteInstanceId, userId: actor.userId },
  });
  await db.remoteInstanceAuthorization.deleteMany({
    where: { remoteInstanceId: input.remoteInstanceId, userId: actor.userId },
  });
}

export async function assertRemoteConnectionSecretsDecryptable(
  db: PrismaClient,
  ring: EncryptionKeyRing | null,
): Promise<void> {
  const versions = await db.remoteInstanceConnection.findMany({
    distinct: ["tokensKeyVersion"],
    select: { tokensKeyVersion: true },
  });
  const missing = missingKeyVersions(
    ring,
    versions.map((v) => v.tokensKeyVersion),
  );
  if (missing.length)
    throw new Error(
      `WEAVER_ENCRYPTION_KEYS lacks version(s) ${missing.join(", ")} used by remote instance connections`,
    );
}

export async function rotateRemoteConnectionSecrets(
  db: PrismaClient,
  ring: EncryptionKeyRing,
): Promise<{ rotated: number; skipped: number }> {
  let rotated = 0,
    skipped = 0;
  for (const row of await db.remoteInstanceConnection.findMany()) {
    if (row.tokensKeyVersion === ring.activeVersion) {
      skipped += 1;
      continue;
    }
    // Compare-and-swap: a concurrent refresh must not be overwritten with the rotated-out tokens.
    const result = await db.remoteInstanceConnection.updateMany({
      where: {
        id: row.id,
        tokensCiphertext: row.tokensCiphertext,
        tokensKeyVersion: row.tokensKeyVersion,
      },
      data: sealTokens(ring, row.id, openTokens(ring, row)),
    });
    rotated += result.count;
    skipped += 1 - result.count;
  }
  return { rotated, skipped };
}

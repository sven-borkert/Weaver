import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@weaver/db/client";
import { OAUTH_SCOPES } from "@weaver/auth/constants";
import { CoreError } from "../../errors";
import {
  remoteFetchFor,
  remoteJson,
  RemoteHttpError,
} from "../../remotes/http";
import {
  normalizeRemoteBaseUrl,
  remoteClientId,
  remoteEndpoints,
} from "../../remotes/urls";
import {
  assertSystemAdmin,
  type SecurityContext,
} from "../../security/context";
import type { RemoteInstanceView, RemoteRuntimeDeps } from "./types";

type Tx = Prisma.TransactionClient;

export const REMOTE_INSTANCE_SELECT = {
  id: true,
  name: true,
  baseUrl: true,
  enabled: true,
  revision: true,
  createdAt: true,
  updatedAt: true,
  lastCheckedAt: true,
  checkStatus: true,
  checkErrorSummary: true,
} satisfies Prisma.RemoteInstanceSelect;

const nameSchemaError = () =>
  new CoreError("BAD_REQUEST", "Name must be 1–120 characters", {
    field: "name",
  });

function checkName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || [...trimmed].length > 120) throw nameSchemaError();
  return trimmed;
}

export function fetchForRemote(
  deps: RemoteRuntimeDeps,
  baseUrl: string,
): typeof fetch {
  return deps.pinOutbound === false
    ? deps.fetchImpl
    : remoteFetchFor(deps.fetchImpl, baseUrl, deps.allowedOrigins);
}

/** The peer's OAuth client on this instance; deterministic so the peer needs no registration step. */
export async function syncRemoteOauthClient(
  tx: Tx,
  remote: { name: string; baseUrl: string; enabled: boolean },
  mcpResourceUrl: string,
): Promise<void> {
  const clientId = remoteClientId(remote.baseUrl);
  const now = new Date();
  const data = {
    name: `Weaver (${new URL(remote.baseUrl).host})`,
    redirectUris: [remoteEndpoints(remote.baseUrl).callback],
    scopes: [...OAUTH_SCOPES],
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "none",
    applicationType: "web",
    requirePKCE: true,
    disabled: !remote.enabled,
    skipConsent: false,
    dpopBoundAccessTokens: false,
    updatedAt: now,
  };
  await tx.oauthClient.upsert({
    where: { clientId },
    create: { clientId, createdAt: now, ...data },
    update: data,
  });
  await tx.oauthClientResource.upsert({
    where: { clientId_resourceId: { clientId, resourceId: mcpResourceUrl } },
    create: { clientId, resourceId: mcpResourceUrl, createdAt: now },
    update: {},
  });
}

async function removeRemoteOauthClient(tx: Tx, baseUrl: string): Promise<void> {
  const clientId = remoteClientId(baseUrl);
  await tx.oauthClientResource.deleteMany({ where: { clientId } });
  await tx.oauthClient.deleteMany({ where: { clientId } });
}

function conflictFromUnique(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    // The pg driver adapter reports the columns under driverAdapterError, not target.
    const meta = error.meta as
      | {
          target?: unknown;
          driverAdapterError?: {
            cause?: { constraint?: { fields?: unknown } };
          };
        }
      | undefined;
    const fields =
      meta?.target ?? meta?.driverAdapterError?.cause?.constraint?.fields;
    const onBaseUrl = (Array.isArray(fields) ? fields : [fields]).some(
      (field) => typeof field === "string" && field.includes("baseUrl"),
    );
    throw new CoreError(
      "CONFLICT",
      onBaseUrl
        ? "A remote with this base URL exists"
        : "A remote with this name exists",
      { field: onBaseUrl ? "baseUrl" : "name" },
    );
  }
  throw error;
}

export async function listRemoteInstances(
  db: PrismaClient,
  actor: SecurityContext,
): Promise<RemoteInstanceView[]> {
  assertSystemAdmin(actor);
  return db.remoteInstance.findMany({
    select: REMOTE_INSTANCE_SELECT,
    orderBy: { name: "asc" },
  });
}

export async function createRemoteInstance(
  deps: RemoteRuntimeDeps,
  actor: SecurityContext,
  input: { name: string; baseUrl: string; enabled?: boolean },
): Promise<RemoteInstanceView> {
  assertSystemAdmin(actor);
  const name = checkName(input.name);
  const baseUrl = normalizeRemoteBaseUrl(input.baseUrl);
  if (baseUrl === deps.selfBaseUrl)
    throw new CoreError(
      "BAD_REQUEST",
      "This instance cannot be its own remote",
      { field: "baseUrl" },
    );
  const enabled = input.enabled ?? true;
  try {
    return await deps.db.$transaction(async (tx) => {
      const row = await tx.remoteInstance.create({
        data: {
          id: randomUUID(),
          name,
          baseUrl,
          enabled,
          createdById: actor.userId,
        },
        select: REMOTE_INSTANCE_SELECT,
      });
      await syncRemoteOauthClient(tx, row, deps.mcpResourceUrl);
      return row;
    });
  } catch (error) {
    conflictFromUnique(error);
  }
}

async function lockRemote(tx: Tx, id: string, expectedRevision?: number) {
  const [row] = await tx.$queryRaw<
    Array<{
      id: string;
      revision: number;
      baseUrl: string;
      enabled: boolean;
      name: string;
    }>
  >`
    SELECT "id", "revision", "baseUrl", "enabled", "name" FROM "RemoteInstance" WHERE "id" = ${id}::uuid FOR UPDATE`;
  if (!row) throw new CoreError("NOT_FOUND", "Remote instance not found");
  if (expectedRevision !== undefined && row.revision !== expectedRevision)
    throw new CoreError(
      "CONFLICT",
      "The remote was changed by someone else; reload and try again",
    );
  return row;
}

export async function updateRemoteInstance(
  deps: RemoteRuntimeDeps,
  actor: SecurityContext,
  input: {
    id: string;
    expectedRevision: number;
    patch: { name?: string; baseUrl?: string; enabled?: boolean };
  },
): Promise<RemoteInstanceView> {
  assertSystemAdmin(actor);
  const name =
    input.patch.name === undefined ? undefined : checkName(input.patch.name);
  const baseUrl =
    input.patch.baseUrl === undefined
      ? undefined
      : normalizeRemoteBaseUrl(input.patch.baseUrl);
  if (baseUrl === deps.selfBaseUrl)
    throw new CoreError(
      "BAD_REQUEST",
      "This instance cannot be its own remote",
      { field: "baseUrl" },
    );
  try {
    return await deps.db.$transaction(async (tx) => {
      const current = await lockRemote(tx, input.id, input.expectedRevision);
      const next = {
        name: name ?? current.name,
        baseUrl: baseUrl ?? current.baseUrl,
        enabled: input.patch.enabled ?? current.enabled,
      };
      if (next.baseUrl !== current.baseUrl) {
        // A new base URL is a new peer: its client id, connections and tokens no longer apply.
        await removeRemoteOauthClient(tx, current.baseUrl);
        await tx.remoteInstanceConnection.deleteMany({
          where: { remoteInstanceId: input.id },
        });
        await tx.remoteInstanceAuthorization.deleteMany({
          where: { remoteInstanceId: input.id },
        });
      }
      const row = await tx.remoteInstance.update({
        where: { id: input.id },
        data: { ...next, revision: { increment: 1 } },
        select: REMOTE_INSTANCE_SELECT,
      });
      await syncRemoteOauthClient(tx, row, deps.mcpResourceUrl);
      return row;
    });
  } catch (error) {
    conflictFromUnique(error);
  }
}

export async function deleteRemoteInstance(
  deps: RemoteRuntimeDeps,
  actor: SecurityContext,
  input: { id: string; expectedRevision: number },
): Promise<void> {
  assertSystemAdmin(actor);
  await deps.db.$transaction(async (tx) => {
    const current = await lockRemote(tx, input.id, input.expectedRevision);
    await removeRemoteOauthClient(tx, current.baseUrl);
    await tx.remoteInstance.delete({ where: { id: input.id } });
  });
}

type CheckStatus = "ok" | "unreachable" | "not_weaver" | "oauth_unavailable";

export async function testRemoteInstance(
  deps: RemoteRuntimeDeps,
  actor: SecurityContext,
  input: { id: string },
): Promise<{
  status: CheckStatus;
  summary: string;
  remote: RemoteInstanceView;
}> {
  assertSystemAdmin(actor);
  const remote = await deps.db.remoteInstance.findUnique({
    where: { id: input.id },
    select: REMOTE_INSTANCE_SELECT,
  });
  if (!remote) throw new CoreError("NOT_FOUND", "Remote instance not found");
  const endpoints = remoteEndpoints(remote.baseUrl);
  const fetchImpl = fetchForRemote(deps, remote.baseUrl);
  let status: CheckStatus = "ok";
  let summary = "";
  try {
    const health = await remoteJson<{ status?: unknown; version?: unknown }>(
      fetchImpl,
      endpoints.health,
      { headers: { accept: "application/json" } },
    );
    if (health.status !== "ok" || typeof health.version !== "string") {
      status = "not_weaver";
      summary = "The URL answered, but not like a Weaver instance";
    } else {
      try {
        const metadata = await remoteJson<{ authorization_endpoint?: unknown }>(
          fetchImpl,
          endpoints.metadata,
          { headers: { accept: "application/json" } },
        );
        if (metadata.authorization_endpoint !== endpoints.authorize) {
          status = "oauth_unavailable";
          summary =
            "The instance does not announce the expected OAuth authorization endpoint";
        } else summary = `Weaver ${health.version} answered and offers OAuth`;
      } catch (error) {
        status = "oauth_unavailable";
        summary =
          error instanceof RemoteHttpError
            ? `OAuth metadata answered ${error.status}`
            : "OAuth metadata could not be fetched";
      }
    }
  } catch (error) {
    status = error instanceof RemoteHttpError ? "not_weaver" : "unreachable";
    summary =
      error instanceof Error
        ? error.message.slice(0, 300)
        : String(error).slice(0, 300);
  }
  const updated = await deps.db.remoteInstance.update({
    where: { id: input.id },
    data: {
      lastCheckedAt: deps.now(),
      checkStatus: status,
      checkErrorSummary: status === "ok" ? null : summary,
    },
    select: REMOTE_INSTANCE_SELECT,
  });
  return { status, summary, remote: updated };
}

import type { ApiKeyIssuer } from "@weaver/auth";
import { CoreError } from "@weaver/core/errors";
import {
  API_KEY_CAPABILITIES,
  apiKeyPermissionsFromCapabilities,
  capabilitiesFromApiKeyPermissions,
  type ApiKeyCapability,
  type ApiKeyPermissions,
  type Capability,
} from "@weaver/core/security/context";
import type { ApiKey, Prisma, PrismaClient } from "@weaver/db/client";
import { notDeleted, type ProjectActor } from "./projectAccess";

type Db = PrismaClient | Prisma.TransactionClient;

import {
  API_KEY_NAME_MAX_LENGTH,
  API_KEY_MAX_EXPIRY_DAYS,
  API_KEY_MAX_RATE_LIMIT_PER_MINUTE,
} from "@weaver/auth/constants";
export {
  API_KEY_NAME_MAX_LENGTH,
  API_KEY_MAX_EXPIRY_DAYS,
  API_KEY_MAX_RATE_LIMIT_PER_MINUTE,
} from "@weaver/auth/constants";
const MINUTE_MS = 60_000;

export type ApiKeySummary = {
  id: string;
  name: string;
  start: string | null;
  capabilities: Capability[];
  projectIds: string[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  rateLimitPerMinute: number | null;
  enabled: boolean;
};

export type CreateApiKeyInput = {
  name: string;
  capabilities: readonly ApiKeyCapability[];
  projectIds: readonly string[];
  expiresInDays: number | null;
  rateLimitPerMinute: number | null;
};

export type UpdateApiKeyInput = {
  keyId: string;
  name: string;
  capabilities: readonly ApiKeyCapability[];
  projectIds: readonly string[];
  rateLimitPerMinute: number | null;
};

type ApiKeyRow = ApiKey & { projects: Array<{ projectId: string }> };

/** Better Auth's default when no custom limit is set; the summary renders it as 10000/min. */
const DEFAULT_RATE_LIMIT = {
  rateLimitEnabled: true,
  rateLimitMax: API_KEY_MAX_RATE_LIMIT_PER_MINUTE,
  rateLimitTimeWindow: MINUTE_MS,
};

function parsePermissions(value: string | null): ApiKeyPermissions | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as ApiKeyPermissions)
      : null;
  } catch {
    return null;
  }
}

function toSummary(row: ApiKeyRow): ApiKeySummary {
  const perMinute =
    row.rateLimitEnabled &&
    row.rateLimitMax &&
    row.rateLimitTimeWindow === MINUTE_MS
      ? row.rateLimitMax
      : null;
  return {
    id: row.id,
    name: row.name ?? "",
    start: row.start,
    capabilities: [
      ...capabilitiesFromApiKeyPermissions(parsePermissions(row.permissions)),
    ],
    projectIds: row.projects.map((p) => p.projectId).sort(),
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastRequest,
    createdAt: row.createdAt,
    rateLimitPerMinute: perMinute,
    enabled: row.enabled === true,
  };
}

function assertSessionActor(actor: ProjectActor): void {
  // Spec §8: keys act as the user within a narrower scope; a key or token must not mint keys.
  if (actor.authenticationMethod !== "session") {
    throw new CoreError(
      "FORBIDDEN",
      "Only a signed-in session can manage API keys",
    );
  }
}

export async function listApiKeys(
  db: Db,
  actor: ProjectActor,
): Promise<ApiKeySummary[]> {
  assertSessionActor(actor);
  const rows = await db.apiKey.findMany({
    where: { referenceId: actor.userId },
    include: { projects: { select: { projectId: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
  });
  return rows.map(toSummary);
}

/** Shared by create and update: name, capabilities, rate limit, and member-only project restrictions. */
async function validateKeyPolicy(
  db: Db,
  actor: ProjectActor,
  input: {
    name: string;
    capabilities: readonly ApiKeyCapability[];
    projectIds: readonly string[];
    rateLimitPerMinute: number | null;
  },
): Promise<{ name: string; projectIds: string[] }> {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new CoreError("BAD_REQUEST", "Name is required", { field: "name" });
  }
  if (name.length > API_KEY_NAME_MAX_LENGTH) {
    throw new CoreError(
      "BAD_REQUEST",
      `Name must be at most ${API_KEY_NAME_MAX_LENGTH} characters`,
      { field: "name" },
    );
  }
  for (const capability of input.capabilities) {
    if (!(API_KEY_CAPABILITIES as readonly string[]).includes(capability)) {
      throw new CoreError("BAD_REQUEST", "Unknown capability", {
        field: "capabilities",
      });
    }
  }
  if (
    input.capabilities.includes("system:admin") &&
    actor.globalRole !== "Admin"
  ) {
    throw new CoreError(
      "FORBIDDEN",
      "Only global Admins can grant system administration",
      { field: "capabilities" },
    );
  }
  if (
    input.rateLimitPerMinute !== null &&
    (!Number.isInteger(input.rateLimitPerMinute) ||
      input.rateLimitPerMinute < 1 ||
      input.rateLimitPerMinute > API_KEY_MAX_RATE_LIMIT_PER_MINUTE)
  ) {
    throw new CoreError(
      "BAD_REQUEST",
      "Rate limit must be 1–10000 requests per minute",
      {
        field: "rateLimitPerMinute",
      },
    );
  }

  const projectIds = [...new Set(input.projectIds)];
  if (projectIds.length > 0) {
    const memberOf = await db.project.count({
      where: {
        id: { in: projectIds },
        ...notDeleted,
        organization: { members: { some: { userId: actor.userId } } },
      },
    });
    if (memberOf !== projectIds.length) {
      throw new CoreError(
        "BAD_REQUEST",
        "You can only restrict a key to projects you belong to",
        {
          field: "projectIds",
        },
      );
    }
  }
  return { name, projectIds };
}

export async function createApiKey(
  db: PrismaClient,
  actor: ProjectActor,
  input: CreateApiKeyInput,
  issuer: ApiKeyIssuer,
): Promise<{ key: ApiKeySummary; secret: string }> {
  assertSessionActor(actor);
  const { name, projectIds } = await validateKeyPolicy(db, actor, input);
  if (
    input.expiresInDays !== null &&
    (!Number.isInteger(input.expiresInDays) ||
      input.expiresInDays < 1 ||
      input.expiresInDays > API_KEY_MAX_EXPIRY_DAYS)
  ) {
    throw new CoreError("BAD_REQUEST", "Expiry must be 1–365 days", {
      field: "expiresInDays",
    });
  }

  // Better Auth owns the mint transaction, so restrictions cannot be committed atomically with it.
  const issued = await issuer.issue({
    userId: actor.userId,
    name,
    permissions: apiKeyPermissionsFromCapabilities(input.capabilities),
    expiresInSeconds:
      input.expiresInDays === null ? null : input.expiresInDays * 86_400,
    rateLimit:
      input.rateLimitPerMinute === null
        ? null
        : { maxRequests: input.rateLimitPerMinute, windowMs: MINUTE_MS },
  });

  try {
    if (projectIds.length > 0) {
      await db.apiKeyProject.createMany({
        data: projectIds.map((projectId) => ({
          apiKeyId: issued.id,
          projectId,
        })),
      });
    }
  } catch (error) {
    // Never leave an unrestricted key behind when the restriction failed to persist.
    await db.apiKey.delete({ where: { id: issued.id } }).catch(async () => {
      // Delete itself failed: fail closed by disabling the stranded key instead of leaving it usable and unrestricted.
      await db.apiKey
        .update({ where: { id: issued.id }, data: { enabled: false } })
        .catch(() => undefined);
    });
    throw error;
  }

  const row = await db.apiKey.findUniqueOrThrow({
    where: { id: issued.id },
    include: { projects: { select: { projectId: true } } },
  });
  return { key: toSummary(row), secret: issued.key };
}

export async function updateApiKey(
  db: PrismaClient,
  actor: ProjectActor,
  input: UpdateApiKeyInput,
): Promise<ApiKeySummary> {
  assertSessionActor(actor);
  const { name, projectIds } = await validateKeyPolicy(db, actor, input);
  const rateLimit =
    input.rateLimitPerMinute === null
      ? DEFAULT_RATE_LIMIT
      : {
          rateLimitEnabled: true,
          rateLimitMax: input.rateLimitPerMinute,
          rateLimitTimeWindow: MINUTE_MS,
        };
  // Permissions are read from the row on every bearer request, so the change is immediate.
  const row = await db.$transaction(async (tx) => {
    const { count } = await tx.apiKey.updateMany({
      where: { id: input.keyId, referenceId: actor.userId },
      data: {
        name,
        permissions: JSON.stringify(
          apiKeyPermissionsFromCapabilities(input.capabilities),
        ),
        ...rateLimit,
        updatedAt: new Date(),
      },
    });
    if (count === 0) throw new CoreError("NOT_FOUND");
    await tx.apiKeyProject.deleteMany({ where: { apiKeyId: input.keyId } });
    if (projectIds.length > 0) {
      await tx.apiKeyProject.createMany({
        data: projectIds.map((projectId) => ({
          apiKeyId: input.keyId,
          projectId,
        })),
      });
    }
    return tx.apiKey.findUniqueOrThrow({
      where: { id: input.keyId },
      include: { projects: { select: { projectId: true } } },
    });
  });
  return toSummary(row);
}

export async function revokeApiKey(
  db: Db,
  actor: ProjectActor,
  keyId: string,
): Promise<void> {
  assertSessionActor(actor);
  const { count } = await db.apiKey.deleteMany({
    where: { id: keyId, referenceId: actor.userId },
  });
  if (count === 0) throw new CoreError("NOT_FOUND");
}

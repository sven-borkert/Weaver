import { createPinnedFetch } from "@weaver/config/outboundFetch";
import { randomUUID } from "node:crypto";
import type {
  LlmEmbeddingDimensionMode,
  LlmModelCapability,
  LlmProviderType,
  LlmTestOutcome,
  Prisma,
  PrismaClient,
} from "@weaver/db/client";
import { CoreError } from "../errors";
import type { UserSecurityContext } from "../security/context";
import { assertLlmAdmin } from "./llmAdminAccess";
import {
  decryptSecret,
  encryptSecret,
  missingKeyVersions,
  secretAad,
  type EncryptionKeyRing,
} from "../security/encryption";
import type { DiscoveredModel, ProviderAdapter } from "../ai/adapter";
import { MAX_DISCOVERED_MODELS } from "../ai/adapter";
import {
  createProviderAdapter,
  isCredentialOptional,
  isLocalProvider,
  PROVIDER_DEFAULT_ENDPOINTS,
  PROVIDER_FIXED_ENDPOINTS,
} from "../ai/adapters";
import { mapWithConcurrency } from "../ai/concurrency";
import { emptyUsage, PROVIDER_TIMEOUT_MESSAGE } from "../ai/http";
import { MODEL_DISCOVERY_DEADLINE_MESSAGE } from "../ai/ollama";
import { listOpenRouterUpstreamProviders as discoverOpenRouterUpstreamProviders } from "../ai/openrouter";
import { finalizeDiscoveredModels } from "../ai/modelDiscovery";
import { AiProviderError, type AiUsageSample } from "../ai/types";
import { diagnosticFetch } from "../diagnostics/fetch";
import { emitDiagnostic } from "../diagnostics/writer";
import type { RecordAiUsageInput } from "./aiUsage";
import { recordAiUsageSafely } from "./aiUsageBestEffort";
import {
  clampLimit,
  decodeIdPageCursor,
  encodePageCursor,
} from "./adminPaging";
import { invalidateLlmRouteCache } from "./llmRouteCache";
import { withKnowledgeRoutingChange } from "./knowledgeRoutingChange";
import { resolveKnowledgeRouting } from "./llmRoutes";
import {
  KNOWLEDGE_DIMENSIONS_MESSAGE,
  isSupportedKnowledgeDimensions,
} from "../knowledge/dimensions";
import { loadEncryptionKeyRing } from "../security/encryption";

type Db = PrismaClient | Prisma.TransactionClient;
import {
  MAX_LLM_NAME_LENGTH as MAX_NAME,
  MAX_EMBEDDING_DIMENSIONS,
  isValidEmbeddingVector,
} from "../ai/validation";
const MAX_CREDENTIAL = 4096;
const MAX_SUMMARY = 300;
const MAX_CURRENCY = 8;
const MAX_IMPORT_ROWS = MAX_DISCOVERED_MODELS;
const MAX_IMPORT_PROBES = 50;
const PROBE_CONCURRENCY = 4;
const MAX_LIMIT = 2_147_483_647;
export const MIN_REQUEST_TIMEOUT_MS = 1;
export const MAX_REQUEST_TIMEOUT_MS = 120_000;

export type LlmAdminDeps = {
  ring: EncryptionKeyRing | null;
  fetchImpl?: typeof fetch;
};

export type LlmModelSummary = {
  id: string;
  connectionId: string;
  providerModelId: string;
  displayName: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  embeddingDimensions: number | null;
  embeddingDimensionMode: LlmEmbeddingDimensionMode;
  upstreamProvider: string | null;
  capabilities: LlmModelCapability[];
  inputCostMicrosPerMillion: number | null;
  outputCostMicrosPerMillion: number | null;
  currency: string | null;
  vectorSpaceKey: string | null;
  vectorSpaceReferenceModelId: string | null;
  vectorSpaceVerifiedAt: Date | null;
  vectorSpaceMinSimilarity: number | null;
};

export type LlmConnectionSummary = {
  id: string;
  name: string;
  providerType: LlmProviderType;
  endpoint: string;
  requestTimeoutMs: number;
  enabled: boolean;
  credentialKeyVersion: number;
  credentialUpdatedAt: Date;
  lastTestAt: Date | null;
  lastTestOutcome: LlmTestOutcome | null;
  lastTestSummary: string | null;
  createdAt: Date;
  updatedAt: Date;
  models: LlmModelSummary[];
};

export type PagedLlmConnectionSummary = LlmConnectionSummary & {
  modelsTruncated: boolean;
};

export type PagedLlmModelSummary = LlmModelSummary & {
  connectionName: string;
  providerType: LlmProviderType;
};

export type LlmListInput = {
  limit?: number;
  cursor?: string;
};

export type LlmPage<T> = {
  items: T[];
  nextCursor: string | null;
  truncated: boolean;
};

export type LlmTestResult = {
  outcome: LlmTestOutcome;
  durationMs: number;
  summary: string;
  /** Present on a successful connection test; capped at MAX_DISCOVERED_MODELS. */
  models?: DiscoveredModel[];
  /** Provider usage returned by a model probe; null when unavailable. */
  usage?: AiUsageSample | null;
};

export type CreateLlmConnectionInput = {
  name: string;
  providerType: LlmProviderType;
  endpoint?: string | null;
  credential: string;
  requestTimeoutMs?: number;
  enabled?: boolean;
};

export type UpdateLlmConnectionInput = {
  connectionId: string;
  name?: string;
  endpoint?: string | null;
  credential?: string | null;
  requestTimeoutMs?: number;
  enabled?: boolean;
};

export type CreateLlmModelInput = {
  connectionId: string;
  providerModelId: string;
  displayName: string;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  embeddingDimensions?: number | null;
  embeddingDimensionMode?: LlmEmbeddingDimensionMode;
  upstreamProvider?: string | null;
  capabilities: LlmModelCapability[];
  inputCostMicrosPerMillion?: number | null;
  outputCostMicrosPerMillion?: number | null;
  currency?: string | null;
};

export type UpdateLlmModelInput = Partial<
  Omit<CreateLlmModelInput, "connectionId">
> & { modelId: string };

export type ImportLlmModelRow = {
  providerModelId: string;
  displayName: string;
  capabilities: LlmModelCapability[];
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  embeddingDimensions?: number | null;
};

export type ImportLlmModelsInput = {
  connectionId: string;
  /** Refresh limits on models that are already declared instead of skipping them. */
  updateExisting: boolean;
  models: ImportLlmModelRow[];
};

export type ImportLlmModelsResult = {
  created: number;
  updated: number;
  skipped: { providerModelId: string; reason: string }[];
};

export { assertLlmAdmin } from "./llmAdminAccess";

function settingsChanged(
  actor: UserSecurityContext,
  setting: "llm.connection" | "llm.model",
  action: "created" | "updated" | "deleted" | "imported",
  details: Record<string, unknown>,
): void {
  emitDiagnostic({
    event: "settings.changed",
    message: `${setting} ${action}`,
    userId: actor.userId,
    credentialId: actor.credentialId,
    details: { setting, action, ...details },
  });
}

const CONNECTION_UPDATE_FIELDS = [
  "credential",
  "name",
  "endpoint",
  "requestTimeoutMs",
  "enabled",
] as const;
const MODEL_UPDATE_FIELDS = [
  "providerModelId",
  "displayName",
  "contextWindow",
  "maxOutputTokens",
  "embeddingDimensions",
  "embeddingDimensionMode",
  "upstreamProvider",
  "capabilities",
  "inputCostMicrosPerMillion",
  "outputCostMicrosPerMillion",
  "currency",
] as const;

function definedFieldNames<T extends object, K extends keyof T>(
  input: T,
  allowed: readonly K[],
): string[] {
  return allowed.filter((key) => input[key] !== undefined).map(String);
}

export function credentialAad(connectionId: string): string {
  return secretAad("llm-connection", connectionId);
}

const MODEL_SELECT = {
  id: true,
  connectionId: true,
  providerModelId: true,
  displayName: true,
  contextWindow: true,
  maxOutputTokens: true,
  embeddingDimensions: true,
  embeddingDimensionMode: true,
  upstreamProvider: true,
  capabilities: true,
  inputCostMicrosPerMillion: true,
  outputCostMicrosPerMillion: true,
  currency: true,
  vectorSpaceKey: true,
  vectorSpaceReferenceModelId: true,
  vectorSpaceVerifiedAt: true,
  vectorSpaceMinSimilarity: true,
} satisfies Prisma.LlmModelSelect;

/** Cleared whenever a model/connection identity edit could break a verified vector-space match. */
export const CLEARED_VECTOR_SPACE = {
  vectorSpaceKey: null,
  vectorSpaceReferenceModelId: null,
  vectorSpaceVerifiedAt: null,
  vectorSpaceMinSimilarity: null,
} as const;

export const CONNECTION_SUMMARY_SELECT = {
  id: true,
  name: true,
  providerType: true,
  endpoint: true,
  requestTimeoutMs: true,
  enabled: true,
  credentialKeyVersion: true,
  credentialUpdatedAt: true,
  lastTestAt: true,
  lastTestOutcome: true,
  lastTestSummary: true,
  createdAt: true,
  updatedAt: true,
  models: {
    select: MODEL_SELECT,
    orderBy: [{ displayName: "asc" }, { id: "asc" }],
  },
} satisfies Prisma.LlmConnectionSelect;

const CONNECTION_MODEL_PREVIEW_LIMIT = 20;

const PAGED_CONNECTION_SUMMARY_SELECT = {
  ...CONNECTION_SUMMARY_SELECT,
  models: {
    ...CONNECTION_SUMMARY_SELECT.models,
    take: CONNECTION_MODEL_PREVIEW_LIMIT + 1,
  },
} satisfies Prisma.LlmConnectionSelect;

export async function listLlmConnections(
  db: Db,
  actor: UserSecurityContext,
): Promise<LlmConnectionSummary[]> {
  assertLlmAdmin(actor);
  return db.llmConnection.findMany({
    select: CONNECTION_SUMMARY_SELECT,
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
}

export async function listLlmConnectionsPage(
  db: Db,
  actor: UserSecurityContext,
  input: LlmListInput,
): Promise<LlmPage<PagedLlmConnectionSummary>> {
  assertLlmAdmin(actor);
  const limit = clampLimit(input.limit);
  const afterId = input.cursor ? decodeIdPageCursor(input.cursor) : undefined;
  const rows = await db.llmConnection.findMany({
    ...(afterId ? { where: { id: { gt: afterId } } } : {}),
    select: PAGED_CONNECTION_SUMMARY_SELECT,
    orderBy: { id: "asc" },
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const items = pageRows.map((row) => ({
    ...row,
    models: row.models.slice(0, CONNECTION_MODEL_PREVIEW_LIMIT),
    modelsTruncated: row.models.length > CONNECTION_MODEL_PREVIEW_LIMIT,
  }));
  const last = items.at(-1);
  return {
    items,
    nextCursor: hasMore && last ? encodePageCursor([last.id]) : null,
    truncated: hasMore || items.some((item) => item.modelsTruncated),
  };
}

export async function listLlmModelsPage(
  db: Db,
  actor: UserSecurityContext,
  input: LlmListInput & { connectionId?: string },
): Promise<LlmPage<PagedLlmModelSummary>> {
  assertLlmAdmin(actor);
  const limit = clampLimit(input.limit);
  const afterId = input.cursor ? decodeIdPageCursor(input.cursor) : undefined;
  const rows = await db.llmModel.findMany({
    where: {
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      ...(afterId ? { id: { gt: afterId } } : {}),
    },
    select: {
      ...MODEL_SELECT,
      connection: { select: { name: true, providerType: true } },
    },
    orderBy: { id: "asc" },
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(({ connection, ...model }) => ({
    ...model,
    connectionName: connection.name,
    providerType: connection.providerType,
  }));
  const last = items.at(-1);
  return {
    items,
    nextCursor: hasMore && last ? encodePageCursor([last.id]) : null,
    truncated: hasMore,
  };
}

function normalizeName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > MAX_NAME) {
    throw new CoreError(
      "BAD_REQUEST",
      `Name must be 1–${MAX_NAME} characters`,
      { field: "name" },
    );
  }
  return trimmed;
}

function normalizeEndpoint(
  providerType: LlmProviderType,
  endpoint: string | null | undefined,
): string {
  if (
    providerType === "openai" ||
    providerType === "anthropic" ||
    providerType === "openrouter"
  )
    return PROVIDER_FIXED_ENDPOINTS[providerType];
  const trimmed = endpoint?.trim() ?? "";
  const raw =
    trimmed !== ""
      ? trimmed
      : isLocalProvider(providerType)
        ? PROVIDER_DEFAULT_ENDPOINTS[providerType]
        : "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CoreError("BAD_REQUEST", "Endpoint must be an http(s) URL", {
      field: "endpoint",
    });
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    raw.includes("?") ||
    raw.includes("#") ||
    url.search ||
    url.hash
  ) {
    throw new CoreError("BAD_REQUEST", "Endpoint must be a plain http(s) URL", {
      field: "endpoint",
    });
  }
  const normalized = url.toString().replace(/\/+$/, "");
  // Local servers store their root; adapters append /v1 for OpenAI-compatible calls.
  return isLocalProvider(providerType)
    ? normalized.replace(/\/v1$/i, "")
    : normalized;
}

function normalizeCredential(
  providerType: LlmProviderType,
  credential: string | null | undefined,
): string {
  if (credential && /[\u0000-\u001f\u007f-\uffff]/.test(credential)) {
    throw new CoreError(
      "BAD_REQUEST",
      "Credential must contain printable ASCII characters",
      { field: "credential" },
    );
  }
  const trimmed = credential?.trim() ?? "";
  if (trimmed === "" && isCredentialOptional(providerType)) return "";
  if (!trimmed || trimmed.length > MAX_CREDENTIAL) {
    throw new CoreError("BAD_REQUEST", "Credential is required", {
      field: "credential",
    });
  }
  return trimmed;
}

function normalizeTimeout(value: number | undefined): number {
  const timeout = value ?? 30_000;
  if (
    !Number.isInteger(timeout) ||
    timeout < MIN_REQUEST_TIMEOUT_MS ||
    timeout > MAX_REQUEST_TIMEOUT_MS
  ) {
    throw new CoreError(
      "BAD_REQUEST",
      `Timeout must be ${MIN_REQUEST_TIMEOUT_MS}–${MAX_REQUEST_TIMEOUT_MS} ms`,
      { field: "requestTimeoutMs" },
    );
  }
  return timeout;
}

function requireRing(ring: EncryptionKeyRing | null): EncryptionKeyRing {
  if (!ring) {
    throw new CoreError(
      "PRECONDITION_FAILED",
      "Encryption keys are not configured; set WEAVER_ENCRYPTION_KEYS",
    );
  }
  return ring;
}

function encryptedColumns(
  ring: EncryptionKeyRing,
  connectionId: string,
  credential: string,
) {
  const secret = encryptSecret(ring, credential, credentialAad(connectionId));
  return {
    credentialCiphertext: Buffer.from(secret.ciphertext),
    credentialNonce: Buffer.from(secret.nonce),
    credentialTag: Buffer.from(secret.tag),
    credentialKeyVersion: secret.keyVersion,
    credentialUpdatedAt: new Date(),
  };
}

function isUniqueViolation(error: unknown, target: string): boolean {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    (error as { code?: string }).code !== "P2002"
  ) {
    return false;
  }
  const meta = (
    error as {
      meta?: {
        target?: unknown;
        driverAdapterError?: {
          cause?: { constraint?: { fields?: unknown } };
        };
      };
    }
  ).meta;
  const fields =
    meta?.target ?? meta?.driverAdapterError?.cause?.constraint?.fields;
  const matches = (field: unknown) =>
    typeof field === "string" && field.replaceAll('"', "") === target;
  return Array.isArray(fields) ? fields.some(matches) : matches(fields);
}

function isRelationViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ["P2003", "P2014"].includes((error as { code?: string }).code ?? "")
  );
}

export async function createLlmConnection(
  db: PrismaClient,
  actor: UserSecurityContext,
  deps: LlmAdminDeps,
  input: CreateLlmConnectionInput,
): Promise<LlmConnectionSummary> {
  assertLlmAdmin(actor);
  const name = normalizeName(input.name);
  const endpoint = normalizeEndpoint(input.providerType, input.endpoint);
  const credential = normalizeCredential(input.providerType, input.credential);
  const requestTimeoutMs = normalizeTimeout(input.requestTimeoutMs);
  const ring = requireRing(deps.ring);
  const id = randomUUID();
  let result: LlmConnectionSummary;
  try {
    result = await db.llmConnection.create({
      data: {
        id,
        name,
        providerType: input.providerType,
        endpoint,
        requestTimeoutMs,
        enabled: input.enabled ?? true,
        createdById: actor.userId,
        ...encryptedColumns(ring, id, credential),
      },
      select: CONNECTION_SUMMARY_SELECT,
    });
  } catch (error) {
    if (isUniqueViolation(error, "name")) {
      throw new CoreError(
        "CONFLICT",
        "A connection with this name already exists",
        { field: "name" },
      );
    }
    throw error;
  }
  settingsChanged(actor, "llm.connection", "created", {
    id: result.id,
    changed: [
      "name",
      "providerType",
      "endpoint",
      "requestTimeoutMs",
      "enabled",
    ],
  });
  return result;
}

export async function updateLlmConnection(
  db: PrismaClient,
  actor: UserSecurityContext,
  deps: LlmAdminDeps,
  input: UpdateLlmConnectionInput,
): Promise<LlmConnectionSummary & { reindexProjects: number }> {
  assertLlmAdmin(actor);
  const { result, reindexProjects } = await withKnowledgeRoutingChange(
    db,
    actor,
    resolveKnowledgeRouting,
    () => updateLlmConnectionChange(db, actor, deps, input),
  );
  return { ...result, reindexProjects };
}

async function updateLlmConnectionChange(
  db: PrismaClient,
  actor: UserSecurityContext,
  deps: LlmAdminDeps,
  input: UpdateLlmConnectionInput,
): Promise<LlmConnectionSummary> {
  const result = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "LlmConnection" WHERE "id" = ${input.connectionId}::uuid FOR UPDATE`;
    const existing = await tx.llmConnection.findUnique({
      where: { id: input.connectionId },
      select: { id: true, providerType: true, endpoint: true },
    });
    if (!existing) throw new CoreError("NOT_FOUND", "Connection not found");
    const data: Prisma.LlmConnectionUpdateInput = {};
    let destinationChanged = false;
    if (input.name !== undefined) data.name = normalizeName(input.name);
    if (input.endpoint !== undefined) {
      data.endpoint = normalizeEndpoint(existing.providerType, input.endpoint);
      destinationChanged =
        new URL(data.endpoint).origin !== new URL(existing.endpoint).origin;
      if (destinationChanged && input.credential == null) {
        throw new CoreError(
          "BAD_REQUEST",
          "Re-enter the credential when changing the endpoint origin",
          { field: "credential" },
        );
      }
      if (data.endpoint !== existing.endpoint) {
        await tx.llmModel.updateMany({
          where: { connectionId: existing.id },
          data: CLEARED_VECTOR_SPACE,
        });
      }
    }
    if (input.requestTimeoutMs !== undefined)
      data.requestTimeoutMs = normalizeTimeout(input.requestTimeoutMs);
    if (input.enabled !== undefined) data.enabled = input.enabled;
    if (
      input.credential !== undefined &&
      input.credential !== null &&
      (input.credential.trim() !== "" || destinationChanged)
    ) {
      Object.assign(
        data,
        encryptedColumns(
          requireRing(deps.ring),
          existing.id,
          normalizeCredential(existing.providerType, input.credential),
        ),
      );
    }
    try {
      return await tx.llmConnection.update({
        where: { id: existing.id },
        data,
        select: CONNECTION_SUMMARY_SELECT,
      });
    } catch (error) {
      if (isUniqueViolation(error, "name")) {
        throw new CoreError(
          "CONFLICT",
          "A connection with this name already exists",
          { field: "name" },
        );
      }
      throw error;
    }
  });
  invalidateLlmRouteCache();
  settingsChanged(actor, "llm.connection", "updated", {
    id: result.id,
    changed: definedFieldNames(input, CONNECTION_UPDATE_FIELDS),
  });
  return result;
}

export async function deleteLlmConnection(
  db: PrismaClient,
  actor: UserSecurityContext,
  connectionId: string,
): Promise<void> {
  assertLlmAdmin(actor);
  try {
    await db.$transaction(async (tx) => {
      const routed = await tx.llmRoute.count({
        where: { model: { connectionId } },
      });
      if (routed > 0) {
        throw new CoreError(
          "CONFLICT",
          "Clear the routes that use this connection before deleting it",
        );
      }
      const result = await tx.llmConnection.deleteMany({
        where: { id: connectionId },
      });
      if (result.count === 0)
        throw new CoreError("NOT_FOUND", "Connection not found");
    });
  } catch (error) {
    if (isRelationViolation(error)) {
      throw new CoreError(
        "CONFLICT",
        "Clear the routes that use this connection before deleting it",
      );
    }
    throw error;
  }
  settingsChanged(actor, "llm.connection", "deleted", { id: connectionId });
}

export async function decryptConnectionCredential(
  db: Db,
  ring: EncryptionKeyRing | null,
  connectionId: string,
  expected?: {
    endpoint: string;
    providerType: LlmProviderType;
    enabled: boolean;
  },
): Promise<string> {
  const row = await db.llmConnection.findUnique({
    where: { id: connectionId },
    select: {
      endpoint: true,
      providerType: true,
      enabled: true,
      credentialCiphertext: true,
      credentialNonce: true,
      credentialTag: true,
      credentialKeyVersion: true,
    },
  });
  if (!row) throw new CoreError("NOT_FOUND", "Connection not found");
  if (
    expected &&
    (row.endpoint !== expected.endpoint ||
      row.providerType !== expected.providerType ||
      row.enabled !== expected.enabled)
  ) {
    throw new CoreError(
      "PRECONDITION_FAILED",
      "Provider connection changed; resolve routing again",
      { reason: "PROVIDER_CONNECTION_CHANGED" },
    );
  }
  return decryptSecret(
    requireRing(ring),
    {
      ciphertext: row.credentialCiphertext,
      nonce: row.credentialNonce,
      tag: row.credentialTag,
      keyVersion: row.credentialKeyVersion,
    },
    credentialAad(connectionId),
  );
}

export async function assertConnectionSecretsDecryptable(
  db: PrismaClient,
  ring: EncryptionKeyRing | null,
): Promise<void> {
  const rows = await db.llmConnection.findMany({
    distinct: ["credentialKeyVersion"],
    select: {
      id: true,
      credentialCiphertext: true,
      credentialNonce: true,
      credentialTag: true,
      credentialKeyVersion: true,
    },
  });
  const versions = rows.map((row) => row.credentialKeyVersion);
  if (versions.length === 0) return;
  const missing = missingKeyVersions(ring, versions);
  if (missing.length > 0) {
    throw new Error(
      `LLM connections are encrypted with key version(s) ${missing.join(", ")} that are not present in WEAVER_ENCRYPTION_KEYS. ` +
        "Restore the key(s) (the ring may list several versions) or run `pnpm secrets:rotate` with both old and new keys configured.",
    );
  }
  for (const row of rows) {
    try {
      decryptSecret(
        ring!,
        {
          ciphertext: row.credentialCiphertext,
          nonce: row.credentialNonce,
          tag: row.credentialTag,
          keyVersion: row.credentialKeyVersion,
        },
        credentialAad(row.id),
      );
    } catch (cause) {
      throw new Error(
        `LLM connection credentials using key version ${row.credentialKeyVersion} cannot be decrypted. Restore the correct key material before starting Weaver.`,
        { cause },
      );
    }
  }
}

export async function rotateConnectionSecrets(
  db: PrismaClient,
  ring: EncryptionKeyRing,
): Promise<{ rotated: number; skipped: number }> {
  const rows = await db.llmConnection.findMany({
    select: { id: true, credentialKeyVersion: true },
  });
  let rotated = 0;
  let skipped = 0;
  for (const row of rows) {
    if (row.credentialKeyVersion === ring.activeVersion) {
      skipped += 1;
      continue;
    }
    await db.$transaction(async (tx) => {
      const plaintext = await decryptConnectionCredential(tx, ring, row.id);
      const result = await tx.llmConnection.updateMany({
        where: { id: row.id, credentialKeyVersion: row.credentialKeyVersion },
        data: encryptedColumns(ring, row.id, plaintext),
      });
      if (result.count === 1) rotated += 1;
      else skipped += 1;
    });
  }
  return { rotated, skipped };
}

export function adapterForConnection(
  connection: {
    id: string;
    providerType: LlmProviderType;
    endpoint: string;
    requestTimeoutMs: number;
    enabled: boolean;
  },
  db: Db,
  ring: EncryptionKeyRing | null,
  fetchImpl: typeof fetch = createPinnedFetch(),
  upstreamProvider: string | null = null,
): ProviderAdapter {
  return createProviderAdapter(
    connection.providerType,
    {
      baseUrl: connection.endpoint,
      requestTimeoutMs: connection.requestTimeoutMs,
      upstreamProvider,
      resolveCredential: () =>
        decryptConnectionCredential(db, ring, connection.id, connection),
    },
    diagnosticFetch(fetchImpl, {
      connectionId: connection.id,
      providerType: connection.providerType,
      requestTimeoutMs: connection.requestTimeoutMs,
    }),
  );
}

export async function listOpenRouterUpstreamProviders(
  db: Db,
  actor: UserSecurityContext,
  deps: LlmAdminDeps,
  input: { connectionId: string; providerModelId: string },
): Promise<{ label: string; slug: string }[]> {
  assertLlmAdmin(actor);
  const connection = await db.llmConnection.findUnique({
    where: { id: input.connectionId },
    select: {
      id: true,
      providerType: true,
      endpoint: true,
      requestTimeoutMs: true,
      enabled: true,
    },
  });
  if (!connection) throw new CoreError("NOT_FOUND", "Connection not found");
  if (connection.providerType !== "openrouter") {
    throw new CoreError("BAD_REQUEST", "Select an OpenRouter connection", {
      field: "connectionId",
    });
  }
  return discoverOpenRouterUpstreamProviders(
    {
      baseUrl: connection.endpoint,
      requestTimeoutMs: connection.requestTimeoutMs,
      resolveCredential: () =>
        decryptConnectionCredential(db, deps.ring, connection.id, connection),
    },
    input.providerModelId,
    diagnosticFetch(deps.fetchImpl ?? createPinnedFetch(), {
      connectionId: connection.id,
      providerType: connection.providerType,
      requestTimeoutMs: connection.requestTimeoutMs,
    }),
  );
}

export function summarize(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "Unknown provider error";
  return message.slice(0, MAX_SUMMARY);
}

function testFailureReason(error: unknown) {
  if (error instanceof CoreError) return "configuration";
  if (error instanceof AiProviderError) {
    if (
      error.message === PROVIDER_TIMEOUT_MESSAGE ||
      error.message === MODEL_DISCOVERY_DEADLINE_MESSAGE
    )
      return "timeout";
    if (error.kind === "validation") return "validation";
  }
  return "provider";
}

async function recordTest(
  db: Db,
  connectionId: string,
  outcome: LlmTestOutcome,
  summary: string,
): Promise<void> {
  await db.llmConnection.update({
    where: { id: connectionId },
    data: {
      lastTestAt: new Date(),
      lastTestOutcome: outcome,
      lastTestSummary: summary.slice(0, MAX_SUMMARY),
    },
  });
}

export async function testLlmConnection(
  db: PrismaClient,
  actor: UserSecurityContext,
  deps: LlmAdminDeps,
  connectionId: string,
): Promise<LlmTestResult> {
  assertLlmAdmin(actor);
  const connection = await db.llmConnection.findUnique({
    where: { id: connectionId },
    select: {
      id: true,
      providerType: true,
      endpoint: true,
      requestTimeoutMs: true,
      enabled: true,
    },
  });
  if (!connection) throw new CoreError("NOT_FOUND", "Connection not found");
  const adapter = adapterForConnection(
    connection,
    db,
    deps.ring,
    deps.fetchImpl,
  );
  const startedAt = Date.now();
  try {
    const listing = await adapter.listModels();
    // The summary counts everything the provider listed; the payload is capped.
    const summary = `Listed ${listing.models.length} model(s)`;
    await recordTest(db, connection.id, "success", summary);
    emitDiagnostic({
      event: "llm.connection.tested",
      outcome: "ok",
      message: "LLM connection discovery succeeded",
      connectionId: connection.id,
      userId: actor.userId,
      credentialId: actor.credentialId,
      durationMs: Date.now() - startedAt,
      details: { modelCount: listing.models.length },
    });
    return {
      outcome: "success",
      durationMs: listing.durationMs,
      summary,
      models: finalizeDiscoveredModels(
        connection.providerType,
        listing.models,
      ).slice(0, MAX_DISCOVERED_MODELS),
    };
  } catch (error) {
    if (!(error instanceof AiProviderError) && !(error instanceof CoreError))
      throw error;
    const summary = summarize(error);
    await recordTest(db, connection.id, "failure", summary);
    const reason = testFailureReason(error);
    emitDiagnostic({
      event: "llm.connection.tested",
      severity: "warn",
      outcome: reason === "timeout" ? "timeout" : "error",
      message: "LLM connection discovery failed",
      connectionId: connection.id,
      userId: actor.userId,
      credentialId: actor.credentialId,
      durationMs: Date.now() - startedAt,
      details: { reason },
    });
    return { outcome: "failure", durationMs: Date.now() - startedAt, summary };
  }
}

function normalizeModel(input: Omit<CreateLlmModelInput, "connectionId">) {
  const providerModelId = input.providerModelId.trim();
  if (!providerModelId || providerModelId.length > 200) {
    throw new CoreError("BAD_REQUEST", "Provider model id is required", {
      field: "providerModelId",
    });
  }
  const displayName = input.displayName.trim();
  if (!displayName || displayName.length > MAX_NAME) {
    throw new CoreError(
      "BAD_REQUEST",
      `Display name must be 1–${MAX_NAME} characters`,
      { field: "displayName" },
    );
  }
  const capabilities = [...new Set(input.capabilities)];
  if (capabilities.length === 0) {
    throw new CoreError("BAD_REQUEST", "Select at least one capability", {
      field: "capabilities",
    });
  }
  const embeddingDimensions = input.embeddingDimensions ?? null;
  const embeddingDimensionMode = capabilities.includes("embedding")
    ? (input.embeddingDimensionMode ?? "native")
    : "native";
  if (
    capabilities.includes("embedding") &&
    (embeddingDimensions === null ||
      !Number.isInteger(embeddingDimensions) ||
      embeddingDimensions < 1 ||
      embeddingDimensions > MAX_EMBEDDING_DIMENSIONS)
  ) {
    throw new CoreError(
      "BAD_REQUEST",
      "Embedding models must declare their dimensions",
      { field: "embeddingDimensions" },
    );
  }
  for (const [field, value] of [
    ["contextWindow", input.contextWindow],
    ["maxOutputTokens", input.maxOutputTokens],
  ] as const) {
    if (
      value !== undefined &&
      value !== null &&
      (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT)
    ) {
      throw new CoreError("BAD_REQUEST", "Must be a positive integer", {
        field,
      });
    }
  }
  for (const [field, value] of [
    ["inputCostMicrosPerMillion", input.inputCostMicrosPerMillion],
    ["outputCostMicrosPerMillion", input.outputCostMicrosPerMillion],
  ] as const) {
    if (
      value !== undefined &&
      value !== null &&
      (!Number.isInteger(value) || value < 0 || value > MAX_LIMIT)
    ) {
      throw new CoreError("BAD_REQUEST", "Must be a non-negative integer", {
        field,
      });
    }
  }
  const currency = input.currency?.trim();
  if (currency !== undefined && currency.length > MAX_CURRENCY) {
    throw new CoreError(
      "BAD_REQUEST",
      `Currency must be at most ${MAX_CURRENCY} characters`,
      { field: "currency" },
    );
  }
  const upstreamProvider = input.upstreamProvider?.trim() ?? null;
  if (
    upstreamProvider !== null &&
    (upstreamProvider.length === 0 ||
      upstreamProvider.length > 200 ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(upstreamProvider))
  ) {
    throw new CoreError("BAD_REQUEST", "Invalid upstream provider", {
      field: "upstreamProvider",
    });
  }
  return {
    providerModelId,
    displayName,
    capabilities,
    contextWindow: input.contextWindow ?? null,
    maxOutputTokens: input.maxOutputTokens ?? null,
    embeddingDimensions: capabilities.includes("embedding")
      ? embeddingDimensions
      : null,
    embeddingDimensionMode,
    upstreamProvider,
    inputCostMicrosPerMillion: input.inputCostMicrosPerMillion ?? null,
    outputCostMicrosPerMillion: input.outputCostMicrosPerMillion ?? null,
    currency: currency === undefined || currency === "" ? null : currency,
  };
}

export async function createLlmModel(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: CreateLlmModelInput,
): Promise<LlmModelSummary> {
  assertLlmAdmin(actor);
  const data = normalizeModel(input);
  const connection = await db.llmConnection.findUnique({
    where: { id: input.connectionId },
    select: { id: true, providerType: true, endpoint: true },
  });
  if (!connection) throw new CoreError("NOT_FOUND", "Connection not found");
  if (connection.providerType !== "openrouter" && data.upstreamProvider) {
    throw new CoreError(
      "BAD_REQUEST",
      "Upstream provider is only available for OpenRouter",
      { field: "upstreamProvider" },
    );
  }
  if (
    connection.providerType === "anthropic" &&
    data.capabilities.includes("embedding")
  ) {
    throw new CoreError(
      "BAD_REQUEST",
      "Anthropic connections do not provide embeddings",
      { field: "capabilities" },
    );
  }
  let result: LlmModelSummary;
  try {
    result = await db.llmModel.create({
      data: { ...data, connectionId: connection.id },
      select: MODEL_SELECT,
    });
  } catch (error) {
    if (isUniqueViolation(error, "providerModelId")) {
      throw new CoreError(
        "CONFLICT",
        "This model is already declared on the connection",
        { field: "providerModelId" },
      );
    }
    throw error;
  }
  settingsChanged(actor, "llm.model", "created", {
    id: result.id,
    changed: [
      "connectionId",
      "providerModelId",
      "displayName",
      "contextWindow",
      "maxOutputTokens",
      "embeddingDimensions",
      "embeddingDimensionMode",
      "upstreamProvider",
      "capabilities",
      "inputCostMicrosPerMillion",
      "outputCostMicrosPerMillion",
      "currency",
    ],
  });
  return result;
}

type ProbedEmbeddingIdentity = {
  connectionId: string;
  providerType: LlmProviderType;
  endpoint: string;
  providerModelId: string;
  embeddingDimensions: number | null;
  embeddingDimensionMode: LlmEmbeddingDimensionMode;
  upstreamProvider: string | null;
};

export async function updateLlmModel(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: UpdateLlmModelInput,
  deps?: LlmAdminDeps,
): Promise<LlmModelSummary & { reindexProjects: number }> {
  assertLlmAdmin(actor);
  const probed = await probeRoutedEmbeddingEdit(db, deps, input);
  const { result, reindexProjects } = await withKnowledgeRoutingChange(
    db,
    actor,
    resolveKnowledgeRouting,
    () => updateLlmModelChange(db, actor, input, probed),
  );
  return { ...result, reindexProjects };
}

async function probeRoutedEmbeddingEdit(
  db: PrismaClient,
  deps: LlmAdminDeps | undefined,
  input: UpdateLlmModelInput,
): Promise<ProbedEmbeddingIdentity | null> {
  const routing = await resolveKnowledgeRouting(db);
  if (routing?.embedding.modelId !== input.modelId) return null;
  const existing = await db.llmModel.findUnique({
    where: { id: input.modelId },
    select: {
      ...MODEL_SELECT,
      connection: {
        select: {
          id: true,
          providerType: true,
          endpoint: true,
          requestTimeoutMs: true,
          enabled: true,
        },
      },
    },
  });
  if (!existing) return null;
  if (!(input.capabilities ?? existing.capabilities).includes("embedding"))
    return null;
  const candidate = {
    providerModelId: input.providerModelId ?? existing.providerModelId,
    embeddingDimensions:
      input.embeddingDimensions === undefined
        ? existing.embeddingDimensions
        : input.embeddingDimensions,
    embeddingDimensionMode:
      input.embeddingDimensionMode ?? existing.embeddingDimensionMode,
    upstreamProvider:
      input.upstreamProvider === undefined
        ? existing.upstreamProvider
        : input.upstreamProvider,
  };
  if (
    candidate.providerModelId === existing.providerModelId &&
    candidate.embeddingDimensions === existing.embeddingDimensions &&
    candidate.embeddingDimensionMode === existing.embeddingDimensionMode &&
    candidate.upstreamProvider === existing.upstreamProvider
  )
    return null;
  await probeKnowledgeEmbedding(
    db,
    deps,
    {
      connection: existing.connection,
      ...candidate,
      inputCostMicrosPerMillion: existing.inputCostMicrosPerMillion,
      outputCostMicrosPerMillion: existing.outputCostMicrosPerMillion,
      currency: existing.currency,
    },
    "embeddingDimensions",
  );
  return {
    connectionId: existing.connection.id,
    providerType: existing.connection.providerType,
    endpoint: existing.connection.endpoint,
    providerModelId: existing.providerModelId,
    embeddingDimensions: existing.embeddingDimensions,
    embeddingDimensionMode: existing.embeddingDimensionMode,
    upstreamProvider: existing.upstreamProvider,
  };
}

async function updateLlmModelChange(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: UpdateLlmModelInput,
  probed: ProbedEmbeddingIdentity | null,
): Promise<LlmModelSummary> {
  const result = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "LlmModel" WHERE "id" = ${input.modelId}::uuid FOR UPDATE`;
    const existing = await tx.llmModel.findUnique({
      where: { id: input.modelId },
      select: {
        ...MODEL_SELECT,
        connection: {
          select: { id: true, providerType: true, endpoint: true },
        },
      },
    });
    if (!existing) throw new CoreError("NOT_FOUND", "Model not found");
    if (probed) {
      const [connection] = await tx.$queryRaw<
        Array<{ providerType: string; endpoint: string }>
      >`SELECT "providerType"::text AS "providerType", "endpoint" FROM "LlmConnection" WHERE "id" = ${existing.connection.id}::uuid FOR SHARE`;
      if (
        existing.connection.id !== probed.connectionId ||
        connection?.providerType !== probed.providerType ||
        connection.endpoint !== probed.endpoint ||
        existing.providerModelId !== probed.providerModelId ||
        existing.embeddingDimensions !== probed.embeddingDimensions ||
        existing.embeddingDimensionMode !== probed.embeddingDimensionMode ||
        existing.upstreamProvider !== probed.upstreamProvider
      ) {
        throw new CoreError(
          "CONFLICT",
          "The model changed while its embeddings were being checked",
          { field: "embeddingDimensions" },
        );
      }
    }
    const merged = normalizeModel({
      providerModelId: input.providerModelId ?? existing.providerModelId,
      displayName: input.displayName ?? existing.displayName,
      capabilities: input.capabilities ?? existing.capabilities,
      contextWindow:
        input.contextWindow === undefined
          ? existing.contextWindow
          : input.contextWindow,
      maxOutputTokens:
        input.maxOutputTokens === undefined
          ? existing.maxOutputTokens
          : input.maxOutputTokens,
      embeddingDimensions:
        input.embeddingDimensions === undefined
          ? existing.embeddingDimensions
          : input.embeddingDimensions,
      embeddingDimensionMode:
        input.embeddingDimensionMode ?? existing.embeddingDimensionMode,
      upstreamProvider:
        input.upstreamProvider === undefined
          ? existing.upstreamProvider
          : input.upstreamProvider,
      inputCostMicrosPerMillion:
        input.inputCostMicrosPerMillion === undefined
          ? existing.inputCostMicrosPerMillion
          : input.inputCostMicrosPerMillion,
      outputCostMicrosPerMillion:
        input.outputCostMicrosPerMillion === undefined
          ? existing.outputCostMicrosPerMillion
          : input.outputCostMicrosPerMillion,
      currency:
        input.currency === undefined ? existing.currency : input.currency,
    });
    if (
      existing.connection.providerType === "anthropic" &&
      merged.capabilities.includes("embedding")
    ) {
      throw new CoreError(
        "BAD_REQUEST",
        "Anthropic connections do not provide embeddings",
        { field: "capabilities" },
      );
    }
    if (
      existing.connection.providerType !== "openrouter" &&
      merged.upstreamProvider
    ) {
      throw new CoreError(
        "BAD_REQUEST",
        "Upstream provider is only available for OpenRouter",
        { field: "upstreamProvider" },
      );
    }
    // A routed model must keep the capabilities its purpose needs (checked again in llmRoutes health).
    const identityChanged =
      merged.providerModelId !== existing.providerModelId ||
      merged.embeddingDimensions !== existing.embeddingDimensions ||
      merged.embeddingDimensionMode !== existing.embeddingDimensionMode ||
      merged.upstreamProvider !== existing.upstreamProvider;
    try {
      return await tx.llmModel.update({
        where: { id: existing.id },
        data: identityChanged ? { ...merged, ...CLEARED_VECTOR_SPACE } : merged,
        select: MODEL_SELECT,
      });
    } catch (error) {
      if (isUniqueViolation(error, "providerModelId")) {
        throw new CoreError(
          "CONFLICT",
          "This model is already declared on the connection",
          { field: "providerModelId" },
        );
      }
      throw error;
    }
  });
  invalidateLlmRouteCache();
  settingsChanged(actor, "llm.model", "updated", {
    id: result.id,
    changed: definedFieldNames(input, MODEL_UPDATE_FIELDS),
  });
  return result;
}

function isLimit(value: number | null | undefined): value is number {
  return (
    value !== null &&
    value !== undefined &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_LIMIT
  );
}

/** Bulk-declare discovered models; every per-row problem becomes a skipped entry. */
export async function importLlmModels(
  db: PrismaClient,
  actor: UserSecurityContext,
  deps: LlmAdminDeps,
  input: ImportLlmModelsInput,
): Promise<ImportLlmModelsResult> {
  assertLlmAdmin(actor);
  if (input.models.length > MAX_IMPORT_ROWS) {
    throw new CoreError(
      "BAD_REQUEST",
      `Import at most ${MAX_IMPORT_ROWS} models per request`,
      { field: "models" },
    );
  }
  const connection = await db.llmConnection.findUnique({
    where: { id: input.connectionId },
    select: {
      id: true,
      providerType: true,
      endpoint: true,
      requestTimeoutMs: true,
      enabled: true,
    },
  });
  if (!connection) throw new CoreError("NOT_FOUND", "Connection not found");

  const skipped: ImportLlmModelsResult["skipped"] = [];
  const skip = (providerModelId: string, reason: string) =>
    skipped.push({ providerModelId, reason });

  const seen = new Set<string>();
  const candidates: ImportLlmModelRow[] = [];
  for (const row of input.models) {
    const providerModelId = row.providerModelId.trim();
    if (seen.has(providerModelId)) {
      skip(providerModelId, "Duplicate row");
      continue;
    }
    seen.add(providerModelId);
    if (
      connection.providerType === "anthropic" &&
      row.capabilities.includes("embedding")
    ) {
      skip(providerModelId, "Anthropic connections do not provide embeddings");
      continue;
    }
    candidates.push({ ...row, providerModelId });
  }

  const existingRows = await db.llmModel.findMany({
    where: {
      connectionId: connection.id,
      providerModelId: { in: candidates.map((row) => row.providerModelId) },
    },
    select: {
      id: true,
      providerModelId: true,
      capabilities: true,
      embeddingDimensions: true,
    },
  });
  const existingById = new Map(
    existingRows.map((row) => [row.providerModelId, row]),
  );
  const creates: ImportLlmModelRow[] = [];
  const updates: {
    existing: (typeof existingRows)[number];
    row: ImportLlmModelRow;
  }[] = [];
  for (const row of candidates) {
    const existing = existingById.get(row.providerModelId);
    if (!existing) creates.push(row);
    else if (input.updateExisting) updates.push({ existing, row });
    else skip(row.providerModelId, "Already declared on this connection");
  }

  // Probe dimensions before the transaction: network calls never hold a pg connection.
  const needsProbe = creates.filter(
    (row) =>
      row.capabilities.includes("embedding") &&
      (row.embeddingDimensions ?? null) === null,
  );
  for (const row of needsProbe.slice(MAX_IMPORT_PROBES)) {
    skip(
      row.providerModelId,
      "Too many embedding models without dimensions; import in smaller batches",
    );
  }
  const probed = new Map<string, number>();
  const probeFailed = new Set<string>();
  const probeRows = needsProbe.slice(0, MAX_IMPORT_PROBES);
  if (probeRows.length > 0) {
    const adapter = adapterForConnection(
      connection,
      db,
      deps.ring,
      deps.fetchImpl,
    );
    const signal = AbortSignal.timeout(60_000);
    const deadlineMessage =
      "Model import probe deadline exceeded; import fewer models";
    await mapWithConcurrency(probeRows, PROBE_CONCURRENCY, async (row) => {
      if (signal.aborted) {
        probeFailed.add(row.providerModelId);
        skip(row.providerModelId, deadlineMessage);
        return;
      }
      const startedAt = Date.now();
      let usage: AiUsageSample | null = null;
      let failure: string | null = null;
      let reason = "provider";
      let outcome: RecordAiUsageInput["outcome"] = "provider_failure";
      try {
        const result = await adapter.probeEmbeddingDimensions(
          row.providerModelId,
          { signal },
        );
        usage = result.usage;
        probed.set(row.providerModelId, result.dimensions);
        outcome = "success";
      } catch (error) {
        if (signal.aborted) {
          failure = deadlineMessage;
          reason = "deadline";
        } else if (
          !(error instanceof AiProviderError) &&
          !(error instanceof CoreError)
        ) {
          throw error;
        } else {
          failure = summarize(error);
          reason = testFailureReason(error);
        }
        usage = error instanceof AiProviderError ? error.usage : null;
        if (error instanceof AiProviderError && error.kind === "validation")
          outcome = "validation_failure";
      } finally {
        await recordAiUsageSafely(db, {
          projectId: null,
          operation: "llm_model_import_probe",
          connectionId: connection.id,
          provider: connection.providerType,
          model: row.providerModelId,
          configFingerprint: "llm-model-import-probe",
          usage: usage ?? emptyUsage(Date.now() - startedAt),
          outcome,
          pricing: {
            inputCostMicrosPerMillion: null,
            outputCostMicrosPerMillion: null,
          },
          currency: null,
        });
        if (outcome !== "success") {
          emitDiagnostic({
            event: "llm.model.import_probe_failed",
            severity: "warn",
            outcome:
              reason === "deadline" || reason === "timeout"
                ? "timeout"
                : "error",
            message: "LLM model import probe failed",
            connectionId: connection.id,
            userId: actor.userId,
            credentialId: actor.credentialId,
            durationMs: Date.now() - startedAt,
            details: { reason },
          });
        }
      }
      if (failure !== null) {
        probeFailed.add(row.providerModelId);
        skip(
          row.providerModelId,
          `Could not detect embedding dimensions: ${failure}`,
        );
      }
    });
  }

  const overCap = new Set(
    needsProbe.slice(MAX_IMPORT_PROBES).map((row) => row.providerModelId),
  );
  const createData: Prisma.LlmModelCreateManyInput[] = [];
  for (const row of creates) {
    if (
      probeFailed.has(row.providerModelId) ||
      overCap.has(row.providerModelId)
    )
      continue;
    try {
      const data = normalizeModel({
        ...row,
        embeddingDimensions:
          row.embeddingDimensions ?? probed.get(row.providerModelId) ?? null,
      });
      createData.push({ ...data, connectionId: connection.id });
    } catch (error) {
      if (!(error instanceof CoreError)) throw error;
      skip(row.providerModelId, error.message);
    }
  }
  const updateData: {
    id: string;
    data: Prisma.LlmModelUpdateManyMutationInput;
  }[] = [];
  for (const { existing, row } of updates) {
    // Only limits are refreshed; names, capabilities, and prices stay admin-owned.
    const data: Prisma.LlmModelUpdateManyMutationInput = {};
    if (isLimit(row.contextWindow) && row.contextWindow > 0)
      data.contextWindow = row.contextWindow;
    if (isLimit(row.maxOutputTokens) && row.maxOutputTokens > 0)
      data.maxOutputTokens = row.maxOutputTokens;
    if (
      existing.embeddingDimensions === null &&
      existing.capabilities.includes("embedding") &&
      isLimit(row.embeddingDimensions) &&
      row.embeddingDimensions >= 1 &&
      row.embeddingDimensions <= MAX_EMBEDDING_DIMENSIONS
    ) {
      data.embeddingDimensions = row.embeddingDimensions;
    }
    if (Object.keys(data).length === 0) {
      skip(row.providerModelId, "No limits to update");
      continue;
    }
    updateData.push({ id: existing.id, data });
  }

  const counts = await db.$transaction(async (tx) => {
    // createMany + skipDuplicates: a per-row create failure would abort the pg transaction.
    const created =
      createData.length === 0
        ? 0
        : (
            await tx.llmModel.createMany({
              data: createData,
              skipDuplicates: true,
            })
          ).count;
    let updated = 0;
    for (const { id, data } of updateData) {
      updated += (
        await tx.llmModel.updateMany({
          where: { id, connectionId: connection.id },
          data,
        })
      ).count;
    }
    return { created, updated };
  });
  invalidateLlmRouteCache();
  const result = { ...counts, skipped };
  settingsChanged(actor, "llm.model", "imported", {
    connectionId: connection.id,
    created: result.created,
    updated: result.updated,
    skipped: result.skipped.length,
  });
  return result;
}

export async function deleteLlmModel(
  db: PrismaClient,
  actor: UserSecurityContext,
  modelId: string,
): Promise<void> {
  assertLlmAdmin(actor);
  try {
    await db.$transaction(async (tx) => {
      if ((await tx.llmRoute.count({ where: { modelId } })) > 0) {
        throw new CoreError(
          "CONFLICT",
          "Clear the routes that use this model before deleting it",
        );
      }
      const result = await tx.llmModel.deleteMany({ where: { id: modelId } });
      if (result.count === 0)
        throw new CoreError("NOT_FOUND", "Model not found");
    });
  } catch (error) {
    if (isRelationViolation(error)) {
      throw new CoreError(
        "CONFLICT",
        "Clear the routes that use this model before deleting it",
      );
    }
    throw error;
  }
  settingsChanged(actor, "llm.model", "deleted", { id: modelId });
}

export async function testLlmModel(
  db: PrismaClient,
  actor: UserSecurityContext,
  deps: LlmAdminDeps,
  modelId: string,
): Promise<LlmTestResult> {
  assertLlmAdmin(actor);
  const model = await db.llmModel.findUnique({
    where: { id: modelId },
    select: {
      ...MODEL_SELECT,
      connection: {
        select: {
          id: true,
          providerType: true,
          endpoint: true,
          requestTimeoutMs: true,
          enabled: true,
        },
      },
    },
  });
  if (!model) throw new CoreError("NOT_FOUND", "Model not found");
  const adapter = adapterForConnection(
    model.connection,
    db,
    deps.ring,
    deps.fetchImpl,
    model.upstreamProvider,
  );
  const startedAt = Date.now();
  let usage: AiUsageSample | null = null;
  let outcome: LlmTestOutcome = "success";
  let summary = "";
  let failureReason: ReturnType<typeof testFailureReason> | null = null;
  try {
    if (model.capabilities.includes("embedding")) {
      const result = await adapter.embed(
        model.providerModelId,
        ["Weaver connection test"],
        {
          size: model.embeddingDimensions ?? 0,
          mode: model.embeddingDimensionMode,
        },
      );
      usage = result.usage;
      summary = `Embedded 1 input (${model.embeddingDimensions} dimensions)`;
    } else {
      usage = (await adapter.ping(model.providerModelId)).usage;
      summary = "Completion succeeded";
    }
  } catch (error) {
    if (!(error instanceof AiProviderError) && !(error instanceof CoreError))
      throw error;
    outcome = "failure";
    failureReason = testFailureReason(error);
    summary = summarize(error);
    usage = error instanceof AiProviderError ? error.usage : null;
  }
  const durationMs = Date.now() - startedAt;
  await recordAiUsageSafely(db, {
    projectId: null,
    operation: "llm_model_test",
    connectionId: model.connection.id,
    provider: model.connection.providerType,
    model: model.providerModelId,
    configFingerprint: "llm-model-test",
    usage: usage ?? {
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      totalTokens: null,
      durationMs,
    },
    outcome:
      outcome === "success"
        ? "success"
        : failureReason === "validation"
          ? "validation_failure"
          : "provider_failure",
    pricing: {
      inputCostMicrosPerMillion: model.inputCostMicrosPerMillion,
      outputCostMicrosPerMillion: model.outputCostMicrosPerMillion,
    },
    currency: model.currency,
  });

  emitDiagnostic({
    event: "llm.model.tested",
    severity: outcome === "success" ? "info" : "warn",
    outcome:
      outcome === "success"
        ? "ok"
        : failureReason === "timeout"
          ? "timeout"
          : "error",
    message:
      outcome === "success"
        ? "LLM model test succeeded"
        : "LLM model test failed",
    connectionId: model.connection.id,
    userId: actor.userId,
    credentialId: actor.credentialId,
    durationMs,
    details: { modelId: model.id, reason: failureReason },
  });

  return { outcome, durationMs, summary, usage };
}

export type EmbeddingProbeTarget = {
  connection: {
    id: string;
    providerType: LlmProviderType;
    endpoint: string;
    requestTimeoutMs: number;
    enabled: boolean;
  };
  providerModelId: string;
  embeddingDimensions: number | null;
  embeddingDimensionMode: LlmEmbeddingDimensionMode;
  upstreamProvider: string | null;
  inputCostMicrosPerMillion: number | null;
  outputCostMicrosPerMillion: number | null;
  currency: string | null;
};

const EMBEDDING_PROBE_TEXT = "Weaver embedding size check";

/** Embeds one input without requesting a size, so the vector length is the model's native size. */
export async function detectEmbeddingDimensions(
  db: PrismaClient,
  actor: UserSecurityContext,
  deps: LlmAdminDeps,
  input: {
    connectionId: string;
    providerModelId: string;
    upstreamProvider?: string | null;
  },
): Promise<{ dimensions: number }> {
  assertLlmAdmin(actor);
  const connection = await db.llmConnection.findUnique({
    where: { id: input.connectionId },
    select: {
      id: true,
      providerType: true,
      endpoint: true,
      requestTimeoutMs: true,
      enabled: true,
    },
  });
  if (!connection) throw new CoreError("NOT_FOUND", "Connection not found");
  const adapter = adapterForConnection(
    connection,
    db,
    deps.ring,
    deps.fetchImpl,
    connection.providerType === "openrouter"
      ? (input.upstreamProvider ?? null)
      : null,
  );
  const startedAt = Date.now();
  let dimensions: number | null = null;
  let usage: AiUsageSample | null = null;
  let failure: Error | null = null;
  try {
    const result = await adapter.probeEmbeddingDimensions(
      input.providerModelId,
    );
    dimensions = result.dimensions;
    usage = result.usage;
  } catch (error) {
    if (!(error instanceof AiProviderError) && !(error instanceof CoreError))
      throw error;
    failure = error;
    usage = error instanceof AiProviderError ? error.usage : null;
  }
  await recordAiUsageSafely(db, {
    projectId: null,
    operation: "llm_model_test",
    connectionId: connection.id,
    provider: connection.providerType,
    model: input.providerModelId,
    configFingerprint: "llm-model-test",
    usage: usage ?? {
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      totalTokens: null,
      durationMs: Date.now() - startedAt,
    },
    outcome:
      failure === null
        ? "success"
        : failure instanceof AiProviderError && failure.kind === "validation"
          ? "validation_failure"
          : "provider_failure",
    pricing: {
      inputCostMicrosPerMillion: null,
      outputCostMicrosPerMillion: null,
    },
    currency: null,
  });
  if (failure || dimensions === null) {
    throw new CoreError(
      "BAD_REQUEST",
      `Could not detect the native embedding size${failure ? `: ${summarize(failure)}` : ""}`,
      { field: "embeddingDimensions" },
    );
  }
  return { dimensions };
}

/** A wrong size would fail every document terminally, and such a generation still activates. */
export async function probeKnowledgeEmbedding(
  db: PrismaClient,
  deps: LlmAdminDeps | undefined,
  target: EmbeddingProbeTarget,
  field: "embeddingDimensions" | "modelId",
): Promise<void> {
  const size = target.embeddingDimensions;
  if (!isSupportedKnowledgeDimensions(size)) {
    throw new CoreError("BAD_REQUEST", KNOWLEDGE_DIMENSIONS_MESSAGE, { field });
  }
  const { ring, fetchImpl } = deps ?? { ring: loadEncryptionKeyRing() };
  const adapter = adapterForConnection(
    target.connection,
    db,
    ring,
    fetchImpl,
    target.upstreamProvider,
  );
  const startedAt = Date.now();
  let usage: AiUsageSample | null = null;
  let failure: Error | null = null;
  try {
    const result = await adapter.embed(
      target.providerModelId,
      [EMBEDDING_PROBE_TEXT],
      { size, mode: target.embeddingDimensionMode },
    );
    usage = result.usage;
    if (
      result.vectors.length !== 1 ||
      !isValidEmbeddingVector(result.vectors[0], size)
    ) {
      failure = new AiProviderError("AI provider returned invalid embeddings", {
        kind: "validation",
        retryable: false,
      });
    }
  } catch (error) {
    if (!(error instanceof AiProviderError) && !(error instanceof CoreError))
      throw error;
    failure = error;
    usage = error instanceof AiProviderError ? error.usage : null;
  }
  await recordAiUsageSafely(db, {
    projectId: null,
    operation: "llm_model_test",
    connectionId: target.connection.id,
    provider: target.connection.providerType,
    model: target.providerModelId,
    configFingerprint: "llm-model-test",
    usage: usage ?? {
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      totalTokens: null,
      durationMs: Date.now() - startedAt,
    },
    outcome:
      failure === null
        ? "success"
        : failure instanceof AiProviderError && failure.kind === "validation"
          ? "validation_failure"
          : "provider_failure",
    pricing: {
      inputCostMicrosPerMillion: target.inputCostMicrosPerMillion,
      outputCostMicrosPerMillion: target.outputCostMicrosPerMillion,
    },
    currency: target.currency,
  });
  if (failure) {
    throw new CoreError(
      "BAD_REQUEST",
      `The model did not return ${size}-dimension embeddings: ${summarize(failure)}`,
      { field },
    );
  }
}

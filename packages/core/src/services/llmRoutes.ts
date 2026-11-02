import {
  Prisma,
  type LlmEmbeddingDimensionMode,
  type LlmModelCapability,
  type LlmProviderType,
  type LlmPurpose,
  type LlmReasoningMode,
  type PrismaClient,
} from "@weaver/db/client";

import { CoreError } from "../errors";
import {
  KNOWLEDGE_EXTRACTION_SCHEMA_VERSION,
  KNOWLEDGE_PROMPT_VERSION,
  knowledgeConfigFingerprint,
  type KnowledgeRoutingIdentity,
} from "../knowledge/config";
import {
  KNOWLEDGE_DIMENSIONS_MESSAGE,
  isSupportedKnowledgeDimensions,
} from "../knowledge/dimensions";
import { knowledgeExtractionFingerprint } from "../knowledge/identity";
import { emitDiagnostic } from "../diagnostics/writer";
import type { UserSecurityContext } from "../security/context";
import { assertLlmAdmin } from "./llmAdminAccess";
import { withKnowledgeRoutingChange } from "./knowledgeRoutingChange";
import { clampLimit, decodePageCursor, encodePageCursor } from "./adminPaging";
import {
  invalidateLlmRouteCache,
  llmRouteCacheRevision,
} from "./llmRouteCache";
import { probeKnowledgeEmbedding, type LlmAdminDeps } from "./llmConnections";

type Db = PrismaClient | Prisma.TransactionClient;

export const ACTIVE_LLM_PURPOSES = [
  "assistant",
  "knowledge_extraction",
  "knowledge_embedding",
  "ingestion",
  "jobs",
  "document_summary",
] as const;
export type ActiveLlmPurpose = (typeof ACTIVE_LLM_PURPOSES)[number];

export const REQUIRED_CAPABILITIES: Record<
  LlmPurpose,
  readonly LlmModelCapability[]
> = {
  assistant: ["chat", "tool_use"],
  knowledge_extraction: ["chat", "json_output"],
  knowledge_embedding: ["embedding"],
  ingestion: ["chat"],
  jobs: ["chat"],
  document_summary: ["chat"],
};

export type LlmModelSnapshot = {
  connectionId: string;
  connectionName: string;
  providerType: LlmProviderType;
  endpoint: string;
  requestTimeoutMs: number;
  enabled: boolean;
  modelId: string;
  providerModelId: string;
  displayName: string;
  contextWindow: number | null;
  maxOutputTokens?: number | null;
  embeddingDimensions: number | null;
  embeddingDimensionMode: LlmEmbeddingDimensionMode;
  upstreamProvider: string | null;
  vectorSpaceKey?: string | null;
  reasoningMode: LlmReasoningMode;
  capabilities: LlmModelCapability[];
  inputCostMicrosPerMillion: number | null;
  outputCostMicrosPerMillion: number | null;
  currency: string | null;
};

export type LlmRouteHealth =
  | "ready"
  | "unassigned"
  | "connection_disabled"
  | "capability_mismatch"
  | "dimensions_mismatch";

export type LlmRouteView = {
  purpose: ActiveLlmPurpose;
  model: LlmModelSnapshot | null;
  reasoningMode: LlmReasoningMode;
  health: LlmRouteHealth;
  updatedAt: Date | null;
};

type KnowledgeRouteModelSnapshot = {
  connectionId: string;
  connectionName: string;
  providerType: LlmProviderType;
  endpoint: string;
  modelId: string;
  providerModelId: string;
  embeddingDimensionMode: LlmEmbeddingDimensionMode;
  upstreamProvider?: string | null;
  vectorSpaceKey?: string | null;
};

export type KnowledgeRouteSnapshot = {
  extraction: KnowledgeRouteModelSnapshot;
  embedding: KnowledgeRouteModelSnapshot;
};

export type KnowledgeRouting = {
  extraction: LlmModelSnapshot;
  embedding: LlmModelSnapshot;
  embeddingDimensions: number;
  configFingerprint: string;
  extractionFingerprint: string;
  extractionSchemaVersion: number;
  promptVersion: string;
};

const ROUTE_SELECT = {
  purpose: true,
  updatedAt: true,
  reasoningMode: true,
  model: {
    select: {
      id: true,
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
      connection: {
        select: {
          id: true,
          name: true,
          providerType: true,
          endpoint: true,
          requestTimeoutMs: true,
          enabled: true,
        },
      },
    },
  },
} satisfies Prisma.LlmRouteSelect;

type RouteRow = Prisma.LlmRouteGetPayload<{ select: typeof ROUTE_SELECT }>;

type KnowledgeRouteRow = {
  purpose: "knowledge_extraction" | "knowledge_embedding";
  connectionId: string;
  connectionName: string;
  providerType: LlmProviderType;
  endpoint: string;
  requestTimeoutMs: number;
  enabled: boolean;
  modelId: string;
  providerModelId: string;
  displayName: string;
  contextWindow: number | null;
  maxOutputTokens?: number | null;
  embeddingDimensions: number | null;
  embeddingDimensionMode: LlmEmbeddingDimensionMode;
  upstreamProvider: string | null;
  vectorSpaceKey: string | null;
  reasoningMode: LlmReasoningMode;
  capabilities: LlmModelCapability[];
  inputCostMicrosPerMillion: number | null;
  outputCostMicrosPerMillion: number | null;
  currency: string | null;
};

function toSnapshot(
  model: RouteRow["model"],
  reasoningMode: LlmReasoningMode,
): LlmModelSnapshot {
  return {
    connectionId: model.connection.id,
    connectionName: model.connection.name,
    providerType: model.connection.providerType,
    endpoint: model.connection.endpoint,
    requestTimeoutMs: model.connection.requestTimeoutMs,
    enabled: model.connection.enabled,
    modelId: model.id,
    providerModelId: model.providerModelId,
    displayName: model.displayName,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens ?? null,
    embeddingDimensions: model.embeddingDimensions,
    embeddingDimensionMode: model.embeddingDimensionMode,
    upstreamProvider: model.upstreamProvider,
    reasoningMode,
    capabilities: [...model.capabilities],
    inputCostMicrosPerMillion: model.inputCostMicrosPerMillion,
    outputCostMicrosPerMillion: model.outputCostMicrosPerMillion,
    currency: model.currency,
  };
}

function knowledgeRowToSnapshot(row: KnowledgeRouteRow): LlmModelSnapshot {
  return {
    connectionId: row.connectionId,
    connectionName: row.connectionName,
    providerType: row.providerType,
    endpoint: row.endpoint,
    requestTimeoutMs: row.requestTimeoutMs,
    enabled: row.enabled,
    modelId: row.modelId,
    providerModelId: row.providerModelId,
    displayName: row.displayName,
    contextWindow: row.contextWindow,
    maxOutputTokens: row.maxOutputTokens ?? null,
    embeddingDimensions: row.embeddingDimensions,
    embeddingDimensionMode: row.embeddingDimensionMode,
    upstreamProvider: row.upstreamProvider,
    vectorSpaceKey: row.vectorSpaceKey,
    reasoningMode: row.reasoningMode,
    capabilities: [...row.capabilities],
    inputCostMicrosPerMillion: row.inputCostMicrosPerMillion,
    outputCostMicrosPerMillion: row.outputCostMicrosPerMillion,
    currency: row.currency,
  };
}

export function routeHealth(
  purpose: LlmPurpose,
  model: LlmModelSnapshot | null,
): LlmRouteHealth {
  if (!model) return "unassigned";
  if (!model.enabled) return "connection_disabled";
  if (
    !REQUIRED_CAPABILITIES[purpose].every((capability) =>
      model.capabilities.includes(capability),
    )
  ) {
    return "capability_mismatch";
  }
  if (
    purpose === "knowledge_embedding" &&
    !isSupportedKnowledgeDimensions(model.embeddingDimensions)
  ) {
    return "dimensions_mismatch";
  }
  return "ready";
}

async function loadRoutes(db: Db): Promise<Map<LlmPurpose, RouteRow>> {
  const rows = await db.llmRoute.findMany({ select: ROUTE_SELECT });
  return new Map(rows.map((row) => [row.purpose, row]));
}

async function loadKnowledgeRoutes(
  db: Db,
): Promise<Map<KnowledgeRouteRow["purpose"], KnowledgeRouteRow>> {
  const rows = await db.$queryRaw<KnowledgeRouteRow[]>(Prisma.sql`
    SELECT
      route."purpose"::text AS "purpose",
      connection."id"::text AS "connectionId",
      connection."name" AS "connectionName",
      connection."providerType"::text AS "providerType",
      connection."endpoint" AS "endpoint",
      connection."requestTimeoutMs" AS "requestTimeoutMs",
      connection."enabled" AS "enabled",
      model."id"::text AS "modelId",
      model."providerModelId" AS "providerModelId",
      model."displayName" AS "displayName",
      model."contextWindow" AS "contextWindow",
      model."maxOutputTokens" AS "maxOutputTokens",
      model."embeddingDimensions" AS "embeddingDimensions",
      model."embeddingDimensionMode"::text AS "embeddingDimensionMode",
      model."upstreamProvider" AS "upstreamProvider",
      model."vectorSpaceKey" AS "vectorSpaceKey",
      route."reasoningMode"::text AS "reasoningMode",
      model."capabilities"::text[] AS "capabilities",
      model."inputCostMicrosPerMillion" AS "inputCostMicrosPerMillion",
      model."outputCostMicrosPerMillion" AS "outputCostMicrosPerMillion",
      model."currency" AS "currency"
    FROM "LlmRoute" AS route
    INNER JOIN "LlmModel" AS model ON model."id" = route."modelId"
    INNER JOIN "LlmConnection" AS connection
      ON connection."id" = model."connectionId"
    WHERE route."purpose" IN (
      ${"knowledge_extraction"}::"LlmPurpose",
      ${"knowledge_embedding"}::"LlmPurpose"
    )
  `);
  return new Map(rows.map((row) => [row.purpose, row]));
}

function view(
  purpose: ActiveLlmPurpose,
  row: RouteRow | undefined,
): LlmRouteView {
  const model = row ? toSnapshot(row.model, row.reasoningMode) : null;
  return {
    purpose,
    model,
    reasoningMode: row?.reasoningMode ?? "provider_default",
    health: routeHealth(purpose, model),
    updatedAt: row?.updatedAt ?? null,
  };
}

export async function listLlmRoutes(
  db: Db,
  actor: UserSecurityContext,
): Promise<LlmRouteView[]> {
  assertLlmAdmin(actor);
  const rows = await loadRoutes(db);
  return ACTIVE_LLM_PURPOSES.map((purpose) => view(purpose, rows.get(purpose)));
}

export async function listLlmRoutesPage(
  db: Db,
  actor: UserSecurityContext,
  input: { limit?: number; cursor?: string },
): Promise<{
  items: LlmRouteView[];
  nextCursor: string | null;
  truncated: boolean;
}> {
  const routes = await listLlmRoutes(db, actor);
  const limit = clampLimit(input.limit);
  const [afterPurpose] = input.cursor
    ? decodePageCursor(input.cursor, 1)
    : [undefined];
  const start = afterPurpose
    ? routes.findIndex((route) => route.purpose === afterPurpose) + 1
    : 0;
  if (afterPurpose && start === 0) {
    throw new CoreError("BAD_REQUEST", "Invalid cursor", { field: "cursor" });
  }
  const items = routes.slice(start, start + limit);
  const hasMore = start + items.length < routes.length;
  const last = items.at(-1);
  return {
    items,
    nextCursor: hasMore && last ? encodePageCursor([last.purpose]) : null,
    truncated: hasMore,
  };
}

type ProbedRouteModel = {
  providerType: LlmProviderType;
  endpoint: string;
  providerModelId: string;
  embeddingDimensions: number | null;
  embeddingDimensionMode: LlmEmbeddingDimensionMode;
  upstreamProvider: string | null;
};

/** Only a switch away from a live index is checked; a first assignment has nothing to replace. */
async function probeEmbeddingRouteSwitch(
  db: PrismaClient,
  deps: LlmAdminDeps | undefined,
  modelId: string,
): Promise<ProbedRouteModel | null> {
  const routing = await resolveKnowledgeRouting(db);
  if (!routing || routing.embedding.modelId === modelId) return null;
  const model = await db.llmModel.findUnique({
    where: { id: modelId },
    select: { ...ROUTE_SELECT.model.select, vectorSpaceKey: true },
  });
  if (!model) return null;
  const snapshot = {
    ...toSnapshot(model, "provider_default"),
    vectorSpaceKey: model.vectorSpaceKey,
  };
  if (routeHealth("knowledge_embedding", snapshot) !== "ready") return null;
  const fingerprint = knowledgeConfigFingerprint(
    knowledgeRoutingIdentity({
      extraction: routing.extraction,
      embedding: snapshot,
    }),
  );
  if (fingerprint === routing.configFingerprint) return null;
  await probeKnowledgeEmbedding(
    db,
    deps,
    {
      connection: model.connection,
      providerModelId: model.providerModelId,
      embeddingDimensions: model.embeddingDimensions,
      embeddingDimensionMode: model.embeddingDimensionMode,
      upstreamProvider: model.upstreamProvider,
      inputCostMicrosPerMillion: model.inputCostMicrosPerMillion,
      outputCostMicrosPerMillion: model.outputCostMicrosPerMillion,
      currency: model.currency,
    },
    "modelId",
  );
  return {
    providerType: model.connection.providerType,
    endpoint: model.connection.endpoint,
    providerModelId: model.providerModelId,
    embeddingDimensions: model.embeddingDimensions,
    embeddingDimensionMode: model.embeddingDimensionMode,
    upstreamProvider: model.upstreamProvider,
  };
}

export async function setLlmRoute(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: {
    purpose: ActiveLlmPurpose;
    modelId: string | null;
    reasoningMode?: LlmReasoningMode;
  },
  deps?: LlmAdminDeps,
): Promise<LlmRouteView & { reindexProjects: number }> {
  assertLlmAdmin(actor);
  if (!ACTIVE_LLM_PURPOSES.includes(input.purpose)) {
    throw new CoreError("BAD_REQUEST", "This purpose has no consumer yet", {
      field: "purpose",
    });
  }
  if (
    input.purpose === "knowledge_embedding" &&
    input.reasoningMode !== undefined &&
    input.reasoningMode !== "provider_default"
  ) {
    throw new CoreError(
      "BAD_REQUEST",
      "Embeddings do not use thinking effort",
      {
        field: "reasoningMode",
      },
    );
  }
  const probed =
    input.purpose === "knowledge_embedding" && input.modelId !== null
      ? await probeEmbeddingRouteSwitch(db, deps, input.modelId)
      : null;
  const { result: routeView, reindexProjects } =
    await withKnowledgeRoutingChange(
      db,
      actor,
      resolveKnowledgeRouting,
      async () => {
        let result;
        try {
          result = await db.$transaction(async (tx) => {
            if (input.modelId === null) {
              await tx.llmRoute.deleteMany({
                where: { purpose: input.purpose },
              });
              return undefined;
            }
            const model = await tx.llmModel.findUnique({
              where: { id: input.modelId },
              select: ROUTE_SELECT.model.select,
            });
            if (!model) throw new CoreError("NOT_FOUND", "Model not found");
            const health = routeHealth(
              input.purpose,
              toSnapshot(model, input.reasoningMode ?? "provider_default"),
            );
            if (health !== "ready") {
              const reason = {
                connection_disabled: "Its connection is disabled",
                capability_mismatch: `Model lacks ${REQUIRED_CAPABILITIES[input.purpose].join(" + ")}`,
                dimensions_mismatch: KNOWLEDGE_DIMENSIONS_MESSAGE,
                unassigned: "",
                ready: "",
              }[health];
              throw new CoreError("BAD_REQUEST", reason, { field: "modelId" });
            }
            if (
              probed &&
              (model.connection.providerType !== probed.providerType ||
                model.connection.endpoint !== probed.endpoint ||
                model.providerModelId !== probed.providerModelId ||
                model.embeddingDimensions !== probed.embeddingDimensions ||
                model.embeddingDimensionMode !==
                  probed.embeddingDimensionMode ||
                model.upstreamProvider !== probed.upstreamProvider)
            ) {
              throw new CoreError(
                "CONFLICT",
                "The selected model changed while its embeddings were being checked",
                { field: "modelId" },
              );
            }
            return tx.llmRoute.upsert({
              where: { purpose: input.purpose },
              create: {
                purpose: input.purpose,
                modelId: model.id,
                reasoningMode: input.reasoningMode ?? "provider_default",
                updatedById: actor.userId,
              },
              update: {
                modelId: model.id,
                reasoningMode: input.reasoningMode,
                updatedById: actor.userId,
              },
              select: ROUTE_SELECT,
            });
          });
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            ["P2003", "P2014"].includes((error as { code?: string }).code ?? "")
          ) {
            throw new CoreError(
              "CONFLICT",
              "The selected model changed while the route was being saved",
              { field: "modelId" },
            );
          }
          throw error;
        }
        invalidateLlmRouteCache();
        emitDiagnostic({
          event: "settings.changed",
          message: `route ${input.purpose} ${input.modelId ? "assigned" : "cleared"}`,
          userId: actor.userId,
          credentialId: actor.credentialId,
          details: {
            setting: "llm.route",
            purpose: input.purpose,
            modelId: input.modelId,
            reasoningMode: input.reasoningMode,
          },
        });
        return view(input.purpose, result);
      },
    );
  return { ...routeView, reindexProjects };
}

export async function resolveLlmRoute(
  db: Db,
  purpose: LlmPurpose,
): Promise<LlmModelSnapshot | null> {
  const row = await db.llmRoute.findUnique({
    where: { purpose },
    select: ROUTE_SELECT,
  });
  if (!row) return null;
  const model = toSnapshot(row.model, row.reasoningMode);
  return routeHealth(purpose, model) === "ready" ? model : null;
}

export function knowledgeRoutingIdentity(
  routing: Pick<KnowledgeRouting, "extraction" | "embedding">,
): KnowledgeRoutingIdentity {
  return {
    extraction: {
      providerType: routing.extraction.providerType,
      endpoint: routing.extraction.endpoint,
      providerModelId: routing.extraction.providerModelId,
      upstreamProvider: routing.extraction.upstreamProvider,
    },
    embedding: {
      providerType: routing.embedding.providerType,
      endpoint: routing.embedding.endpoint,
      providerModelId: routing.embedding.providerModelId,
      upstreamProvider: routing.embedding.upstreamProvider,
      vectorSpaceKey: routing.embedding.vectorSpaceKey ?? null,
      embeddingDimensions: routing.embedding.embeddingDimensions ?? 0,
      embeddingDimensionMode: routing.embedding.embeddingDimensionMode,
    },
  };
}

export async function resolveKnowledgeRouting(
  db: Db,
): Promise<KnowledgeRouting | null> {
  const routes = await loadKnowledgeRoutes(db);
  const extractionRow = routes.get("knowledge_extraction");
  const embeddingRow = routes.get("knowledge_embedding");
  const extraction = extractionRow
    ? knowledgeRowToSnapshot(extractionRow)
    : null;
  const embedding = embeddingRow ? knowledgeRowToSnapshot(embeddingRow) : null;
  if (
    !extraction ||
    !embedding ||
    routeHealth("knowledge_extraction", extraction) !== "ready" ||
    routeHealth("knowledge_embedding", embedding) !== "ready" ||
    embedding.embeddingDimensions === null
  ) {
    return null;
  }
  const partial = { extraction, embedding };
  return {
    ...partial,
    embeddingDimensions: embedding.embeddingDimensions,
    configFingerprint: knowledgeConfigFingerprint(
      knowledgeRoutingIdentity(partial),
    ),
    extractionFingerprint: knowledgeExtractionFingerprint(
      extraction,
      KNOWLEDGE_PROMPT_VERSION,
    ),
    extractionSchemaVersion: KNOWLEDGE_EXTRACTION_SCHEMA_VERSION,
    promptVersion: KNOWLEDGE_PROMPT_VERSION,
  };
}

export function knowledgeRouteSnapshot(
  routing: KnowledgeRouting,
): KnowledgeRouteSnapshot {
  const pick = (model: LlmModelSnapshot): KnowledgeRouteModelSnapshot => ({
    connectionId: model.connectionId,
    connectionName: model.connectionName,
    providerType: model.providerType,
    endpoint: model.endpoint,
    modelId: model.modelId,
    providerModelId: model.providerModelId,
    embeddingDimensionMode: model.embeddingDimensionMode,
    upstreamProvider: model.upstreamProvider,
    vectorSpaceKey: model.vectorSpaceKey ?? null,
  });
  return {
    extraction: pick(routing.extraction),
    embedding: pick(routing.embedding),
  };
}

let cache: {
  revision: number;
  expiresAt: number;
  value: KnowledgeRouting | null;
  pending: Promise<KnowledgeRouting | null> | null;
} = {
  revision: llmRouteCacheRevision(),
  expiresAt: 0,
  value: null,
  pending: null,
};

export { invalidateLlmRouteCache } from "./llmRouteCache";

export async function cachedKnowledgeRouting(
  db: Db,
  ttlMs = 15_000,
): Promise<KnowledgeRouting | null> {
  const revision = llmRouteCacheRevision();
  if (cache.revision !== revision) {
    cache = { revision, expiresAt: 0, value: null, pending: null };
  }
  const now = Date.now();
  if (cache.expiresAt > now) return cache.value;
  if (cache.pending) return cache.pending;
  const pending = resolveKnowledgeRouting(db).then(
    (value) => {
      if (llmRouteCacheRevision() === revision) {
        cache = {
          revision,
          expiresAt: Date.now() + ttlMs,
          value,
          pending: null,
        };
      }
      return value;
    },
    (error) => {
      if (cache.revision === revision) cache.pending = null;
      throw error;
    },
  );
  cache.pending = pending;
  return pending;
}

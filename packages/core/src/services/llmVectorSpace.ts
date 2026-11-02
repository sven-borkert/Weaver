import {
  Prisma,
  type LlmEmbeddingDimensionMode,
  type PrismaClient,
} from "@weaver/db/client";

import {
  EMBEDDING_COMPATIBILITY_SAMPLES,
  compareEmbeddingSamples,
} from "../ai/embeddingCompatibility";
import { AiProviderError } from "../ai/types";
import { emitDiagnostic } from "../diagnostics/writer";
import { CoreError } from "../errors";
import { KNOWLEDGE_EXTRACTION_SCHEMA_VERSION } from "../knowledge/config";
import {
  effectiveVectorSpaceKey,
  knowledgeIndexFingerprint,
} from "../knowledge/identity";
import type { UserSecurityContext } from "../security/context";
import { recordAiUsageSafely } from "./aiUsageBestEffort";
import { withKnowledgeRoutingChange } from "./knowledgeRoutingChange";
import { assertLlmAdmin } from "./llmAdminAccess";
import {
  CLEARED_VECTOR_SPACE,
  adapterForConnection,
  summarize,
  type LlmAdminDeps,
} from "./llmConnections";
import { invalidateLlmRouteCache } from "./llmRouteCache";
import { resolveKnowledgeRouting } from "./llmRoutes";

export type VectorSpaceVerification = {
  outcome: "compatible" | "incompatible" | "failure";
  minSimilarity: number | null;
  meanSimilarity: number | null;
  durationMs: number;
  summary: string;
  reindexProjects: number;
};

export type KnowledgeRouteChangeEffect =
  "none" | "extraction_only" | "compatible" | "reindex";

export type ClearCompatibilityEffect = "none" | "reindex";

const EMBEDDING_MODEL_SELECT = {
  id: true,
  providerModelId: true,
  displayName: true,
  capabilities: true,
  embeddingDimensions: true,
  embeddingDimensionMode: true,
  upstreamProvider: true,
  vectorSpaceKey: true,
  inputCostMicrosPerMillion: true,
  outputCostMicrosPerMillion: true,
  currency: true,
  connection: {
    select: {
      id: true,
      providerType: true,
      endpoint: true,
      requestTimeoutMs: true,
      enabled: true,
    },
  },
} as const;

async function loadModel(db: PrismaClient, id: string) {
  const model = await db.llmModel.findUnique({
    where: { id },
    select: EMBEDDING_MODEL_SELECT,
  });
  if (!model) throw new CoreError("NOT_FOUND", "Model not found");
  return model;
}
type EmbeddingModel = Awaited<ReturnType<typeof loadModel>>;

function keyOf(model: EmbeddingModel): string {
  return effectiveVectorSpaceKey({
    providerType: model.connection.providerType,
    endpoint: model.connection.endpoint,
    providerModelId: model.providerModelId,
    upstreamProvider: model.upstreamProvider,
    vectorSpaceKey: model.vectorSpaceKey,
  });
}

function indexFingerprintOf(
  model: EmbeddingModel,
  vectorSpaceKey: string,
): string {
  return knowledgeIndexFingerprint(
    {
      vectorSpaceKey,
      embeddingDimensions: model.embeddingDimensions ?? 0,
      embeddingDimensionMode: model.embeddingDimensionMode,
    },
    KNOWLEDGE_EXTRACTION_SCHEMA_VERSION,
  );
}

function liveProjectCount(db: PrismaClient): Promise<number> {
  return db.project.count({ where: { deletedAt: null } });
}

const modelChanged = () =>
  new CoreError("CONFLICT", "The model changed while it was being verified");

/** Writes only while both models and their connections still have the identity that was compared. */
async function storeSharedKey(
  db: PrismaClient,
  model: EmbeddingModel,
  reference: EmbeddingModel,
  data: {
    model: Prisma.LlmModelUncheckedUpdateManyInput;
    reference: Prisma.LlmModelUncheckedUpdateManyInput;
  },
): Promise<void> {
  await db.$transaction(async (tx) => {
    const connections = await tx.$queryRaw<
      Array<{ id: string; providerType: string; endpoint: string }>
    >(Prisma.sql`
      SELECT "id"::text AS "id", "providerType"::text AS "providerType", "endpoint"
      FROM "LlmConnection"
      WHERE "id" IN (${model.connection.id}::uuid, ${reference.connection.id}::uuid)
      FOR SHARE
    `);
    for (const [candidate, update] of [
      [model, data.model],
      [reference, data.reference],
    ] as const) {
      const connection = connections.find(
        (row) => row.id === candidate.connection.id,
      );
      if (
        connection?.providerType !== candidate.connection.providerType ||
        connection.endpoint !== candidate.connection.endpoint
      ) {
        throw modelChanged();
      }
      const { count } = await tx.llmModel.updateMany({
        where: {
          id: candidate.id,
          connectionId: candidate.connection.id,
          providerModelId: candidate.providerModelId,
          embeddingDimensions: candidate.embeddingDimensions,
          embeddingDimensionMode: candidate.embeddingDimensionMode,
          upstreamProvider: candidate.upstreamProvider,
          vectorSpaceKey: candidate.vectorSpaceKey,
        },
        data: update,
      });
      if (count !== 1) throw modelChanged();
    }
  });
}

function assertComparable(
  model: EmbeddingModel,
  reference: EmbeddingModel,
): void {
  const embedding = (candidate: EmbeddingModel) =>
    candidate.capabilities.includes("embedding") &&
    candidate.connection.enabled;
  if (!embedding(model) || !embedding(reference)) {
    throw new CoreError(
      "PRECONDITION_FAILED",
      "Both models must be embedding models on enabled connections",
    );
  }
  if (
    model.embeddingDimensions === null ||
    model.embeddingDimensions !== reference.embeddingDimensions ||
    model.embeddingDimensionMode !== reference.embeddingDimensionMode
  ) {
    throw new CoreError(
      "PRECONDITION_FAILED",
      "Both models must declare the same embedding dimensions and dimension mode",
    );
  }
}

async function embedSamples(
  db: PrismaClient,
  deps: LlmAdminDeps,
  model: EmbeddingModel,
): Promise<number[][]> {
  const adapter = adapterForConnection(
    model.connection,
    db,
    deps.ring,
    deps.fetchImpl,
    model.upstreamProvider,
  );
  const startedAt = Date.now();
  try {
    const result = await adapter.embed(
      model.providerModelId,
      [...EMBEDDING_COMPATIBILITY_SAMPLES],
      {
        size: model.embeddingDimensions ?? 0,
        mode: model.embeddingDimensionMode,
      },
    );
    await recordUsage(
      db,
      model,
      result.usage,
      "success",
      Date.now() - startedAt,
    );
    return result.vectors;
  } catch (error) {
    await recordUsage(
      db,
      model,
      error instanceof AiProviderError ? error.usage : null,
      "provider_failure",
      Date.now() - startedAt,
    );
    throw error;
  }
}

async function recordUsage(
  db: PrismaClient,
  model: EmbeddingModel,
  usage: Parameters<typeof recordAiUsageSafely>[1]["usage"] | null,
  outcome: "success" | "provider_failure",
  durationMs: number,
): Promise<void> {
  await recordAiUsageSafely(db, {
    projectId: null,
    operation: "llm_vector_space_check",
    connectionId: model.connection.id,
    provider: model.connection.providerType,
    model: model.providerModelId,
    configFingerprint: "llm-vector-space-check",
    usage: usage ?? {
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      totalTokens: null,
      durationMs,
    },
    outcome,
    pricing: {
      inputCostMicrosPerMillion: model.inputCostMicrosPerMillion,
      outputCostMicrosPerMillion: model.outputCostMicrosPerMillion,
    },
    currency: model.currency,
  });
}

export async function verifyEmbeddingCompatibility(
  db: PrismaClient,
  actor: UserSecurityContext,
  deps: LlmAdminDeps,
  input: { modelId: string; referenceModelId: string },
): Promise<VectorSpaceVerification> {
  assertLlmAdmin(actor);
  if (input.modelId === input.referenceModelId) {
    throw new CoreError("BAD_REQUEST", "Choose a different reference model", {
      field: "referenceModelId",
    });
  }
  const [model, reference] = await Promise.all([
    loadModel(db, input.modelId),
    loadModel(db, input.referenceModelId),
  ]);
  assertComparable(model, reference);
  const startedAt = Date.now();
  let comparison: ReturnType<typeof compareEmbeddingSamples>;
  try {
    const [modelVectors, referenceVectors] = await Promise.all([
      embedSamples(db, deps, model),
      embedSamples(db, deps, reference),
    ]);
    comparison = compareEmbeddingSamples(modelVectors, referenceVectors);
  } catch (error) {
    if (
      !(error instanceof AiProviderError) &&
      !(error instanceof CoreError) &&
      !(
        error instanceof Error &&
        /Embedding (vector|comparison)/.test(error.message)
      )
    )
      throw error;
    return {
      outcome: "failure",
      minSimilarity: null,
      meanSimilarity: null,
      durationMs: Date.now() - startedAt,
      summary: error instanceof Error ? summarize(error) : "Embedding failed",
      reindexProjects: 0,
    };
  }
  const durationMs = Date.now() - startedAt;
  if (!comparison.compatible) {
    return {
      outcome: "incompatible",
      minSimilarity: comparison.minSimilarity,
      meanSimilarity: comparison.meanSimilarity,
      durationMs,
      summary: "The models place the sample texts in different vector spaces",
      reindexProjects: 0,
    };
  }
  const { reindexProjects } = await withKnowledgeRoutingChange(
    db,
    actor,
    resolveKnowledgeRouting,
    async () => {
      const routed = await db.llmRoute.findUnique({
        where: { purpose: "knowledge_embedding" },
        select: { modelId: true },
      });
      const sharedKey =
        routed?.modelId === model.id ? keyOf(model) : keyOf(reference);
      await storeSharedKey(db, model, reference, {
        model: {
          vectorSpaceKey: sharedKey,
          vectorSpaceReferenceModelId: reference.id,
          vectorSpaceVerifiedAt: new Date(),
          vectorSpaceMinSimilarity: comparison.minSimilarity,
        },
        reference: { vectorSpaceKey: sharedKey },
      });
    },
  );
  invalidateLlmRouteCache();
  emitDiagnostic({
    event: "settings.changed",
    message: "llm.model.vector_space verified",
    userId: actor.userId,
    credentialId: actor.credentialId,
    details: {
      setting: "llm.model.vector_space",
      action: "verified",
      modelId: model.id,
      referenceModelId: reference.id,
      minSimilarity: comparison.minSimilarity,
    },
  });
  return {
    outcome: "compatible",
    minSimilarity: comparison.minSimilarity,
    meanSimilarity: comparison.meanSimilarity,
    durationMs,
    summary: "Vectors match; existing knowledge vectors stay usable",
    reindexProjects,
  };
}

export async function clearEmbeddingCompatibility(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: { modelId: string },
): Promise<{ reindexProjects: number }> {
  assertLlmAdmin(actor);
  const { reindexProjects } = await withKnowledgeRoutingChange(
    db,
    actor,
    resolveKnowledgeRouting,
    async () => {
      const result = await db.llmModel.updateMany({
        where: { id: input.modelId },
        data: CLEARED_VECTOR_SPACE,
      });
      if (result.count === 0)
        throw new CoreError("NOT_FOUND", "Model not found");
    },
  );
  invalidateLlmRouteCache();
  emitDiagnostic({
    event: "settings.changed",
    message: "llm.model.vector_space cleared",
    userId: actor.userId,
    credentialId: actor.credentialId,
    details: {
      setting: "llm.model.vector_space",
      action: "cleared",
      modelId: input.modelId,
    },
  });
  return { reindexProjects };
}

export async function previewClearEmbeddingCompatibility(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: { modelId: string },
): Promise<{ effect: ClearCompatibilityEffect; projects: number }> {
  assertLlmAdmin(actor);
  const model = await loadModel(db, input.modelId);
  const current = await resolveKnowledgeRouting(db);
  if (
    current?.embedding.modelId !== model.id ||
    indexFingerprintOf(model, keyOf({ ...model, vectorSpaceKey: null })) ===
      current.configFingerprint
  ) {
    return { effect: "none", projects: 0 };
  }
  return { effect: "reindex", projects: await liveProjectCount(db) };
}

export async function previewKnowledgeRouteChange(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: {
    purpose: "knowledge_extraction" | "knowledge_embedding";
    modelId: string;
  },
): Promise<{ effect: KnowledgeRouteChangeEffect; projects: number }> {
  assertLlmAdmin(actor);
  const current = await resolveKnowledgeRouting(db);
  const model = await loadModel(db, input.modelId);
  if (input.purpose === "knowledge_extraction") {
    return {
      effect:
        current?.extraction.modelId === model.id ? "none" : "extraction_only",
      projects: 0,
    };
  }
  if (current?.embedding.modelId === model.id)
    return { effect: "none", projects: 0 };
  if (current?.configFingerprint === indexFingerprintOf(model, keyOf(model)))
    return { effect: "compatible", projects: 0 };
  return { effect: "reindex", projects: await liveProjectCount(db) };
}

export type KnowledgeModelChangeEffect = "none" | "reembed";

/** An identity edit clears any shared key, so it always changes the routed model's fingerprint. */
export async function previewKnowledgeModelChange(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: {
    modelId: string;
    providerModelId?: string;
    embeddingDimensions?: number | null;
    embeddingDimensionMode?: LlmEmbeddingDimensionMode;
    upstreamProvider?: string | null;
  },
): Promise<{ effect: KnowledgeModelChangeEffect; projects: number }> {
  assertLlmAdmin(actor);
  const model = await loadModel(db, input.modelId);
  const current = await resolveKnowledgeRouting(db);
  const changed =
    (input.providerModelId !== undefined &&
      input.providerModelId !== model.providerModelId) ||
    (input.embeddingDimensions !== undefined &&
      input.embeddingDimensions !== model.embeddingDimensions) ||
    (input.embeddingDimensionMode !== undefined &&
      input.embeddingDimensionMode !== model.embeddingDimensionMode) ||
    (input.upstreamProvider !== undefined &&
      input.upstreamProvider !== model.upstreamProvider);
  if (current?.embedding.modelId !== model.id || !changed)
    return { effect: "none", projects: 0 };
  return { effect: "reembed", projects: await liveProjectCount(db) };
}

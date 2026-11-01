import { knowledgeTransaction } from "./knowledgeTargets";
import {
  throwIfAborted,
  cancellationError,
  assertVector,
  validationError,
  emptyUsage,
} from "../ai/knowledgeCalls";
import { loadKnowledgeTarget } from "./knowledgeTargets";
import { emitDiagnostic } from "../diagnostics/writer";
import { createHash, randomUUID } from "node:crypto";

import pgvector from "pgvector";

import {
  Prisma,
  type AiUsageOutcome,
  type PrismaClient,
} from "@weaver/db/client";
import { isSupportedKnowledgeDimensions } from "@weaver/core/knowledge/dimensions";
import type {
  AiCallOptions,
  AiProvider,
  AiUsageSample,
  EmbeddingResult,
} from "../ai/types";
import { AiProviderError } from "../ai/types";
import { makeEmbeddingBatches } from "../ai/embeddingBatches";
import { isValidEmbeddingVector } from "../ai/validation";
import type { KnowledgeSystemContext } from "../jobs/systemContext";
import { UTC_NOW } from "./sql";
import { recordAiUsage } from "./aiUsage";

const QUERY_CACHE_MAX_ENTRIES = 500;
const QUERY_CACHE_TTL_MS = 5 * 60 * 1_000;

export type EmbeddingIdentity = {
  processingClaimToken?: string;
  providerName: string;
  embeddingConnectionId: string | null;
  embeddingModel: string;
  embeddingDimensions: number;
  configFingerprint: string;
  inputCostMicrosPerMillion: number | null;
  outputCostMicrosPerMillion: number | null;
  currency: string | null;
  jobId?: string | null;
  runId?: string | null;
};

export type EmbedGenerationDocumentInput = EmbeddingIdentity & {
  projectId: string;
  generationId: string;
  documentId: string;
  sourceCommitSha: string;
};

/** Safe per-document request metadata for diagnostics; never includes content. */
export type EmbeddingRequestStats = {
  count: number;
  largest: number;
  characters: number;
  durationMs: number;
};

export type EmbedQueryInput = EmbeddingIdentity & {
  query: string;
  signal?: AbortSignal;
};

type Db = PrismaClient | Prisma.TransactionClient;

type Chunk = {
  id: string;
  ordinal: number;
  contentHash: string;
  content: string;
};

type StagedEmbedding = {
  chunk: Chunk;
  vector: number[];
  reused: boolean;
};

type UsageRecord = {
  usage: AiUsageSample;
  outcome: AiUsageOutcome;
};

type CacheEntry = {
  vector: number[];
  dimensions: number;
  expiresAt: number;
};

type ReusableEmbeddingRow = { embedding: string; contentHash: string };

export class QueryEmbeddingCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(options?: { maxEntries?: number; ttlMs?: number }) {
    this.maxEntries = Math.min(
      QUERY_CACHE_MAX_ENTRIES,
      Math.max(1, options?.maxEntries ?? QUERY_CACHE_MAX_ENTRIES),
    );
    this.ttlMs = Math.min(
      QUERY_CACHE_TTL_MS,
      Math.max(1, options?.ttlMs ?? QUERY_CACHE_TTL_MS),
    );
  }

  get(key: string, dimensions: number, now = Date.now()): number[] | null {
    this.removeExpired(now);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (
      entry.dimensions !== dimensions ||
      !isValidEmbeddingVector(entry.vector, dimensions)
    ) {
      this.entries.delete(key);
      return null;
    }
    return [...entry.vector];
  }

  set(
    key: string,
    vector: number[],
    dimensions: number,
    now = Date.now(),
  ): void {
    assertVector(vector, dimensions);
    this.removeExpired(now);
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
    this.entries.set(key, {
      vector: [...vector],
      dimensions,
      expiresAt: now + this.ttlMs,
    });
  }

  private removeExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}

const processQueryEmbeddingCache = new QueryEmbeddingCache();

export async function embedGenerationDocument(
  context: KnowledgeSystemContext,
  db: PrismaClient,
  provider: AiProvider,
  input: EmbedGenerationDocumentInput,
  options?: AiCallOptions,
): Promise<{
  outcome: "embedded" | "stale";
  embeddedCount: number;
  reusedCount: number;
  requests: EmbeddingRequestStats;
}> {
  void context;
  throwIfAborted(options?.signal);
  assertEmbeddingIdentity(input);
  const chunks = await db.documentSearchChunk.findMany({
    where: {
      projectId: input.projectId,
      documentId: input.documentId,
      sourceCommitSha: input.sourceCommitSha,
      supersededAt: null,
    },
    orderBy: [{ ordinal: "asc" }, { id: "asc" }],
    select: { id: true, ordinal: true, contentHash: true, content: true },
  });
  if (!(await targetMetadataIsCompatible(db, input))) {
    return {
      outcome: "stale",
      embeddedCount: 0,
      reusedCount: 0,
      requests: { count: 0, largest: 0, characters: 0, durationMs: 0 },
    };
  }

  const stagedByChunkId = new Map<string, StagedEmbedding>();
  const missing: Chunk[] = [];
  const reusable = await loadCompatibleEmbeddings(db, input, chunks);
  for (const chunk of chunks) {
    throwIfAborted(options?.signal);
    const vector = reusable.get(chunk.contentHash);
    if (vector) {
      stagedByChunkId.set(chunk.id, { chunk, vector, reused: true });
    } else {
      missing.push(chunk);
    }
  }

  const usageRecords: UsageRecord[] = [];
  const requests: EmbeddingRequestStats = {
    count: 0,
    largest: 0,
    characters: 0,
    durationMs: 0,
  };
  for (const batch of makeEmbeddingBatches(
    missing,
    provider,
    (chunk) => chunk.content,
  )) {
    if (options?.signal?.aborted) {
      await cancelWithUsage(db, input, usageRecords);
    }
    let result: EmbeddingResult | undefined;
    let callError: unknown;
    let failed = false;
    let cancelled = false;
    let usage = emptyUsage(0);
    let usageKnown = false;
    let outcome: AiUsageOutcome = "provider_failure";
    const startedAt = Date.now();
    try {
      result = await provider.embed(
        batch.map((chunk) => chunk.content),
        options,
      );
      usage = result.usage;
      usageKnown = true;
      throwIfAborted(options?.signal);
      assertEmbeddingResult(result, batch.length, input.embeddingDimensions);
      outcome = "success";
    } catch (error) {
      if (error instanceof AiProviderError && error.usage) {
        usage = error.usage;
        usageKnown = true;
      }
      if (options?.signal?.aborted) {
        cancelled = true;
      } else {
        failed = true;
        callError = error;
        if (error instanceof AiProviderError) {
          outcome =
            error.kind === "validation"
              ? "validation_failure"
              : "provider_failure";
        }
      }
    } finally {
      if (!cancelled && !usageKnown) {
        usage = emptyUsage(Math.max(0, Date.now() - startedAt));
      }
      // A cancelled call is billable only when the provider reported its usage.
      if (!cancelled || usageKnown) usageRecords.push({ usage, outcome });
      requests.count += 1;
      requests.largest = Math.max(requests.largest, batch.length);
      requests.characters += batch.reduce(
        (total, chunk) => total + chunk.content.length,
        0,
      );
      requests.durationMs += Math.max(0, Date.now() - startedAt);
    }

    if (cancelled) await cancelWithUsage(db, input, usageRecords);
    if (failed) {
      await persistDocumentUsageRecords(db, input, usageRecords);
      throw callError;
    }
    for (let index = 0; index < batch.length; index += 1) {
      const chunk = batch[index]!;
      stagedByChunkId.set(chunk.id, {
        chunk,
        vector: result!.vectors[index]!,
        reused: false,
      });
    }
  }

  const staged = chunks.map((chunk) => stagedByChunkId.get(chunk.id)!);
  if (options?.signal?.aborted) await cancelWithUsage(db, input, usageRecords);
  const published = await knowledgeTransaction(db, async (tx) => {
    const compatible = await lockCompatibleTarget(tx, input);
    const finalOutcome: AiUsageOutcome = compatible
      ? "success"
      : "stale_discarded";
    for (const record of usageRecords) {
      await recordDocumentUsage(tx, input, {
        usage: record.usage,
        outcome: finalOutcome,
      });
    }
    if (!compatible) return false;

    await tx.knowledgeEmbedding.deleteMany({
      where: {
        generationId: input.generationId,
        ownerType: "document_chunk",
        ownerId: { in: chunks.map((chunk) => chunk.id) },
      },
    });
    for (const embedding of staged) {
      await insertEmbedding(tx, input, embedding.chunk, embedding.vector);
    }
    await tx.knowledgeGenerationDocument.update({
      where: {
        generationId_documentId: {
          generationId: input.generationId,
          documentId: input.documentId,
        },
      },
      data: { semanticIndexedSha: input.sourceCommitSha },
    });
    return true;
  });
  if (!published) {
    return { outcome: "stale", embeddedCount: 0, reusedCount: 0, requests };
  }

  return {
    outcome: "embedded",
    embeddedCount: staged.filter((embedding) => !embedding.reused).length,
    reusedCount: staged.filter((embedding) => embedding.reused).length,
    requests,
  };
}

export async function embedQuery(
  db: PrismaClient,
  provider: AiProvider,
  input: EmbedQueryInput,
  cache: QueryEmbeddingCache = processQueryEmbeddingCache,
): Promise<number[]> {
  assertEmbeddingIdentity(input);
  const query = normalizeQuery(input.query);
  if (!query) {
    throw validationError("Embedding query must not be empty");
  }
  const cacheKey = queryCacheKey(input, query);
  const cached = cache.get(cacheKey, input.embeddingDimensions);
  if (cached) return cached;

  let vector: number[] | undefined;
  let callError: unknown;
  let failed = false;
  let usage = emptyUsage(0);
  let usageKnown = false;
  let outcome: AiUsageOutcome = "provider_failure";
  const startedAt = Date.now();
  try {
    const result = await provider.embed([query], { signal: input.signal });
    usage = result.usage;
    usageKnown = true;
    assertEmbeddingResult(result, 1, input.embeddingDimensions);
    vector = result.vectors[0]!;
    outcome = "success";
  } catch (error) {
    failed = true;
    callError = error;
    if (error instanceof AiProviderError) {
      outcome =
        error.kind === "validation" ? "validation_failure" : "provider_failure";
      if (error.usage) {
        usage = error.usage;
        usageKnown = true;
      }
    }
  } finally {
    if (!usageKnown) {
      usage = emptyUsage(Math.max(0, Date.now() - startedAt));
    }
    await recordAiUsage(db, {
      projectId: null,
      operation: "search_query_embedding",
      jobId: input.jobId,
      runId: input.runId,
      documentId: null,
      connectionId: input.embeddingConnectionId,
      provider: input.providerName,
      model: input.embeddingModel,
      configFingerprint: input.configFingerprint,
      usage,
      outcome,
      pricing: input,
      currency: input.currency,
    });
  }

  if (failed) throw callError;
  cache.set(cacheKey, vector!, input.embeddingDimensions);
  return [...vector!];
}

async function targetMetadataIsCompatible(
  db: Db,
  input: EmbedGenerationDocumentInput,
): Promise<boolean> {
  return (await loadKnowledgeTarget(db, input)) !== null;
}

async function lockCompatibleTarget(
  tx: Prisma.TransactionClient,
  input: EmbedGenerationDocumentInput,
): Promise<boolean> {
  return (await loadKnowledgeTarget(tx, input, { lock: true })) !== null;
}

async function loadCompatibleEmbeddings(
  db: Db,
  input: EmbedGenerationDocumentInput,
  chunks: Chunk[],
): Promise<Map<string, number[]>> {
  const result = new Map<string, number[]>();
  if (chunks.length === 0) return result;
  const rows = await db.$queryRaw<ReusableEmbeddingRow[]>(Prisma.sql`
    SELECT DISTINCT ON (source."contentHash") source."contentHash", source."embedding"::text AS "embedding"
    FROM "KnowledgeEmbedding" AS source
    JOIN "KnowledgeGeneration" AS target_generation
      ON target_generation."id" = ${input.generationId}::uuid
     AND target_generation."projectId" = ${input.projectId}::uuid
     AND target_generation."configFingerprint" = ${input.configFingerprint}
    JOIN "KnowledgeGeneration" AS source_generation
      ON source_generation."id" = source."generationId"
     AND source_generation."projectId" = ${input.projectId}::uuid
     AND source_generation."configFingerprint" = target_generation."configFingerprint"
     AND source_generation."embeddingDimensions" = ${input.embeddingDimensions}
    WHERE source."projectId" = ${input.projectId}::uuid
      AND source."ownerType" = 'document_chunk'
      AND source."contentHash" IN (${Prisma.join(chunks.map((chunk) => chunk.contentHash))})
      AND source."configFingerprint" = source_generation."configFingerprint"
      AND source."embeddingDimensions" = ${input.embeddingDimensions}
    ORDER BY source."contentHash", source."createdAt" DESC, source."id" DESC
  `);
  for (const row of rows) {
    try {
      const vector = pgvector.fromSql(row.embedding);
      if (!Array.isArray(vector)) continue;
      assertVector(vector, input.embeddingDimensions);
      result.set(row.contentHash, [...vector]);
    } catch {
      continue;
    }
  }
  return result;
}

async function persistDocumentUsageRecords(
  db: PrismaClient,
  input: EmbedGenerationDocumentInput,
  records: UsageRecord[],
): Promise<void> {
  await knowledgeTransaction(db, async (tx) => {
    for (const record of records) {
      await recordDocumentUsage(tx, input, record);
    }
  });
}

async function cancelWithUsage(
  db: PrismaClient,
  input: EmbedGenerationDocumentInput,
  records: UsageRecord[],
): Promise<never> {
  try {
    if (records.length > 0) {
      await persistDocumentUsageRecords(
        db,
        input,
        records.map((record) => ({ ...record, outcome: "stale_discarded" })),
      );
    }
  } catch {
    emitDiagnostic({
      event: "ai.usage.failed",
      severity: "warn",
      message: "AI usage could not be recorded",
      outcome: "error",
      projectId: input.projectId,
      documentId: input.documentId,
      jobId: input.jobId ?? undefined,
      runId: input.runId ?? undefined,
      connectionId: input.embeddingConnectionId ?? undefined,
      details: {
        operation: "document_chunk_embedding",
        usageOutcome: "stale_discarded",
        failureKind: "accounting",
      },
    });
  }
  throw cancellationError();
}

async function recordDocumentUsage(
  db: Db,
  input: EmbedGenerationDocumentInput,
  record: UsageRecord,
): Promise<void> {
  await recordAiUsage(db, {
    projectId: input.projectId,
    operation: "document_chunk_embedding",
    jobId: input.jobId,
    runId: input.runId,
    documentId: input.documentId,
    connectionId: input.embeddingConnectionId,
    provider: input.providerName,
    model: input.embeddingModel,
    configFingerprint: input.configFingerprint,
    usage: record.usage,
    outcome: record.outcome,
    pricing: input,
    currency: input.currency,
  });
}

async function insertEmbedding(
  tx: Prisma.TransactionClient,
  input: EmbedGenerationDocumentInput,
  chunk: Chunk,
  vector: number[],
): Promise<void> {
  assertVector(vector, input.embeddingDimensions);
  const sqlVector = pgvector.toSql(vector);
  if (sqlVector === null) {
    throw validationError("AI provider returned invalid embeddings");
  }
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "KnowledgeEmbedding"
      ("id", "projectId", "generationId", "ownerType", "ownerId",
       "contentHash", "configFingerprint", "model",
       "embeddingDimensions", "embedding", "createdAt")
    VALUES
      (${randomUUID()}::uuid, ${input.projectId}::uuid,
       ${input.generationId}::uuid, 'document_chunk', ${chunk.id},
       ${chunk.contentHash}, ${input.configFingerprint}, ${input.embeddingModel},
       ${input.embeddingDimensions}, ${sqlVector}::vector, ${UTC_NOW})
  `);
}

function assertEmbeddingResult(
  result: EmbeddingResult,
  expectedCount: number,
  dimensions: number,
): void {
  if (result.vectors.length !== expectedCount) {
    throw validationError("AI provider returned invalid embeddings");
  }
  for (const vector of result.vectors) assertVector(vector, dimensions);
}

function assertEmbeddingIdentity(input: EmbeddingIdentity): void {
  if (
    !isSupportedKnowledgeDimensions(input.embeddingDimensions) ||
    !input.providerName.trim() ||
    !input.embeddingModel.trim() ||
    !input.configFingerprint.trim()
  ) {
    throw validationError("Invalid embedding configuration");
  }
}

function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ");
}

function queryCacheKey(input: EmbeddingIdentity, query: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.configFingerprint,
        input.embeddingModel,
        input.embeddingDimensions,
        query,
      ]),
    )
    .digest("hex");
}

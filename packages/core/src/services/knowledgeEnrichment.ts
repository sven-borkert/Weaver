import { KNOWLEDGE_ENRICHMENT_EXPIRE_IN_SECONDS } from "../jobs/types";
import { ZodError } from "zod";
import { selectEntityDescription } from "../knowledge/entityDescriptions";
import {
  loadCurrentEntityDescriptions,
  refreshEntityDescriptions,
} from "./knowledgeEntityDescriptions";
import { emitDiagnostic } from "../diagnostics/writer";
import { knowledgeTransaction } from "./knowledgeTargets";
import {
  throwIfAborted,
  cancellationError,
  assertVector,
  validationError,
  emptyUsage,
} from "../ai/knowledgeCalls";
import { loadKnowledgeTarget } from "./knowledgeTargets";
import { randomUUID } from "node:crypto";

import pgvector from "pgvector";

import {
  Prisma,
  type AiUsageOutcome,
  type PrismaClient,
} from "@weaver/db/client";
import {
  MAX_KNOWLEDGE_CHUNKS,
  MAX_KNOWLEDGE_HEADING_COMPONENT_CHARACTERS,
  MAX_KNOWLEDGE_HEADING_DEPTH,
  contentHash,
} from "@weaver/core/knowledge/chunking";
import { isSupportedKnowledgeDimensions } from "@weaver/core/knowledge/dimensions";
import {
  MAX_EXTRACTION_ISSUE_SUMMARIES,
  describeExtractionIssues,
  describeTemporalIssues,
  extractionResponseSchema,
  normalizeKnowledgeName,
  normalizeRelationType,
  type ExtractionResponse,
} from "@weaver/core/knowledge/extraction";
import type {
  AiCallOptions,
  AiProvider,
  AiUsageSample,
  EmbeddingResult,
  ExtractionRequest,
} from "../ai/types";
import { AiProviderError } from "../ai/types";
import type { AiProviderErrorDetails } from "../ai/types";
import { makeEmbeddingBatches } from "../ai/embeddingBatches";
import type { KnowledgeSystemContext } from "../jobs/systemContext";
import { UTC_NOW } from "./sql";
import { recordAiUsage } from "./aiUsage";
import { resolveEntityCandidates } from "./entityResolution";
import type { EmbeddingIdentity } from "./knowledgeEmbeddings";

const MAX_EXTRACTION_CHUNKS = MAX_KNOWLEDGE_CHUNKS;
const MAX_EXTRACTION_REQUEST_CHARACTERS = 64_000;
const MAX_EXTRACTION_TITLE_CHARACTERS = 200;
const MAX_DOCUMENT_ENTITY_OCCURRENCES = 50;
const MAX_DOCUMENT_RELATIONS = 100;
const MAX_ENTITY_ALIASES = 20;
const MAX_ENTITY_CANDIDATE_SCAN = 16;
const MAX_RESOLUTION_ATTEMPTS = 3;

export type EnrichGenerationDocumentInput = EmbeddingIdentity & {
  projectId: string;
  generationId: string;
  documentId: string;
  sourceCommitSha: string;
  extractionModel: string;
  extractionFingerprint: string;
  extractionProviderName: string;
  extractionConnectionId: string;
  extractionInputCostMicrosPerMillion: number | null;
  extractionOutputCostMicrosPerMillion: number | null;
  extractionCurrency: string | null;
};

type Db = PrismaClient | Prisma.TransactionClient;

type SourceChunk = {
  id: string;
  ordinal: number;
  headingPath: string[];
  content: string;
};

type TargetRow = {
  title: string;
  semanticIndexedSha: string | null;
  graphIndexedSha: string | null;
};

type ExistingEntity = {
  id: string;
  entityType: string;
  canonicalName: string;
  normalizedName: string;
  description: string | null;
  aliases: Array<{ alias: string; normalizedAlias: string }>;
};

type ResolvedEntity = ExistingEntity & { isNew: boolean };

type ExtractedChunk = {
  chunk: SourceChunk;
  extraction: ExtractionResponse;
};

type StagedMention = {
  entity: ResolvedEntity;
  chunk: SourceChunk;
  mentionText: string;
  description: string | null;
  confidence: number;
};

type StagedRelation = {
  sourceEntity: ResolvedEntity;
  targetEntity: ResolvedEntity;
  chunk: SourceChunk;
  relationType: string;
  normalizedType: string;
  evidenceText: string;
  confidence: number;
  validFrom: Date | null;
  validTo: Date | null;
};

type ResolutionPlan = {
  entities: ResolvedEntity[];
  mentions: StagedMention[];
  relations: StagedRelation[];
  newEntityIds: Map<string, string>;
  signature: string;
};

type CandidateLoad = {
  candidatesByIdentity: Map<string, ExistingEntity[]>;
  rawUniqueIdentities: Set<string>;
  overflowIdentities: Set<string>;
};

type EntityEmbedding = {
  entity: ResolvedEntity;
  canonicalText: string;
  contentHash: string;
  vector: number[];
  reused: boolean;
};

type UsageRecord = {
  operation: "document_graph_extraction" | "entity_embedding";
  model: string;
  usage: AiUsageSample;
  outcome: AiUsageOutcome;
};

type CandidateScanRow = {
  requestOrdinal: number;
  id: string;
  overflow: boolean;
};
type ReusableEmbeddingRow = { contentHash: string; embedding: string };

export async function enrichGenerationDocument(
  context: KnowledgeSystemContext,
  db: PrismaClient,
  provider: AiProvider,
  input: EnrichGenerationDocumentInput,
  options?: AiCallOptions,
): Promise<{
  outcome: "enriched" | "stale";
  entityCount: number;
  relationCount: number;
  embeddedCount: number;
  reusedCount: number;
}> {
  void context;
  throwIfAborted(options?.signal);
  assertIdentity(input);

  const target = await compatibleTarget(db, input);
  if (!target) return staleResult();
  if (targetIsPublished(target, input)) {
    const embeddedCount = await embedDocumentEntities(
      db,
      provider,
      input,
      options,
    );
    return { ...emptyEnrichedResult(), embeddedCount };
  }

  const chunks = await db.documentSearchChunk.findMany({
    where: {
      projectId: input.projectId,
      documentId: input.documentId,
      sourceCommitSha: input.sourceCommitSha,
      supersededAt: null,
    },
    orderBy: [{ ordinal: "asc" }, { id: "asc" }],
    take: MAX_EXTRACTION_CHUNKS + 1,
    select: {
      id: true,
      ordinal: true,
      headingPath: true,
      content: true,
    },
  });
  assertChunksAreBounded(chunks);
  const requests = chunks.map((chunk) =>
    buildExtractionRequest(input, target, chunk),
  );

  const extractionUsage: UsageRecord[] = [];
  const extractedChunks: ExtractedChunk[] = [];
  const admittedEntities = new Set<string>();
  let admittedMentions = 0;
  let admittedRelations = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    if (options?.signal?.aborted) {
      await cancelWithUsage(db, input, extractionUsage);
    }
    const chunk = chunks[index]!;
    try {
      const extraction = await callExtraction(
        provider,
        requests[index]!,
        options,
      );
      if (options?.signal?.aborted) {
        extractionUsage.push(
          successRecord(
            "document_graph_extraction",
            input.extractionModel,
            extraction.usage,
          ),
        );
        throw cancellationError();
      }
      assertDocumentExtractionBounds(
        extraction.data.entities.length,
        extraction.data.relations.length,
        extraction.usage,
      );
      extraction.data.entities = extraction.data.entities.filter((entity) => {
        const identity = resolutionIdentity(entity.name, entity.type);
        if (
          admittedMentions >= 2000 ||
          (!admittedEntities.has(identity) && admittedEntities.size >= 500)
        )
          return false;
        admittedMentions += 1;
        admittedEntities.add(identity);
        return true;
      });
      const keys = new Set(
        extraction.data.entities.map((entity) => entity.key),
      );
      extraction.data.relations = extraction.data.relations.filter(
        (relation) => {
          if (
            !keys.has(relation.sourceKey) ||
            !keys.has(relation.targetKey) ||
            admittedRelations >= 1000
          )
            return false;
          admittedRelations += 1;
          return true;
        },
      );
      extractionUsage.push(
        successRecord(
          "document_graph_extraction",
          input.extractionModel,
          extraction.usage,
        ),
      );
      extractedChunks.push({ chunk, extraction: extraction.data });
    } catch (error) {
      if (options?.signal?.aborted) {
        const usage = reportedUsageOf(error);
        if (usage) {
          extractionUsage.push(
            successRecord(
              "document_graph_extraction",
              input.extractionModel,
              usage,
            ),
          );
        }
        await cancelWithUsage(db, input, extractionUsage);
      }
      extractionUsage.push(
        usageRecordForFailure(
          "document_graph_extraction",
          input.extractionModel,
          error,
        ),
      );
      await persistUsageRecords(db, input, extractionUsage);
      throw safeProviderError(error, "AI provider returned invalid extraction");
    }
  }

  const preferredNewEntityIds = new Map<string, string>();
  const stagedVectors = new Map<string, number[]>();
  for (let attempt = 0; attempt < MAX_RESOLUTION_ATTEMPTS; attempt += 1) {
    const plan = await prepareResolutionPlan(
      db,
      input,
      extractedChunks,
      preferredNewEntityIds,
    );
    if (!plan) {
      await persistUsageRecords(
        db,
        input,
        extractionUsage.map((usage) => ({
          ...usage,
          outcome: "stale_discarded",
        })),
      );
      return staleResult();
    }
    for (const [key, id] of plan.newEntityIds) {
      if (!preferredNewEntityIds.has(key)) preferredNewEntityIds.set(key, id);
    }

    const entityEmbeddingUsage: UsageRecord[] = [];
    let embeddings: EntityEmbedding[];
    try {
      throwIfAborted(options?.signal);
      embeddings = await stageEntityEmbeddings(
        db,
        provider,
        input,
        plan.entities,
        entityEmbeddingUsage,
        options,
        stagedVectors,
      );
    } catch (error) {
      if (options?.signal?.aborted) {
        await cancelWithUsage(db, input, [
          ...extractionUsage,
          ...entityEmbeddingUsage,
        ]);
      }
      await persistUsageRecords(db, input, [
        ...extractionUsage,
        ...entityEmbeddingUsage,
      ]);
      throw safeProviderError(error, "AI provider returned invalid embeddings");
    }

    if (options?.signal?.aborted) {
      await cancelWithUsage(db, input, [
        ...extractionUsage,
        ...entityEmbeddingUsage,
      ]);
    }
    const publication = await knowledgeTransaction(
      db,
      async (tx) => {
        const lockedTarget = await lockCompatibleTarget(tx, input);
        if (!lockedTarget) {
          await recordUsageWithOutcome(
            tx,
            input,
            extractionUsage,
            "stale_discarded",
          );
          await recordUsageWithOutcome(
            tx,
            input,
            entityEmbeddingUsage,
            "stale_discarded",
          );
          return { outcome: "stale" } as const;
        }
        if (targetIsPublished(lockedTarget, input)) {
          await recordUsageWithOutcome(
            tx,
            input,
            extractionUsage,
            "stale_discarded",
          );
          await recordUsageWithOutcome(
            tx,
            input,
            entityEmbeddingUsage,
            "stale_discarded",
          );
          return { outcome: "already-published" } as const;
        }

        const finalPlan = await buildResolutionPlan(
          tx,
          input,
          extractedChunks,
          preferredNewEntityIds,
        );
        if (finalPlan.signature !== plan.signature) {
          await recordUsageWithOutcome(
            tx,
            input,
            entityEmbeddingUsage,
            "stale_discarded",
          );
          return { outcome: "retry" } as const;
        }

        await recordUsageWithOutcome(tx, input, extractionUsage, "success");
        await recordUsageWithOutcome(
          tx,
          input,
          entityEmbeddingUsage,
          "success",
        );
        const finalHashes = new Map(
          finalPlan.entities.map((entity) => [
            entity.id,
            contentHash(canonicalEntityText(entity)),
          ]),
        );
        await publishResolutionPlan(
          tx,
          input,
          finalPlan,
          embeddings.filter(
            (embedding) =>
              finalHashes.get(embedding.entity.id) === embedding.contentHash,
          ),
        );
        return { outcome: "published" } as const;
      },
      { timeout: 60_000, maxWait: 30_000 },
    );

    if (publication.outcome === "retry") continue;
    if (publication.outcome === "stale") return staleResult();
    if (publication.outcome === "already-published") {
      return emptyEnrichedResult();
    }
    return enrichedResult(plan, embeddings);
  }

  await persistUsageRecords(
    db,
    input,
    extractionUsage.map((usage) => ({
      ...usage,
      outcome: "stale_discarded",
    })),
  );
  throw new Error(
    "Entity resolution changed repeatedly during publication; retry enrichment",
  );
}

function buildExtractionRequest(
  input: EnrichGenerationDocumentInput,
  target: TargetRow,
  chunk: SourceChunk,
): ExtractionRequest {
  const request = {
    documentId: input.documentId,
    chunkId: chunk.id,
    title: boundedRequestComponent(
      target.title,
      MAX_EXTRACTION_TITLE_CHARACTERS,
    ),
    headingPath: chunk.headingPath
      .slice(0, MAX_KNOWLEDGE_HEADING_DEPTH)
      .map((heading) =>
        boundedRequestComponent(
          heading,
          MAX_KNOWLEDGE_HEADING_COMPONENT_CHARACTERS,
        ),
      )
      .filter(Boolean),
    text: chunk.content,
  };
  if (JSON.stringify(request).length > MAX_EXTRACTION_REQUEST_CHARACTERS) {
    throw validationError("Document extraction input exceeds limits");
  }
  return request;
}

function boundedRequestComponent(value: string, maxCharacters: number): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxCharacters);
}

async function callExtraction(
  provider: AiProvider,
  request: ExtractionRequest,
  options?: AiCallOptions,
): Promise<{ data: ExtractionResponse; usage: AiUsageSample }> {
  const startedAt = Date.now();
  let reportedUsage: AiUsageSample | undefined;
  try {
    const result = await provider.extract(request, options);
    reportedUsage = result.usage;
    const data = extractionResponseSchema.parse(result.data);
    assertTemporalValidity(data);
    if (result.correction) {
      emitDiagnostic({
        event: "knowledge.extraction.corrected",
        severity: "warn",
        message: "Extraction accepted after one correction",
        documentId: request.documentId,
        details: { chunkId: request.chunkId, ...result.correction },
      });
    }
    return { data, usage: result.usage };
  } catch (error) {
    // An error carrying usage is a completed call; the caller must still account it.
    const thrownUsage = error instanceof AiProviderError ? error.usage : null;
    if (options?.signal?.aborted && !reportedUsage && !thrownUsage)
      throw cancellationError();
    if (error instanceof AiProviderError) {
      if (error.kind !== "validation" || error.usage || !reportedUsage) {
        throw error;
      }
      throw new AiProviderError(error.message, {
        kind: "validation",
        retryable: false,
        usage: reportedUsage,
        details: error.details,
      });
    }
    if (isValidationError(error)) {
      throw new AiProviderError("AI provider returned invalid extraction", {
        kind: "validation",
        retryable: false,
        usage: reportedUsage,
        details: schemaFailureDetails(error),
      });
    }
    throw new AiProviderError("AI provider extraction failed", {
      kind: "provider",
      retryable: false,
      usage: emptyUsage(Math.max(0, Date.now() - startedAt)),
    });
  }
}

async function prepareResolutionPlan(
  db: PrismaClient,
  input: EnrichGenerationDocumentInput,
  extractedChunks: ExtractedChunk[],
  preferredNewEntityIds: ReadonlyMap<string, string>,
): Promise<ResolutionPlan | null> {
  return knowledgeTransaction(db, async (tx) => {
    const target = await lockCompatibleTarget(tx, input);
    if (!target || targetIsPublished(target, input)) return null;
    return buildResolutionPlan(
      tx,
      input,
      extractedChunks,
      preferredNewEntityIds,
    );
  });
}

async function buildResolutionPlan(
  db: Db,
  input: EnrichGenerationDocumentInput,
  extractedChunks: ExtractedChunk[],
  preferredNewEntityIds: ReadonlyMap<string, string>,
): Promise<ResolutionPlan> {
  const loaded = await loadRelevantEntityCandidates(db, input, extractedChunks);
  if (loaded.overflowIdentities.size) {
    emitDiagnostic({
      event: "knowledge.entity.resolution_limited",
      severity: "warn",
      message: "Entity resolution candidate limit reached",
      projectId: input.projectId,
      generationId: input.generationId,
      documentId: input.documentId,
      details: { count: loaded.overflowIdentities.size },
    });
  }
  const existingById = new Map<string, ResolvedEntity>();
  const candidatesByIdentity = new Map<string, ResolvedEntity[]>();
  for (const [identity, entities] of loaded.candidatesByIdentity) {
    candidatesByIdentity.set(
      identity,
      entities.map((entity) => {
        let resolved = existingById.get(entity.id);
        if (!resolved) {
          resolved = {
            ...entity,
            aliases: [...entity.aliases],
            isNew: false,
          };
          existingById.set(entity.id, resolved);
        }
        return resolved;
      }),
    );
  }
  const runLocal = new Map<string, ResolvedEntity>();
  const runCandidates = new Map<string, ResolvedEntity>();
  const newEntityIds = new Map<string, string>();
  const mentions: StagedMention[] = [];
  const relations: StagedRelation[] = [];

  for (const { chunk, extraction } of extractedChunks) {
    const localKeys = new Map<string, ResolvedEntity>();
    for (const extracted of extraction.entities) {
      const identity = resolutionIdentity(extracted.name, extracted.type);
      let resolved: ResolvedEntity | null | undefined = runLocal.get(identity);
      if (!resolved) {
        const resolutionCandidates = new Map<string, ResolvedEntity>();
        for (const candidate of candidatesByIdentity.get(identity) ?? []) {
          resolutionCandidates.set(candidate.id, candidate);
        }
        for (const candidate of runCandidates.values()) {
          resolutionCandidates.set(candidate.id, candidate);
        }
        resolved = resolveEntityCandidates(
          [...resolutionCandidates.values()],
          extracted,
          { complete: !loaded.overflowIdentities.has(identity) },
        );
        if (!resolved) {
          const id = preferredNewEntityIds.get(identity) ?? randomUUID();
          const normalizedName = normalizeKnowledgeName(extracted.name);
          const uniqueIdentityIsOccupied =
            loaded.rawUniqueIdentities.has(
              rawUniqueIdentity(extracted.type, normalizedName),
            ) ||
            [...runCandidates.values()].some(
              (candidate) =>
                candidate.entityType === extracted.type &&
                candidate.normalizedName === normalizedName,
            );
          const needsDistinctInternalIdentity = uniqueIdentityIsOccupied;
          resolved = {
            id,
            entityType: extracted.type,
            canonicalName: extracted.name,
            normalizedName: needsDistinctInternalIdentity
              ? disambiguatedNormalizedName(normalizedName, id)
              : normalizedName,
            description: extracted.description,
            aliases: [],
            isNew: true,
          };
          if (needsDistinctInternalIdentity) {
            mergeAliases(resolved, [extracted.name]);
          }
          newEntityIds.set(identity, id);
        }
        runLocal.set(identity, resolved);
        runCandidates.set(resolved.id, resolved);
      }
      mergeAliases(resolved, extracted.aliases);
      localKeys.set(extracted.key, resolved);
      mentions.push({
        entity: resolved,
        chunk,
        mentionText: extracted.mentionText,
        description: extracted.description,
        confidence: extracted.confidence,
      });
    }

    for (const relation of extraction.relations) {
      const sourceEntity = localKeys.get(relation.sourceKey);
      const targetEntity = localKeys.get(relation.targetKey);
      if (!sourceEntity || !targetEntity) {
        throw validationError("AI provider returned invalid extraction");
      }
      relations.push({
        sourceEntity,
        targetEntity,
        chunk,
        relationType: relation.type,
        normalizedType: normalizeRelationType(relation.type),
        evidenceText: (relation.description ?? chunk.content).slice(0, 1000),
        confidence: relation.confidence,
        validFrom: relation.validFrom ? new Date(relation.validFrom) : null,
        validTo: relation.validTo ? new Date(relation.validTo) : null,
      });
    }
  }

  const entities = uniqueMentionedEntities(mentions);
  const currentDescriptions = await loadCurrentEntityDescriptions(db, {
    projectId: input.projectId,
    generationId: input.generationId,
    entityIds: entities.map((entity) => entity.id),
    excludeDocumentId: input.documentId,
  });
  for (const entity of entities) {
    entity.description = selectEntityDescription([
      ...(currentDescriptions.get(entity.id) ?? []),
      ...mentions
        .filter((mention) => mention.entity.id === entity.id)
        .map((mention) => ({
          documentId: input.documentId,
          description: mention.description,
          confidence: mention.confidence,
        })),
    ]);
  }
  return {
    entities,
    mentions,
    relations,
    newEntityIds,
    signature: resolutionPlanSignature(entities, mentions, relations),
  };
}

async function loadRelevantEntityCandidates(
  db: Db,
  input: EnrichGenerationDocumentInput,
  extractedChunks: ExtractedChunk[],
): Promise<CandidateLoad> {
  const requested = new Map<
    string,
    {
      name: string;
      entityType: string;
      normalizedName: string;
      normalizedType: string;
    }
  >();
  for (const { extraction } of extractedChunks) {
    for (const entity of extraction.entities) {
      const normalizedName = normalizeKnowledgeName(entity.name);
      const normalizedType = normalizeKnowledgeName(entity.type);
      const identity = `${normalizedType}\0${normalizedName}`;
      if (!requested.has(identity)) {
        requested.set(identity, {
          name: entity.name,
          entityType: entity.type,
          normalizedName,
          normalizedType,
        });
      }
    }
  }
  if (requested.size === 0) {
    return {
      candidatesByIdentity: new Map(),
      rawUniqueIdentities: new Set(),
      overflowIdentities: new Set(),
    };
  }

  const requestedValues = [...requested.entries()].map(
    ([identity, value], requestOrdinal) => ({
      identity,
      requestOrdinal,
      ...value,
    }),
  );
  const exactCandidates = await db.graphEntity.findMany({
    where: {
      projectId: input.projectId,
      generationId: input.generationId,
      OR: requestedValues.map((value) => ({
        entityType: value.entityType,
        normalizedName: value.normalizedName,
      })),
    },
    select: { id: true, entityType: true, normalizedName: true },
  });
  const values = Prisma.join(
    requestedValues.map(
      (value) =>
        Prisma.sql`(${value.requestOrdinal}::integer, ${value.normalizedName}, ${value.normalizedType})`,
    ),
  );
  const scanRows = await db.$queryRaw<CandidateScanRow[]>(Prisma.sql`
    WITH requested("requestOrdinal", "normalizedName", "normalizedType") AS (
      VALUES ${values}
    ), ranked AS (
      SELECT requested."requestOrdinal",
             entity."id",
             row_number() OVER (
               PARTITION BY requested."requestOrdinal"
               ORDER BY entity."createdAt" ASC, entity."id" ASC
             ) AS "matchRank"
      FROM requested
      JOIN "GraphEntity" AS entity
        ON entity."projectId" = ${input.projectId}::uuid
       AND entity."generationId" = ${input.generationId}::uuid
       AND lower(btrim(regexp_replace(normalize(entity."entityType", NFKC), '\\s+', ' ', 'g'))) = requested."normalizedType"
       AND (
         entity."normalizedName" = requested."normalizedName"
         OR EXISTS (
           SELECT 1
           FROM "GraphEntityAlias" AS alias
           WHERE alias."entityId" = entity."id"
             AND alias."projectId" = ${input.projectId}::uuid
             AND alias."normalizedAlias" = requested."normalizedName"
         )
       )
    )
    SELECT "requestOrdinal",
           "id",
           ("matchRank" > ${MAX_ENTITY_CANDIDATE_SCAN}) AS "overflow"
    FROM ranked
    WHERE "matchRank" <= ${MAX_ENTITY_CANDIDATE_SCAN + 1}
    ORDER BY "requestOrdinal" ASC, "matchRank" ASC
    LIMIT ${requestedValues.length * (MAX_ENTITY_CANDIDATE_SCAN + 1)}
  `);
  const scannedIds = scanRows
    .filter((row) => !row.overflow)
    .map((row) => row.id);
  const candidateIds = [
    ...new Set([
      ...exactCandidates.map((candidate) => candidate.id),
      ...scannedIds,
    ]),
  ];
  const entities = await db.graphEntity.findMany({
    where: {
      id: { in: candidateIds },
      projectId: input.projectId,
      generationId: input.generationId,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      entityType: true,
      canonicalName: true,
      normalizedName: true,
      description: true,
      aliases: {
        orderBy: [{ normalizedAlias: "asc" }, { id: "asc" }],
        take: MAX_ENTITY_ALIASES,
        select: { alias: true, normalizedAlias: true },
      },
    },
  });
  const entitiesById = new Map(entities.map((entity) => [entity.id, entity]));
  const exactIds = new Set(exactCandidates.map((candidate) => candidate.id));
  const rawUniqueIdentities = new Set(
    entities
      .filter((entity) => exactIds.has(entity.id))
      .map((entity) =>
        rawUniqueIdentity(entity.entityType, entity.normalizedName),
      ),
  );
  const overflowIdentities = new Set(
    scanRows
      .filter((row) => row.overflow)
      .map((row) => requestedValues[row.requestOrdinal]!.identity),
  );
  const scanIdsByOrdinal = new Map<number, string[]>();
  for (const row of scanRows) {
    if (row.overflow) continue;
    const ids = scanIdsByOrdinal.get(row.requestOrdinal) ?? [];
    ids.push(row.id);
    scanIdsByOrdinal.set(row.requestOrdinal, ids);
  }
  const candidatesByIdentity = new Map<string, ExistingEntity[]>();
  for (const value of requestedValues) {
    const candidates = new Map<string, ExistingEntity>();
    for (const entity of entities) {
      if (
        exactIds.has(entity.id) &&
        entity.entityType === value.entityType &&
        entity.normalizedName === value.normalizedName
      ) {
        candidates.set(entity.id, entity);
      }
    }
    for (const id of scanIdsByOrdinal.get(value.requestOrdinal) ?? []) {
      const entity = entitiesById.get(id);
      if (!entity) continue;
      if (
        resolveEntityCandidates([entity], {
          name: value.name,
          type: value.entityType,
        })
      ) {
        candidates.set(entity.id, entity);
      }
      if (candidates.size >= 2) break;
    }
    candidatesByIdentity.set(value.identity, [...candidates.values()]);
  }
  return {
    candidatesByIdentity,
    rawUniqueIdentities,
    overflowIdentities,
  };
}

function loadEntitiesById(
  client: Db,
  input: EnrichGenerationDocumentInput,
  ids: string[],
) {
  return client.graphEntity.findMany({
    where: {
      projectId: input.projectId,
      generationId: input.generationId,
      id: { in: ids },
    },
    select: {
      id: true,
      entityType: true,
      canonicalName: true,
      normalizedName: true,
      description: true,
      aliases: {
        orderBy: [{ normalizedAlias: "asc" }, { id: "asc" }],
        take: MAX_ENTITY_ALIASES,
        select: { alias: true, normalizedAlias: true },
      },
    },
  });
}

const MAX_ENTITY_EMBEDDING_REPAIRS = 200;

/**
 * Re-embeds entities that still have live provenance but no vector. A changed
 * canonical description deletes the vector, and the enrichment that caused it
 * only re-embeds the entities of its own extraction — so an entity dropped
 * from that document, or supported only by other documents after a delete,
 * would otherwise stay out of semantic entity search. No re-extraction: the
 * text is rebuilt from the stored entity.
 */
export async function repairMissingEntityEmbeddings(
  db: PrismaClient,
  provider: AiProvider,
  input: EnrichGenerationDocumentInput,
  options?: AiCallOptions,
): Promise<number> {
  assertIdentity(input);
  if (!(await compatibleTarget(db, input))) return 0;
  if (!input.processingClaimToken)
    await db.knowledgeGenerationDocument.updateMany({
      where: {
        projectId: input.projectId,
        generationId: input.generationId,
        documentId: input.documentId,
        targetSha: input.sourceCommitSha,
        configFingerprint: input.configFingerprint,
        status: "ready",
        semanticIndexedSha: input.sourceCommitSha,
        graphIndexedSha: input.sourceCommitSha,
        processingClaimToken: { not: null },
        OR: [
          { lastAttemptAt: null },
          {
            lastAttemptAt: {
              lte: new Date(
                Date.now() - KNOWLEDGE_ENRICHMENT_EXPIRE_IN_SECONDS * 1000,
              ),
            },
          },
        ],
      },
      data: {
        processingClaimToken: null,
        processingJobId: null,
        processingRetryCount: null,
        completedAt: new Date(),
      },
    });
  const orphans = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT entity."id"::text AS "id"
    FROM "GraphEntity" entity
    WHERE entity."projectId" = ${input.projectId}::uuid
      AND entity."generationId" = ${input.generationId}::uuid
      AND EXISTS (
        SELECT 1 FROM "EntityMention" mention
        WHERE mention."entityId" = entity."id"
          AND mention."generationId" = entity."generationId"
          AND mention."invalidatedAt" IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM "KnowledgeEmbedding" embedding
        WHERE embedding."generationId" = entity."generationId"
          AND embedding."ownerType" = 'entity'
          AND embedding."ownerId" = entity."id"::text
      )
    ORDER BY entity."id"
    LIMIT ${MAX_ENTITY_EMBEDDING_REPAIRS}
  `);
  if (orphans.length === 0) return 0;
  const orphanIds = orphans.map((orphan) => orphan.id);
  const entities = (await loadEntitiesById(db, input, orphanIds)).map(
    (entity) => ({
      ...entity,
      isNew: false,
    }),
  );

  const usageRecords: UsageRecord[] = [];
  let embeddings: EntityEmbedding[];
  try {
    embeddings = await stageEntityEmbeddings(
      db,
      provider,
      input,
      entities,
      usageRecords,
      options,
    );
  } catch (error) {
    if (options?.signal?.aborted)
      await cancelWithUsage(db, input, usageRecords);
    await persistUsageRecords(db, input, usageRecords);
    throw error;
  }
  return knowledgeTransaction(db, async (tx) => {
    // Skip an entity whose text changed meanwhile; the next pass repairs it.
    const current = new Map(
      (await loadEntitiesById(tx, input, orphanIds)).map((entity) => [
        entity.id,
        contentHash(canonicalEntityText({ ...entity, isNew: false })),
      ]),
    );
    const fresh = embeddings.filter(
      (embedding) => current.get(embedding.entity.id) === embedding.contentHash,
    );
    await tx.knowledgeEmbedding.deleteMany({
      where: {
        generationId: input.generationId,
        ownerType: "entity",
        ownerId: { in: fresh.map((embedding) => embedding.entity.id) },
      },
    });
    for (const embedding of fresh)
      await insertEntityEmbedding(tx, input, embedding.entity.id, embedding);
    for (const record of usageRecords)
      await recordEnrichmentUsage(tx, input, record);
    return fresh.length;
  });
}

/** A carried graph is already published; only the entities this document mentions still need vectors. */
async function embedDocumentEntities(
  db: PrismaClient,
  provider: AiProvider,
  input: EnrichGenerationDocumentInput,
  options?: AiCallOptions,
): Promise<number> {
  const missing = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT entity."id"::text AS "id"
    FROM "GraphEntity" entity
    WHERE entity."projectId" = ${input.projectId}::uuid
      AND entity."generationId" = ${input.generationId}::uuid
      AND EXISTS (
        SELECT 1 FROM "EntityMention" mention
        WHERE mention."entityId" = entity."id"
          AND mention."generationId" = entity."generationId"
          AND mention."documentId" = ${input.documentId}::uuid
          AND mention."sourceCommitSha" = ${input.sourceCommitSha}
          AND mention."invalidatedAt" IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM "KnowledgeEmbedding" embedding
        WHERE embedding."generationId" = entity."generationId"
          AND embedding."ownerType" = 'entity'
          AND embedding."ownerId" = entity."id"::text
      )
    ORDER BY entity."id"
  `);
  if (missing.length === 0) return 0;
  const ids = missing.map((row) => row.id);
  const entities = (await loadEntitiesById(db, input, ids)).map((entity) => ({
    ...entity,
    isNew: false,
  }));
  const usageRecords: UsageRecord[] = [];
  let embeddings: EntityEmbedding[];
  try {
    embeddings = await stageEntityEmbeddings(
      db,
      provider,
      input,
      entities,
      usageRecords,
      options,
    );
  } catch (error) {
    if (options?.signal?.aborted)
      await cancelWithUsage(db, input, usageRecords);
    await persistUsageRecords(db, input, usageRecords);
    throw error;
  }
  return knowledgeTransaction(db, async (tx) => {
    // An entity whose text changed meanwhile is left to the repair pass.
    const current = new Map(
      (await loadEntitiesById(tx, input, ids)).map((entity) => [
        entity.id,
        contentHash(canonicalEntityText({ ...entity, isNew: false })),
      ]),
    );
    let inserted = 0;
    for (const embedding of embeddings) {
      if (current.get(embedding.entity.id) !== embedding.contentHash) continue;
      inserted += await insertEntityEmbedding(
        tx,
        input,
        embedding.entity.id,
        embedding,
        { ignoreExisting: true },
      );
    }
    for (const record of usageRecords)
      await recordEnrichmentUsage(tx, input, record);
    return inserted;
  });
}

async function stageEntityEmbeddings(
  db: PrismaClient,
  provider: AiProvider,
  input: EnrichGenerationDocumentInput,
  entities: ResolvedEntity[],
  usageRecords: UsageRecord[],
  options?: AiCallOptions,
  stagedVectors = new Map<string, number[]>(),
): Promise<EntityEmbedding[]> {
  const pending = entities.map((entity) => {
    const canonicalText = canonicalEntityText(entity);
    return {
      entity,
      canonicalText,
      contentHash: contentHash(canonicalText),
    };
  });
  const reusable = await loadCompatibleEntityEmbeddings(
    db,
    input,
    pending.map((embedding) => embedding.contentHash),
  );
  const embeddings: EntityEmbedding[] = [];
  const missing: typeof pending = [];
  for (const embedding of pending) {
    const vector =
      stagedVectors.get(embedding.contentHash) ??
      reusable.get(embedding.contentHash);
    if (vector) {
      embeddings.push({ ...embedding, vector, reused: true });
    } else {
      missing.push(embedding);
    }
  }

  for (const batch of makeEmbeddingBatches(
    missing,
    provider,
    (embedding) => embedding.canonicalText,
  )) {
    throwIfAborted(options?.signal);
    try {
      const result = await provider.embed(
        batch.map((embedding) => embedding.canonicalText),
        options,
      );
      if (options?.signal?.aborted) {
        usageRecords.push(
          successRecord("entity_embedding", input.embeddingModel, result.usage),
        );
        throw cancellationError();
      }
      assertEmbeddingResult(result, batch.length, input.embeddingDimensions);
      usageRecords.push(
        successRecord("entity_embedding", input.embeddingModel, result.usage),
      );
      for (let index = 0; index < batch.length; index += 1) {
        stagedVectors.set(batch[index]!.contentHash, result.vectors[index]!);
        embeddings.push({
          ...batch[index]!,
          vector: result.vectors[index]!,
          reused: false,
        });
      }
    } catch (error) {
      if (options?.signal?.aborted) {
        const usage = reportedUsageOf(error);
        if (usage) {
          usageRecords.push(
            successRecord("entity_embedding", input.embeddingModel, usage),
          );
        }
        throw cancellationError();
      }
      usageRecords.push(
        usageRecordForFailure("entity_embedding", input.embeddingModel, error),
      );
      throw error;
    }
  }
  return embeddings;
}

async function publishResolutionPlan(
  tx: Prisma.TransactionClient,
  input: EnrichGenerationDocumentInput,
  plan: ResolutionPlan,
  embeddings: EntityEmbedding[],
): Promise<void> {
  const publishedAt = new Date();
  await tx.entityMention.updateMany({
    where: {
      projectId: input.projectId,
      generationId: input.generationId,
      documentId: input.documentId,
      sourceCommitSha: { not: input.sourceCommitSha },
      invalidatedAt: null,
    },
    data: { invalidatedAt: publishedAt },
  });
  await tx.relationEvidence.updateMany({
    where: {
      projectId: input.projectId,
      generationId: input.generationId,
      documentId: input.documentId,
      sourceCommitSha: { not: input.sourceCommitSha },
      invalidatedAt: null,
    },
    data: { invalidatedAt: publishedAt },
  });
  await tx.entityMention.deleteMany({
    where: {
      projectId: input.projectId,
      generationId: input.generationId,
      documentId: input.documentId,
      sourceCommitSha: input.sourceCommitSha,
    },
  });
  await tx.relationEvidence.deleteMany({
    where: {
      projectId: input.projectId,
      generationId: input.generationId,
      documentId: input.documentId,
      sourceCommitSha: input.sourceCommitSha,
    },
  });

  const actualEntityIds = new Map<string, string>();
  const aliasRows: Array<{
    projectId: string;
    entityId: string;
    alias: string;
    normalizedAlias: string;
  }> = [];
  for (const entity of plan.entities) {
    const actual = await publishEntity(tx, input, entity);
    actualEntityIds.set(entity.id, actual.id);
    for (const alias of entity.aliases) {
      aliasRows.push({
        projectId: input.projectId,
        entityId: actual.id,
        alias: alias.alias,
        normalizedAlias: alias.normalizedAlias,
      });
    }
  }
  if (aliasRows.length > 0) {
    await tx.graphEntityAlias.createMany({
      data: aliasRows,
      skipDuplicates: true,
    });
  }

  if (plan.mentions.length > 0) {
    await tx.entityMention.createMany({
      data: plan.mentions.map((mention) => ({
        projectId: input.projectId,
        generationId: input.generationId,
        entityId: actualEntityIds.get(mention.entity.id)!,
        documentId: input.documentId,
        sourceChunkId: mention.chunk.id,
        sourceCommitSha: input.sourceCommitSha,
        mentionText: mention.mentionText,
        sourceDescription: mention.description,
        confidence: mention.confidence,
        validFrom: null,
        validTo: null,
        recordedAt: publishedAt,
      })),
    });
  }

  await refreshEntityDescriptions(tx, input);

  const embeddingOwnerIds = [
    ...new Set(
      embeddings.map((embedding) => actualEntityIds.get(embedding.entity.id)!),
    ),
  ];
  if (embeddingOwnerIds.length > 0) {
    await tx.knowledgeEmbedding.deleteMany({
      where: {
        generationId: input.generationId,
        ownerType: "entity",
        ownerId: { in: embeddingOwnerIds },
      },
    });
  }
  const insertedEmbeddingIds = new Set<string>();
  for (const embedding of embeddings) {
    const ownerId = actualEntityIds.get(embedding.entity.id)!;
    if (insertedEmbeddingIds.has(ownerId)) continue;
    insertedEmbeddingIds.add(ownerId);
    await insertEntityEmbedding(tx, input, ownerId, embedding);
  }

  const evidenceRows = [];
  for (const relation of plan.relations) {
    const sourceEntityId = actualEntityIds.get(relation.sourceEntity.id)!;
    const targetEntityId = actualEntityIds.get(relation.targetEntity.id)!;
    const publishedRelation = await tx.graphRelation.upsert({
      where: {
        generationId_sourceEntityId_targetEntityId_normalizedType: {
          generationId: input.generationId,
          sourceEntityId,
          targetEntityId,
          normalizedType: relation.normalizedType,
        },
      },
      create: {
        projectId: input.projectId,
        generationId: input.generationId,
        sourceEntityId,
        targetEntityId,
        relationType: relation.relationType,
        normalizedType: relation.normalizedType,
      },
      update: { relationType: relation.relationType },
    });
    evidenceRows.push({
      projectId: input.projectId,
      generationId: input.generationId,
      relationId: publishedRelation.id,
      documentId: input.documentId,
      sourceChunkId: relation.chunk.id,
      sourceCommitSha: input.sourceCommitSha,
      evidenceText: relation.evidenceText,
      confidence: relation.confidence,
      validFrom: relation.validFrom,
      validTo: relation.validTo,
      recordedAt: publishedAt,
    });
  }
  if (evidenceRows.length > 0) {
    await tx.relationEvidence.createMany({ data: evidenceRows });
  }

  await tx.knowledgeGenerationDocument.update({
    where: {
      generationId_documentId: {
        generationId: input.generationId,
        documentId: input.documentId,
      },
    },
    data: {
      semanticIndexedSha: input.sourceCommitSha,
      graphIndexedSha: input.sourceCommitSha,
      status: "ready",
      failureKind: null,
      failureSummary: null,
      completedAt: publishedAt,
      extractionFingerprint: input.extractionFingerprint,
      extractionModel: input.extractionModel.slice(0, 200),
    },
  });
  await tx.knowledgeGeneration.update({
    where: { id: input.generationId },
    data: { documentReadyCount: { increment: 1 } },
  });
}

async function compatibleTarget(
  db: Db,
  input: EnrichGenerationDocumentInput,
): Promise<TargetRow | null> {
  return loadKnowledgeTarget(db, input, { requireKeywordReady: true });
}

async function lockCompatibleTarget(
  tx: Prisma.TransactionClient,
  input: EnrichGenerationDocumentInput,
): Promise<TargetRow | null> {
  return loadKnowledgeTarget(tx, input, {
    lock: true,
    requireKeywordReady: true,
  });
}

async function publishEntity(
  tx: Prisma.TransactionClient,
  input: EnrichGenerationDocumentInput,
  entity: ResolvedEntity,
) {
  const existing = await tx.graphEntity.findFirst({
    where: {
      id: entity.id,
      projectId: input.projectId,
      generationId: input.generationId,
    },
  });
  if (existing) {
    return tx.graphEntity.update({
      where: { id: existing.id },
      data: { description: existing.description ?? entity.description },
    });
  }
  return tx.graphEntity.create({
    data: {
      id: entity.id,
      projectId: input.projectId,
      generationId: input.generationId,
      entityType: entity.entityType,
      canonicalName: entity.canonicalName,
      normalizedName: entity.normalizedName,
      description: entity.description,
    },
  });
}

async function loadCompatibleEntityEmbeddings(
  db: Db,
  input: EnrichGenerationDocumentInput,
  hashes: string[],
): Promise<Map<string, number[]>> {
  if (hashes.length === 0) return new Map();
  const rows = await db.$queryRaw<ReusableEmbeddingRow[]>(Prisma.sql`
    SELECT DISTINCT ON (source."contentHash")
           source."contentHash" AS "contentHash",
           source."embedding"::text AS "embedding"
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
      AND source."ownerType" = 'entity'
      AND source."contentHash" IN (${Prisma.join(hashes)})
      AND source."configFingerprint" = source_generation."configFingerprint"
      AND source."embeddingDimensions" = ${input.embeddingDimensions}
    ORDER BY source."contentHash" ASC, source."createdAt" DESC, source."id" DESC
  `);
  const reusable = new Map<string, number[]>();
  for (const row of rows) {
    try {
      const vector = pgvector.fromSql(row.embedding);
      if (!Array.isArray(vector)) continue;
      assertVector(vector, input.embeddingDimensions);
      reusable.set(row.contentHash, [...vector]);
    } catch {
      continue;
    }
  }
  return reusable;
}

async function insertEntityEmbedding(
  tx: Prisma.TransactionClient,
  input: EnrichGenerationDocumentInput,
  ownerId: string,
  embedding: EntityEmbedding,
  options: { ignoreExisting?: boolean } = {},
): Promise<number> {
  assertVector(embedding.vector, input.embeddingDimensions);
  const sqlVector = pgvector.toSql(embedding.vector);
  if (sqlVector === null) {
    throw validationError("AI provider returned invalid embeddings");
  }
  return tx.$executeRaw(Prisma.sql`
    INSERT INTO "KnowledgeEmbedding"
      ("id", "projectId", "generationId", "ownerType", "ownerId",
       "contentHash", "configFingerprint", "model",
       "embeddingDimensions", "embedding", "createdAt")
    VALUES
      (${randomUUID()}::uuid, ${input.projectId}::uuid,
       ${input.generationId}::uuid, 'entity', ${ownerId},
       ${embedding.contentHash}, ${input.configFingerprint},
       ${input.embeddingModel}, ${input.embeddingDimensions},
       ${sqlVector}::vector, ${UTC_NOW})
    ${options.ignoreExisting ? Prisma.sql`ON CONFLICT ("generationId", "ownerType", "ownerId") DO NOTHING` : Prisma.empty}
  `);
}

function resolutionIdentity(name: string, entityType: string): string {
  return `${normalizeKnowledgeName(entityType)}\0${normalizeKnowledgeName(name)}`;
}

function disambiguatedNormalizedName(
  normalizedName: string,
  entityId: string,
): string {
  return `${normalizedName}::${entityId}`;
}

function rawUniqueIdentity(entityType: string, normalizedName: string): string {
  return `${entityType}\0${normalizedName}`;
}

function resolutionPlanSignature(
  entities: ResolvedEntity[],
  mentions: StagedMention[],
  relations: StagedRelation[],
): string {
  return contentHash(
    JSON.stringify({
      entities: entities
        .map((entity) => [
          entity.id,
          canonicalEntityText({ ...entity, description: null }),
        ])
        .sort((left, right) => left[0]!.localeCompare(right[0]!)),
      mentions: mentions.map((mention) => [
        mention.chunk.id,
        mention.mentionText,
        mention.entity.id,
      ]),
      relations: relations.map((relation) => [
        relation.chunk.id,
        relation.sourceEntity.id,
        relation.targetEntity.id,
        relation.normalizedType,
      ]),
    }),
  );
}

function mergeAliases(entity: ResolvedEntity, aliases: string[]): void {
  const known = new Set(entity.aliases.map((alias) => alias.normalizedAlias));
  for (const alias of aliases) {
    if (entity.aliases.length >= MAX_ENTITY_ALIASES) break;
    const normalizedAlias = normalizeKnowledgeName(alias);
    if (!normalizedAlias || known.has(normalizedAlias)) continue;
    known.add(normalizedAlias);
    entity.aliases.push({ alias, normalizedAlias });
  }
  entity.aliases.sort((left, right) =>
    left.normalizedAlias.localeCompare(right.normalizedAlias),
  );
}

function uniqueMentionedEntities(mentions: StagedMention[]): ResolvedEntity[] {
  const entities = new Map<string, ResolvedEntity>();
  for (const mention of mentions) {
    entities.set(mention.entity.id, mention.entity);
  }
  return [...entities.values()];
}

function canonicalEntityText(entity: ResolvedEntity): string {
  const aliases = entity.aliases
    .map((alias) => alias.alias)
    .sort((left, right) => left.localeCompare(right));
  return `${entity.canonicalName}\nType: ${entity.entityType}\nAliases: ${aliases.join(", ")}\n${entity.description ?? ""}`;
}

function relationCount(plan: ResolutionPlan): number {
  return new Set(
    plan.relations.map((relation) =>
      JSON.stringify([
        relation.sourceEntity.id,
        relation.targetEntity.id,
        relation.normalizedType,
      ]),
    ),
  ).size;
}

function assertTemporalValidity(extraction: ExtractionResponse): void {
  const issues = describeTemporalIssues(extraction);
  if (!issues.length) return;
  throw validationError("AI provider returned invalid extraction", undefined, {
    stage: "temporal",
    issueCount: issues.length,
    issues: issues.slice(0, MAX_EXTRACTION_ISSUE_SUMMARIES),
  });
}

function schemaFailureDetails(error: unknown): AiProviderErrorDetails {
  if (error instanceof ZodError) {
    return {
      stage: "schema",
      issueCount: error.issues.length,
      issues: describeExtractionIssues(error.issues),
    };
  }
  return { stage: "schema" };
}

function assertDocumentExtractionBounds(
  entities: number,
  relations: number,
  usage: AiUsageSample,
): void {
  if (
    entities > MAX_DOCUMENT_ENTITY_OCCURRENCES ||
    relations > MAX_DOCUMENT_RELATIONS
  ) {
    throw validationError("Document extraction output exceeds limits", usage);
  }
}

function assertChunksAreBounded(chunks: SourceChunk[]): void {
  if (chunks.length > MAX_EXTRACTION_CHUNKS) {
    throw validationError("Document extraction input exceeds limits");
  }
}

function assertEmbeddingResult(
  result: EmbeddingResult,
  expectedCount: number,
  dimensions: number,
): void {
  if (result.vectors.length !== expectedCount) {
    throw validationError(
      "AI provider returned invalid embeddings",
      result.usage,
    );
  }
  for (const vector of result.vectors)
    assertVector(vector, dimensions, result.usage);
}

function assertIdentity(input: EnrichGenerationDocumentInput): void {
  if (
    !isSupportedKnowledgeDimensions(input.embeddingDimensions) ||
    !input.providerName.trim() ||
    !input.extractionProviderName.trim() ||
    !input.extractionModel.trim() ||
    !input.extractionFingerprint.trim() ||
    !input.embeddingModel.trim() ||
    !input.configFingerprint.trim()
  ) {
    throw validationError("Invalid enrichment configuration");
  }
}

function targetIsPublished(
  target: TargetRow,
  input: EnrichGenerationDocumentInput,
): boolean {
  return (
    target.semanticIndexedSha === input.sourceCommitSha &&
    target.graphIndexedSha === input.sourceCommitSha
  );
}

function isValidationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "ZodError" ||
      (error instanceof AiProviderError && error.kind === "validation"))
  );
}

function successRecord(
  operation: UsageRecord["operation"],
  model: string,
  usage: AiUsageSample,
): UsageRecord {
  return { operation, model, usage, outcome: "success" };
}

// callExtraction attaches a completed call's usage to its validation errors only.
function reportedUsageOf(error: unknown): AiUsageSample | undefined {
  return error instanceof AiProviderError && error.kind === "validation"
    ? (error.usage ?? undefined)
    : undefined;
}

function usageRecordForFailure(
  operation: UsageRecord["operation"],
  model: string,
  error: unknown,
): UsageRecord {
  if (error instanceof AiProviderError) {
    return {
      operation,
      model,
      usage: error.usage ?? emptyUsage(0),
      outcome:
        error.kind === "validation" ? "validation_failure" : "provider_failure",
    };
  }
  return {
    operation,
    model,
    usage: emptyUsage(0),
    outcome: "provider_failure",
  };
}

async function persistUsageRecords(
  db: PrismaClient,
  input: EnrichGenerationDocumentInput,
  records: UsageRecord[],
): Promise<void> {
  if (records.length === 0) return;
  await knowledgeTransaction(db, async (tx) => {
    for (const record of records) {
      await recordEnrichmentUsage(tx, input, record);
    }
  });
}

async function cancelWithUsage(
  db: PrismaClient,
  input: EnrichGenerationDocumentInput,
  records: UsageRecord[],
): Promise<never> {
  try {
    await persistUsageRecords(
      db,
      input,
      records.map((record) => ({ ...record, outcome: "stale_discarded" })),
    );
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
      details: { usageOutcome: "stale_discarded", failureKind: "accounting" },
    });
  }
  throw cancellationError();
}

async function recordUsageWithOutcome(
  db: Db,
  input: EnrichGenerationDocumentInput,
  records: UsageRecord[],
  outcome: AiUsageOutcome,
): Promise<void> {
  for (const record of records) {
    await recordEnrichmentUsage(db, input, { ...record, outcome });
  }
}

async function recordEnrichmentUsage(
  db: Db,
  input: EnrichGenerationDocumentInput,
  record: UsageRecord,
): Promise<void> {
  const isExtraction = record.operation === "document_graph_extraction";
  await recordAiUsage(db, {
    projectId: input.projectId,
    operation: record.operation,
    jobId: input.jobId,
    runId: input.runId,
    documentId: input.documentId,
    provider: isExtraction ? input.extractionProviderName : input.providerName,
    connectionId: isExtraction
      ? input.extractionConnectionId
      : input.embeddingConnectionId,
    model: record.model,
    configFingerprint: input.configFingerprint,
    usage: record.usage,
    outcome: record.outcome,
    pricing: isExtraction
      ? {
          inputCostMicrosPerMillion: input.extractionInputCostMicrosPerMillion,
          outputCostMicrosPerMillion:
            input.extractionOutputCostMicrosPerMillion,
        }
      : input,
    currency: isExtraction ? input.extractionCurrency : input.currency,
  });
}

function safeProviderError(error: unknown, message: string): unknown {
  if (error instanceof AiProviderError) return error;
  return new AiProviderError(message, {
    kind: "provider",
    retryable: false,
  });
}

function staleResult() {
  return {
    outcome: "stale" as const,
    entityCount: 0,
    relationCount: 0,
    embeddedCount: 0,
    reusedCount: 0,
  };
}

function emptyEnrichedResult() {
  return {
    outcome: "enriched" as const,
    entityCount: 0,
    relationCount: 0,
    embeddedCount: 0,
    reusedCount: 0,
  };
}

function enrichedResult(plan: ResolutionPlan, embeddings: EntityEmbedding[]) {
  return {
    outcome: "enriched" as const,
    entityCount: plan.entities.length,
    relationCount: relationCount(plan),
    embeddedCount: embeddings.filter((embedding) => !embedding.reused).length,
    reusedCount: embeddings.filter((embedding) => embedding.reused).length,
  };
}

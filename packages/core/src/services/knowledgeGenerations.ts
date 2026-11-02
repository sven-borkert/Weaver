import { randomUUID } from "node:crypto";
import { isAiExempt } from "../knowledge/aiExempt";
import { carryForwardGraph } from "./knowledgeCarryForward";
import { knowledgeTransaction } from "./knowledgeTargets";
import { refreshEntityDescriptions } from "./knowledgeEntityDescriptions";
import { throwIfAborted, cancellationError } from "../ai/knowledgeCalls";
import { lockLiveKnowledgeProject as lockLiveProject } from "./knowledgeTargets";
import {
  Prisma,
  type KnowledgeFailureKind,
  type KnowledgeGeneration,
  type KnowledgeGenerationTrigger,
  type PrismaClient,
} from "@weaver/db/client";
import {
  LAST_ROUTING_CHANGE_SETTING,
  type KnowledgeRoutingChangeRecord,
} from "./knowledgeRoutingChange";
import type { AiProvider } from "../ai/types";
import type { AiCallOptions } from "../ai/types";
import { AiProviderError } from "../ai/types";
import type { AiProviderErrorDetails } from "../ai/types";
import {
  captureError,
  emitDiagnostic,
  reserveDiagnosticEvent,
} from "../diagnostics/writer";
import { withReference } from "../diagnostics/reference";
import { summarizeError } from "../diagnostics/errorSummary";
import { requestKnowledgeJob } from "../jobs/queue";
import type { KnowledgeSystemContext } from "../jobs/systemContext";
import {
  KNOWLEDGE_ENRICHMENT_DEADLINE_MS,
  KNOWLEDGE_ENRICHMENT_EXPIRE_IN_SECONDS,
  type KnowledgeJobPayloads,
} from "../jobs/types";
import { UTC_NOW } from "./sql";
import { embedGenerationDocument } from "./knowledgeEmbeddings";
import {
  enrichGenerationDocument,
  repairMissingEntityEmbeddings,
  type EnrichGenerationDocumentInput,
} from "./knowledgeEnrichment";
import type { KnowledgeRouteSnapshot } from "./llmRoutes";
import { isSupportedKnowledgeDimensions } from "../knowledge/dimensions";

const MAX_DOCUMENT_ENRICHMENT_ATTEMPTS = 6;
const SUPERSEDED_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const CONFIGURATION_FAILURE_SUMMARY = "AI configuration is unavailable";
const GENERATION_BATCH_SIZE = 200;
const GENERATION_CLEANUP_BATCH_SIZE = 200;
const PROCESSING_CLAIM_TIMEOUT_MS =
  KNOWLEDGE_ENRICHMENT_EXPIRE_IN_SECONDS * 1_000;
const ROUTING_CHANGE_ATTRIBUTION_MS = 24 * 60 * 60 * 1000;

export type GenerationConfiguration = {
  projectId: string;
  configFingerprint: string;
  embeddingModel: string;
  embeddingDimensions: number;
  extractionSchemaVersion: number;
  promptVersion: string;
  routeSnapshot: KnowledgeRouteSnapshot | null;
};

type GenerationBuildPayload = KnowledgeJobPayloads["project.generation-build"];
type GenerationDocumentPayload = KnowledgeJobPayloads["document.ai-enrich"];
type ContentDeletePayload = KnowledgeJobPayloads["content.delete"];
type ProcessingInput = GenerationDocumentPayload & {
  processingClaimToken?: string;
};
type ProcessingDelivery = { jobId: string | null; retryCount: number | null };
type Db = PrismaClient | Prisma.TransactionClient;

type LockedGeneration = {
  id: string;
  projectId: string;
  configFingerprint: string;
  status: "building" | "active" | "failed" | "superseded";
};
type LockedGenerationDocument = {
  targetSha: string;
  semanticIndexedSha: string | null;
  graphIndexedSha: string | null;
  configFingerprint: string;
  attempts: number;
  failureKind: KnowledgeFailureKind | null;
  lastAttemptAt: Date | null;
  completedAt: Date | null;
  processingClaimToken: string | null;
  processingJobId: string | null;
  processingRetryCount: number | null;
  status:
    | "pending"
    | "processing"
    | "ready"
    | "failed"
    | "blocked_configuration"
    | "missing";
};
type LiveDocument = {
  id: string;
  path: string;
  headCommitSha: string;
  wikiSourceItemId?: string | null;
};
type GenerationCounts = { total: number; ready: number; failed: number };

export async function ensureGenerationForCurrentConfig(
  context: KnowledgeSystemContext,
  db: PrismaClient,
  configuration: GenerationConfiguration,
): Promise<KnowledgeGeneration | null> {
  void context;
  assertGenerationConfiguration(configuration);
  const result = await knowledgeTransaction(db, async (tx) => {
    if (!(await lockLiveProject(tx, configuration.projectId))) return null;
    const superseded = await tx.knowledgeGeneration.updateManyAndReturn({
      where: {
        projectId: configuration.projectId,
        status: "building",
        configFingerprint: { not: configuration.configFingerprint },
      },
      data: { status: "superseded", supersededAt: new Date() },
      select: { id: true, graphSourceGenerationId: true },
    });
    // A superseded generation with no graph source was re-extracting; don't paper over that with a carried graph.
    const supersededReextraction = superseded.some(
      (generation) => generation.graphSourceGenerationId === null,
    );
    const candidates = await tx.knowledgeGeneration.findMany({
      where: {
        projectId: configuration.projectId,
        configFingerprint: configuration.configFingerprint,
        embeddingDimensions: configuration.embeddingDimensions,
        extractionSchemaVersion: configuration.extractionSchemaVersion,
        status: { in: ["active", "building"] },
      },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    });
    const active = candidates.find(
      (candidate) => candidate.status === "active",
    );
    if (active)
      return {
        generation: active,
        resume: false,
        created: false,
        superseded,
        carried: null,
      };
    const building = candidates.find(
      (candidate) => candidate.status === "building",
    );
    if (building)
      return {
        generation: building,
        resume: true,
        created: false,
        superseded,
        carried: null,
      };
    const previous = await tx.knowledgeGeneration.findFirst({
      where: { projectId: configuration.projectId, status: "active" },
      select: {
        id: true,
        configFingerprint: true,
        extractionSchemaVersion: true,
        routeSnapshot: true,
      },
    });
    const attribution = await generationAttribution(
      tx,
      configuration,
      previous,
    );
    const graphSource =
      !supersededReextraction &&
      previous &&
      previous.routeSnapshot !== null &&
      previous.extractionSchemaVersion === configuration.extractionSchemaVersion
        ? previous.id
        : null;
    const generation = await createGenerationSnapshot(
      tx,
      configuration,
      attribution,
      graphSource,
    );
    const carried = graphSource
      ? await carryForwardGraph(tx, {
          projectId: configuration.projectId,
          sourceGenerationId: graphSource,
          targetGenerationId: generation.id,
          configFingerprint: generation.configFingerprint,
        })
      : null;
    return { generation, resume: true, created: true, superseded, carried };
  });
  if (!result) return null;
  for (const { id } of result.superseded) {
    emitDiagnostic({
      event: "knowledge.generation.superseded",
      message: `generation ${id.slice(0, 8)} superseded after configuration changed`,
      projectId: configuration.projectId,
      generationId: id,
      details: { replacementGenerationId: result.generation.id },
    });
  }
  if (result.created) emitGenerationCreated(result.generation);
  if (result.carried && result.generation.graphSourceGenerationId) {
    emitDiagnostic({
      event: "knowledge.generation.graph_carried",
      message: `generation ${result.generation.id.slice(0, 8)} reuses the graph of ${result.generation.graphSourceGenerationId.slice(0, 8)}`,
      projectId: configuration.projectId,
      generationId: result.generation.id,
      details: {
        sourceGenerationId: result.generation.graphSourceGenerationId,
        ...result.carried,
      },
    });
  }
  if (result.resume) {
    return resumeGenerationBuild(context, db, {
      projectId: result.generation.projectId,
      generationId: result.generation.id,
      configFingerprint: result.generation.configFingerprint,
    });
  }
  return result.generation;
}

/** @internal Explicit generation fixture; actor rebuilds use requestKnowledgeRebuild. */
export async function startGenerationBuild(
  context: KnowledgeSystemContext,
  db: PrismaClient,
  configuration: GenerationConfiguration,
): Promise<KnowledgeGeneration | null> {
  void context;
  assertGenerationConfiguration(configuration);
  const generation = await knowledgeTransaction(db, async (tx) => {
    if (!(await lockLiveProject(tx, configuration.projectId))) return null;
    return createGenerationSnapshot(tx, configuration, {
      buildTrigger: "initial",
      requestedById: null,
    });
  });
  if (!generation) return null;
  emitGenerationCreated(generation);
  return resumeGenerationBuild(context, db, {
    projectId: generation.projectId,
    generationId: generation.id,
    configFingerprint: generation.configFingerprint,
  });
}

export async function resumeGenerationBuild(
  context: KnowledgeSystemContext,
  db: PrismaClient,
  payload: GenerationBuildPayload,
): Promise<KnowledgeGeneration | null> {
  void context;
  const result = await knowledgeTransaction(db, async (tx) => {
    if (!(await lockLiveProject(tx, payload.projectId))) return null;
    const generation = await lockGeneration(tx, payload.generationId);
    if (
      generation?.projectId !== payload.projectId ||
      generation.status !== "building" ||
      generation.configFingerprint !== payload.configFingerprint
    ) {
      return null;
    }

    if (!payload.cursor) {
      await markMissingGenerationDocuments(
        tx,
        generation.id,
        payload.projectId,
      );
    }

    const page = await tx.document.findMany({
      where: {
        projectId: payload.projectId,
        ...(payload.cursor ? { id: { gt: payload.cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: GENERATION_BATCH_SIZE + 1,
      select: {
        id: true,
        path: true,
        headCommitSha: true,
        wikiSourceItemId: true,
      },
    });
    const hasMore = page.length > GENERATION_BATCH_SIZE;
    const pageDocuments = page.slice(0, GENERATION_BATCH_SIZE);
    await markExemptDocumentsReady(
      tx,
      generation,
      pageDocuments.filter(isAiExempt),
    );
    const documents = pageDocuments.filter((document) => !isAiExempt(document));
    const existingStates = await tx.knowledgeGenerationDocument.findMany({
      where: {
        generationId: generation.id,
        documentId: { in: documents.map((document) => document.id) },
      },
    });
    const stateByDocument = new Map(
      existingStates.map((state) => [state.documentId, state]),
    );

    const jobs: GenerationDocumentPayload[] = [];
    const keywordJobs: KnowledgeJobPayloads["document.search-sync"][] = [];
    const changedDocuments: LiveDocument[] = [];
    for (const document of documents) {
      const existing = stateByDocument.get(document.id) ?? null;
      if (
        existing?.status === "ready" &&
        existing.targetSha !== document.headCommitSha &&
        existing.semanticIndexedSha === existing.targetSha &&
        existing.graphIndexedSha === existing.targetSha &&
        existing.configFingerprint === generation.configFingerprint
      ) {
        keywordJobs.push({
          projectId: generation.projectId,
          documentId: document.id,
          sourceCommitSha: document.headCommitSha,
          pathAtSha: document.path,
        });
        continue;
      }
      changedDocuments.push(document);
      if (generationDocumentNeedsEnqueue(existing, document, generation)) {
        jobs.push(generationJob(generation, document));
      }
    }
    await bulkUpsertGenerationDocuments(tx, generation, changedDocuments);
    if (!hasMore) {
      await refreshGenerationCounters(tx, generation.id, payload.projectId);
    }
    const persisted = await tx.knowledgeGeneration.findUniqueOrThrow({
      where: { id: generation.id },
    });
    return {
      generation: persisted,
      jobs,
      keywordJobs,
      continuation:
        hasMore && pageDocuments.length > 0
          ? {
              projectId: payload.projectId,
              generationId: generation.id,
              configFingerprint: generation.configFingerprint,
              cursor: pageDocuments.at(-1)!.id,
            }
          : null,
    };
  });
  if (!result) return null;
  for (const job of result.keywordJobs)
    await requestKnowledgeJob("document.search-sync", job);
  await enqueueGenerationJobs(result.jobs);
  if (result.continuation) {
    await requestKnowledgeJob("project.generation-build", result.continuation);
  } else {
    await activateCompletedGeneration(context, db, {
      projectId: result.generation.projectId,
      generationId: result.generation.id,
    });
  }
  return loadGeneration(db, result.generation.id);
}

export async function recordDocumentChangeForGenerations(
  context: KnowledgeSystemContext,
  db: PrismaClient,
  payload: KnowledgeJobPayloads["document.search-sync"],
): Promise<number> {
  let exemptGenerations: string[] = [];
  const jobs = await knowledgeTransaction(db, async (tx) => {
    if (!(await lockLiveProject(tx, payload.projectId))) return [];
    const generations = await lockCurrentProjectGenerations(
      tx,
      payload.projectId,
    );
    const [document] = await tx.$queryRaw<LiveDocument[]>(Prisma.sql`
      SELECT "id", "path", "headCommitSha", "wikiSourceItemId"
      FROM "Document"
      WHERE "id" = ${payload.documentId}::uuid
        AND "projectId" = ${payload.projectId}::uuid
      FOR UPDATE
    `);
    if (
      document?.headCommitSha !== payload.sourceCommitSha ||
      document.path !== payload.pathAtSha
    ) {
      return [];
    }
    if (isAiExempt({ wikiSourceItemId: document.wikiSourceItemId ?? null })) {
      for (const generation of generations)
        await markExemptDocumentsReady(tx, generation, [document]);
      exemptGenerations = generations.map((generation) => generation.id);
      return [];
    }
    const pendingJobs: GenerationDocumentPayload[] = [];
    for (const generation of generations) {
      const existing = await tx.knowledgeGenerationDocument.findUnique({
        where: {
          generationId_documentId: {
            generationId: generation.id,
            documentId: payload.documentId,
          },
        },
      });
      if (generationDocumentNeedsEnqueue(existing, document, generation)) {
        await upsertPendingGenerationDocument(
          tx,
          generation,
          document,
          existing?.targetSha !== document.headCommitSha ||
            existing.configFingerprint !== generation.configFingerprint ||
            existing.status === "missing",
        );
        const contribution = persistedContribution(existing, generation);
        await adjustGenerationCounters(tx, generation.id, {
          total: existing ? 0 : 1,
          ready: -contribution.ready,
          failed: -contribution.failed,
        });
        pendingJobs.push(generationJob(generation, document));
      }
    }
    return pendingJobs;
  });
  for (const generationId of exemptGenerations)
    await activateCompletedGeneration(context, db, {
      projectId: payload.projectId,
      generationId,
    });
  return enqueueGenerationJobs(jobs);
}

/** A terminal ready row at the head commit, its counters refreshed; never a provider call. */
async function markExemptDocumentsReady(
  tx: Prisma.TransactionClient,
  generation: Pick<
    KnowledgeGeneration,
    "id" | "projectId" | "configFingerprint"
  >,
  documents: ReadonlyArray<Pick<LiveDocument, "id" | "headCommitSha">>,
): Promise<void> {
  if (documents.length === 0) return;
  for (const document of documents)
    await purgeDocumentAiState(tx, generation.projectId, document.id);
  const values = documents.map(
    (document) => Prisma.sql`
    (
      ${generation.id}::uuid,
      ${document.id}::uuid,
      ${generation.projectId}::uuid,
      ${document.headCommitSha},
      ${document.headCommitSha},
      ${document.headCommitSha},
      ${generation.configFingerprint},
      'ready'::"KnowledgeDocumentStatus",
      ${UTC_NOW},
      ${UTC_NOW},
      ${UTC_NOW}
    )
  `,
  );
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "KnowledgeGenerationDocument" (
      "generationId",
      "documentId",
      "projectId",
      "targetSha",
      "semanticIndexedSha",
      "graphIndexedSha",
      "configFingerprint",
      "status",
      "completedAt",
      "createdAt",
      "updatedAt"
    )
    VALUES ${Prisma.join(values)}
    ON CONFLICT ("generationId", "documentId") DO UPDATE SET
      "targetSha" = EXCLUDED."targetSha",
      "semanticIndexedSha" = EXCLUDED."semanticIndexedSha",
      "graphIndexedSha" = EXCLUDED."graphIndexedSha",
      "configFingerprint" = EXCLUDED."configFingerprint",
      "status" = 'ready',
      "processingClaimToken" = NULL,
      "processingJobId" = NULL,
      "processingRetryCount" = NULL,
      "failureKind" = NULL,
      "failureSummary" = NULL,
      "completedAt" = EXCLUDED."completedAt",
      "updatedAt" = EXCLUDED."updatedAt"
  `);
  await refreshGenerationCounters(tx, generation.id, generation.projectId);
}

/** Vectors deleted, mentions and evidence invalidated; safe to repeat. */
async function purgeDocumentAiState(
  tx: Prisma.TransactionClient,
  projectId: string,
  documentId: string,
): Promise<void> {
  const invalidatedAt = new Date();
  const mentions = await tx.entityMention.updateMany({
    where: { projectId, documentId, invalidatedAt: null },
    data: { invalidatedAt },
  });
  if (mentions.count > 0)
    await refreshEntityDescriptions(tx, { projectId, documentId });
  await tx.relationEvidence.updateMany({
    where: { projectId, documentId, invalidatedAt: null },
    data: { invalidatedAt },
  });
  await tx.$executeRaw(Prisma.sql`
    DELETE FROM "KnowledgeEmbedding" AS embedding
    USING "DocumentSearchChunk" AS chunk
    WHERE embedding."projectId" = ${projectId}::uuid
      AND embedding."ownerType" = 'document_chunk'
      AND chunk."id" = embedding."ownerId"
      AND chunk."projectId" = embedding."projectId"
      AND chunk."documentId" = ${documentId}::uuid
  `);
}

/** An exempt document's delivery or block ends here; returns false for an ordinary one. */
async function finishIfExempt(
  context: KnowledgeSystemContext,
  db: PrismaClient,
  input: { projectId: string; documentId: string; generationId: string },
): Promise<boolean> {
  const exempt = await knowledgeTransaction(db, async (tx) => {
    if (!(await lockLiveProject(tx, input.projectId))) return false;
    const [document] = await tx.$queryRaw<LiveDocument[]>(Prisma.sql`
      SELECT "id", "path", "headCommitSha", "wikiSourceItemId"
      FROM "Document"
      WHERE "id" = ${input.documentId}::uuid
        AND "projectId" = ${input.projectId}::uuid
      FOR UPDATE
    `);
    if (
      !document ||
      !isAiExempt({ wikiSourceItemId: document.wikiSourceItemId ?? null })
    )
      return false;
    const generation = await lockGeneration(tx, input.generationId);
    if (
      generation?.projectId === input.projectId &&
      ["active", "building"].includes(generation.status)
    )
      await markExemptDocumentsReady(tx, generation, [document]);
    return true;
  });
  if (exempt) await activateCompletedGeneration(context, db, input);
  return exempt;
}

/**
 * A change of Document.wikiSourceItemId. To exempt: vectors and graph evidence go and the row
 * becomes terminal ready. Back: the row resets to pending and enrichment is enqueued, because
 * reconcile would otherwise see a complete row and never index the page.
 */
export async function flipDocumentAiExempt(
  context: KnowledgeSystemContext,
  db: PrismaClient,
  input: { projectId: string; documentId: string },
): Promise<void> {
  const flipped = await knowledgeTransaction(db, async (tx) => {
    if (!(await lockLiveProject(tx, input.projectId))) return null;
    const generations = await lockCurrentProjectGenerations(
      tx,
      input.projectId,
    );
    const [document] = await tx.$queryRaw<LiveDocument[]>(Prisma.sql`
      SELECT "id", "path", "headCommitSha", "wikiSourceItemId"
      FROM "Document"
      WHERE "id" = ${input.documentId}::uuid
        AND "projectId" = ${input.projectId}::uuid
      FOR UPDATE
    `);
    if (!document) return null;
    const exempt = isAiExempt({
      wikiSourceItemId: document.wikiSourceItemId ?? null,
    });
    const jobs: GenerationDocumentPayload[] = [];
    for (const generation of generations) {
      if (exempt) {
        await markExemptDocumentsReady(tx, generation, [document]);
        continue;
      }
      await tx.knowledgeGenerationDocument.upsert({
        where: {
          generationId_documentId: {
            generationId: generation.id,
            documentId: document.id,
          },
        },
        create: {
          generationId: generation.id,
          documentId: document.id,
          projectId: generation.projectId,
          targetSha: document.headCommitSha,
          configFingerprint: generation.configFingerprint,
          status: "pending",
          attempts: 0,
        },
        update: {
          targetSha: document.headCommitSha,
          semanticIndexedSha: null,
          graphIndexedSha: null,
          configFingerprint: generation.configFingerprint,
          status: "pending",
          attempts: 0,
          processingClaimToken: null,
          processingJobId: null,
          processingRetryCount: null,
          failureKind: null,
          failureSummary: null,
          completedAt: null,
        },
      });
      await refreshGenerationCounters(tx, generation.id, input.projectId);
      jobs.push(generationJob(generation, document));
    }
    return {
      jobs,
      generationIds: exempt ? generations.map((row) => row.id) : [],
    };
  });
  if (!flipped) return;
  for (const generationId of flipped.generationIds)
    await activateCompletedGeneration(context, db, {
      projectId: input.projectId,
      generationId,
    });
  await enqueueGenerationJobs(flipped.jobs);
}

// Best effort: a failed repair must never fail a document that is already ready.
async function repairEntityEmbeddingsSafely(
  db: PrismaClient,
  provider: AiProvider,
  input: EnrichGenerationDocumentInput,
  options: AiCallOptions,
): Promise<void> {
  try {
    const repaired = await repairMissingEntityEmbeddings(
      db,
      provider,
      { ...input, processingClaimToken: undefined },
      options,
    );
    if (repaired > 0)
      emitDiagnostic({
        event: "knowledge.entity.embeddings_repaired",
        message: `re-embedded ${repaired} entities that had lost their vector`,
        projectId: input.projectId,
        generationId: input.generationId,
        details: { repaired },
      });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    emitDiagnostic({
      event: "knowledge.entity.embeddings_repair_failed",
      severity: "warn",
      message: "entity embedding repair failed; reconciliation retries it",
      outcome: "error",
      projectId: input.projectId,
      generationId: input.generationId,
    });
  }
}

export async function recoverBlockedGenerationDocuments(
  db: PrismaClient,
  input: {
    projectId: string;
    generationId: string;
    configFingerprint: string;
    documentIds: string[];
  },
): Promise<void> {
  await knowledgeTransaction(db, async (tx) => {
    if (!(await lockLiveProject(tx, input.projectId))) return;
    const generation = await lockGeneration(tx, input.generationId);
    if (
      generation?.projectId !== input.projectId ||
      !["active", "building"].includes(generation.status) ||
      generation.configFingerprint !== input.configFingerprint
    )
      return;
    const recovered = await tx.knowledgeGenerationDocument.updateMany({
      where: {
        projectId: input.projectId,
        generationId: input.generationId,
        configFingerprint: input.configFingerprint,
        documentId: { in: input.documentIds },
        status: "blocked_configuration",
      },
      data: {
        status: "pending",
        attempts: 0,
        completedAt: null,
        failureKind: null,
        failureSummary: null,
        processingClaimToken: null,
        processingJobId: null,
        processingRetryCount: null,
      },
    });
    if (recovered.count)
      await refreshGenerationCountersBatch(tx, input.projectId, [
        input.generationId,
      ]);
  });
}

export async function processGenerationDocument(
  context: KnowledgeSystemContext,
  db: PrismaClient,
  provider: AiProvider,
  input: EnrichGenerationDocumentInput & { pathAtSha: string },
  options?: AiCallOptions & {
    deadlineMs?: number;
    delivery?: ProcessingDelivery;
  },
): Promise<{ outcome: "ready" | "failed" | "stale" }> {
  throwIfAborted(options?.signal);
  if (await finishIfExempt(context, db, input)) return { outcome: "ready" };
  // A job cancellation stays a cancellation; only the deadline becomes a retryable failure.
  const deadline = AbortSignal.timeout(
    options?.deadlineMs ?? KNOWLEDGE_ENRICHMENT_DEADLINE_MS,
  );
  const callOptions: AiCallOptions = {
    signal: options?.signal
      ? AbortSignal.any([options.signal, deadline])
      : deadline,
  };
  const prepared = await prepareGenerationDocument(
    context,
    db,
    input,
    options?.delivery,
  );
  if (!prepared) {
    // Reconciliation sends an up-to-date document here to repair orphaned vectors.
    await repairEntityEmbeddingsSafely(db, provider, input, callOptions);
    await activateCompletedGeneration(context, db, {
      projectId: input.projectId,
      generationId: input.generationId,
    });
    emitDiagnostic({
      event: "knowledge.document.stale",
      message: `document ${input.documentId.slice(0, 8)} is stale`,
      outcome: "stale",
      projectId: input.projectId,
      documentId: input.documentId,
      generationId: input.generationId,
    });
    return { outcome: "stale" };
  }
  input = { ...input, processingClaimToken: prepared.claimToken };
  if (prepared.recovered) {
    emitDiagnostic({
      event: "knowledge.document.recovered",
      message: `document ${input.documentId.slice(0, 8)} processing recovered`,
      projectId: input.projectId,
      documentId: input.documentId,
      generationId: input.generationId,
      details: {
        attempt: prepared.attempt,
        retryCount: options?.delivery?.retryCount ?? null,
      },
    });
  }
  emitDiagnostic({
    event: "knowledge.document.started",
    message: `document ${input.documentId.slice(0, 8)} started`,
    projectId: input.projectId,
    documentId: input.documentId,
    generationId: input.generationId,
    details: { attempt: prepared.attempt },
  });
  let chunkCount: number | null = null;
  let documentReady = false;
  try {
    throwIfAborted(options?.signal);
    const keywordFailure = await db.documentIndexState.findFirst({
      where: {
        projectId: input.projectId,
        documentId: input.documentId,
        targetSha: input.sourceCommitSha,
        status: "failed",
        completedAt: { not: null },
        failureKind: { in: ["validation", "source_missing"] },
      },
      select: { failureKind: true, failureSummary: true },
    });
    if (keywordFailure?.failureKind) {
      const failed = await failGenerationDocument(context, db, input, {
        kind: keywordFailure.failureKind,
        summary:
          keywordFailure.failureSummary ?? "Document keyword indexing failed",
      });
      if (!failed) return { outcome: "stale" };
      emitDiagnostic({
        event: "knowledge.document.failed",
        severity: "error",
        message: `document ${input.documentId.slice(0, 8)} failed keyword validation`,
        projectId: input.projectId,
        documentId: input.documentId,
        generationId: input.generationId,
        details: {
          attempt: prepared.attempt,
          kind: keywordFailure.failureKind,
          retryable: false,
          summary: keywordFailure.failureSummary,
        },
      });
      await activateCompletedGeneration(context, db, input);
      return { outcome: "failed" };
    }
    const embedding = await embedGenerationDocument(
      context,
      db,
      provider,
      input,
      callOptions,
    );
    if (embedding.outcome === "stale") {
      await failGenerationDocument(context, db, input, {
        kind: "stale",
        summary: "Source changed while enrichment was running",
      });
      emitDiagnostic({
        event: "knowledge.document.stale",
        message: `document ${input.documentId.slice(0, 8)} is stale`,
        outcome: "stale",
        projectId: input.projectId,
        documentId: input.documentId,
        generationId: input.generationId,
        details: { attempt: prepared.attempt },
      });
      return { outcome: "stale" };
    }
    chunkCount = embedding.embeddedCount + embedding.reusedCount;
    emitDiagnostic({
      event: "knowledge.document.embedded",
      message: `document ${input.documentId.slice(0, 8)} embedded`,
      projectId: input.projectId,
      documentId: input.documentId,
      generationId: input.generationId,
      durationMs: embedding.requests.durationMs,
      details: {
        attempt: prepared.attempt,
        chunks: chunkCount,
        embedded: embedding.embeddedCount,
        reused: embedding.reusedCount,
        requests: embedding.requests.count,
        largestRequest: embedding.requests.largest,
        characters: embedding.requests.characters,
        durationMs: embedding.requests.durationMs,
        characterBudget: provider.embeddingCharacterBudget?.() ?? null,
      },
    });
    const enrichment = await enrichGenerationDocument(
      context,
      db,
      provider,
      input,
      callOptions,
    );
    if (enrichment.outcome === "stale") {
      await failGenerationDocument(context, db, input, {
        kind: "stale",
        summary: "Source changed while enrichment was running",
      });
      emitDiagnostic({
        event: "knowledge.document.stale",
        message: `document ${input.documentId.slice(0, 8)} is stale`,
        outcome: "stale",
        projectId: input.projectId,
        documentId: input.documentId,
        generationId: input.generationId,
        details: { attempt: prepared.attempt, chunks: chunkCount },
      });
      return { outcome: "stale" };
    }

    throwIfAborted(options?.signal);
    const ready = await finalizeGenerationDocument(context, db, input, {
      status: "ready",
    });
    if (!ready) {
      emitDiagnostic({
        event: "knowledge.document.stale",
        message: `document ${input.documentId.slice(0, 8)} is stale`,
        outcome: "stale",
        projectId: input.projectId,
        documentId: input.documentId,
        generationId: input.generationId,
        details: { attempt: prepared.attempt, chunks: chunkCount },
      });
      return { outcome: "stale" };
    }
    documentReady = true;
    throwIfAborted(options?.signal);
    await repairEntityEmbeddingsSafely(db, provider, input, callOptions);
    await activateCompletedGeneration(context, db, {
      projectId: input.projectId,
      generationId: input.generationId,
    });
    emitDiagnostic({
      event: "knowledge.document.ready",
      message: `document ${input.documentId.slice(0, 8)} is ready`,
      projectId: input.projectId,
      documentId: input.documentId,
      generationId: input.generationId,
      details: { attempt: prepared.attempt, chunks: chunkCount },
    });
    return { outcome: "ready" };
  } catch (caught) {
    if (options?.signal?.aborted) {
      const released = await releaseGenerationDocumentClaim(context, db, input);
      if (released) {
        emitDiagnostic({
          event: "knowledge.document.cancelled",
          message: `document ${input.documentId.slice(0, 8)} processing interrupted`,
          outcome: "cancelled",
          projectId: input.projectId,
          documentId: input.documentId,
          generationId: input.generationId,
          details: { attempt: prepared.attempt, status: "pending" },
        });
      }
      throw cancellationError();
    }
    const error = deadline.aborted
      ? new AiProviderError("AI enrichment exceeded its time budget", {
          kind: "provider",
          retryable: true,
        })
      : caught;
    if (documentReady) throw error;
    const failure = classifyProcessingFailure(error);
    if (prepared.attempt >= MAX_DOCUMENT_ENRICHMENT_ATTEMPTS)
      failure.retryable = false;
    const reserved = reserveDiagnosticEvent("error");
    failure.summary = withReference(
      failure.summary,
      reserved?.reference ?? null,
      300,
    );
    const failed = await failGenerationDocument(context, db, input, failure);
    if (!failed) {
      emitDiagnostic({
        event: "knowledge.document.stale",
        message: `document ${input.documentId.slice(0, 8)} is stale`,
        outcome: "stale",
        projectId: input.projectId,
        documentId: input.documentId,
        generationId: input.generationId,
        details: {
          attempt: prepared.attempt,
          ...(chunkCount === null ? {} : { chunks: chunkCount }),
        },
      });
      if (failure.retryable) throw error;
      return { outcome: "stale" };
    }
    emitDiagnostic({
      id: reserved?.id,
      event: "knowledge.document.failed",
      severity: "error",
      message: `document ${input.documentId.slice(0, 8)} failed`,
      projectId: input.projectId,
      documentId: input.documentId,
      generationId: input.generationId,
      details: {
        attempt: prepared.attempt,
        kind: failure.kind,
        retryable: failure.retryable === true,
        summary: failure.summary,
        reference: reserved?.reference ?? null,
        error: summarizeError(error),
        ...(error instanceof AiProviderError && error.details
          ? { validation: error.details }
          : {}),
        ...(chunkCount === null ? {} : { chunks: chunkCount }),
      },
    });
    if (failure.retryable) throw error;
    await activateCompletedGeneration(context, db, input);
    return { outcome: "failed" };
  }
}

export async function blockGenerationDocumentForConfiguration(
  context: KnowledgeSystemContext,
  db: PrismaClient,
  input: GenerationDocumentPayload,
  delivery?: ProcessingDelivery,
): Promise<void> {
  if (await finishIfExempt(context, db, input)) return;
  const prepared = await prepareGenerationDocument(
    context,
    db,
    input,
    delivery,
  );
  if (!prepared) return;
  const blocked = await finalizeGenerationDocument(
    context,
    db,
    {
      ...input,
      processingClaimToken: prepared.claimToken,
    },
    {
      status: "blocked_configuration",
      failureKind: "configuration",
      failureSummary: CONFIGURATION_FAILURE_SUMMARY,
    },
  );
  if (blocked) {
    await activateCompletedGeneration(context, db, input);
    emitDiagnostic({
      event: "knowledge.document.blocked",
      severity: "warn",
      message: `document ${input.documentId.slice(0, 8)} blocked`,
      outcome: "blocked",
      projectId: input.projectId,
      documentId: input.documentId,
      generationId: input.generationId,
      details: {
        attempt: prepared.attempt,
        kind: "configuration",
        summary: CONFIGURATION_FAILURE_SUMMARY,
      },
    });
  }
}

export async function blockGenerationBuildForConfiguration(
  context: KnowledgeSystemContext,
  db: PrismaClient,
  payload: GenerationBuildPayload,
): Promise<void> {
  void context;
  const result = await knowledgeTransaction(db, async (tx) => {
    if (!(await lockLiveProject(tx, payload.projectId))) return null;
    const generation = await lockGeneration(tx, payload.generationId);
    if (
      generation?.projectId !== payload.projectId ||
      generation.status !== "building" ||
      generation.configFingerprint !== payload.configFingerprint
    ) {
      return null;
    }
    if (!payload.cursor) {
      await markMissingGenerationDocuments(
        tx,
        generation.id,
        payload.projectId,
      );
    }
    const page = await tx.document.findMany({
      where: {
        projectId: payload.projectId,
        ...(payload.cursor ? { id: { gt: payload.cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: GENERATION_BATCH_SIZE + 1,
      select: {
        id: true,
        path: true,
        headCommitSha: true,
        wikiSourceItemId: true,
      },
    });
    const hasMore = page.length > GENERATION_BATCH_SIZE;
    const documents = page.slice(0, GENERATION_BATCH_SIZE);
    await markExemptDocumentsReady(
      tx,
      generation,
      documents.filter(isAiExempt),
    );
    await bulkBlockGenerationDocuments(
      tx,
      generation,
      documents.filter((document) => !isAiExempt(document)),
    );
    if (!hasMore) {
      await refreshGenerationCounters(tx, generation.id, payload.projectId);
      await tx.knowledgeGeneration.updateMany({
        where: { id: generation.id, status: "building" },
        data: {
          status: "failed",
          failureKind: "configuration",
          failureSummary:
            "Knowledge routing changed before this generation completed",
          completedAt: new Date(),
        },
      });
      return { continuation: null };
    }
    return {
      continuation: {
        projectId: payload.projectId,
        generationId: generation.id,
        configFingerprint: generation.configFingerprint,
        cursor: documents.at(-1)!.id,
      },
    };
  });
  if (!result) return;
  emitDiagnostic({
    event: "knowledge.generation.blocked",
    severity: "warn",
    message: `generation ${payload.generationId.slice(0, 8)} blocked`,
    outcome: "blocked",
    projectId: payload.projectId,
    generationId: payload.generationId,
  });
  if (result.continuation) {
    await requestKnowledgeJob("project.generation-build", result.continuation);
  }
}

export async function activateCompletedGeneration(
  context: KnowledgeSystemContext,
  db: PrismaClient,
  input: { projectId: string; generationId: string },
): Promise<boolean> {
  void context;
  const result = await knowledgeTransaction(db, async (tx) => {
    if (!(await lockLiveProject(tx, input.projectId))) {
      return { activated: false, transitioned: false, supersededIds: [] };
    }
    const target = await lockGeneration(tx, input.generationId);
    if (
      target?.projectId !== input.projectId ||
      !["building", "active"].includes(target.status)
    ) {
      return { activated: false, transitioned: false, supersededIds: [] };
    }

    const [counts] = await generationCounts(
      tx,
      input.generationId,
      input.projectId,
    );
    const [terminal] = await tx.$queryRaw<
      Array<{ count: number; blocked: number }>
    >(Prisma.sql`
      SELECT count(*) FILTER (WHERE state."status" = 'failed' AND state."completedAt" IS NOT NULL)::int AS count,
             count(*) FILTER (WHERE state."status" = 'blocked_configuration')::int AS blocked
      FROM "KnowledgeGenerationDocument" AS state
      JOIN "Document" AS document ON document."id" = state."documentId" AND document."projectId" = state."projectId"
        AND document."headCommitSha" = state."targetSha"
      WHERE state."generationId" = ${input.generationId}::uuid AND state."projectId" = ${input.projectId}::uuid
        AND state."configFingerprint" = ${target.configFingerprint}
    `);
    const terminalFailures = terminal?.count ?? 0;
    const complete = counts?.total === (counts?.ready ?? 0) + terminalFailures;
    await persistGenerationCounts(
      tx,
      input.generationId,
      input.projectId,
      counts,
    );
    if (target.status === "building" && (terminal?.blocked ?? 0) > 0) {
      await tx.knowledgeGeneration.update({
        where: { id: input.generationId },
        data: {
          status: "failed",
          failureKind: "configuration",
          failureSummary: CONFIGURATION_FAILURE_SUMMARY,
          completedAt: new Date(),
        },
      });
      return {
        activated: false,
        transitioned: false,
        supersededIds: [],
        blocked: true,
      };
    }
    if (!complete) {
      return { activated: false, transitioned: false, supersededIds: [] };
    }
    if (target.status === "active") {
      return { activated: true, transitioned: false, supersededIds: [] };
    }

    const activatedAt = new Date();
    const superseded = await tx.knowledgeGeneration.updateManyAndReturn({
      where: {
        projectId: input.projectId,
        status: "active",
        id: { not: input.generationId },
      },
      data: { status: "superseded", supersededAt: activatedAt },
      select: { id: true },
    });
    await tx.knowledgeGeneration.update({
      where: { id: input.generationId },
      data: {
        status: "active",
        documentTotal: counts.total,
        documentReadyCount: counts.ready,
        documentFailedCount: counts.failed,
        failureKind: null,
        failureSummary: null,
        completedAt: activatedAt,
        activatedAt,
        supersededAt: null,
      },
    });
    return {
      activated: true,
      transitioned: true,
      supersededIds: superseded.map(({ id }) => id).sort(),
    };
  });
  if ("blocked" in result && result.blocked) {
    emitDiagnostic({
      event: "knowledge.generation.blocked",
      severity: "warn",
      message: `generation ${input.generationId.slice(0, 8)} failed because AI configuration is unavailable`,
      projectId: input.projectId,
      generationId: input.generationId,
      outcome: "blocked",
      details: { status: "failed", kind: "configuration" },
    });
  }
  if (result.transitioned) {
    for (const generationId of result.supersededIds) {
      emitDiagnostic({
        event: "knowledge.generation.superseded",
        message: `generation ${generationId.slice(0, 8)} superseded`,
        projectId: input.projectId,
        generationId,
        details: { replacementGenerationId: input.generationId },
      });
    }
    emitDiagnostic({
      event: "knowledge.generation.activated",
      message: `generation ${input.generationId.slice(0, 8)} activated`,
      projectId: input.projectId,
      generationId: input.generationId,
      details: { superseded: result.supersededIds.length },
    });
  }
  return result.activated;
}

/** @internal Administrative generation state transition. */
export async function failGeneration(
  context: KnowledgeSystemContext,
  db: PrismaClient,
  input: {
    projectId: string;
    generationId: string;
    failureKind: KnowledgeFailureKind;
    failureSummary: string;
    error?: unknown;
  },
): Promise<boolean> {
  void context;
  const reserved = reserveDiagnosticEvent("error");
  const failureSummary = safeFailureSummary(
    input.failureSummary,
    "Knowledge generation failed",
    reserved?.reference ?? null,
  );
  const failed = await knowledgeTransaction(db, async (tx) => {
    if (!(await lockLiveProject(tx, input.projectId))) return false;
    const generation = await lockGeneration(tx, input.generationId);
    if (
      generation?.projectId !== input.projectId ||
      generation.status !== "building"
    ) {
      return false;
    }
    await refreshGenerationCounters(tx, input.generationId, input.projectId);
    await tx.knowledgeGeneration.update({
      where: { id: input.generationId },
      data: {
        status: "failed",
        failureKind: input.failureKind,
        failureSummary,
        completedAt: new Date(),
      },
    });
    return true;
  });
  if (failed) {
    emitDiagnostic({
      id: reserved?.id,
      event: "knowledge.generation.failed",
      severity: "error",
      message: `generation ${input.generationId.slice(0, 8)} failed`,
      projectId: input.projectId,
      generationId: input.generationId,
      details: {
        kind: input.failureKind,
        summary: failureSummary,
        reference: reserved?.reference ?? null,
        ...(input.error === undefined
          ? {}
          : { error: summarizeError(input.error) }),
      },
    });
  }
  return failed;
}

export async function deleteKnowledgeContent(
  context: KnowledgeSystemContext,
  db: PrismaClient,
  payload: ContentDeletePayload,
): Promise<boolean> {
  void context;
  const deleted = await knowledgeTransaction(db, async (tx) => {
    if (!(await lockLiveProject(tx, payload.projectId))) return false;
    if (payload.sourceType === "table") {
      const live = await tx.dataTable.findFirst({
        where: { id: payload.sourceId, projectId: payload.projectId },
        select: { id: true },
      });
      if (live) return false;
      await tx.tableSearchProjection.deleteMany({
        where: { tableId: payload.sourceId, projectId: payload.projectId },
      });
      return true;
    }

    const [live] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "Document"
      WHERE "id" = ${payload.sourceId}::uuid
        AND "projectId" = ${payload.projectId}::uuid
      FOR UPDATE
    `);
    if (live) return false;
    const invalidatedAt = new Date();
    await tx.entityMention.updateMany({
      where: {
        projectId: payload.projectId,
        documentId: payload.sourceId,
        invalidatedAt: null,
      },
      data: { invalidatedAt },
    });
    await refreshEntityDescriptions(tx, {
      projectId: payload.projectId,
      documentId: payload.sourceId,
    });
    await tx.relationEvidence.updateMany({
      where: {
        projectId: payload.projectId,
        documentId: payload.sourceId,
        invalidatedAt: null,
      },
      data: { invalidatedAt },
    });
    await tx.documentIndexState.deleteMany({
      where: { documentId: payload.sourceId, projectId: payload.projectId },
    });
    await tx.documentSearchChunk.deleteMany({
      where: { documentId: payload.sourceId, projectId: payload.projectId },
    });
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "KnowledgeEmbedding" AS embedding
      WHERE embedding."projectId" = ${payload.projectId}::uuid
        AND embedding."ownerType" = 'document_chunk'
        AND NOT EXISTS (
          SELECT 1 FROM "DocumentSearchChunk" AS chunk
          WHERE chunk."id" = embedding."ownerId" AND chunk."projectId" = embedding."projectId"
        )
    `);
    const generationStates = await tx.knowledgeGenerationDocument.findMany({
      where: { documentId: payload.sourceId, projectId: payload.projectId },
      select: { generationId: true },
    });
    const generationIdsWithState = [
      ...new Set(generationStates.map((state) => state.generationId)),
    ];
    await tx.knowledgeGenerationDocument.updateMany({
      where: { documentId: payload.sourceId, projectId: payload.projectId },
      data: {
        status: "missing",
        failureKind: "source_missing",
        failureSummary: "Source document is no longer live",
        completedAt: invalidatedAt,
        processingClaimToken: null,
        processingJobId: null,
        processingRetryCount: null,
      },
    });
    await refreshGenerationCountersBatch(
      tx,
      payload.projectId,
      generationIdsWithState,
    );
    return true;
  });
  if (deleted) {
    emitDiagnostic({
      event: "knowledge.content.deleted",
      message: "deleted source knowledge projections cleaned up",
      projectId: payload.projectId,
      ...(payload.sourceType === "document"
        ? { documentId: payload.sourceId }
        : {}),
      details: { sourceType: payload.sourceType, sourceId: payload.sourceId },
    });
  }
  return deleted;
}

export async function cleanupSupersededGenerations(
  context: KnowledgeSystemContext,
  db: PrismaClient,
  projectId: string,
  now = new Date(),
): Promise<number> {
  void context;
  const count = await knowledgeTransaction(db, async (tx) => {
    if (!(await lockLiveProject(tx, projectId))) return 0;
    const newestFallback = await tx.knowledgeGeneration.findFirst({
      where: { projectId, status: "superseded" },
      orderBy: [
        { supersededAt: { sort: "desc", nulls: "last" } },
        { createdAt: "desc" },
        { id: "asc" },
      ],
      select: { id: true },
    });
    const cutoff = new Date(now.getTime() - SUPERSEDED_RETENTION_MS);
    const expired = await tx.knowledgeGeneration.findMany({
      where: {
        projectId,
        OR: [
          {
            status: "superseded",
            ...(newestFallback ? { id: { not: newestFallback.id } } : {}),
            supersededAt: { lt: cutoff },
          },
          {
            status: "failed",
            OR: [
              { completedAt: { lt: cutoff } },
              { completedAt: null, createdAt: { lt: cutoff } },
            ],
          },
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: GENERATION_CLEANUP_BATCH_SIZE,
      select: { id: true },
    });
    const deleteIds = expired.map(({ id }) => id);
    if (deleteIds.length === 0) return 0;
    const deleted = await tx.knowledgeGeneration.deleteMany({
      where: {
        projectId,
        id: { in: deleteIds },
        status: { in: ["superseded", "failed"] },
      },
    });
    return deleted.count;
  });
  if (count > 0) {
    emitDiagnostic({
      event: "knowledge.generations.pruned",
      message: "expired knowledge generations pruned",
      projectId,
      details: { count, limit: GENERATION_CLEANUP_BATCH_SIZE },
    });
  }
  return count;
}

async function createGenerationSnapshot(
  tx: Prisma.TransactionClient,
  configuration: GenerationConfiguration,
  attribution: {
    buildTrigger: KnowledgeGenerationTrigger;
    requestedById: string | null;
  },
  graphSourceGenerationId: string | null = null,
): Promise<KnowledgeGeneration> {
  return tx.knowledgeGeneration.create({
    data: {
      projectId: configuration.projectId,
      configFingerprint: configuration.configFingerprint,
      embeddingModel: configuration.embeddingModel,
      embeddingDimensions: configuration.embeddingDimensions,
      extractionSchemaVersion: configuration.extractionSchemaVersion,
      promptVersion: configuration.promptVersion,
      routeSnapshot:
        configuration.routeSnapshot === null
          ? Prisma.DbNull
          : (configuration.routeSnapshot as Prisma.InputJsonObject),
      status: "building",
      documentTotal: 0,
      buildTrigger: attribution.buildTrigger,
      requestedById: attribution.requestedById,
      graphSourceGenerationId,
    },
  });
}

async function generationAttribution(
  tx: Prisma.TransactionClient,
  configuration: GenerationConfiguration,
  previous: { configFingerprint: string } | null,
): Promise<{
  buildTrigger: KnowledgeGenerationTrigger;
  requestedById: string | null;
}> {
  if (!previous) return { buildTrigger: "initial", requestedById: null };
  const setting = await tx.systemSetting.findUnique({
    where: { key: LAST_ROUTING_CHANGE_SETTING },
    select: { value: true },
  });
  const record = setting?.value as
    Partial<KnowledgeRoutingChangeRecord> | undefined;
  const recent =
    typeof record?.at === "string" &&
    Date.now() - Date.parse(record.at) < ROUTING_CHANGE_ATTRIBUTION_MS;
  if (
    recent &&
    record?.indexFingerprint === configuration.configFingerprint &&
    typeof record.userId === "string"
  ) {
    const requester = await tx.user.findUnique({
      where: { id: record.userId },
      select: { id: true },
    });
    return {
      buildTrigger: "embedding_change",
      requestedById: requester?.id ?? null,
    };
  }
  return { buildTrigger: "index_upgrade", requestedById: null };
}

export function emitGenerationCreated(generation: KnowledgeGeneration): void {
  emitDiagnostic({
    event: "knowledge.generation.created",
    message: `generation ${generation.id.slice(0, 8)} created`,
    projectId: generation.projectId,
    generationId: generation.id,
    details: {
      fingerprint: generation.configFingerprint.slice(0, 12),
      promptVersion: generation.promptVersion,
    },
  });
}

async function markMissingGenerationDocuments(
  tx: Prisma.TransactionClient,
  generationId: string,
  projectId: string,
): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    UPDATE "KnowledgeGenerationDocument" AS state
    SET
      "status" = 'missing',
      "failureKind" = 'source_missing',
      "failureSummary" = 'Source document is no longer live',
      "completedAt" = ${UTC_NOW},
      "processingClaimToken" = NULL,
      "processingJobId" = NULL,
      "processingRetryCount" = NULL,
      "updatedAt" = ${UTC_NOW}
    WHERE state."generationId" = ${generationId}::uuid
      AND state."projectId" = ${projectId}::uuid
      AND NOT EXISTS (
        SELECT 1
        FROM "Document" AS document
        WHERE document."id" = state."documentId"
          AND document."projectId" = ${projectId}::uuid
      )
  `);
}

async function bulkUpsertGenerationDocuments(
  tx: Prisma.TransactionClient,
  generation: Pick<
    KnowledgeGeneration,
    "id" | "projectId" | "configFingerprint"
  >,
  documents: LiveDocument[],
): Promise<void> {
  if (documents.length === 0) return;
  const values = documents.map(
    (document) => Prisma.sql`
    (
      ${generation.id}::uuid,
      ${document.id}::uuid,
      ${generation.projectId}::uuid,
      ${document.headCommitSha},
      ${generation.configFingerprint},
      'pending'::"KnowledgeDocumentStatus",
      ${UTC_NOW},
      ${UTC_NOW}
    )
  `,
  );
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "KnowledgeGenerationDocument" (
      "generationId",
      "documentId",
      "projectId",
      "targetSha",
      "configFingerprint",
      "status",
      "createdAt",
      "updatedAt"
    )
    VALUES ${Prisma.join(values)}
    ON CONFLICT ("generationId", "documentId") DO UPDATE SET
      "targetSha" = EXCLUDED."targetSha",
      "configFingerprint" = EXCLUDED."configFingerprint",
      "status" = 'pending',
      "attempts" = 0,
      "processingClaimToken" = NULL,
      "processingJobId" = NULL,
      "processingRetryCount" = NULL,
      "failureKind" = NULL,
      "failureSummary" = NULL,
      "completedAt" = NULL,
      "updatedAt" = ${UTC_NOW}
    WHERE
      "KnowledgeGenerationDocument"."targetSha" <> EXCLUDED."targetSha"
      OR "KnowledgeGenerationDocument"."configFingerprint" <>
        EXCLUDED."configFingerprint"
      OR "KnowledgeGenerationDocument"."status" = 'missing'
  `);
}

async function bulkBlockGenerationDocuments(
  tx: Prisma.TransactionClient,
  generation: Pick<
    KnowledgeGeneration,
    "id" | "projectId" | "configFingerprint"
  >,
  documents: LiveDocument[],
): Promise<void> {
  if (documents.length === 0) return;
  const values = documents.map(
    (document) => Prisma.sql`
    (
      ${generation.id}::uuid,
      ${document.id}::uuid,
      ${generation.projectId}::uuid,
      ${document.headCommitSha},
      ${generation.configFingerprint},
      'blocked_configuration'::"KnowledgeDocumentStatus",
      'configuration'::"KnowledgeFailureKind",
      ${CONFIGURATION_FAILURE_SUMMARY},
      ${UTC_NOW},
      ${UTC_NOW}
    )
  `,
  );
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "KnowledgeGenerationDocument" (
      "generationId",
      "documentId",
      "projectId",
      "targetSha",
      "configFingerprint",
      "status",
      "failureKind",
      "failureSummary",
      "createdAt",
      "updatedAt"
    )
    VALUES ${Prisma.join(values)}
    ON CONFLICT ("generationId", "documentId") DO UPDATE SET
      "targetSha" = EXCLUDED."targetSha",
      "configFingerprint" = EXCLUDED."configFingerprint",
      "status" = EXCLUDED."status",
      "processingClaimToken" = NULL,
      "processingJobId" = NULL,
      "processingRetryCount" = NULL,
      "failureKind" = EXCLUDED."failureKind",
      "failureSummary" = EXCLUDED."failureSummary",
      "completedAt" = NULL,
      "updatedAt" = ${UTC_NOW}
  `);
}

function generationDocumentNeedsEnqueue(
  state: Awaited<
    ReturnType<
      Prisma.TransactionClient["knowledgeGenerationDocument"]["findUnique"]
    >
  >,
  document: LiveDocument,
  generation: Pick<KnowledgeGeneration, "configFingerprint">,
): boolean {
  const exact =
    state?.targetSha === document.headCommitSha &&
    state.configFingerprint === generation.configFingerprint;
  if (!exact) return true;
  return (
    generationDocumentRecoveryDue(state) ||
    (state.status === "ready" &&
      (state.semanticIndexedSha !== document.headCommitSha ||
        state.graphIndexedSha !== document.headCommitSha))
  );
}

export function generationDocumentRecoveryDue(
  state: {
    status: LockedGenerationDocument["status"];
    failureKind: KnowledgeFailureKind | null;
    lastAttemptAt: Date | null;
    completedAt: Date | null;
    processingJobId?: string | null;
    processingRetryCount?: number | null;
  },
  now = new Date(),
  delivery?: ProcessingDelivery,
): boolean {
  if (state.status === "pending" || state.status === "missing") return true;
  if (state.status === "processing") {
    return (
      (delivery?.jobId != null &&
        delivery.retryCount !== null &&
        state.processingJobId === delivery.jobId &&
        state.processingRetryCount != null &&
        delivery.retryCount > state.processingRetryCount) ||
      state.lastAttemptAt === null ||
      state.lastAttemptAt.getTime() <=
        now.getTime() - PROCESSING_CLAIM_TIMEOUT_MS
    );
  }
  return (
    state.status === "failed" &&
    state.completedAt === null &&
    (state.failureKind === "provider" || state.failureKind === "internal")
  );
}

function loadGeneration(
  db: PrismaClient,
  generationId: string,
): Promise<KnowledgeGeneration | null> {
  return db.knowledgeGeneration.findUnique({ where: { id: generationId } });
}

async function prepareGenerationDocument(
  context: KnowledgeSystemContext,
  db: PrismaClient,
  input: GenerationDocumentPayload,
  delivery?: ProcessingDelivery,
): Promise<{ attempt: number; claimToken: string; recovered: boolean } | null> {
  void context;
  return knowledgeTransaction(db, async (tx) => {
    if (!(await lockLiveProject(tx, input.projectId))) return null;
    const generation = await lockGeneration(tx, input.generationId);
    if (
      generation?.projectId !== input.projectId ||
      !["active", "building"].includes(generation.status) ||
      generation.configFingerprint !== input.configFingerprint
    ) {
      return null;
    }
    const [document] = await tx.$queryRaw<LiveDocument[]>(Prisma.sql`
      SELECT "id", "path", "headCommitSha"
      FROM "Document"
      WHERE "id" = ${input.documentId}::uuid
        AND "projectId" = ${input.projectId}::uuid
      FOR UPDATE
    `);
    if (
      document?.headCommitSha !== input.sourceCommitSha ||
      document.path !== input.pathAtSha
    ) {
      return null;
    }
    const [state] = await tx.$queryRaw<LockedGenerationDocument[]>(Prisma.sql`
      SELECT
        "targetSha",
        "semanticIndexedSha",
        "graphIndexedSha",
        "configFingerprint",
        "attempts",
        "status",
        "failureKind",
        "lastAttemptAt",
        "completedAt",
        "processingClaimToken",
        "processingJobId",
        "processingRetryCount"
      FROM "KnowledgeGenerationDocument"
      WHERE "generationId" = ${input.generationId}::uuid
        AND "documentId" = ${input.documentId}::uuid
        AND "projectId" = ${input.projectId}::uuid
      FOR UPDATE
    `);
    const exact =
      state?.targetSha === input.sourceCommitSha &&
      state.configFingerprint === input.configFingerprint;
    const incompleteReady =
      exact &&
      state.status === "ready" &&
      (state.semanticIndexedSha !== input.sourceCommitSha ||
        state.graphIndexedSha !== input.sourceCommitSha);
    if (
      state &&
      (!exact ||
        (!generationDocumentRecoveryDue(state, new Date(), delivery) &&
          !incompleteReady))
    ) {
      return null;
    }
    const attemptedAt = new Date();
    const attempt = (state?.attempts ?? 0) + 1;
    const claimToken = randomUUID();
    const claim = {
      processingClaimToken: claimToken,
      processingJobId: delivery?.jobId ?? null,
      processingRetryCount: delivery?.retryCount ?? null,
    };
    if (state) {
      await tx.knowledgeGenerationDocument.update({
        where: {
          generationId_documentId: {
            generationId: generation.id,
            documentId: document.id,
          },
        },
        data: {
          ...claim,
          status: "processing",
          attempts: { increment: 1 },
          failureKind: null,
          failureSummary: null,
          lastAttemptAt: attemptedAt,
          completedAt: null,
        },
      });
    } else {
      await tx.knowledgeGenerationDocument.create({
        data: {
          ...claim,
          generationId: generation.id,
          documentId: document.id,
          projectId: generation.projectId,
          targetSha: document.headCommitSha,
          configFingerprint: generation.configFingerprint,
          status: "processing",
          attempts: 1,
          lastAttemptAt: attemptedAt,
        },
      });
    }
    const contribution = persistedContribution(state, generation);
    await adjustGenerationCounters(tx, generation.id, {
      ready: -contribution.ready,
      failed: -contribution.failed,
    });
    return { attempt, claimToken, recovered: state?.status === "processing" };
  });
}

async function upsertPendingGenerationDocument(
  tx: Prisma.TransactionClient,
  generation: Pick<
    KnowledgeGeneration,
    "id" | "projectId" | "configFingerprint"
  >,
  document: LiveDocument,
  resetAttempts: boolean,
): Promise<void> {
  await tx.knowledgeGenerationDocument.upsert({
    where: {
      generationId_documentId: {
        generationId: generation.id,
        documentId: document.id,
      },
    },
    create: {
      generationId: generation.id,
      documentId: document.id,
      projectId: generation.projectId,
      targetSha: document.headCommitSha,
      configFingerprint: generation.configFingerprint,
      status: "pending",
      attempts: 0,
      lastAttemptAt: null,
    },
    update: {
      targetSha: document.headCommitSha,
      configFingerprint: generation.configFingerprint,
      status: "pending",
      attempts: resetAttempts ? 0 : undefined,
      processingClaimToken: null,
      processingJobId: null,
      processingRetryCount: null,
      failureKind: null,
      failureSummary: null,
      completedAt: null,
    },
  });
}

async function failGenerationDocument(
  context: KnowledgeSystemContext,
  db: PrismaClient,
  input: ProcessingInput,
  failure: {
    kind: KnowledgeFailureKind;
    summary: string;
    retryable?: boolean;
  },
): Promise<boolean> {
  return finalizeGenerationDocument(context, db, input, {
    status: "failed",
    failureKind: failure.kind,
    failureSummary: safeFailureSummary(
      failure.summary,
      "Knowledge document processing failed",
    ),
    retryable: failure.retryable === true,
  });
}

async function finalizeGenerationDocument(
  context: KnowledgeSystemContext,
  db: PrismaClient,
  input: ProcessingInput,
  final:
    | { status: "ready" }
    | { status: "pending" }
    | {
        status: "failed" | "blocked_configuration";
        failureKind: KnowledgeFailureKind;
        failureSummary: string;
        retryable?: boolean;
      },
): Promise<boolean> {
  void context;
  return knowledgeTransaction(db, async (tx) => {
    if (!(await lockLiveProject(tx, input.projectId))) return false;
    const generation = await lockGeneration(tx, input.generationId);
    if (
      generation?.projectId !== input.projectId ||
      !["active", "building"].includes(generation.status) ||
      generation.configFingerprint !== input.configFingerprint
    ) {
      return false;
    }
    const [document] = await tx.$queryRaw<LiveDocument[]>(Prisma.sql`
      SELECT "id", "path", "headCommitSha"
      FROM "Document"
      WHERE "id" = ${input.documentId}::uuid
        AND "projectId" = ${input.projectId}::uuid
      FOR UPDATE
    `);
    if (
      document?.headCommitSha !== input.sourceCommitSha ||
      document.path !== input.pathAtSha
    ) {
      return false;
    }
    const [state] = await tx.$queryRaw<LockedGenerationDocument[]>(Prisma.sql`
      SELECT
        "targetSha",
        "semanticIndexedSha",
        "graphIndexedSha",
        "configFingerprint",
        "status",
        "failureKind",
        "lastAttemptAt",
        "completedAt",
        "processingClaimToken"
      FROM "KnowledgeGenerationDocument"
      WHERE "generationId" = ${input.generationId}::uuid
        AND "documentId" = ${input.documentId}::uuid
        AND "projectId" = ${input.projectId}::uuid
      FOR UPDATE
    `);
    if (
      state?.targetSha !== input.sourceCommitSha ||
      state.configFingerprint !== input.configFingerprint ||
      state.processingClaimToken !== (input.processingClaimToken ?? null) ||
      (final.status === "ready"
        ? !["processing", "ready"].includes(state.status)
        : state.status !== "processing") ||
      (final.status === "ready" &&
        (state.semanticIndexedSha !== input.sourceCommitSha ||
          state.graphIndexedSha !== input.sourceCommitSha))
    ) {
      return false;
    }
    await tx.knowledgeGenerationDocument.update({
      where: {
        generationId_documentId: {
          generationId: input.generationId,
          documentId: input.documentId,
        },
      },
      data: {
        processingClaimToken: null,
        processingJobId: null,
        processingRetryCount: null,
        ...(final.status === "ready" || final.status === "pending"
          ? {
              status: final.status,
              failureKind: null,
              failureSummary: null,
              completedAt: final.status === "ready" ? new Date() : null,
            }
          : {
              status: final.status,
              failureKind: final.failureKind,
              failureSummary: final.failureSummary,
              completedAt:
                final.status === "failed" && final.retryable
                  ? null
                  : new Date(),
            }),
      },
    });
    if (final.status === "failed" && !final.retryable) {
      const where = {
        projectId: input.projectId,
        generationId: input.generationId,
        documentId: input.documentId,
        sourceCommitSha: { not: input.sourceCommitSha },
        invalidatedAt: null,
      };
      const data = { invalidatedAt: new Date() };
      await tx.entityMention.updateMany({ where, data });
      await tx.relationEvidence.updateMany({ where, data });
      await refreshEntityDescriptions(tx, input);
    }
    const before = persistedContribution(state, generation);
    const after =
      final.status === "ready"
        ? { ready: 1, failed: 0 }
        : { ready: 0, failed: final.status === "pending" ? 0 : 1 };
    await adjustGenerationCounters(tx, input.generationId, {
      ready: after.ready - before.ready,
      failed: after.failed - before.failed,
    });
    return true;
  });
}

async function releaseGenerationDocumentClaim(
  context: KnowledgeSystemContext,
  db: PrismaClient,
  input: ProcessingInput,
): Promise<boolean> {
  return finalizeGenerationDocument(context, db, input, { status: "pending" });
}

function persistedContribution(
  state:
    | Pick<
        LockedGenerationDocument,
        | "targetSha"
        | "semanticIndexedSha"
        | "graphIndexedSha"
        | "configFingerprint"
        | "status"
      >
    | null
    | undefined,
  generation: Pick<LockedGeneration, "configFingerprint">,
): { ready: number; failed: number } {
  if (state?.configFingerprint !== generation.configFingerprint) {
    return { ready: 0, failed: 0 };
  }
  if (
    state.status === "ready" &&
    state.semanticIndexedSha === state.targetSha &&
    state.graphIndexedSha === state.targetSha
  ) {
    return { ready: 1, failed: 0 };
  }
  return state.status === "failed" || state.status === "blocked_configuration"
    ? { ready: 0, failed: 1 }
    : { ready: 0, failed: 0 };
}

async function adjustGenerationCounters(
  tx: Prisma.TransactionClient,
  generationId: string,
  delta: { total?: number; ready?: number; failed?: number },
): Promise<void> {
  await tx.knowledgeGeneration.update({
    where: { id: generationId },
    data: {
      ...(delta.total ? { documentTotal: { increment: delta.total } } : {}),
      ...(delta.ready
        ? { documentReadyCount: { increment: delta.ready } }
        : {}),
      ...(delta.failed
        ? { documentFailedCount: { increment: delta.failed } }
        : {}),
    },
  });
}

export async function refreshGenerationCounters(
  db: Db,
  generationId: string,
  projectId: string,
): Promise<void> {
  const [counts] = await generationCounts(db, generationId, projectId);
  await persistGenerationCounts(db, generationId, projectId, counts);
}

export async function refreshGenerationCountersBatch(
  db: Db,
  projectId: string,
  generationIds: string[],
  sourceMode: "current" | "persisted" = "current",
): Promise<void> {
  if (generationIds.length === 0) return;
  const requested = generationIds.map((id) => Prisma.sql`(${id}::uuid)`);
  await db.$executeRaw(Prisma.sql`
    WITH requested("id") AS (VALUES ${Prisma.join(requested)}),
    counts AS (
      SELECT
        generation."id",
        count(document."id")::int AS "total",
        count(state."documentId") FILTER (
          WHERE state."configFingerprint" = generation."configFingerprint"
            ${sourceMode === "current" ? Prisma.sql`AND state."targetSha" = document."headCommitSha"` : Prisma.empty}
            AND state."status" = 'ready'
            AND state."semanticIndexedSha" = state."targetSha"
            AND state."graphIndexedSha" = state."targetSha"
        )::int AS "ready",
        count(state."documentId") FILTER (
          WHERE state."configFingerprint" = generation."configFingerprint"
            ${sourceMode === "current" ? Prisma.sql`AND state."targetSha" = document."headCommitSha"` : Prisma.empty}
            AND state."status" IN ('failed', 'blocked_configuration')
        )::int AS "failed"
      FROM requested
      JOIN "KnowledgeGeneration" AS generation
        ON generation."id" = requested."id"
       AND generation."projectId" = ${projectId}::uuid
      LEFT JOIN "Document" AS document
        ON document."projectId" = generation."projectId"
      LEFT JOIN "KnowledgeGenerationDocument" AS state
        ON state."generationId" = generation."id"
       AND state."projectId" = generation."projectId"
       AND state."documentId" = document."id"
      GROUP BY generation."id"
    )
    UPDATE "KnowledgeGeneration" AS generation
    SET
      "documentTotal" = counts."total",
      "documentReadyCount" = counts."ready",
      "documentFailedCount" = counts."failed"
    FROM counts
    WHERE generation."id" = counts."id"
  `);
}

function generationCounts(
  db: Db,
  generationId: string,
  projectId: string,
): Promise<GenerationCounts[]> {
  return db.$queryRaw<GenerationCounts[]>(Prisma.sql`
    SELECT
      count(document."id")::int AS "total",
      count(state."documentId") FILTER (
        WHERE state."targetSha" = document."headCommitSha"
          AND state."configFingerprint" = generation."configFingerprint"
          AND state."status" = 'ready'
          AND state."semanticIndexedSha" = document."headCommitSha"
          AND state."graphIndexedSha" = document."headCommitSha"
      )::int AS "ready",
      count(state."documentId") FILTER (
        WHERE state."targetSha" = document."headCommitSha"
          AND state."configFingerprint" = generation."configFingerprint"
          AND state."status" IN ('failed', 'blocked_configuration')
      )::int AS "failed"
    FROM "KnowledgeGeneration" AS generation
    LEFT JOIN "Document" AS document
      ON document."projectId" = generation."projectId"
    LEFT JOIN "KnowledgeGenerationDocument" AS state
      ON state."generationId" = generation."id"
     AND state."projectId" = generation."projectId"
     AND state."documentId" = document."id"
    WHERE generation."id" = ${generationId}::uuid
      AND generation."projectId" = ${projectId}::uuid
    GROUP BY generation."id"
  `);
}

async function persistGenerationCounts(
  db: Db,
  generationId: string,
  projectId: string,
  counts: GenerationCounts | undefined,
): Promise<void> {
  if (!counts) return;
  await db.knowledgeGeneration.updateMany({
    where: { id: generationId, projectId },
    data: {
      documentTotal: counts.total,
      documentReadyCount: counts.ready,
      documentFailedCount: counts.failed,
    },
  });
}

async function lockGeneration(
  tx: Prisma.TransactionClient,
  generationId: string,
): Promise<LockedGeneration | null> {
  const [generation] = await tx.$queryRaw<LockedGeneration[]>(Prisma.sql`
    SELECT "id", "projectId", "configFingerprint", "status"
    FROM "KnowledgeGeneration"
    WHERE "id" = ${generationId}::uuid
    FOR UPDATE
  `);
  return generation ?? null;
}

function lockCurrentProjectGenerations(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<LockedGeneration[]> {
  return tx.$queryRaw<LockedGeneration[]>(Prisma.sql`
    SELECT "id", "projectId", "configFingerprint", "status"
    FROM "KnowledgeGeneration"
    WHERE "projectId" = ${projectId}::uuid
      AND "status" IN ('active', 'building')
    ORDER BY "id" ASC
    FOR UPDATE
  `);
}

function generationJob(
  generation: Pick<
    KnowledgeGeneration,
    "id" | "projectId" | "configFingerprint"
  >,
  document: LiveDocument,
): GenerationDocumentPayload {
  return {
    projectId: generation.projectId,
    generationId: generation.id,
    documentId: document.id,
    sourceCommitSha: document.headCommitSha,
    pathAtSha: document.path,
    configFingerprint: generation.configFingerprint,
  };
}

async function enqueueGenerationJobs(
  jobs: GenerationDocumentPayload[],
): Promise<number> {
  let accepted = 0;
  for (const job of jobs) {
    try {
      if (await requestKnowledgeJob("document.ai-enrich", job)) accepted += 1;
    } catch (error) {
      const reference = captureError({
        event: "knowledge.enqueue.failed",
        message: "knowledge enqueue failed after generation commit",
        error,
        projectId: job.projectId,
        details: {
          job: "document.ai-enrich",
          sourceCommitSha: job.sourceCommitSha,
        },
      });
      console.error(
        `Knowledge enqueue failed after generation commit (ref ${reference ?? "none"})`,
      );
    }
  }
  return accepted;
}

function classifyProcessingFailure(error: unknown): {
  kind: KnowledgeFailureKind;
  summary: string;
  retryable: boolean;
} {
  if (error instanceof AiProviderError) {
    return {
      kind: error.kind === "validation" ? "validation" : "provider",
      summary: withValidationHint(error.message, error.details),
      retryable: error.retryable,
    };
  }
  return {
    kind: "internal",
    summary: "Knowledge document processing failed",
    retryable: true,
  };
}

/** Appends the first listed issues so the stored summary says what was rejected. */
function withValidationHint(
  message: string,
  details: AiProviderErrorDetails | null,
): string {
  if (!details) return message;
  const issues = Array.isArray(details.issues)
    ? details.issues.filter(
        (issue): issue is string => typeof issue === "string",
      )
    : [];
  const parts: string[] = [];
  if (typeof details.stage === "string" && issues.length === 0) {
    parts.push(`stage ${details.stage}`);
    if (typeof details.reason === "string") parts.push(details.reason);
    if (typeof details.finishReason === "string")
      parts.push(`finish ${details.finishReason}`);
  }
  parts.push(...issues.slice(0, 2));
  const issueCount =
    typeof details.issueCount === "number" ? details.issueCount : issues.length;
  if (issueCount > 2) parts.push(`+${issueCount - 2} more`);
  return parts.length ? `${message}: ${parts.join("; ")}` : message;
}

function safeFailureSummary(
  summary: string,
  fallback: string,
  reference: string | null = null,
): string {
  const normalized = summary.replace(/\s+/g, " ").trim();
  // The reference is appended after normalising so the 300-character cap is
  // measured on the stored text and the suffix always survives it.
  return withReference(normalized || fallback, reference, 300);
}

function assertGenerationConfiguration(
  configuration: GenerationConfiguration,
): void {
  if (
    !configuration.projectId ||
    !configuration.configFingerprint.trim() ||
    !configuration.embeddingModel.trim() ||
    !isSupportedKnowledgeDimensions(configuration.embeddingDimensions) ||
    !Number.isSafeInteger(configuration.extractionSchemaVersion) ||
    configuration.extractionSchemaVersion <= 0 ||
    !configuration.promptVersion.trim()
  ) {
    throw new Error("Invalid knowledge generation configuration");
  }
}

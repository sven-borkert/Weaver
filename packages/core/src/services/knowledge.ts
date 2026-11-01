import { knowledgeTransaction } from "./knowledgeTargets";
import { lockLiveKnowledgeProject } from "./knowledgeTargets";
import { CoreError } from "@weaver/core/errors";

import {
  Prisma,
  type KnowledgeGeneration,
  type PrismaClient,
} from "@weaver/db/client";
import {
  KNOWLEDGE_EXTRACTION_SCHEMA_VERSION,
  KNOWLEDGE_PROMPT_VERSION,
} from "@weaver/core/knowledge/config";
import { generationEmbedding } from "@weaver/core/knowledge/generationEmbedding";
import { UTC_NOW } from "./sql";
import { assertProjectRole, type ProjectActor } from "./projectAccess";
import { requestKnowledgeJob } from "../jobs/queue";
import {
  emitGenerationCreated,
  refreshGenerationCountersBatch,
} from "./knowledgeGenerations";
import { safelyRequestIndex } from "./knowledgeReconciliation";
import {
  cachedKnowledgeRouting,
  knowledgeRouteSnapshot,
  resolveKnowledgeRouting,
} from "./llmRoutes";
import { captureError, emitDiagnostic } from "../diagnostics/writer";
import { withReference } from "../diagnostics/reference";

type ReadinessLayer = "empty" | "building" | "ready" | "degraded";

export type KnowledgeReadiness = {
  keyword: ReadinessLayer;
  semantic: ReadinessLayer;
  graph: ReadinessLayer;
  aiConfigured: boolean;
};

type ProjectInput = { projectId: string };
type RetryInput = ProjectInput & {
  cursor?: { generationId: string; documentId: string };
};
type RetryCandidate = {
  generationId: string;
  documentId: string;
  configFingerprint: string;
  sourceCommitSha: string;
  pathAtSha: string;
};
type KeywordReadinessCounts = {
  total: number;
  ready: number;
  failed: number;
};
type GenerationReadinessCounts = {
  semanticReady: number;
  graphReady: number;
  semanticFailed: number;
  graphFailed: number;
};

const FAILURE_LIMIT = 50;
const FAILURE_SUMMARY_LIMIT = 300;
const RETRY_BATCH_SIZE = 200;
const KEYWORD_RETRY_CURSOR = "00000000-0000-4000-8000-000000000000";
const PG_BOSS_JOB_RELATION = "pgboss.job";

export async function getKnowledgeReadiness(
  db: PrismaClient,
  input: ProjectInput,
  actor: ProjectActor,
): Promise<KnowledgeReadiness> {
  await assertProjectRole(db, input.projectId, actor, "Viewer");
  return loadKnowledgeReadiness(db, input.projectId);
}

export async function getKnowledgeStatus(
  db: PrismaClient,
  input: ProjectInput,
  actor: ProjectActor,
) {
  // Maintainer-gated *read*: a read-only credential held by a Maintainer may see it.
  await assertProjectRole(db, input.projectId, actor, "Maintainer", {
    capability: "content:read",
  });

  const [
    readiness,
    activeGeneration,
    buildingGeneration,
    liveDocuments,
    keywordCompletion,
    generationDocumentCompletion,
    generationCompletion,
    documentFailures,
    generationFailures,
    keywordFailures,
    queue,
  ] = await Promise.all([
    loadKnowledgeReadiness(db, input.projectId),
    findGeneration(db, input.projectId, "active"),
    findGeneration(db, input.projectId, "building"),
    db.document.count({ where: { projectId: input.projectId } }),
    db.documentIndexState.findFirst({
      where: { projectId: input.projectId, completedAt: { not: null } },
      orderBy: { completedAt: "desc" },
      select: { completedAt: true },
    }),
    db.knowledgeGenerationDocument.findFirst({
      where: { projectId: input.projectId, completedAt: { not: null } },
      orderBy: { completedAt: "desc" },
      select: { completedAt: true },
    }),
    db.knowledgeGeneration.findFirst({
      where: { projectId: input.projectId, completedAt: { not: null } },
      orderBy: { completedAt: "desc" },
      select: { completedAt: true },
    }),
    db.knowledgeGenerationDocument.findMany({
      where: {
        projectId: input.projectId,
        status: { in: ["failed", "blocked_configuration"] },
        generation: { status: { in: ["active", "building"] } },
      },
      orderBy: [
        { updatedAt: "desc" },
        { generationId: "asc" },
        { documentId: "asc" },
      ],
      take: FAILURE_LIMIT,
      select: {
        generationId: true,
        documentId: true,
        status: true,
        failureKind: true,
        failureSummary: true,
        completedAt: true,
        updatedAt: true,
      },
    }),
    db.knowledgeGeneration.findMany({
      where: { projectId: input.projectId, status: "failed" },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: FAILURE_LIMIT,
      select: {
        id: true,
        failureKind: true,
        failureSummary: true,
        completedAt: true,
        createdAt: true,
      },
    }),
    db.documentIndexState.findMany({
      where: { projectId: input.projectId, status: "failed" },
      orderBy: [{ updatedAt: "desc" }, { documentId: "asc" }],
      take: FAILURE_LIMIT,
      select: {
        documentId: true,
        failureKind: true,
        failureSummary: true,
        completedAt: true,
        updatedAt: true,
      },
    }),
    loadProjectQueueCounts(db, input.projectId),
  ]);

  const failures = [
    ...keywordFailures.map((failure) => ({
      generationId: "keyword",
      documentId: failure.documentId,
      status: "failed" as const,
      kind: failure.failureKind ?? ("internal" as const),
      summary: safeFailureSummary(
        failure.failureSummary,
        "Keyword indexing failed",
      ),
      completedAt: failure.completedAt,
      occurredAt: failure.completedAt ?? failure.updatedAt,
    })),
    ...documentFailures.map((failure) => ({
      generationId: failure.generationId,
      documentId: failure.documentId,
      status: failure.status,
      kind: failure.failureKind ?? ("internal" as const),
      summary: safeFailureSummary(
        failure.failureSummary,
        "Knowledge document processing failed",
      ),
      completedAt: failure.completedAt,
      occurredAt: failure.completedAt ?? failure.updatedAt,
    })),
    ...generationFailures.map((failure) => ({
      generationId: failure.id,
      documentId: null,
      status: "failed" as const,
      kind: failure.failureKind ?? ("internal" as const),
      summary: safeFailureSummary(
        failure.failureSummary,
        "Knowledge generation failed",
      ),
      completedAt: failure.completedAt,
      occurredAt: failure.completedAt ?? failure.createdAt,
    })),
  ]
    .sort(
      (left, right) =>
        right.occurredAt.getTime() - left.occurredAt.getTime() ||
        left.generationId.localeCompare(right.generationId) ||
        (left.documentId ?? "").localeCompare(right.documentId ?? ""),
    )
    .slice(0, FAILURE_LIMIT);

  const lastCompletedAt = latestDate([
    keywordCompletion?.completedAt,
    generationDocumentCompletion?.completedAt,
    generationCompletion?.completedAt,
  ]);

  const routing = await cachedKnowledgeRouting(db);
  const outdatedExtraction = await countOutdatedExtraction(
    db,
    input.projectId,
    activeGeneration?.id ?? null,
    routing?.extractionFingerprint ?? null,
  );

  return {
    readiness,
    activeGeneration: generationStatus(activeGeneration),
    buildingGeneration: generationStatus(buildingGeneration),
    liveDocuments,
    outdatedExtraction,
    lastCompletedAt,
    failures,
    queue,
  };
}

async function countOutdatedExtraction(
  db: PrismaClient,
  projectId: string,
  generationId: string | null,
  liveExtractionFingerprint: string | null,
): Promise<number> {
  if (!generationId || !liveExtractionFingerprint) return 0;
  const [row] = await db.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    SELECT count(*)::int AS "count"
    FROM "Document" AS document
    JOIN "KnowledgeGenerationDocument" AS state
      ON state."generationId" = ${generationId}::uuid
     AND state."projectId" = document."projectId"
     AND state."documentId" = document."id"
     AND state."graphIndexedSha" = document."headCommitSha"
    WHERE document."projectId" = ${projectId}::uuid
      AND state."extractionFingerprint" IS DISTINCT FROM ${liveExtractionFingerprint}
  `);
  return row?.count ?? 0;
}

export async function requestKnowledgeRebuild(
  db: PrismaClient,
  input: ProjectInput,
  actor: ProjectActor,
): Promise<{ generationId: string }> {
  const result = await knowledgeTransaction(db, async (tx) => {
    await assertProjectRole(tx, input.projectId, actor, "Maintainer");
    await lockLiveProject(tx, input.projectId);
    const routing = await resolveKnowledgeRouting(tx);
    if (!routing)
      throw new CoreError(
        "PRECONDITION_FAILED",
        "Configure knowledge extraction and embedding before rebuilding the AI index",
      );
    const configFingerprint = routing.configFingerprint;
    const superseded = await tx.knowledgeGeneration.updateManyAndReturn({
      where: { projectId: input.projectId, status: "building" },
      data: { status: "superseded", supersededAt: new Date() },
      select: { id: true },
    });
    const generation = await tx.knowledgeGeneration.create({
      data: {
        projectId: input.projectId,
        configFingerprint,
        embeddingModel: routing?.embedding.providerModelId ?? "unconfigured",
        embeddingDimensions: routing.embeddingDimensions,
        extractionSchemaVersion: KNOWLEDGE_EXTRACTION_SCHEMA_VERSION,
        promptVersion: KNOWLEDGE_PROMPT_VERSION,
        routeSnapshot: routing
          ? (knowledgeRouteSnapshot(routing) as Prisma.InputJsonObject)
          : Prisma.DbNull,
        status: "building",
        buildTrigger: "manual_rebuild",
        requestedById: actor.userId,
      },
    });
    return { generation, configFingerprint, superseded };
  });

  for (const { id } of result.superseded) {
    emitDiagnostic({
      event: "knowledge.generation.superseded",
      message: `generation ${id.slice(0, 8)} superseded by requested rebuild`,
      projectId: input.projectId,
      generationId: id,
      details: { replacementGenerationId: result.generation.id },
    });
  }
  emitGenerationCreated(result.generation);
  await safelyRequestIndex("project.generation-build", {
    projectId: input.projectId,
    generationId: result.generation.id,
    configFingerprint: result.configFingerprint,
  });
  return { generationId: result.generation.id };
}

export async function retryFailedKnowledge(
  db: PrismaClient,
  input: RetryInput,
  actor: ProjectActor,
): Promise<{
  retried: number;
  hasMore: boolean;
  nextCursor: RetryInput["cursor"] | null;
}> {
  const generationCursor =
    input.cursor?.generationId === KEYWORD_RETRY_CURSOR
      ? undefined
      : input.cursor;
  const page = await knowledgeTransaction(db, async (tx) => {
    await assertProjectRole(tx, input.projectId, actor, "Maintainer");
    await lockLiveProject(tx, input.projectId);
    const keywordJobs =
      !input.cursor || input.cursor.generationId === KEYWORD_RETRY_CURSOR
        ? await tx.$queryRaw<
            Array<{
              documentId: string;
              sourceCommitSha: string;
              pathAtSha: string;
            }>
          >(Prisma.sql`
          SELECT document."id" AS "documentId", document."headCommitSha" AS "sourceCommitSha", document."path" AS "pathAtSha"
          FROM "DocumentIndexState" AS state JOIN "Document" AS document
            ON document."id" = state."documentId" AND document."projectId" = state."projectId" AND document."headCommitSha" = state."targetSha"
          WHERE state."projectId" = ${input.projectId}::uuid AND state."status" = 'failed'
            AND (${input.cursor?.documentId ?? null}::uuid IS NULL OR document."id" > ${input.cursor?.documentId ?? null}::uuid)
          ORDER BY document."id" LIMIT ${RETRY_BATCH_SIZE} FOR UPDATE OF state, document
        `)
        : [];
    if (keywordJobs.length)
      await tx.documentIndexState.updateMany({
        where: {
          projectId: input.projectId,
          documentId: { in: keywordJobs.map((job) => job.documentId) },
        },
        data: {
          status: "pending",
          failureKind: null,
          failureSummary: null,
          completedAt: null,
          lastAttemptAt: null,
        },
      });
    if (keywordJobs.length === RETRY_BATCH_SIZE)
      return {
        jobs: [] as RetryCandidate[],
        keywordJobs,
        hasMore: true,
        nextCursor: {
          generationId: KEYWORD_RETRY_CURSOR,
          documentId: keywordJobs.at(-1)!.documentId,
        },
      };
    const remaining = RETRY_BATCH_SIZE - keywordJobs.length;
    const candidates = await tx.$queryRaw<RetryCandidate[]>(Prisma.sql`
      SELECT state."generationId",
             state."documentId",
             state."configFingerprint",
             document."headCommitSha" AS "sourceCommitSha",
             document."path" AS "pathAtSha"
      FROM "KnowledgeGenerationDocument" AS state
      JOIN "KnowledgeGeneration" AS generation
        ON generation."id" = state."generationId"
       AND generation."projectId" = state."projectId"
      JOIN "Document" AS document
        ON document."id" = state."documentId"
       AND document."projectId" = state."projectId"
      WHERE state."projectId" = ${input.projectId}::uuid
        AND generation."status" IN ('active', 'building')
        AND state."status" IN ('failed', 'blocked_configuration')
        AND state."targetSha" = document."headCommitSha"
        AND state."configFingerprint" = generation."configFingerprint"
        AND (
          ${generationCursor?.generationId ?? null}::uuid IS NULL
          OR (state."generationId", state."documentId") >
             (${generationCursor?.generationId ?? null}::uuid,
              ${generationCursor?.documentId ?? null}::uuid)
        )
      ORDER BY state."generationId", state."documentId"
      LIMIT ${remaining + 1}
      FOR UPDATE OF state, generation, document
    `);

    const hasMore = candidates.length > remaining;
    const jobs = candidates.slice(0, remaining);
    if (jobs.length > 0) {
      const identities = jobs.map(
        (candidate) => Prisma.sql`
        (${candidate.generationId}::uuid, ${candidate.documentId}::uuid)
      `,
      );
      await tx.$executeRaw(Prisma.sql`
        UPDATE "KnowledgeGenerationDocument" AS state
        SET
          "status" = 'pending',
          "failureKind" = NULL,
          "failureSummary" = NULL,
          "attempts" = 0,
          "processingClaimToken" = NULL,
          "processingJobId" = NULL,
          "processingRetryCount" = NULL,
          "lastAttemptAt" = NULL,
          "completedAt" = NULL,
          "updatedAt" = ${UTC_NOW}
        FROM (VALUES ${Prisma.join(identities)}) AS selected(
          "generationId", "documentId"
        )
        WHERE state."generationId" = selected."generationId"
          AND state."documentId" = selected."documentId"
          AND state."projectId" = ${input.projectId}::uuid
          AND state."status" IN ('failed', 'blocked_configuration')
      `);
      await refreshGenerationCountersBatch(tx, input.projectId, [
        ...new Set(jobs.map((job) => job.generationId)),
      ]);
    }
    const last = jobs.at(-1);
    return {
      jobs,
      keywordJobs,
      hasMore,
      nextCursor:
        hasMore && last
          ? { generationId: last.generationId, documentId: last.documentId }
          : null,
    };
  });

  let keywordEnqueued = 0;
  let enrichmentEnqueued = 0;
  for (const job of page.keywordJobs) {
    if (
      await safelyRequestIndex("document.search-sync", {
        projectId: input.projectId,
        ...job,
      })
    )
      keywordEnqueued += 1;
  }
  const deliveryFailures: RetryCandidate[] = [];
  let enqueueReference: string | null = null;
  for (const job of page.jobs) {
    try {
      if (
        await requestKnowledgeJob("document.ai-enrich", {
          projectId: input.projectId,
          ...job,
        })
      )
        enrichmentEnqueued += 1;
    } catch (error) {
      deliveryFailures.push(job);
      const reference = captureError({
        event: "knowledge.enqueue.failed",
        message: "knowledge retry enqueue failed",
        error,
        projectId: input.projectId,
        details: {
          job: "document.ai-enrich",
          sourceCommitSha: job.sourceCommitSha,
        },
      });
      enqueueReference ??= reference;
      console.error(
        `Knowledge retry enqueue failed (ref ${reference ?? "none"})`,
      );
    }
  }
  if (deliveryFailures.length > 0) {
    await restoreFailedRetryDeliveries(
      db,
      input.projectId,
      deliveryFailures,
      enqueueReference,
    );
  }
  emitDiagnostic({
    event: "knowledge.retry.requested",
    ...(deliveryFailures.length > 0
      ? { severity: "warn" as const, outcome: "error" as const }
      : {}),
    message: "failed knowledge retry page processed",
    projectId: input.projectId,
    details: {
      resetCount: page.keywordJobs.length + page.jobs.length,
      keywordEnqueued,
      enrichmentEnqueued,
      enrichmentPublicationFailures: deliveryFailures.length,
      hasMore: page.hasMore || deliveryFailures.length > 0,
    },
  });
  return {
    retried:
      page.keywordJobs.length + page.jobs.length - deliveryFailures.length,
    hasMore: page.hasMore || deliveryFailures.length > 0,
    nextCursor:
      deliveryFailures.length > 0 ? (input.cursor ?? null) : page.nextCursor,
  };
}

async function restoreFailedRetryDeliveries(
  db: PrismaClient,
  projectId: string,
  failures: RetryCandidate[],
  reference: string | null,
): Promise<void> {
  await knowledgeTransaction(db, async (tx) => {
    await lockLiveProject(tx, projectId);
    const identities = failures.map(
      (failure) => Prisma.sql`
      (${failure.generationId}::uuid, ${failure.documentId}::uuid)
    `,
    );
    await tx.$executeRaw(Prisma.sql`
      UPDATE "KnowledgeGenerationDocument" AS state
      SET
        "status" = 'failed',
        "failureKind" = 'internal',
        "failureSummary" = ${withReference("Knowledge retry enqueue failed", reference, 300)},
        "completedAt" = NULL,
        "updatedAt" = ${UTC_NOW}
      FROM (VALUES ${Prisma.join(identities)}) AS failed(
        "generationId", "documentId"
      )
      WHERE state."generationId" = failed."generationId"
        AND state."documentId" = failed."documentId"
        AND state."projectId" = ${projectId}::uuid
        AND state."status" = 'pending'
    `);
    await refreshGenerationCountersBatch(tx, projectId, [
      ...new Set(failures.map((failure) => failure.generationId)),
    ]);
  });
}

async function loadKnowledgeReadiness(
  db: PrismaClient,
  projectId: string,
): Promise<KnowledgeReadiness> {
  const aiConfigured = (await cachedKnowledgeRouting(db)) !== null;
  const [keywordCounts] = await db.$queryRaw<KeywordReadinessCounts[]>(
    Prisma.sql`
      SELECT
        count(document."id")::int AS "total",
        count(state."documentId") FILTER (
          WHERE state."status" = 'ready'
            AND state."targetSha" = document."headCommitSha"
            AND state."keywordIndexedSha" = document."headCommitSha"
        )::int AS "ready",
        count(state."documentId") FILTER (
          WHERE state."targetSha" = document."headCommitSha"
            AND state."status" IN ('failed', 'blocked_configuration')
        )::int AS "failed"
      FROM "Document" AS document
      LEFT JOIN "DocumentIndexState" AS state
        ON state."documentId" = document."id"
       AND state."projectId" = document."projectId"
      WHERE document."projectId" = ${projectId}::uuid
    `,
  );
  const counts = keywordCounts ?? { total: 0, ready: 0, failed: 0 };
  if (counts.total === 0) {
    return {
      keyword: "empty",
      semantic: "empty",
      graph: "empty",
      aiConfigured,
    };
  }

  const primaryGeneration =
    (await findGeneration(db, projectId, "active")) ??
    (await findGeneration(db, projectId, "building"));
  if (!primaryGeneration) {
    const failedGeneration = await findGeneration(db, projectId, "failed");
    return {
      keyword: layerReadiness(counts.total, counts.ready, counts.failed),
      semantic: failedGeneration ? "degraded" : "empty",
      graph: failedGeneration ? "degraded" : "empty",
      aiConfigured,
    };
  }

  // Configuration-blocked active documents count as building while a building generation covers them.
  const coveredByBuild =
    primaryGeneration.status === "active" &&
    (await db.knowledgeGeneration.count({
      where: { projectId, status: "building" },
    })) > 0;
  const [generationCounts] = await db.$queryRaw<GenerationReadinessCounts[]>(
    Prisma.sql`
      SELECT
        count(state."documentId") FILTER (
          WHERE state."targetSha" = document."headCommitSha"
            AND state."configFingerprint" = ${primaryGeneration.configFingerprint}
            AND state."semanticIndexedSha" = document."headCommitSha"
        )::int AS "semanticReady",
        count(state."documentId") FILTER (
          WHERE state."targetSha" = document."headCommitSha"
            AND state."configFingerprint" = ${primaryGeneration.configFingerprint}
            AND state."graphIndexedSha" = document."headCommitSha"
        )::int AS "graphReady",
        count(state."documentId") FILTER (
          WHERE state."targetSha" = document."headCommitSha"
            AND state."configFingerprint" = ${primaryGeneration.configFingerprint}
            AND (state."status" = 'failed'
              OR (state."status" = 'blocked_configuration' AND NOT ${coveredByBuild}))
            AND state."semanticIndexedSha" IS DISTINCT FROM document."headCommitSha"
        )::int AS "semanticFailed",
        count(state."documentId") FILTER (
          WHERE state."targetSha" = document."headCommitSha"
            AND state."configFingerprint" = ${primaryGeneration.configFingerprint}
            AND (state."status" = 'failed'
              OR (state."status" = 'blocked_configuration' AND NOT ${coveredByBuild}))
            AND state."graphIndexedSha" IS DISTINCT FROM document."headCommitSha"
        )::int AS "graphFailed"
      FROM "Document" AS document
      LEFT JOIN "KnowledgeGenerationDocument" AS state
        ON state."generationId" = ${primaryGeneration.id}::uuid
       AND state."projectId" = document."projectId"
       AND state."documentId" = document."id"
      WHERE document."projectId" = ${projectId}::uuid
    `,
  );
  const aiCounts = generationCounts ?? {
    semanticReady: 0,
    graphReady: 0,
    semanticFailed: 0,
    graphFailed: 0,
  };

  // A layer is degraded only by failures that left it unindexed at HEAD; an
  // embedded document whose graph extraction failed keeps semantic ready.
  return {
    keyword: layerReadiness(counts.total, counts.ready, counts.failed),
    semantic: layerReadiness(
      counts.total,
      aiCounts.semanticReady,
      aiCounts.semanticFailed,
    ),
    graph: layerReadiness(
      counts.total,
      aiCounts.graphReady,
      aiCounts.graphFailed,
    ),
    aiConfigured,
  };
}

function findGeneration(
  db: PrismaClient,
  projectId: string,
  status: "active" | "building" | "failed",
) {
  return db.knowledgeGeneration.findFirst({
    where: { projectId, status },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
  });
}

function generationStatus(generation: KnowledgeGeneration | null) {
  if (!generation) return null;
  return {
    id: generation.id,
    status: generation.status,
    documentTotal: generation.documentTotal,
    documentReadyCount: generation.documentReadyCount,
    documentFailedCount: generation.documentFailedCount,
    createdAt: generation.createdAt,
    completedAt: generation.completedAt,
    graphCarried: generation.graphSourceGenerationId !== null,
    embedding: generationEmbedding(generation, { includeModel: true }),
  };
}

function layerReadiness(
  total: number,
  ready: number,
  failed: number,
): ReadinessLayer {
  if (total === 0) return "empty";
  if (failed > 0) return "degraded";
  if (ready === total) return "ready";
  return "building";
}

async function loadProjectQueueCounts(
  db: PrismaClient,
  projectId: string,
): Promise<{ queued: number; active: number }> {
  const empty = { queued: 0, active: 0 };
  const [relation] = await db.$queryRaw<Array<{ relation: string | null }>>(
    Prisma.sql`
      SELECT to_regclass(${PG_BOSS_JOB_RELATION})::text AS relation
    `,
  );
  if (!relation?.relation) return empty;

  try {
    const [counts] = await db.$queryRaw<
      Array<{ queued: number; active: number }>
    >(Prisma.sql`
      SELECT count(*) FILTER (
               WHERE job.state IN ('created', 'retry')
             )::int AS queued,
             count(*) FILTER (
               WHERE job.state = 'active'
             )::int AS active
      FROM pgboss.job AS job
      WHERE job.data->>'projectId' = ${projectId}
        AND job.state IN ('created', 'retry', 'active')
        AND job.name IN ('document.search-sync', 'document.ai-enrich', 'table.search-sync', 'content.delete', 'project.reconcile', 'project.generation-build')
    `);
    return counts ?? empty;
  } catch (error) {
    if (missingQueueRelation(error)) return empty;
    throw error;
  }
}

function missingQueueRelation(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("meta" in error)) return false;
  const meta = (
    error as {
      meta?: {
        code?: unknown;
        driverAdapterError?: { cause?: { originalCode?: unknown } };
      };
    }
  ).meta;
  const code = meta?.code ?? meta?.driverAdapterError?.cause?.originalCode;
  return code === "42P01" || code === "3F000";
}

async function lockLiveProject(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<void> {
  if (!(await lockLiveKnowledgeProject(tx, projectId)))
    throw new CoreError("NOT_FOUND");
}

function safeFailureSummary(summary: string | null, fallback: string): string {
  const normalized = summary?.replace(/\s+/g, " ").trim() ?? "";
  return (normalized || fallback).slice(0, FAILURE_SUMMARY_LIMIT);
}

function latestDate(values: Array<Date | null | undefined>): Date | null {
  const dates = values.filter((value): value is Date => value instanceof Date);
  if (dates.length === 0) return null;
  return new Date(Math.max(...dates.map((value) => value.getTime())));
}

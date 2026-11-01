import { Prisma, type PrismaClient } from "@weaver/db/client";
import { captureError, emitDiagnostic } from "../diagnostics/writer";
import { requestKnowledgeJob } from "../jobs/queue";
import type { KnowledgeSystemContext } from "../jobs/systemContext";
import type { KnowledgeJobName, KnowledgeJobPayloads } from "../jobs/types";
import {
  activateCompletedGeneration,
  recordDocumentChangeForGenerations,
  cleanupSupersededGenerations,
  generationDocumentRecoveryDue,
  recoverBlockedGenerationDocuments,
} from "./knowledgeGenerations";

const RECONCILIATION_BATCH_SIZE = 200;

type DocumentChangedPayload = KnowledgeJobPayloads["document.search-sync"];
type TableChangedPayload = KnowledgeJobPayloads["table.search-sync"];
type ContentDeletedPayload = KnowledgeJobPayloads["content.delete"];

type GenerationDocumentStatePageRow = {
  documentId: string;
  targetSha: string;
};

async function loadGenerationDocumentStatePage(
  db: PrismaClient,
  projectId: string,
  cursor?: string,
): Promise<GenerationDocumentStatePageRow[]> {
  const cursorPredicate = cursor
    ? Prisma.sql`AND "documentId" > ${cursor}::uuid`
    : Prisma.empty;

  return db.$queryRaw<GenerationDocumentStatePageRow[]>(Prisma.sql`
    SELECT DISTINCT ON ("documentId")
      "documentId",
      "targetSha"
    FROM "KnowledgeGenerationDocument"
    WHERE "projectId" = ${projectId}::uuid
      AND "status" <> 'missing'
      ${cursorPredicate}
    ORDER BY "documentId" ASC, "updatedAt" DESC, "generationId" ASC
    LIMIT ${RECONCILIATION_BATCH_SIZE}
  `);
}

export async function safelyRequestIndex<N extends KnowledgeJobName>(
  name: N,
  data: KnowledgeJobPayloads[N],
): Promise<boolean> {
  try {
    return (await requestKnowledgeJob(name, data)) !== null;
  } catch (error) {
    const projectId = "projectId" in data ? data.projectId : undefined;
    const reference = captureError({
      event: "knowledge.enqueue.failed",
      message: "knowledge enqueue failed after durable source transition",
      error,
      ...(projectId === undefined ? {} : { projectId }),
      details: {
        job: name,
        sourceCommitSha:
          "sourceCommitSha" in data ? data.sourceCommitSha : undefined,
      },
    });
    console.error(
      `Knowledge enqueue failed after durable source transition (ref ${reference ?? "none"})`,
    );
    return false;
  }
}

export async function enqueueDocumentChanged(
  data: DocumentChangedPayload,
): Promise<boolean> {
  return safelyRequestIndex("document.search-sync", data);
}

export async function enqueueTableChanged(
  data: TableChangedPayload,
): Promise<boolean> {
  return safelyRequestIndex("table.search-sync", data);
}

export async function enqueueContentDeleted(
  data: ContentDeletedPayload,
): Promise<boolean> {
  return safelyRequestIndex("content.delete", data);
}

export async function enqueueProjectReconcile(
  projectId: string,
  repairDocumentIds?: string[],
): Promise<boolean> {
  return safelyRequestIndex("project.reconcile", {
    projectId,
    ...(repairDocumentIds?.length ? { repairDocumentIds } : {}),
  });
}

export async function reconcileProjectKnowledge(
  context: KnowledgeSystemContext,
  db: PrismaClient,
  projectId: string,
  options?: { signal?: AbortSignal; liveConfigFingerprint?: string },
): Promise<void> {
  void context;
  const project = await db.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true },
  });
  if (!project) return;

  await cleanupSupersededGenerations(context, db, projectId);

  const generations = await db.knowledgeGeneration.findMany({
    where: { projectId, status: { in: ["active", "building"] } },
    select: { id: true, status: true, configFingerprint: true },
  });
  generations.sort((left, right) => {
    if (left.status !== right.status) return left.status === "active" ? -1 : 1;
    return left.id.localeCompare(right.id);
  });

  let documentsChecked = 0;
  let jobsEnqueued = 0;
  let documentCursor: string | undefined;
  for (;;) {
    options?.signal?.throwIfAborted();
    const documents = await db.document.findMany({
      where: {
        projectId,
        ...(documentCursor ? { id: { gt: documentCursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: RECONCILIATION_BATCH_SIZE,
      select: { id: true, path: true, headCommitSha: true },
    });
    if (documents.length === 0) break;

    const documentIds = documents.map((document) => document.id);
    const localStates = await db.documentIndexState.findMany({
      where: { projectId, documentId: { in: documentIds } },
      select: {
        documentId: true,
        targetSha: true,
        keywordIndexedSha: true,
        status: true,
      },
    });
    const localStateByDocument = new Map(
      localStates.map((state) => [state.documentId, state]),
    );
    for (const generation of generations) {
      if (generation.configFingerprint === options?.liveConfigFingerprint) {
        await recoverBlockedGenerationDocuments(db, {
          projectId,
          generationId: generation.id,
          configFingerprint: generation.configFingerprint,
          documentIds,
        });
      }
    }
    const generationStates =
      generations.length === 0
        ? []
        : await db.knowledgeGenerationDocument.findMany({
            where: {
              projectId,
              documentId: { in: documentIds },
              generationId: {
                in: generations.map((generation) => generation.id),
              },
            },
            select: {
              generationId: true,
              documentId: true,
              targetSha: true,
              configFingerprint: true,
              semanticIndexedSha: true,
              graphIndexedSha: true,
              status: true,
              failureKind: true,
              lastAttemptAt: true,
              completedAt: true,
            },
          });
    const generationStateByDocument = new Map(
      generationStates.map((state) => [
        `${state.generationId}:${state.documentId}`,
        state,
      ]),
    );

    for (const document of documents) {
      options?.signal?.throwIfAborted();
      documentsChecked += 1;
      const payload = {
        projectId,
        documentId: document.id,
        sourceCommitSha: document.headCommitSha,
        pathAtSha: document.path,
      } satisfies DocumentChangedPayload;
      const localState = localStateByDocument.get(document.id);
      if (
        localState?.targetSha !== document.headCommitSha ||
        (localState?.status !== "failed" &&
          (localState?.keywordIndexedSha !== document.headCommitSha ||
            localState?.status !== "ready"))
      ) {
        if (await enqueueDocumentChanged(payload)) jobsEnqueued += 1;
        // Let keyword sync carry completed results before resetting their source target.
        if (
          localState?.status === "ready" &&
          generations.some((generation) => {
            const state = generationStateByDocument.get(
              `${generation.id}:${document.id}`,
            );
            return (
              state?.status === "ready" &&
              state.targetSha === localState.keywordIndexedSha &&
              state.semanticIndexedSha === state.targetSha &&
              state.graphIndexedSha === state.targetSha &&
              state.configFingerprint === generation.configFingerprint
            );
          })
        )
          continue;
      }

      const targetDrift = generations.some((generation) => {
        const state = generationStateByDocument.get(
          `${generation.id}:${document.id}`,
        );
        return (
          state?.targetSha !== document.headCommitSha ||
          state.configFingerprint !== generation.configFingerprint
        );
      });
      if (targetDrift) {
        jobsEnqueued += await recordDocumentChangeForGenerations(
          context,
          db,
          payload,
        );
        continue;
      }
      for (const generation of generations) {
        const state = generationStateByDocument.get(
          `${generation.id}:${document.id}`,
        );
        const exact =
          state?.targetSha === document.headCommitSha &&
          state.configFingerprint === generation.configFingerprint;
        const needsEnrichment =
          !exact ||
          generationDocumentRecoveryDue(state) ||
          (state.status === "ready" &&
            (state.semanticIndexedSha !== document.headCommitSha ||
              state.graphIndexedSha !== document.headCommitSha));
        if (!needsEnrichment) {
          continue;
        }
        if (
          await safelyRequestIndex("document.ai-enrich", {
            ...payload,
            generationId: generation.id,
            configFingerprint: generation.configFingerprint,
          })
        ) {
          jobsEnqueued += 1;
        }
      }
    }

    documentCursor = documents.at(-1)!.id;
  }

  // An entity with live provenance but no vector fell out of semantic search
  // when its canonical description changed. No provider calls here: one
  // enrichment job for an up-to-date supporting document runs the embed-only
  // repair for the whole generation.
  for (const generation of generations) {
    options?.signal?.throwIfAborted();
    const [support] = await db.$queryRaw<
      Array<{ documentId: string; path: string; headCommitSha: string }>
    >(Prisma.sql`
      SELECT document."id"::text AS "documentId",
             document."path",
             document."headCommitSha"
      FROM "GraphEntity" entity
      JOIN "EntityMention" mention
        ON mention."entityId" = entity."id"
       AND mention."generationId" = entity."generationId"
       AND mention."invalidatedAt" IS NULL
      JOIN "Document" document
        ON document."id" = mention."documentId"
       AND document."headCommitSha" = mention."sourceCommitSha"
      JOIN "KnowledgeGenerationDocument" state
        ON state."generationId" = entity."generationId"
       AND state."documentId" = document."id"
       AND state."status" = 'ready'
       AND state."targetSha" = document."headCommitSha"
       AND state."graphIndexedSha" = document."headCommitSha"
       AND state."configFingerprint" = ${generation.configFingerprint}
      WHERE entity."projectId" = ${projectId}::uuid
        AND entity."generationId" = ${generation.id}::uuid
        AND NOT EXISTS (
          SELECT 1 FROM "KnowledgeEmbedding" embedding
          WHERE embedding."generationId" = entity."generationId"
            AND embedding."ownerType" = 'entity'
            AND embedding."ownerId" = entity."id"::text
        )
      ORDER BY entity."id", document."id"
      LIMIT 1
    `);
    if (
      support &&
      (await safelyRequestIndex("document.ai-enrich", {
        projectId,
        documentId: support.documentId,
        sourceCommitSha: support.headCommitSha,
        pathAtSha: support.path,
        generationId: generation.id,
        configFingerprint: generation.configFingerprint,
      }))
    ) {
      jobsEnqueued += 1;
    }
  }

  for (const generation of generations) {
    if (generation.status === "building") {
      await activateCompletedGeneration(context, db, {
        projectId,
        generationId: generation.id,
      });
    }
  }

  let tableCursor: string | undefined;
  for (;;) {
    options?.signal?.throwIfAborted();
    const tables = await db.dataTable.findMany({
      where: {
        projectId,
        ...(tableCursor ? { id: { gt: tableCursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: RECONCILIATION_BATCH_SIZE,
      select: { id: true, path: true, headCommitSha: true },
    });
    if (tables.length === 0) break;

    const projections = await db.tableSearchProjection.findMany({
      where: {
        projectId,
        tableId: { in: tables.map((table) => table.id) },
      },
      select: { tableId: true, sourceCommitSha: true },
    });
    const projectionByTable = new Map(
      projections.map((projection) => [projection.tableId, projection]),
    );
    for (const table of tables) {
      if (
        projectionByTable.get(table.id)?.sourceCommitSha === table.headCommitSha
      ) {
        continue;
      }
      if (
        await enqueueTableChanged({
          projectId,
          tableId: table.id,
          sourceCommitSha: table.headCommitSha,
          pathAtSha: table.path,
        })
      ) {
        jobsEnqueued += 1;
      }
    }

    tableCursor = tables.at(-1)!.id;
  }

  let documentStateCursor: string | undefined;
  for (;;) {
    options?.signal?.throwIfAborted();
    const states = await db.documentIndexState.findMany({
      where: {
        projectId,
        ...(documentStateCursor
          ? { documentId: { gt: documentStateCursor } }
          : {}),
      },
      orderBy: { documentId: "asc" },
      take: RECONCILIATION_BATCH_SIZE,
      select: { documentId: true, targetSha: true },
    });
    if (states.length === 0) break;

    const live = await db.document.findMany({
      where: {
        projectId,
        id: { in: states.map((state) => state.documentId) },
      },
      select: { id: true },
    });
    const liveIds = new Set(live.map((document) => document.id));
    for (const state of states) {
      if (liveIds.has(state.documentId)) continue;
      if (
        await enqueueContentDeleted({
          projectId,
          sourceType: "document",
          sourceId: state.documentId,
          sourceCommitSha: state.targetSha,
        })
      ) {
        jobsEnqueued += 1;
      }
    }

    documentStateCursor = states.at(-1)!.documentId;
  }

  let generationDocumentCursor: string | undefined;
  for (;;) {
    options?.signal?.throwIfAborted();
    const states = await loadGenerationDocumentStatePage(
      db,
      projectId,
      generationDocumentCursor,
    );
    if (states.length === 0) break;

    const documentIds = states.map((state) => state.documentId);
    const [live, localStates] = await Promise.all([
      db.document.findMany({
        where: { projectId, id: { in: documentIds } },
        select: { id: true },
      }),
      db.documentIndexState.findMany({
        where: { projectId, documentId: { in: documentIds } },
        select: { documentId: true },
      }),
    ]);
    const coveredIds = new Set([
      ...live.map((document) => document.id),
      ...localStates.map((state) => state.documentId),
    ]);
    for (const state of states) {
      if (coveredIds.has(state.documentId)) continue;
      if (
        await enqueueContentDeleted({
          projectId,
          sourceType: "document",
          sourceId: state.documentId,
          sourceCommitSha: state.targetSha,
        })
      ) {
        jobsEnqueued += 1;
      }
    }

    generationDocumentCursor = states.at(-1)!.documentId;
  }

  let tableProjectionCursor: string | undefined;
  for (;;) {
    options?.signal?.throwIfAborted();
    const projections = await db.tableSearchProjection.findMany({
      where: {
        projectId,
        ...(tableProjectionCursor
          ? { tableId: { gt: tableProjectionCursor } }
          : {}),
      },
      orderBy: { tableId: "asc" },
      take: RECONCILIATION_BATCH_SIZE,
      select: { tableId: true, sourceCommitSha: true },
    });
    if (projections.length === 0) break;

    const live = await db.dataTable.findMany({
      where: {
        projectId,
        id: { in: projections.map((projection) => projection.tableId) },
      },
      select: { id: true },
    });
    const liveIds = new Set(live.map((table) => table.id));
    for (const projection of projections) {
      if (liveIds.has(projection.tableId)) continue;
      if (
        await enqueueContentDeleted({
          projectId,
          sourceType: "table",
          sourceId: projection.tableId,
          sourceCommitSha: projection.sourceCommitSha,
        })
      ) {
        jobsEnqueued += 1;
      }
    }

    tableProjectionCursor = projections.at(-1)!.tableId;
  }

  emitDiagnostic({
    event: "knowledge.reconcile.completed",
    message: `reconciled project ${projectId.slice(0, 8)}`,
    projectId,
    details: {
      documentsChecked,
      jobsEnqueued,
      generations: generations.length,
    },
  });
}

export async function enqueueReconcileForLiveProjects(
  db: PrismaClient,
): Promise<number> {
  let queued = 0;
  let cursor: string | undefined;
  for (;;) {
    const projects = await db.project.findMany({
      where: {
        deletedAt: null,
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: RECONCILIATION_BATCH_SIZE,
      select: { id: true },
    });
    if (projects.length === 0) return queued;
    for (const project of projects) {
      if (await enqueueProjectReconcile(project.id)) queued += 1;
    }
    cursor = projects.at(-1)!.id;
  }
}

export async function reconcileAllProjects(
  context: KnowledgeSystemContext,
  db: PrismaClient,
): Promise<void> {
  void context;
  await enqueueReconcileForLiveProjects(db);
}

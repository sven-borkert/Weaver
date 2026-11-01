import { Prisma } from "@weaver/db/client";
import { BACKGROUND_WORK_LIMITS } from "../../jobs/backgroundWorkSchema";
import { UTC_NOW } from "../sql";
import type { WorkQueryAccess } from "./access";

export function knowledgeSourceSql(access: WorkQueryAccess): Prisma.Sql {
  const windowStart =
    access.windowStart ??
    Prisma.sql`${UTC_NOW}-${BACKGROUND_WORK_LIMITS.recentDays}*interval '1 day'`;
  const personal = access.audience === "mine";
  const scope = personal
    ? Prisma.sql`g."requestedById" = ${access.actor.userId}::uuid
        AND (g.status = 'building'
          OR coalesce(g."activatedAt", g."completedAt", g."supersededAt", g."createdAt") >= ${windowStart})`
    : Prisma.sql`(g.status IN ('active', 'building')
          OR coalesce(greatest(g."completedAt", g."supersededAt"), g."createdAt") >= ${windowStart}
          OR EXISTS (
            SELECT 1 FROM "KnowledgeGenerationDocument" recent_document
            WHERE recent_document."generationId" = g.id AND recent_document."completedAt" >= ${windowStart}
          ))`;
  const buildState = Prisma.sql`CASE
        WHEN g.status = 'building' THEN 'running'
        WHEN g."activatedAt" IS NOT NULL THEN 'succeeded'
        WHEN g.status = 'failed' THEN CASE WHEN g."failureKind" = 'configuration' THEN 'blocked' ELSE 'failed' END
        ELSE 'cancelled' END`;
  const projectState = Prisma.sql`CASE
        WHEN g.status = 'superseded' THEN CASE WHEN g."activatedAt" IS NOT NULL THEN 'succeeded' ELSE 'cancelled' END
        WHEN g.status = 'building' THEN 'running'
        WHEN g.status = 'failed' THEN CASE WHEN g."failureKind" = 'configuration' THEN 'blocked' ELSE 'failed' END
        WHEN documents.processing > 0 THEN 'running'
        WHEN documents.pending > 0 THEN 'queued'
        WHEN documents.failed > 0 THEN 'failed'
        WHEN documents.blocked > 0 THEN 'blocked'
        ELSE 'succeeded' END`;
  const buildFinishedAt = Prisma.sql`coalesce(g."activatedAt", g."completedAt", g."supersededAt")`;
  return Prisma.sql`
    (WITH eligible_generations AS MATERIALIZED (
      SELECT g.id, g."projectId", p.name AS "projectName", g.status, g."createdAt",
        g."completedAt", g."activatedAt", g."supersededAt", g."documentTotal", g."failureKind",
        g."failureSummary", g."buildTrigger", g."graphSourceGenerationId"
      FROM "KnowledgeGeneration" g
      JOIN visible_projects p ON p.id = g."projectId" AND p."canMaintain"
      WHERE ${scope}
        ${access.projectId ? Prisma.sql`AND p.id = ${access.projectId}::uuid` : Prisma.empty}
    ), documents AS (
      SELECT g.id AS "generationId", count(d."generationId") FILTER (WHERE d.status <> 'missing')::int AS total,
        count(*) FILTER (WHERE d.status = 'missing')::int AS missing,
        count(*) FILTER (WHERE d.status = 'ready')::int AS ready,
        count(*) FILTER (WHERE d.status = 'failed')::int AS failed,
        count(*) FILTER (WHERE d.status = 'blocked_configuration')::int AS blocked,
        count(*) FILTER (WHERE d.status = 'processing')::int AS processing,
        count(*) FILTER (WHERE d.status = 'pending')::int AS pending,
        max(d."completedAt") AS "completedAt"
      FROM eligible_generations g
      LEFT JOIN "KnowledgeGenerationDocument" d ON d."generationId" = g.id
      GROUP BY g.id
    )
    SELECT 'knowledge'::text AS kind, g.id::uuid AS id,
      CASE
        WHEN NOT ${personal}::boolean AND g.status = 'active' AND documents.pending + documents.processing > 0
          THEN 'Knowledge index: updating ' || (documents.pending + documents.processing)::text
            || CASE WHEN documents.pending + documents.processing = 1 THEN ' document' ELSE ' documents' END
        WHEN g."graphSourceGenerationId" IS NOT NULL AND g."buildTrigger" = 'index_upgrade' THEN 'Knowledge index re-embedding: Weaver upgrade'
        WHEN g."graphSourceGenerationId" IS NOT NULL THEN 'Knowledge index re-embedding: embedding model changed'
        WHEN g."buildTrigger" = 'embedding_change' THEN 'Knowledge index rebuild: embedding model changed'
        WHEN g."buildTrigger" = 'manual_rebuild' THEN 'Knowledge index rebuild: requested'
        WHEN g."buildTrigger" = 'index_upgrade' THEN 'Knowledge index rebuild: Weaver upgrade'
        ELSE 'Knowledge index' END AS title,
      g."projectId" AS "projectId", g."projectName" AS "projectName", normalized.state AS state,
      g.status::text AS "sourceStatus", g."createdAt" AS "createdAt", g."createdAt" AS "startedAt",
      CASE WHEN normalized.state IN ('queued', 'running') THEN NULL::timestamp
        ELSE ${personal ? buildFinishedAt : Prisma.sql`greatest(g."completedAt", documents."completedAt", g."supersededAt")`} END AS "finishedAt",
      CASE WHEN normalized.state IN ('queued', 'running') THEN g."createdAt"
        ELSE coalesce(${personal ? buildFinishedAt : Prisma.sql`greatest(g."completedAt", documents."completedAt", g."supersededAt")`}, g."createdAt") END AS "sortAt",
      jsonb_build_object('ready', documents.ready, 'total', greatest(documents.total, g."documentTotal" - documents.missing),
        'failed', documents.failed + documents.blocked) AS progress,
      CASE WHEN normalized.state = 'failed' THEN 'KNOWLEDGE_FAILED'::text
        WHEN normalized.state = 'blocked' THEN 'CONFIGURATION_REQUIRED'::text
        ELSE NULL::text END AS "errorCode",
      CASE WHEN g.status = 'failed' THEN left(g."failureSummary", 500) ELSE NULL::text END AS "errorMessage",
      jsonb_build_object('kind', 'knowledge', 'projectId', g."projectId") AS destination,
      ${
        personal
          ? Prisma.sql`CASE WHEN normalized.state NOT IN ('queued', 'running') THEN
              md5(jsonb_build_array('knowledge', g.id, normalized.state, ${buildFinishedAt}, NULL)::text)
              ELSE NULL::text END`
          : Prisma.sql`NULL::text`
      } AS revision,
      ${personal}::boolean AS "isPersonal"
    FROM eligible_generations g
    JOIN documents ON documents."generationId" = g.id
    CROSS JOIN LATERAL (SELECT ${personal ? buildState : projectState} AS state) normalized
    )
  `;
}

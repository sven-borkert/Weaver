import { UTC_NOW } from "../sql";
import { Prisma } from "@weaver/db/client";
import type { WorkQueryAccess } from "./access";

export function importSourceSql(access: WorkQueryAccess): Prisma.Sql {
  const windowStart =
    access.windowStart ?? Prisma.sql`${UTC_NOW} - interval '7 days'`;
  return Prisma.sql`
    SELECT 'import'::text AS kind, f.id::uuid AS id, left(f."fileName", 200) AS title,
      p.id AS "projectId", p.name AS "projectName", normalized.state AS state,
      f.status::text AS "sourceStatus", f."createdAt" AS "createdAt",
      coalesce(f."parseStartedAt", f."analyzeStartedAt", f."linkStartedAt") AS "startedAt",
      CASE WHEN normalized.state IN ('queued', 'running') THEN NULL::timestamp
        ELSE normalized."finishedAt" END AS "finishedAt",
      CASE WHEN normalized.state IN ('queued', 'running') THEN f."createdAt"
        ELSE normalized."resultAt" END AS "sortAt",
      NULL::jsonb AS progress,
      CASE WHEN f.status = 'failed' THEN 'IMPORT_FAILED'::text
        WHEN f.status = 'blocked_configuration' THEN 'CONFIGURATION_REQUIRED'::text
        ELSE NULL::text END AS "errorCode",
      CASE WHEN f.status IN ('failed', 'blocked_configuration') THEN left(f."failureMessage", 500) ELSE NULL::text END AS "errorMessage",
      jsonb_build_object('kind', 'import', 'projectId', p.id, 'fileId', f.id) AS destination,
      CASE WHEN f.status IN ('ready', 'accepting', 'accepted', 'rejected', 'failed', 'blocked_configuration') THEN
        md5(jsonb_build_array('import', f.id,
          CASE WHEN f.status IN ('ready', 'accepting', 'accepted', 'rejected') THEN 'succeeded'
            ELSE normalized.state END,
          normalized."resultAt", f."attemptCount")::text)
        ELSE NULL::text END AS revision,
      b."createdById" = ${access.actor.userId}::uuid AS "isPersonal"
    FROM "IngestionFile" f
    JOIN "IngestionBatch" b ON b.id = f."batchId" AND b."projectId" = f."projectId"
    JOIN visible_projects p ON p.id = b."projectId"
    CROSS JOIN LATERAL (
      SELECT CASE WHEN f.status = 'pending' THEN 'queued'
        WHEN f.status IN ('parsing', 'extracting', 'linking', 'accepting') THEN 'running'
        WHEN f.status = 'failed' THEN 'failed'
        WHEN f.status = 'blocked_configuration' THEN 'blocked'
        ELSE 'succeeded' END AS state,
        coalesce(greatest(f."parseEndedAt", f."analyzeEndedAt", f."linkEndedAt"), CASE WHEN f.status = 'failed' THEN f."updatedAt" END) AS "finishedAt",
        coalesce(greatest(f."parseEndedAt", f."analyzeEndedAt", f."linkEndedAt"), CASE WHEN f.status = 'failed' THEN f."updatedAt" END, f."createdAt") AS "resultAt"
    ) normalized
    WHERE b."origin" <> 'wiki'
      AND ${access.audience === "mine" ? Prisma.sql`b."createdById" = ${access.actor.userId}::uuid` : Prisma.sql`p."canMaintain"`}
      AND (normalized.state IN ('queued', 'running') OR normalized."resultAt" >= ${windowStart})
      ${access.projectId ? Prisma.sql`AND p.id = ${access.projectId}::uuid` : Prisma.empty}
  `;
}

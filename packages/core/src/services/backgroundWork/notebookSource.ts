import { UTC_NOW } from "../sql";
import { Prisma } from "@weaver/db/client";
import {
  NOTEBOOK_ERROR_MESSAGES,
  NOTEBOOK_PARSER_VERSION,
} from "../../artifacts/notebookSchema";
import type { WorkQueryAccess } from "./access";

const errorMessageSql = Prisma.sql`CASE n.error ${Prisma.join(
  Object.entries(NOTEBOOK_ERROR_MESSAGES).map(
    ([code, message]) => Prisma.sql`WHEN ${code} THEN ${message}`,
  ),
  " ",
)} ELSE 'Preparing the notebook failed.' END`;

export function notebookSourceSql(access: WorkQueryAccess): Prisma.Sql {
  const windowStart =
    access.windowStart ?? Prisma.sql`${UTC_NOW} - interval '7 days'`;
  return Prisma.sql`
    SELECT 'notebook'::text AS kind, a.id::uuid AS id,
      left('OneNote notebook: ' || a.filename, 200) AS title,
      p.id AS "projectId", p.name AS "projectName", normalized.state AS state,
      n.status::text AS "sourceStatus", n."queuedAt" AS "createdAt", n."startedAt" AS "startedAt",
      CASE WHEN normalized.state IN ('queued', 'running') THEN NULL::timestamp
        ELSE n."finishedAt" END AS "finishedAt",
      CASE WHEN normalized.state IN ('queued', 'running') THEN n."queuedAt"
        ELSE coalesce(n."finishedAt", n."updatedAt") END AS "sortAt",
      NULL::jsonb AS progress,
      CASE WHEN n.status = 'failed' THEN 'NOTEBOOK_FAILED'::text ELSE NULL::text END AS "errorCode",
      CASE WHEN n.status = 'failed' THEN ${errorMessageSql} ELSE NULL::text END AS "errorMessage",
      jsonb_build_object('kind', 'notebook', 'projectId', p.id, 'filename', a.filename) AS destination,
      CASE WHEN n.status IN ('ready', 'failed') THEN
        md5(jsonb_build_array('notebook', a.id, n.status, n."queuedAt", n."finishedAt")::text)
        ELSE NULL::text END AS revision,
      coalesce(n."requestedById" = ${access.actor.userId}::uuid, false) AS "isPersonal"
    FROM "ArtifactNotebook" n
    JOIN "Artifact" a ON a.id = n."artifactId" AND a."contentDigest" = n."contentDigest"
    JOIN visible_projects p ON p.id = a."projectId"
    CROSS JOIN LATERAL (
      SELECT CASE WHEN n.status = 'ready' THEN 'succeeded' ELSE n.status::text END AS state
    ) normalized
    WHERE n."parserVersion" = ${NOTEBOOK_PARSER_VERSION}
      AND ${access.audience === "mine" ? Prisma.sql`n."requestedById" = ${access.actor.userId}::uuid` : Prisma.sql`p."canMaintain"`}
      AND (normalized.state IN ('queued', 'running') OR coalesce(n."finishedAt", n."updatedAt") >= ${windowStart})
      ${access.projectId ? Prisma.sql`AND p.id = ${access.projectId}::uuid` : Prisma.empty}
  `;
}

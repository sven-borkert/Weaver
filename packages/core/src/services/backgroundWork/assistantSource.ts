import { UTC_NOW } from "../sql";
import { Prisma } from "@weaver/db/client";
import { z } from "zod";
import { MAX_SCOPE_PROJECTS } from "../../assistant/scopeSchema";
import { hasCapability } from "../../security/context";
import type { WorkQueryAccess } from "./access";

const UUID_PATTERN = z.regexes.uuid().source;
const DATETIME_PATTERN = z.regexes.datetime({}).source;

export function assistantSourceSql(access: WorkQueryAccess): Prisma.Sql {
  const windowStart =
    access.windowStart ?? Prisma.sql`${UTC_NOW} - interval '7 days'`;
  return Prisma.sql`
    SELECT 'assistant'::text AS kind, r.id::uuid AS id, 'Assistant response'::text AS title,
      CASE WHEN scope.count = 1 THEN scope."projectId"::uuid ELSE NULL::uuid END AS "projectId",
      CASE WHEN scope.count = 1 THEN scope."projectName"
        WHEN scope.count > 1 THEN 'Multiple projects'::text ELSE NULL::text END AS "projectName",
      normalized.state AS state, r.status::text AS "sourceStatus",
      r."queuedAt" AS "createdAt", r."startedAt" AS "startedAt", r."finishedAt" AS "finishedAt",
      CASE WHEN normalized.state IN ('queued', 'running') THEN r."queuedAt"
        ELSE coalesce(r."finishedAt", r."queuedAt") END AS "sortAt",
      NULL::jsonb AS progress,
      CASE WHEN r.status = 'failed' THEN 'ASSISTANT_FAILED'::text ELSE NULL::text END AS "errorCode",
      CASE WHEN r.status = 'failed' THEN left(r."errorMessage", 500) ELSE NULL::text END AS "errorMessage",
      jsonb_build_object('kind', 'assistant', 'conversationId', c.id) AS destination,
      CASE WHEN normalized.state NOT IN ('queued', 'running') THEN
        md5(jsonb_build_array('assistant', r.id, r.status::text, r."finishedAt", NULL)::text)
        ELSE NULL::text END AS revision,
      true AS "isPersonal"
    FROM "AssistantRun" r
    JOIN "AssistantConversation" c ON c.id = r."conversationId"
    CROSS JOIN LATERAL (
      SELECT CASE WHEN jsonb_typeof(r."scopeSnapshot") = 'object'
        AND jsonb_typeof(r."scopeSnapshot"->'projectIds') = 'array'
        THEN r."scopeSnapshot"->'projectIds' ELSE '[]'::jsonb END AS ids
    ) safe
    CROSS JOIN LATERAL (
      SELECT count(DISTINCT entry.id)::int AS count, min(p.id::text) AS "projectId", min(p.name) AS "projectName",
        coalesce(bool_and(p.id IS NOT NULL), true) AS authorized,
        coalesce(bool_or(p.id = ${access.projectId ?? null}::uuid), false) AS matches
      FROM jsonb_array_elements_text(safe.ids) entry(id)
      LEFT JOIN visible_projects p ON p.id = CASE WHEN entry.id ~* ${UUID_PATTERN} THEN entry.id::uuid ELSE NULL::uuid END
    ) scope
    CROSS JOIN LATERAL (
      SELECT CASE WHEN r.status = 'completed' THEN 'succeeded'
        WHEN r.status = 'cancelling' THEN 'running' ELSE r.status::text END AS state
    ) normalized
    WHERE c."ownerId" = ${access.actor.userId}::uuid
      AND ${hasCapability(access.actor, "assistant:use")}
      AND jsonb_typeof(r."scopeSnapshot") = 'object'
      AND r."scopeSnapshot"->>'kind' IN ('document', 'table', 'project', 'projects', 'all')
      AND jsonb_typeof(r."scopeSnapshot"->'projectIds') = 'array'
      AND jsonb_array_length(safe.ids) <= ${MAX_SCOPE_PROJECTS}
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(safe.ids) element(value)
        WHERE jsonb_typeof(element.value) <> 'string' OR NOT ((element.value #>> '{}') ~* ${UUID_PATTERN}))
      AND (r."scopeSnapshot"->'documentId' = 'null'::jsonb OR
        (jsonb_typeof(r."scopeSnapshot"->'documentId') = 'string' AND r."scopeSnapshot"->>'documentId' ~* ${UUID_PATTERN}))
      AND (r."scopeSnapshot"->'tableId' = 'null'::jsonb OR
        (jsonb_typeof(r."scopeSnapshot"->'tableId') = 'string' AND r."scopeSnapshot"->>'tableId' ~* ${UUID_PATTERN}))
      AND jsonb_typeof(r."scopeSnapshot"->'resolvedAt') = 'string'
      AND r."scopeSnapshot"->>'resolvedAt' ~ ${DATETIME_PATTERN}
      AND (NOT (r."scopeSnapshot" ? 'truncated') OR jsonb_typeof(r."scopeSnapshot"->'truncated') = 'boolean')
      AND scope.authorized
      AND (r.status IN ('queued','running','cancelling') OR coalesce(r."finishedAt", r."queuedAt") >= ${windowStart})
      ${access.projectId ? Prisma.sql`AND scope.matches` : Prisma.empty}
  `;
}

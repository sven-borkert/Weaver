import { UTC_NOW } from "../sql";
import { Prisma } from "@weaver/db/client";
import type { WorkQueryAccess } from "./access";

export function taskSourceSql(access: WorkQueryAccess): Prisma.Sql {
  const windowStart =
    access.windowStart ?? Prisma.sql`${UTC_NOW} - interval '7 days'`;
  return Prisma.sql`
    SELECT 'task'::text AS kind, r.id::uuid AS id, left(t.name, 200) AS title,
      p.id AS "projectId", p.name AS "projectName", r.status::text AS state,
      r.status::text AS "sourceStatus", r."queuedAt" AS "createdAt",
      r."startedAt" AS "startedAt", r."finishedAt" AS "finishedAt",
      CASE WHEN r.status IN ('queued', 'running') THEN r."queuedAt"
        ELSE coalesce(r."finishedAt", r."queuedAt") END AS "sortAt",
      NULL::jsonb AS progress,
      CASE WHEN r.status = 'failed' THEN 'TASK_FAILED'::text ELSE NULL::text END AS "errorCode",
      CASE WHEN r.status = 'failed' AND t."ownerId" = ${access.actor.userId}::uuid THEN left(r."errorMessage", 500) ELSE NULL::text END AS "errorMessage",
      jsonb_build_object('kind', 'task', 'projectId', p.id, 'taskId', t.id) AS destination,
      CASE WHEN r.status NOT IN ('queued', 'running') THEN
        md5(jsonb_build_array('task', r.id, r.status::text, r."finishedAt", NULL)::text)
        ELSE NULL::text END AS revision,
      t."ownerId" = ${access.actor.userId}::uuid AS "isPersonal"
    FROM "ScheduledTaskRun" r
    JOIN "ScheduledTask" t ON t.id = r."taskId"
    JOIN visible_projects p ON p.id = t."outputProjectId"
    WHERE ${access.audience === "mine" ? Prisma.sql`t."ownerId" = ${access.actor.userId}::uuid` : Prisma.sql`p."canMaintain"`}
      AND (r.status IN ('queued','running') OR coalesce(r."finishedAt", r."queuedAt") >= ${windowStart})
      ${access.projectId ? Prisma.sql`AND p.id = ${access.projectId}::uuid` : Prisma.empty}
  `;
}

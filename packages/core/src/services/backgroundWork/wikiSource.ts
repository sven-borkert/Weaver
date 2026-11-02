import { Prisma } from "@weaver/db/client";
import { UTC_NOW } from "../sql";
import type { WorkQueryAccess } from "./access";

/** Personal for the Editor who started the run; a scheduled run has no starter, so only Maintainers see it. */
export function wikiSourceSql(access: WorkQueryAccess): Prisma.Sql {
  const windowStart =
    access.windowStart ?? Prisma.sql`${UTC_NOW} - interval '7 days'`;
  return Prisma.sql`
    SELECT 'wiki'::text AS kind, r.id::uuid AS id, left('Wiki ' || r.kind::text, 200) AS title,
      p.id AS "projectId", p.name AS "projectName", normalized.state AS state,
      r.status::text AS "sourceStatus", r."startedAt" AS "createdAt", r."startedAt" AS "startedAt",
      CASE WHEN normalized.state IN ('queued', 'running') THEN NULL::timestamp ELSE r."endedAt" END AS "finishedAt",
      coalesce(r."endedAt", r."startedAt") AS "sortAt",
      NULL::jsonb AS progress,
      CASE WHEN r.status = 'failed' THEN 'WIKI_FAILED'::text ELSE NULL::text END AS "errorCode",
      CASE WHEN r.status IN ('failed', 'cancelled', 'stopped') THEN left(r."errorMessage", 500) ELSE NULL::text END AS "errorMessage",
      jsonb_build_object('kind', 'wiki', 'projectId', p.id) AS destination,
      CASE WHEN normalized.state NOT IN ('queued', 'running') THEN
        md5(jsonb_build_array('wiki', r.id, r.status::text, r."endedAt")::text)
        ELSE NULL::text END AS revision,
      coalesce(r."startedById" = ${access.actor.userId}::uuid, false) AS "isPersonal"
    FROM "WikiRun" r
    JOIN visible_projects p ON p.id = r."projectId"
    CROSS JOIN LATERAL (
      SELECT CASE WHEN r.status IN ('preparing', 'queued') THEN 'queued'
        WHEN r.status = 'running' THEN 'running'
        WHEN r.status = 'succeeded' THEN 'succeeded'
        WHEN r.status = 'failed' THEN 'failed'
        WHEN r.status = 'cancelled' THEN 'cancelled'
        ELSE 'blocked' END AS state
    ) normalized
    WHERE ${access.audience === "mine" ? Prisma.sql`r."startedById" = ${access.actor.userId}::uuid` : Prisma.sql`p."canMaintain"`}
      AND (normalized.state IN ('queued', 'running') OR r."endedAt" >= ${windowStart})
      ${access.projectId ? Prisma.sql`AND p.id = ${access.projectId}::uuid` : Prisma.empty}
  `;
}

const PAUSE_MESSAGE =
  "Wiki runs are paused: changes in the last 24 hours exceed the project's budget. It clears by itself once the sum falls, or an Owner can raise the budget.";
const SPEND_MESSAGE =
  "The wiki agent's spend in the last 24 hours passed the alert you set. Runs continue.";

/** Owners are told through the bell; a new incident has a new revision and is unseen again. */
export function wikiAlertSourceSql(access: WorkQueryAccess): Prisma.Sql {
  return Prisma.sql`
    SELECT 'wiki'::text AS kind, s.id::uuid AS id,
      CASE WHEN s."destructivePausedAt" IS NOT NULL THEN 'Wiki runs paused' ELSE 'Wiki spend alert' END AS title,
      p.id AS "projectId", p.name AS "projectName", 'failed'::text AS state,
      'failed'::text AS "sourceStatus", alert.at AS "createdAt", NULL::timestamp AS "startedAt",
      alert.at AS "finishedAt", alert.at AS "sortAt",
      NULL::jsonb AS progress, 'WIKI_FAILED'::text AS "errorCode",
      CASE WHEN s."destructivePausedAt" IS NOT NULL THEN ${PAUSE_MESSAGE} ELSE ${SPEND_MESSAGE} END AS "errorMessage",
      jsonb_build_object('kind', 'wiki', 'projectId', p.id) AS destination,
      md5(jsonb_build_array('wiki-alert', s.id, s."destructivePausedAt", s."spendAlertedAt")::text) AS revision,
      true AS "isPersonal"
    FROM "ProjectWikiSettings" s
    JOIN visible_projects p ON p.id = s."projectId"
    CROSS JOIN LATERAL (SELECT coalesce(s."destructivePausedAt", s."spendAlertedAt") AS at) alert
    WHERE p."isOwner"
      AND (s."destructivePausedAt" IS NOT NULL
        OR s."spendAlertedAt" >= ${UTC_NOW} - interval '1 day')
      ${access.projectId ? Prisma.sql`AND p.id = ${access.projectId}::uuid` : Prisma.empty}
  `;
}

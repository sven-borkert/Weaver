import { Prisma } from "@weaver/db/client";
import {
  GIT_PULL_ERROR_FALLBACK,
  GIT_PULL_ERROR_MESSAGES,
  GIT_PUSH_ERROR_FALLBACK,
  GIT_PUSH_ERROR_MESSAGES,
} from "../../documents/gitRemoteMessages";
import type { WorkQueryAccess } from "./access";

function messageSql(
  column: Prisma.Sql,
  messages: Record<string, string>,
  fallback: string,
): Prisma.Sql {
  return Prisma.sql`CASE ${column} ${Prisma.join(
    Object.entries(messages).map(
      ([code, message]) => Prisma.sql`WHEN ${code} THEN ${message}`,
    ),
    " ",
  )} ELSE ${fallback} END`;
}

/** A remote appears only while its sync is failing; it is personal for every Owner and Maintainer so the bell reports it. */
export function gitSyncSourceSql(access: WorkQueryAccess): Prisma.Sql {
  return Prisma.sql`
    SELECT 'git_sync'::text AS kind, g.id::uuid AS id,
      CASE WHEN failing.push THEN 'Git push failed' ELSE 'Git pull failed' END AS title,
      p.id AS "projectId", p.name AS "projectName", 'failed'::text AS state,
      'failed'::text AS "sourceStatus", g."updatedAt" AS "createdAt", NULL::timestamp AS "startedAt",
      g."updatedAt" AS "finishedAt", g."updatedAt" AS "sortAt",
      NULL::jsonb AS progress, 'GIT_SYNC_FAILED'::text AS "errorCode",
      left(CASE WHEN failing.push
        THEN ${messageSql(Prisma.sql`g."lastErrorCode"`, GIT_PUSH_ERROR_MESSAGES, GIT_PUSH_ERROR_FALLBACK)}
        ELSE ${messageSql(Prisma.sql`g."lastPullErrorCode"`, GIT_PULL_ERROR_MESSAGES, GIT_PULL_ERROR_FALLBACK)}
        END, 500) AS "errorMessage",
      jsonb_build_object('kind', 'git_sync', 'projectId', p.id) AS destination,
      -- The last success times change between incidents, so a new failure is unseen again while retries are not.
      md5(jsonb_build_array('git_sync', g.id, failing.push, g."lastErrorCode", g."lastPushedAt",
        g."lastPullErrorCode", g."lastPullAt")::text) AS revision,
      true AS "isPersonal"
    FROM "ProjectGitRemote" g
    JOIN visible_projects p ON p.id = g."projectId"
    CROSS JOIN LATERAL (
      SELECT (g.enabled AND g."lastErrorCode" IS NOT NULL) AS push
    ) failing
    WHERE p."canMaintain"
      AND (failing.push OR g."lastPullErrorCode" IS NOT NULL)
      ${access.projectId ? Prisma.sql`AND p.id = ${access.projectId}::uuid` : Prisma.empty}
  `;
}

import { examSourceSql } from "./examSource";
import { wikiAlertSourceSql, wikiSourceSql } from "./wikiSource";
import { Prisma } from "@weaver/db/client";
import { type WorkQueryAccess, visibleProjectsSql } from "./access";
import { taskSourceSql } from "./taskSource";
import { importSourceSql } from "./importSource";
import { assistantSourceSql } from "./assistantSource";
import { knowledgeSourceSql } from "./knowledgeSource";
import { notebookSourceSql } from "./notebookSource";
import { gitSyncSourceSql } from "./gitSyncSource";
import { UTC_NOW } from "../sql";
import {
  BACKGROUND_WORK_LIMITS,
  type WorkReference,
} from "../../jobs/backgroundWorkSchema";

export function authorizedWorkSql(access: WorkQueryAccess): Prisma.Sql {
  return Prisma.sql`WITH visible_projects AS (${visibleProjectsSql({ ...access, projectId: undefined })}),
    authorized_work AS MATERIALIZED (
      ${taskSourceSql(access)} UNION ALL ${importSourceSql(access)}
      UNION ALL ${assistantSourceSql(access)} UNION ALL ${knowledgeSourceSql(access)}
      UNION ALL ${notebookSourceSql(access)} UNION ALL ${gitSyncSourceSql(access)} UNION ALL ${examSourceSql(access)}
      UNION ALL ${wikiSourceSql(access)} UNION ALL ${wikiAlertSourceSql(access)}
    )`;
}
export const activeWorkSql = Prisma.sql`w.state IN ('queued', 'running')`;
export const terminalWorkSql = Prisma.sql`w.state IN ('succeeded', 'failed', 'blocked', 'cancelled', 'skipped')`;
export function receiptJoinSql(userId: string): Prisma.Sql {
  return Prisma.sql`LEFT JOIN "BackgroundWorkReceipt" r ON r."userId" = ${userId}::uuid
    AND r.kind::text = w.kind AND r."workId" = w.id AND r.revision = w.revision`;
}
export function markSeenSql(
  access: WorkQueryAccess,
  items: WorkReference[],
): Prisma.Sql {
  const values = Prisma.join(
    items.map(
      (item) =>
        Prisma.sql`(${item.kind}::text, ${item.id}::uuid, ${item.revision}::text)`,
    ),
  );
  return Prisma.sql`${authorizedWorkSql(access)}, requested(kind,id,revision) AS (VALUES ${values})
    INSERT INTO "BackgroundWorkReceipt" ("userId",kind,"workId",revision,"seenAt")
    SELECT DISTINCT ${access.actor.userId}::uuid,w.kind::"PersonalWorkKind",w.id,w.revision,${UTC_NOW}
    FROM authorized_work w JOIN requested r ON r.kind=w.kind AND r.id=w.id AND r.revision=w.revision
    WHERE w."isPersonal" AND ${terminalWorkSql} AND w.revision IS NOT NULL
      AND COALESCE(w."finishedAt",w."createdAt") >= ${UTC_NOW} - ${BACKGROUND_WORK_LIMITS.recentDays} * interval '1 day'
      AND COALESCE(w."finishedAt",w."createdAt") <= ${UTC_NOW}
    ON CONFLICT DO NOTHING RETURNING "workId"`;
}

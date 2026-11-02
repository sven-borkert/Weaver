import { Prisma, type PrismaClient } from "@weaver/db/client";
import { CoreError } from "../../errors";
import {
  activityInput,
  DASHBOARD_LIMITS,
  type ActivityInput,
  type ActivityPage,
} from "../../dashboard/schema";
import type { UserSecurityContext } from "../../security/context";
import { authorizedWorkSql, terminalWorkSql } from "../backgroundWork/queries";
import { UTC_NOW } from "../sql";
import { assertDashboardRead, type DashboardAccess } from "./access";
import { assertProjectRole } from "../projectAccess";
import { authorizedContentSql } from "./content";
import {
  activityFilterIdentity,
  decodeActivityCursor,
  encodeActivityCursor,
} from "./cursor";
import { parseActivityRows } from "./rows";
export async function listDashboardActivity(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: ActivityInput,
): Promise<ActivityPage> {
  assertDashboardRead(actor);
  const parsed = activityInput.safeParse(input);
  if (!parsed.success)
    throw new CoreError("BAD_REQUEST", "Invalid dashboard filters");
  const params = parsed.data;
  if (params.projectId)
    await assertProjectRole(
      db,
      params.projectId,
      actor,
      params.audience === "projects" ? "Maintainer" : "Viewer",
      { capability: "content:read" },
    );
  const access: DashboardAccess = {
    actor,
    projectId: params.projectId,
    workAudience: params.audience,
  };
  const filters = activityFilterIdentity(params);
  const cursor = params.cursor
    ? decodeActivityCursor(params.cursor, actor.userId, filters)
    : null;
  const observed = cursor ? Prisma.sql`${cursor.asOf}::timestamp` : UTC_NOW;
  const workStart = cursor
    ? Prisma.sql`${cursor.workWindowStart}::timestamp`
    : Prisma.sql`${UTC_NOW}-${DASHBOARD_LIMITS.workResultDays}*interval '1 day'`;
  const [result] = parseActivityRows(
    await db.$queryRaw(Prisma.sql`
 ${authorizedWorkSql({ actor, audience: access.workAudience, projectId: access.projectId, windowStart: workStart })},
 observed AS (SELECT ${observed} AS "asOf"),clock AS (SELECT "asOf","asOf"-${DASHBOARD_LIMITS.contentActivityDays}*interval '1 day' AS "contentWindowStart","asOf"-${DASHBOARD_LIMITS.workResultDays}*interval '1 day' AS "workWindowStart" FROM observed),
 authorized_content AS NOT MATERIALIZED (${authorizedContentSql(access)}),
 eligible_results AS MATERIALIZED (SELECT w.id,w.kind,w.title,w."projectId",w."projectName",w."sortAt",w."finishedAt",w.state,w."sourceStatus",w.destination,r."outputDocumentId",r."outputCommitSha",
 CASE WHEN d.id IS NOT NULL THEN jsonb_build_object('kind','document','projectId',d."projectId",'documentId',d.id) ELSE NULL::jsonb END AS "currentReport"
 FROM authorized_work w CROSS JOIN clock o
 LEFT JOIN "ScheduledTaskRun" r ON w.kind='task' AND r.id=w.id AND w.state='succeeded'
 LEFT JOIN "Document" d ON d.id=r."outputDocumentId" AND d."projectId"=w."projectId"
 WHERE ${terminalWorkSql} AND COALESCE(w."finishedAt",w."createdAt")>=o."workWindowStart" AND w."sortAt"<=o."asOf"),
 entries AS (
 SELECT c.id,c.source,'content_update'::text AS category,c.title,c."projectId",c."projectName",c."sortAt",c."sortAt" AS "occurredAt",c."editorName",c."isOwnChange",NULL::text AS state,NULL::text AS "sourceStatus",
 CASE WHEN c.source='document' THEN jsonb_build_object('kind','document','projectId',c."projectId",'documentId',c.id) ELSE jsonb_build_object('kind','table','projectId',c."projectId",'tableId',c.id) END AS destination,NULL::jsonb AS "currentReport"
 FROM authorized_content c CROSS JOIN clock o
 WHERE ${params.view !== "results"} AND c."sortAt" BETWEEN o."contentWindowStart" AND o."asOf"
 ${params.view === "others" ? Prisma.sql`AND ((c."lastEditedById" IS NOT NULL AND c."lastEditedById"<>${actor.userId}::uuid) OR c."lastEditedByProjectKeyId" IS NOT NULL)` : Prisma.empty}
 ${params.view === "all" ? Prisma.sql`AND NOT (c.source='document' AND EXISTS (SELECT 1 FROM eligible_results r WHERE r.kind='task' AND r.state='succeeded' AND r."outputDocumentId"=c.id AND r."outputCommitSha"=c."headCommitSha"))` : Prisma.empty}
 UNION ALL
 SELECT r.id,r.kind,'work_result'::text,r.title,r."projectId",r."projectName",r."sortAt",r."finishedAt",NULL::text,NULL::boolean,r.state,r."sourceStatus",r.destination,r."currentReport" FROM eligible_results r WHERE ${params.view !== "others"}),
 page AS (SELECT * FROM entries e ${cursor ? Prisma.sql`WHERE (e."sortAt",e.source COLLATE "C",e.id)<(${cursor.last.sortAt}::timestamp,${cursor.last.source}::text COLLATE "C",${cursor.last.id}::uuid)` : Prisma.empty} ORDER BY e."sortAt" DESC,e.source COLLATE "C" DESC,e.id DESC LIMIT ${params.limit + 1})
 SELECT COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY "sortAt" DESC,source COLLATE "C" DESC,id DESC) FROM page),'[]'::jsonb) AS items,"asOf","contentWindowStart","workWindowStart" FROM clock`),
  );
  const items = result.items.slice(0, params.limit);
  const last = items.at(-1);
  return {
    items,
    observedAt: result.asOf.toISOString(),
    nextCursor:
      result.items.length > params.limit && last
        ? encodeActivityCursor({
            version: 1,
            actorId: actor.userId,
            filters,
            asOf: result.asOf.toISOString(),
            contentWindowStart: result.contentWindowStart.toISOString(),
            workWindowStart: result.workWindowStart.toISOString(),
            last: { sortAt: last.sortAt, source: last.source, id: last.id },
          })
        : null,
  };
}

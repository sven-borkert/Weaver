import { Prisma, type PrismaClient } from "@weaver/db/client";
import { reportsInput, type ReportShortcuts } from "../../dashboard/schema";
import { CoreError } from "../../errors";
import type { UserSecurityContext } from "../../security/context";
import { visibleProjectsSql } from "../backgroundWork/access";
import { UTC_NOW } from "../sql";
import { assertDashboardRead, resolveDashboardAccess } from "./access";
import { parseReportRows } from "./rows";
export async function getReportShortcuts(
  db: PrismaClient,
  actor: UserSecurityContext,
  input?: { projectId?: string },
): Promise<ReportShortcuts> {
  assertDashboardRead(actor);
  const parsed = reportsInput.safeParse(input);
  if (!parsed.success)
    throw new CoreError("BAD_REQUEST", "Invalid dashboard project");
  const { projectId } = await resolveDashboardAccess(
    db,
    actor,
    parsed.data?.projectId,
  );
  const [result] = parseReportRows(
    await db.$queryRaw(Prisma.sql`WITH visible_projects AS (${visibleProjectsSql({ actor, audience: "mine", projectId })}),page AS (
 SELECT t.id AS "taskId",left(t.name,200) AS title,p.id AS "projectId",p.name AS "projectName",t.status::text,t."lastRunStatus"::text,t."nextRunAt",t."lastRunAt",t."createdAt",
 jsonb_build_object('kind','task','projectId',p.id,'taskId',t.id) AS destination,
 CASE WHEN d.id IS NOT NULL THEN jsonb_build_object('kind','document','projectId',p.id,'documentId',d.id) ELSE NULL::jsonb END AS "currentReport"
 FROM "ScheduledTask" t JOIN visible_projects p ON p.id=t."outputProjectId" LEFT JOIN "Document" d ON d.id=t."outputDocumentId" AND d."projectId"=p.id
 WHERE t."ownerId"=${actor.userId}::uuid ORDER BY t."lastRunAt" DESC NULLS LAST,t."createdAt" DESC,t.id DESC LIMIT 5)
 SELECT COALESCE((SELECT jsonb_agg(to_jsonb(page)-'lastRunAt'-'createdAt' ORDER BY "lastRunAt" DESC NULLS LAST,"createdAt" DESC,"taskId" DESC) FROM page),'[]'::jsonb) AS items,${UTC_NOW} AS "observedAt"`),
  );
  return { ...result, observedAt: result.observedAt.toISOString() };
}

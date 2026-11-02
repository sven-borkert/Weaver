import { Prisma, type PrismaClient } from "@weaver/db/client";
import { CoreError } from "../../errors";
import {
  projectOverviewInput,
  type ProjectOverview,
} from "../../dashboard/schema";
import {
  hasCapability,
  type UserSecurityContext,
} from "../../security/context";
import { visibleProjectsSql } from "../backgroundWork/access";
import { UTC_NOW } from "../sql";
import { assertDashboardRead, resolveDashboardAccess } from "./access";
import { authorizedContentSql, contentCardSql } from "./content";
import { parseProjectRows } from "./rows";
export async function getProjectOverview(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: { projectId: string },
): Promise<ProjectOverview> {
  assertDashboardRead(actor);
  const parsed = projectOverviewInput.safeParse(input);
  if (!parsed.success)
    throw new CoreError("BAD_REQUEST", "Invalid dashboard project");
  const access = await resolveDashboardAccess(db, actor, parsed.data.projectId);
  const rows = await db.$queryRaw<
    unknown[]
  >(Prisma.sql`WITH visible_projects AS (${visibleProjectsSql({ actor, audience: "mine", projectId: access.projectId })}),
 project AS (SELECT p.id,p.name,p.description,m.role,v."canMaintain",(v."canMaintain" AND ${hasCapability(actor, "content:write")}) AS "canManagePins" FROM visible_projects v JOIN "Project" p ON p.id=v.id JOIN "Member" m ON m."organizationId"=p."organizationId" AND m."userId"=${actor.userId}::uuid),
 documents AS (SELECT 1 FROM "Document" d JOIN project p ON p.id=d."projectId" LIMIT 10000),tables AS (SELECT 1 FROM "DataTable" d JOIN project p ON p.id=d."projectId" LIMIT 10000),
 authorized_content AS NOT MATERIALIZED (${authorizedContentSql(access)}),
 pins AS (SELECT pin.id,pin.kind,pin."createdAt",${contentCardSql} AS content,c.id IS NOT NULL AS available FROM "ProjectContentPin" pin JOIN project p ON p.id=pin."projectId" LEFT JOIN authorized_content c ON c."projectId"=pin."projectId" AND c.source=pin.kind::text AND c.id=pin."resourceId" ORDER BY pin."createdAt",pin.id LIMIT 12),
 counts AS (SELECT (SELECT count(*)::int FROM documents) AS documents,(SELECT count(*)::int FROM tables) AS tables)
 SELECT jsonb_build_object('id',p.id,'name',p.name,'description',p.description,'myRole',CASE p.role WHEN 'owner' THEN 'Owner' WHEN 'maintainer' THEN 'Maintainer' WHEN 'editor' THEN 'Editor' WHEN 'viewer' THEN 'Viewer' ELSE NULL END) AS project,
 jsonb_build_object('documents',jsonb_build_object('value',c.documents,'capped',c.documents=10000),'tables',jsonb_build_object('value',c.tables,'capped',c.tables=10000)) AS counts,
 COALESCE((SELECT jsonb_agg(CASE WHEN available THEN jsonb_build_object('pinId',id,'kind',kind::text,'available',true,'content',content) ELSE jsonb_build_object('pinId',id,'kind',kind::text,'available',false) END ORDER BY "createdAt",id) FROM pins WHERE available OR p."canManagePins"),'[]'::jsonb) AS pins,
 CASE WHEN p."canManagePins" THEN jsonb_build_object('used',(SELECT count(*)::int FROM pins),'limit',12) ELSE NULL::jsonb END AS "pinCapacity",p."canManagePins",CASE WHEN p."canMaintain" THEN 'projects' ELSE 'mine' END AS "workAudience",${UTC_NOW} AS "observedAt" FROM project p CROSS JOIN counts c`);
  if (Array.isArray(rows) && rows.length === 0)
    throw new CoreError("NOT_FOUND");
  const [result] = parseProjectRows(rows);
  return { ...result, observedAt: result.observedAt.toISOString() };
}

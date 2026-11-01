import { Prisma, type PrismaClient } from "@weaver/db/client";
import { CoreError } from "../../errors";
import {
  recentContentInput,
  type RecentContentInput,
  type RecentContentPage,
} from "../../dashboard/schema";
import type { SecurityContext } from "../../security/context";
import { visibleProjectsSql } from "../backgroundWork/access";
import { UTC_NOW } from "../sql";
import {
  resolveDashboardAccess,
  assertDashboardRead,
  type DashboardAccess,
} from "./access";
import { parseRecentRows } from "./rows";
export function authorizedContentSql(access: DashboardAccess): Prisma.Sql {
  return Prisma.sql`SELECT 'document'::text AS source,d.id,left(d.title,200) AS title,p.id AS "projectId",p.name AS "projectName",d."lastEditedAt" AS "sortAt",d."lastEditedById",d."lastEditedByProjectKeyId",d."lastEditedByName",COALESCE(u.name,d."lastEditedByName") AS "editorName",(d."lastEditedById"=${access.actor.userId}::uuid) IS TRUE AS "isOwnChange",d."headCommitSha",d.kind::text AS "documentKind"
 FROM "Document" d JOIN visible_projects p ON p.id=d."projectId" LEFT JOIN "User" u ON u.id=d."lastEditedById"
 WHERE ${access.projectId ? Prisma.sql`p.id=${access.projectId}::uuid` : Prisma.sql`TRUE`}
 UNION ALL
 SELECT 'table'::text,d.id,left(d.title,200),p.id,p.name,d."lastEditedAt",d."lastEditedById",d."lastEditedByProjectKeyId",d."lastEditedByName",COALESCE(u.name,d."lastEditedByName"),(d."lastEditedById"=${access.actor.userId}::uuid) IS TRUE,d."headCommitSha",NULL
 FROM "DataTable" d JOIN visible_projects p ON p.id=d."projectId" LEFT JOIN "User" u ON u.id=d."lastEditedById"
 WHERE ${access.projectId ? Prisma.sql`p.id=${access.projectId}::uuid` : Prisma.sql`TRUE`}`;
}
export const contentCardSql = Prisma.sql`jsonb_build_object('id',c.id,'kind',c.source,'title',c.title,'projectId',c."projectId",'projectName',c."projectName",'lastEditedAt',c."sortAt",'editorName',c."editorName",'isOwnChange',c."isOwnChange",'documentKind',c."documentKind",'destination',CASE WHEN c.source='document' THEN jsonb_build_object('kind','document','projectId',c."projectId",'documentId',c.id) ELSE jsonb_build_object('kind','table','projectId',c."projectId",'tableId',c.id) END)`;
export function recentContentPageSql(
  access: DashboardAccess,
  limit: number,
): Prisma.Sql {
  return Prisma.sql`SELECT d.source,d.id,left(d.title,200) AS title,p.id AS "projectId",p.name AS "projectName",d."lastEditedAt" AS "sortAt",d."lastEditedById",d."lastEditedByProjectKeyId",d."lastEditedByName",COALESCE(u.name,d."lastEditedByName") AS "editorName",(d."lastEditedById"=${access.actor.userId}::uuid) IS TRUE AS "isOwnChange",d."headCommitSha",d."documentKind"
 FROM visible_projects p CROSS JOIN LATERAL (
 (SELECT 'document'::text AS source,d.id,d.title,d."lastEditedAt",d."lastEditedById",d."lastEditedByProjectKeyId",d."lastEditedByName",d."headCommitSha",d.kind::text AS "documentKind" FROM "Document" d WHERE d."projectId"=p.id ORDER BY d."lastEditedAt" DESC,d.id DESC LIMIT ${limit})
 UNION ALL
 (SELECT 'table'::text AS source,d.id,d.title,d."lastEditedAt",d."lastEditedById",d."lastEditedByProjectKeyId",d."lastEditedByName",d."headCommitSha",NULL FROM "DataTable" d WHERE d."projectId"=p.id ORDER BY d."lastEditedAt" DESC,d.id DESC LIMIT ${limit})
 ) d LEFT JOIN "User" u ON u.id=d."lastEditedById"
 WHERE ${access.projectId ? Prisma.sql`p.id=${access.projectId}::uuid` : Prisma.sql`TRUE`}
 ORDER BY "sortAt" DESC,d.source COLLATE "C" DESC,d.id DESC LIMIT ${limit}`;
}
export async function getRecentContent(
  db: PrismaClient,
  actor: SecurityContext,
  input: RecentContentInput,
): Promise<RecentContentPage> {
  assertDashboardRead(actor);
  const parsed = recentContentInput.safeParse(input);
  if (!parsed.success)
    throw new CoreError("BAD_REQUEST", "Invalid dashboard filters");
  const access = await resolveDashboardAccess(db, actor, parsed.data.projectId);
  const [result] = parseRecentRows(
    await db.$queryRaw(
      Prisma.sql`WITH visible_projects AS (${visibleProjectsSql({ actor, audience: "mine" })}), page AS (${recentContentPageSql(access, parsed.data.limit)}) SELECT COALESCE((SELECT jsonb_agg(${contentCardSql} ORDER BY c."sortAt" DESC,c.source COLLATE "C" DESC,c.id DESC) FROM page c),'[]'::jsonb) AS items,${UTC_NOW} AS "observedAt"`,
    ),
  );
  return { ...result, observedAt: result.observedAt.toISOString() };
}

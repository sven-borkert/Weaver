import { Prisma } from "@weaver/db/client";
import { UTC_NOW } from "../sql";
import type { WorkQueryAccess } from "./access";
export function examSourceSql(access: WorkQueryAccess): Prisma.Sql {
  const windowStart =
    access.windowStart ?? Prisma.sql`${UTC_NOW} - interval '7 days'`;
  return Prisma.sql`
    SELECT 'exam'::text AS kind, a.id::uuid AS id,
      left(CASE WHEN a.status = 'released' THEN e.title || ' — ' || a.percent::text || ' %' || CASE WHEN a.passed IS NULL THEN '' WHEN a.passed THEN ', passed' ELSE ', not passed' END ELSE e.title END,200) AS title,
      p.id AS "projectId",p.name AS "projectName",
      CASE WHEN a.status='released' THEN 'succeeded' ELSE 'running' END::text AS state,
      a.status::text AS "sourceStatus",a."startedAt" AS "createdAt",a."startedAt" AS "startedAt",a."releasedAt" AS "finishedAt",
      coalesce(a."releasedAt",a."submittedAt",a."startedAt") AS "sortAt",NULL::jsonb AS progress,NULL::text AS "errorCode",NULL::text AS "errorMessage",
      jsonb_build_object('kind','exam','projectId',p.id,'attemptId',a.id) AS destination,
      CASE WHEN a.status='released' THEN md5(jsonb_build_array('exam',a.id,a.status::text,a."releasedAt",a.revision)::text) ELSE NULL::text END AS revision,true AS "isPersonal"
    FROM "ExamAttempt" a JOIN "Exam" e ON e.id=a."examId"
    JOIN visible_projects p ON p.id=a."projectId"
    JOIN "ProjectTrainingRole" t ON t."projectId"=p.id AND t."userId"=a."traineeId" AND t.role='trainee'
    WHERE ${access.audience === "mine"} AND a."traineeId"=${access.actor.userId}::uuid
      AND (a.status <> 'released' OR a."releasedAt">=${windowStart})
      ${access.projectId ? Prisma.sql`AND p.id=${access.projectId}::uuid` : Prisma.empty}
  `;
}

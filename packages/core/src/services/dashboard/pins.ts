import { Prisma, type PrismaClient } from "@weaver/db/client";
import {
  DASHBOARD_LIMITS,
  pinContentInput,
  pinCandidatesInput,
  type PinCandidatesInput,
  type RecentContentPage,
  unpinContentInput,
  type PinContentInput,
  type UnpinContentInput,
} from "../../dashboard/schema";
import { CoreError } from "../../errors";
import {
  hasCapability,
  type UserSecurityContext,
} from "../../security/context";
import { assertProjectRole } from "../projectAccess";
import { assertDashboardRead } from "./access";
import { visibleProjectsSql } from "../backgroundWork/access";
import { UTC_NOW } from "../sql";
import { authorizedContentSql, contentCardSql } from "./content";
import { parseRecentRows } from "./rows";

function assertPinWrite(actor: UserSecurityContext) {
  assertDashboardRead(actor);
  if (!hasCapability(actor, "content:write")) {
    throw new CoreError("FORBIDDEN");
  }
}

export async function pinProjectContent(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: PinContentInput,
): Promise<{ pinId: string }> {
  assertPinWrite(actor);
  const parsed = pinContentInput.safeParse(input);
  if (!parsed.success)
    throw new CoreError("BAD_REQUEST", "Invalid project pin");
  const params = parsed.data;
  await assertProjectRole(db, params.projectId, actor, "Maintainer", {
    capability: "content:write",
  });
  return db.$transaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM "Project" WHERE id=${params.projectId}::uuid FOR UPDATE`,
    );
    await assertProjectRole(tx, params.projectId, actor, "Maintainer", {
      capability: "content:write",
    });
    const where = { projectId: params.projectId, id: params.resourceId };
    const target =
      params.kind === "document"
        ? await tx.document.findFirst({ where, select: { id: true } })
        : await tx.dataTable.findFirst({ where, select: { id: true } });
    if (!target) throw new CoreError("NOT_FOUND");
    const existing = await tx.projectContentPin.findUnique({
      where: { projectId_kind_resourceId: params },
      select: { id: true },
    });
    if (existing) return { pinId: existing.id };
    const used = await tx.projectContentPin.count({
      where: { projectId: params.projectId },
    });
    if (used >= DASHBOARD_LIMITS.projectPins) {
      throw new CoreError(
        "PRECONDITION_FAILED",
        "A project can pin up to 12 items.",
      );
    }
    const pin = await tx.projectContentPin.create({
      data: { ...params, createdById: actor.userId, createdAt: new Date() },
      select: { id: true },
    });
    return { pinId: pin.id };
  });
}

export async function unpinProjectContent(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: UnpinContentInput,
): Promise<{ removed: boolean }> {
  assertPinWrite(actor);
  const parsed = unpinContentInput.safeParse(input);
  if (!parsed.success)
    throw new CoreError("BAD_REQUEST", "Invalid project pin");
  const params = parsed.data;
  return db.$transaction(async (tx) => {
    await assertProjectRole(tx, params.projectId, actor, "Maintainer", {
      capability: "content:write",
    });
    const deleted = await tx.projectContentPin.deleteMany({
      where: { projectId: params.projectId, id: params.pinId },
    });
    return { removed: deleted.count > 0 };
  });
}

export async function listProjectPinCandidates(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: PinCandidatesInput,
): Promise<RecentContentPage> {
  assertPinWrite(actor);
  const parsed = pinCandidatesInput.safeParse(input);
  if (!parsed.success) throw new CoreError("BAD_REQUEST", "Invalid pin search");
  const params = parsed.data;
  await assertProjectRole(db, params.projectId, actor, "Maintainer", {
    capability: "content:write",
  });
  const pattern = `%${(params.search ?? "").replace(/[\\%_]/g, "\\$&")}%`;
  const [result] = parseRecentRows(
    await db.$queryRaw(Prisma.sql`
    WITH visible_projects AS (${visibleProjectsSql({ actor, audience: "mine", projectId: params.projectId })}),
    authorized_content AS (${authorizedContentSql({ actor, projectId: params.projectId, workAudience: "mine" })}),
    page AS (
      SELECT c.* FROM authorized_content c
      WHERE EXISTS (SELECT 1 FROM visible_projects p WHERE p.id=c."projectId" AND p."canMaintain")
        AND c.title ILIKE ${pattern}
        ${params.kind ? Prisma.sql`AND c.source=${params.kind}` : Prisma.empty}
      ORDER BY c."sortAt" DESC,c.source COLLATE "C" DESC,c.id DESC
      LIMIT ${DASHBOARD_LIMITS.pinCandidates}
    )
    SELECT COALESCE((SELECT jsonb_agg(${contentCardSql} ORDER BY c."sortAt" DESC,c.source COLLATE "C" DESC,c.id DESC) FROM page c),'[]'::jsonb) AS items,
      ${UTC_NOW} AS "observedAt"
  `),
  );
  return { ...result, observedAt: result.observedAt.toISOString() };
}

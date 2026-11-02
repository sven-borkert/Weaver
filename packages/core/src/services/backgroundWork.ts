import { Prisma, type PrismaClient } from "@weaver/db/client";
import { CoreError } from "../errors";
import {
  BACKGROUND_WORK_LIMITS,
  backgroundWorkListInput,
  backgroundWorkMarkSeenInput,
  type BackgroundWorkItem,
  type BackgroundWorkListInput,
  type BackgroundWorkPage,
  type BackgroundWorkSummary,
  type WorkReference,
} from "../jobs/backgroundWorkSchema";
import type { UserSecurityContext } from "../security/context";
import { assertProjectRole } from "./projectAccess";
import { UTC_NOW } from "./sql";
import {
  assertBackgroundWorkRead,
  type WorkQueryAccess,
} from "./backgroundWork/access";
import {
  decodeWorkCursor,
  encodeWorkCursor,
  workFilterIdentity,
} from "./backgroundWork/cursor";
import {
  activeWorkSql,
  authorizedWorkSql,
  markSeenSql,
  receiptJoinSql,
  terminalWorkSql,
} from "./backgroundWork/queries";

import {
  parseListRows,
  parseSummaryRows,
  parseSeenRows,
  parsePruneCount,
  type WorkRow,
} from "./backgroundWork/rows";

function isoUtc(value: string): string {
  return new Date(
    /[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`,
  ).toISOString();
}
function publicItem(row: WorkRow): BackgroundWorkItem {
  const { revision, isPersonal, ...item } = row;
  const terminal = item.state !== "queued" && item.state !== "running";
  return {
    ...item,
    title: [...item.title]
      .slice(0, BACKGROUND_WORK_LIMITS.titleLength)
      .join(""),
    createdAt: isoUtc(item.createdAt),
    startedAt: item.startedAt ? isoUtc(item.startedAt) : null,
    finishedAt: item.finishedAt ? isoUtc(item.finishedAt) : null,
    sortAt: isoUtc(item.sortAt),
    acknowledgement:
      isPersonal && terminal && revision
        ? { kind: item.kind, id: item.id, revision }
        : null,
  };
}
export async function listBackgroundWork(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: BackgroundWorkListInput,
): Promise<BackgroundWorkPage> {
  assertBackgroundWorkRead(actor);
  const parsed = backgroundWorkListInput.safeParse(input);
  if (!parsed.success)
    throw new CoreError("BAD_REQUEST", "Invalid background work filters");
  const params = parsed.data;
  if (params.projectId)
    await assertProjectRole(
      db,
      params.projectId,
      actor,
      params.audience === "projects" ? "Maintainer" : "Viewer",
      { capability: "content:read" },
    );
  const filters = workFilterIdentity(params);
  const cursor = params.cursor
    ? decodeWorkCursor(params.cursor, actor.userId, filters)
    : null;
  const access: WorkQueryAccess = {
    actor,
    audience: params.audience,
    projectId: params.projectId,
    windowStart: cursor
      ? Prisma.sql`${cursor.windowStart}::timestamp`
      : Prisma.sql`${UTC_NOW}-${BACKGROUND_WORK_LIMITS.recentDays}*interval '1 day'`,
  };
  const observed = cursor ? Prisma.sql`${cursor.asOf}::timestamp` : UTC_NOW;
  const criteria: Prisma.Sql[] = [Prisma.sql`w."sortAt" <= o."asOf"`];
  const recent = Prisma.sql`${terminalWorkSql} AND COALESCE(w."finishedAt",w."createdAt") >= o."windowStart"`;
  criteria.push(
    params.view === "active"
      ? activeWorkSql
      : params.view === "recent"
        ? Prisma.sql`(${recent})`
        : Prisma.sql`(${activeWorkSql} OR (${recent}))`,
  );
  if (params.kind) criteria.push(Prisma.sql`w.kind=${params.kind}`);
  if (params.state) criteria.push(Prisma.sql`w.state=${params.state}`);
  if (cursor)
    criteria.push(
      Prisma.sql`(w."sortAt",w.kind,w.id) < (${cursor.last.sortAt}::timestamp,${cursor.last.kind}::text,${cursor.last.id}::uuid)`,
    );
  const [result] = parseListRows(
    await db.$queryRaw<unknown>(Prisma.sql`
    ${authorizedWorkSql(access)}, observed AS (SELECT ${observed} AS "asOf"),
    clock AS (SELECT "asOf", "asOf"-${BACKGROUND_WORK_LIMITS.recentDays}*interval '1 day' AS "windowStart" FROM observed),
    page AS (SELECT w.*, (w."isPersonal" AND ${terminalWorkSql} AND w.revision IS NOT NULL AND r."userId" IS NULL) AS unseen
      FROM authorized_work w CROSS JOIN clock o ${receiptJoinSql(actor.userId)}
      WHERE ${Prisma.join(criteria, " AND ")} ORDER BY w."sortAt" DESC,w.kind DESC,w.id DESC LIMIT ${params.limit + 1})
    SELECT COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY "sortAt" DESC,kind DESC,id DESC) FROM page),'[]'::jsonb) AS items,
      "asOf","windowStart" FROM clock`),
  );
  const items = result.items.slice(0, params.limit).map(publicItem);
  const last = items.at(-1);
  return {
    items,
    observedAt: result.asOf.toISOString(),
    nextCursor:
      result.items.length > params.limit && last
        ? encodeWorkCursor({
            version: 1,
            actorId: actor.userId,
            filters,
            asOf: result.asOf.toISOString(),
            windowStart: result.windowStart.toISOString(),
            last: { sortAt: last.sortAt, kind: last.kind, id: last.id },
          })
        : null,
  };
}
export async function getBackgroundWorkSummary(
  db: PrismaClient,
  actor: UserSecurityContext,
): Promise<BackgroundWorkSummary> {
  assertBackgroundWorkRead(actor);
  const [result] = parseSummaryRows(
    await db.$queryRaw<unknown>(Prisma.sql`
    ${authorizedWorkSql({ actor, audience: "mine" })}, clock AS (SELECT ${UTC_NOW} AS now),
    active AS (SELECT 1 FROM authorized_work w CROSS JOIN clock c WHERE ${activeWorkSql} AND w."sortAt"<=c.now LIMIT ${BACKGROUND_WORK_LIMITS.summaryCap}),
    unseen AS (SELECT 1 FROM authorized_work w CROSS JOIN clock c ${receiptJoinSql(actor.userId)}
      WHERE w."isPersonal" AND ${terminalWorkSql} AND w.revision IS NOT NULL AND r."userId" IS NULL
      AND COALESCE(w."finishedAt",w."createdAt") BETWEEN c.now-${BACKGROUND_WORK_LIMITS.recentDays}*interval '1 day' AND c.now
      LIMIT ${BACKGROUND_WORK_LIMITS.summaryCap})
    SELECT (SELECT count(*)::int FROM active) AS active,(SELECT count(*)::int FROM unseen) AS unseen,c.now AS "observedAt" FROM clock c`),
  );
  const count = (value: number) => ({
    value: Math.min(value, BACKGROUND_WORK_LIMITS.summaryCap),
    capped: value >= BACKGROUND_WORK_LIMITS.summaryCap,
  });
  return {
    active: count(result.active),
    unseen: count(result.unseen),
    observedAt: result.observedAt.toISOString(),
  };
}
export async function markBackgroundWorkSeen(
  db: PrismaClient,
  actor: UserSecurityContext,
  input: { items: WorkReference[] },
): Promise<{ acknowledged: number }> {
  assertBackgroundWorkRead(actor);
  const parsed = backgroundWorkMarkSeenInput.safeParse(input);
  if (!parsed.success)
    throw new CoreError("BAD_REQUEST", "Invalid background work references");
  const unique = [
    ...new Map(
      parsed.data.items.map((item) => [
        `${item.kind}:${item.id}:${item.revision}`,
        item,
      ]),
    ).values(),
  ];
  const rows = parseSeenRows(
    await db.$queryRaw<unknown>(
      markSeenSql({ actor, audience: "mine" }, unique),
    ),
  );
  return { acknowledged: rows.length };
}
export async function pruneBackgroundWorkReceipts(
  db: PrismaClient,
): Promise<number> {
  return parsePruneCount(
    await db.$executeRaw(Prisma.sql`WITH expired AS (
    SELECT "userId",kind,"workId",revision FROM "BackgroundWorkReceipt"
    WHERE "seenAt" < ${UTC_NOW}-${BACKGROUND_WORK_LIMITS.receiptRetentionDays}*interval '1 day'
    ORDER BY "seenAt" LIMIT ${BACKGROUND_WORK_LIMITS.pruneBatch})
    DELETE FROM "BackgroundWorkReceipt" r USING expired e
    WHERE r."userId"=e."userId" AND r.kind=e.kind AND r."workId"=e."workId" AND r.revision=e.revision`),
  );
}

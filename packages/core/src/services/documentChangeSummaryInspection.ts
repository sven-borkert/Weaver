import type {
  DocumentChangeSummaryStatus,
  Prisma,
  PrismaClient,
} from "@weaver/db/client";
import { CoreError } from "@weaver/core/errors";
import {
  assertSystemAdmin,
  type SecurityContext,
} from "@weaver/core/security/context";
import {
  clampLimit,
  decodeTimestampPageCursor,
  encodePageCursor,
} from "./adminPaging";

const MAX_PROJECT_FACETS = 100;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Metadata only: never summary text, paths, or titles.
const INSPECTION_SELECT = {
  projectId: true,
  documentId: true,
  commitSha: true,
  baseCommitSha: true,
  status: true,
  failureReason: true,
  attempts: true,
  lastErrorClass: true,
  lastJobId: true,
  createdAt: true,
  updatedAt: true,
  completedAt: true,
  project: { select: { name: true } },
} satisfies Prisma.DocumentChangeSummarySelect;

export type ChangeSummaryInspectionFilter = {
  status?: DocumentChangeSummaryStatus;
  projectId?: string;
  documentId?: string;
  since?: Date;
  limit?: number;
  cursor?: string;
};

export type ChangeSummaryInspectionRow = Omit<
  Prisma.DocumentChangeSummaryGetPayload<{ select: typeof INSPECTION_SELECT }>,
  "project"
> & { projectName: string };

export function encodeChangeSummaryCursor(
  row: Pick<
    ChangeSummaryInspectionRow,
    "createdAt" | "projectId" | "commitSha"
  >,
): string {
  return encodePageCursor([
    row.createdAt.toISOString(),
    row.projectId,
    row.commitSha,
  ]);
}

function decodeCursor(cursor: string): [Date, string, string] {
  const [createdAt, projectId, commitSha] = decodeTimestampPageCursor(
    cursor,
    3,
  );
  if (
    !projectId ||
    !commitSha ||
    !UUID_PATTERN.test(projectId) ||
    !SHA_PATTERN.test(commitSha)
  )
    throw new CoreError("BAD_REQUEST", "Invalid cursor", { field: "cursor" });
  return [createdAt, projectId, commitSha];
}

export async function listDocumentChangeSummaries(
  db: PrismaClient,
  actor: SecurityContext,
  filter: ChangeSummaryInspectionFilter,
): Promise<{
  items: ChangeSummaryInspectionRow[];
  nextCursor: string | null;
  truncated: boolean;
  counts: Record<DocumentChangeSummaryStatus, number>;
  projects: Array<{ id: string; name: string }>;
}> {
  assertSystemAdmin(actor);
  const limit = clampLimit(filter.limit);
  const cursor = filter.cursor ? decodeCursor(filter.cursor) : null;
  const scope: Prisma.DocumentChangeSummaryWhereInput = {
    ...(filter.projectId ? { projectId: filter.projectId } : {}),
    ...(filter.documentId ? { documentId: filter.documentId } : {}),
    ...(filter.since ? { createdAt: { gte: filter.since } } : {}),
  };
  const where: Prisma.DocumentChangeSummaryWhereInput = {
    AND: [
      scope,
      filter.status ? { status: filter.status } : {},
      cursor
        ? {
            OR: [
              { createdAt: { lt: cursor[0] } },
              { createdAt: cursor[0], projectId: { lt: cursor[1] } },
              {
                createdAt: cursor[0],
                projectId: cursor[1],
                commitSha: { lt: cursor[2] },
              },
            ],
          }
        : {},
    ],
  };
  const rows = await db.documentChangeSummary.findMany({
    where,
    orderBy: [
      { createdAt: "desc" },
      { projectId: "desc" },
      { commitSha: "desc" },
    ],
    take: limit + 1,
    select: INSPECTION_SELECT,
  });
  const grouped = await db.documentChangeSummary.groupBy({
    by: ["status"],
    where: scope,
    _count: { _all: true },
  });
  const projects = await db.project.findMany({
    where: { documentChangeSummaries: { some: {} } },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: MAX_PROJECT_FACETS,
    select: { id: true, name: true },
  });
  const counts: Record<DocumentChangeSummaryStatus, number> = {
    pending: 0,
    ready: 0,
    failed: 0,
    skipped: 0,
  };
  for (const group of grouped) counts[group.status] = group._count._all;
  const items = rows.slice(0, limit).map(({ project, ...row }) => ({
    ...row,
    projectName: project.name,
  }));
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last ? encodeChangeSummaryCursor(last) : null,
    truncated: rows.length > limit,
    counts,
    projects,
  };
}

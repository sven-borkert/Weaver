import { Prisma, type PrismaClient } from "@weaver/db/client";
import { openProjectRepo } from "@weaver/git-store";
import { CoreError } from "../errors";
import { normalizeKnowledgeName } from "../knowledge/extraction";
import { changeKindOf, type WikiChangeKind } from "../wiki/changeKinds";
import { trackedLink } from "../wiki/links";
import { invalidCursorError } from "./contentCursors";
import { getBacklinks } from "./documents";
import type { SecurityContext } from "../security/context";
import { assertProjectRole } from "./projectAccess";
import { hashNormalizedTitle } from "./searchLexical";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
export const FIND_PAGE_LIMIT = 10;
export const INSPECT_LINKS_LIMIT = 50;
export const RECENT_CHANGES_LIMIT = 25;
const MAX_CHANGES_PER_COMMIT = 20;

export type WikiPageRef = {
  id: string;
  title: string;
  path: string;
  type: string | null;
  summary: string | null;
  link: string;
};

type PageRow = {
  id: string;
  title: string;
  path: string;
  wikiType: string | null;
  wikiSummary: string | null;
};

function pageRef(row: PageRow): WikiPageRef {
  return {
    id: row.id,
    title: row.title,
    path: row.path,
    type: row.wikiType,
    summary: row.wikiSummary,
    link: trackedLink("document", row.id, row.title),
  };
}

const PAGE_SELECT = {
  id: true,
  title: true,
  path: true,
  wikiType: true,
  wikiSummary: true,
} satisfies Prisma.DocumentSelect;

/** Exact title (normalized), slug and path lookup; source pages only when asked. */
export async function findPages(
  db: PrismaClient,
  input: {
    projectId: string;
    title?: string;
    slug?: string;
    path?: string;
    includeSources?: boolean;
  },
  actor: SecurityContext,
): Promise<{ pages: WikiPageRef[]; truncated: boolean }> {
  await assertProjectRole(db, input.projectId, actor, "Viewer");
  if (!input.title && !input.slug && !input.path)
    throw new CoreError("BAD_REQUEST", "give a title, slug or path");
  const normalized =
    input.title === undefined ? null : normalizeKnowledgeName(input.title);
  const rows = await db.document.findMany({
    where: {
      projectId: input.projectId,
      ...(normalized === null
        ? {}
        : {
            normalizedTitleHash: new Uint8Array(
              hashNormalizedTitle(normalized),
            ),
          }),
      ...(input.slug ? { slug: input.slug } : {}),
      ...(input.path ? { path: input.path } : {}),
      ...(input.includeSources ? {} : { wikiSourceItemId: null }),
    },
    select: { ...PAGE_SELECT, normalizedTitle: true },
    orderBy: [{ path: "asc" }, { id: "asc" }],
    take: FIND_PAGE_LIMIT * 4 + 1,
  });
  const matches = rows.filter(
    (row) => normalized === null || row.normalizedTitle === normalized,
  );
  return {
    pages: matches.slice(0, FIND_PAGE_LIMIT).map(pageRef),
    truncated: matches.length > FIND_PAGE_LIMIT,
  };
}

export type InspectLinksResult =
  | { mode: "orphans"; pages: WikiPageRef[]; nextCursor: string | null }
  | {
      mode: "backlinks";
      pages: WikiPageRef[];
      nextCursor: string | null;
    }
  | {
      mode: "dangling";
      links: Array<{
        from: WikiPageRef;
        targetType: "document" | "table";
        targetId: string;
      }>;
      nextCursor: string | null;
    };

function documentCursor(cursor: string | undefined): string | null {
  if (cursor === undefined) return null;
  if (!UUID_RE.test(cursor)) throw invalidCursorError();
  return cursor;
}

/** Live pages with no inbound link from another page; source pages are not candidates. */
async function orphans(
  db: PrismaClient,
  projectId: string,
  cursor: string | undefined,
  limit: number,
): Promise<{ pages: WikiPageRef[]; nextCursor: string | null }> {
  const after = documentCursor(cursor);
  const rows = await db.$queryRaw<PageRow[]>(Prisma.sql`
    SELECT d."id", d."title", d."path", d."wikiType", d."wikiSummary"
    FROM "Document" AS d
    WHERE d."projectId" = ${projectId}::uuid
      AND d."wikiSourceItemId" IS NULL
      ${after === null ? Prisma.empty : Prisma.sql`AND d."id" > ${after}::uuid`}
      AND NOT EXISTS (
        SELECT 1 FROM "DocumentLink" AS l
        JOIN "Document" AS s ON s."id" = l."sourceDocumentId"
        WHERE l."targetType" = 'document'
          AND l."targetDocumentId" = d."id"
          AND l."sourceDocumentId" <> d."id"
          AND s."projectId" = d."projectId"
      )
    ORDER BY d."id" ASC
    LIMIT ${limit + 1}
  `);
  const page = rows.slice(0, limit);
  return {
    pages: page.map(pageRef),
    nextCursor: rows.length > limit ? page.at(-1)!.id : null,
  };
}

type DanglingRow = PageRow & {
  targetType: string;
  targetDocumentId: string;
  linkKey: string;
};

const DANGLING_CURSOR_RE = new RegExp(
  `^(${UUID_RE.source.slice(1, -1)}):(document|table):(${UUID_RE.source.slice(1, -1)})$`,
);

/** Links from live pages whose target document or table is not in this project. */
async function dangling(
  db: PrismaClient,
  projectId: string,
  cursor: string | undefined,
  limit: number,
): Promise<Extract<InspectLinksResult, { mode: "dangling" }>> {
  let after: RegExpExecArray | null = null;
  if (cursor !== undefined) {
    after = DANGLING_CURSOR_RE.exec(cursor);
    if (!after) throw invalidCursorError();
  }
  const rows = await db.$queryRaw<DanglingRow[]>(Prisma.sql`
    SELECT s."id", s."title", s."path", s."wikiType", s."wikiSummary",
           l."targetType", l."targetDocumentId"
    FROM "DocumentLink" AS l
    JOIN "Document" AS s ON s."id" = l."sourceDocumentId"
    WHERE s."projectId" = ${projectId}::uuid
      ${
        after === null
          ? Prisma.empty
          : Prisma.sql`AND (l."sourceDocumentId", l."targetType", l."targetDocumentId")
              > (${after[1]}::uuid, ${after[2]}, ${after[3]}::uuid)`
      }
      AND NOT EXISTS (
        SELECT 1 FROM "Document" AS t
        WHERE l."targetType" = 'document'
          AND t."id" = l."targetDocumentId"
          AND t."projectId" = s."projectId"
      )
      AND NOT EXISTS (
        SELECT 1 FROM "DataTable" AS t
        WHERE l."targetType" = 'table'
          AND t."id" = l."targetDocumentId"
          AND t."projectId" = s."projectId"
      )
    ORDER BY l."sourceDocumentId" ASC, l."targetType" ASC, l."targetDocumentId" ASC
    LIMIT ${limit + 1}
  `);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    mode: "dangling",
    links: page.map((row) => ({
      from: pageRef(row),
      targetType: row.targetType === "table" ? "table" : "document",
      targetId: row.targetDocumentId,
    })),
    nextCursor:
      rows.length > limit && last
        ? `${last.id}:${last.targetType}:${last.targetDocumentId}`
        : null,
  };
}

export async function inspectLinks(
  db: PrismaClient,
  input: {
    projectId: string;
    mode: "orphans" | "dangling" | "backlinks";
    documentId?: string;
    cursor?: string;
    limit?: number;
  },
  actor: SecurityContext,
): Promise<InspectLinksResult> {
  await assertProjectRole(db, input.projectId, actor, "Viewer");
  const limit = Math.max(
    1,
    Math.min(input.limit ?? INSPECT_LINKS_LIMIT, INSPECT_LINKS_LIMIT),
  );
  if (input.mode === "orphans")
    return {
      mode: "orphans",
      ...(await orphans(db, input.projectId, input.cursor, limit)),
    };
  if (input.mode === "dangling")
    return dangling(db, input.projectId, input.cursor, limit);
  if (input.documentId === undefined)
    throw new CoreError("BAD_REQUEST", "mode=backlinks requires documentId");
  if (input.cursor !== undefined) documentCursor(input.cursor);
  const result = await getBacklinks(
    db,
    {
      projectId: input.projectId,
      documentId: input.documentId,
      limit,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    },
    actor,
  );
  const ids = result.documents.map((document) => document.id);
  const typed = await db.document.findMany({
    where: { id: { in: ids } },
    select: PAGE_SELECT,
  });
  const byId = new Map(typed.map((row) => [row.id, row]));
  return {
    mode: "backlinks",
    pages: result.documents.map((document) =>
      pageRef(
        byId.get(document.id) ?? {
          ...document,
          wikiType: null,
          wikiSummary: null,
        },
      ),
    ),
    nextCursor: result.nextCursor,
  };
}

export type RecentChange = {
  sha: string;
  date: string;
  kind: WikiChangeKind;
  /** Only for ledger-trusted commits; an untrusted header name is never repeated. */
  author: string | null;
  /** Null for untrusted commits: their text never reaches a model. */
  subject: string | null;
  changes: Array<{
    status: string;
    path: string;
    documentId: string | null;
  }>;
  moreChanges: boolean;
};

function oneLine(text: string, max: number): string {
  return (text.split("\n", 1)[0] ?? "")
    .replace(/[\x00-\x1f\x7f\p{Zl}\p{Zp}]/gu, " ")
    .trim()
    .slice(0, max);
}

/** Project-wide commit feed, newest first, with the kind taken from trusted operation-id prefixes. */
export async function listRecentChanges(
  db: PrismaClient,
  input: { projectId: string; since?: Date; cursor?: string; limit?: number },
  actor: SecurityContext,
): Promise<{ changes: RecentChange[]; nextCursor: string | null }> {
  await assertProjectRole(db, input.projectId, actor, "Viewer");
  const limit = Math.max(
    1,
    Math.min(input.limit ?? RECENT_CHANGES_LIMIT, RECENT_CHANGES_LIMIT),
  );
  if (input.cursor !== undefined && !SHA_RE.test(input.cursor))
    throw invalidCursorError();
  const repo = await openProjectRepo(input.projectId);
  if (!repo) return { changes: [], nextCursor: null };
  let head: string;
  try {
    head = await repo.resolveHead();
  } catch {
    return { changes: [], nextCursor: null };
  }
  if (
    input.cursor !== undefined &&
    !(await repo.isAncestor(input.cursor, head))
  )
    throw invalidCursorError();
  const entries = await repo.logChangesBefore(input.cursor ?? head, {
    limit: limit + 1,
  });
  if (input.cursor !== undefined && entries[0]?.sha !== input.cursor)
    throw invalidCursorError();
  const page = entries.slice(0, limit);
  const since = input.since;
  // Dates in untrusted commits are attacker-controlled: only a trusted commit ends the walk.
  const stop = since
    ? page.findIndex(
        (entry) => entry.trustedAuthor === true && entry.date < since,
      )
    : -1;
  const kept = stop === -1 ? page : page.slice(0, stop);
  const paths = new Set(
    kept.flatMap((entry) =>
      entry.changes.slice(0, MAX_CHANGES_PER_COMMIT).map((c) => c.path),
    ),
  );
  const documents = await db.document.findMany({
    where: { projectId: input.projectId, path: { in: [...paths] } },
    select: { id: true, path: true },
  });
  const idByPath = new Map(documents.map((row) => [row.path, row.id]));
  const exhausted = stop !== -1 || entries.length <= limit;
  return {
    changes: kept.map((entry) => ({
      sha: entry.sha,
      date: entry.date.toISOString(),
      kind: changeKindOf(entry),
      author: entry.trustedAuthor === true ? entry.authorName : null,
      subject:
        entry.trustedAuthor === true ? oneLine(entry.message, 200) : null,
      changes: entry.changes.slice(0, MAX_CHANGES_PER_COMMIT).map((change) => ({
        status: change.status,
        path: change.path,
        documentId: idByPath.get(change.path) ?? null,
      })),
      moreChanges: entry.changes.length > MAX_CHANGES_PER_COMMIT,
    })),
    nextCursor: exhausted ? null : entries[limit]!.sha,
  };
}

import { Prisma, type PrismaClient } from "@weaver/db/client";
import { openProjectRepo, type GitChangeEntry } from "@weaver/git-store";
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
const MAX_RANGE_COMMITS = 5000;
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
  const since = input.since;
  let kept: GitChangeEntry[];
  let nextCursor: string | null;
  if (since === undefined) {
    const entries = await repo.logChangesBefore(input.cursor ?? head, {
      limit: limit + 1,
    });
    if (input.cursor !== undefined && entries[0]?.sha !== input.cursor)
      throw invalidCursorError();
    kept = entries.slice(0, limit);
    nextCursor = entries.length <= limit ? null : entries[limit]!.sha;
  } else {
    // Untrusted dates cannot end the walk: the boundary is a trusted first-parent ancestor.
    const boundary = await repo.firstParentTrustedBefore(head, since);
    const shas = await repo.listCommitShas(head, {
      exclude: boundary,
      maxCount: MAX_RANGE_COMMITS,
    });
    const start = input.cursor === undefined ? 0 : shas.indexOf(input.cursor);
    if (start === -1) throw invalidCursorError();
    const entries = await repo.logChangesForShas(
      shas.slice(start, start + limit),
    );
    kept = entries.filter(
      (entry) => !(entry.trustedAuthor === true && entry.date < since),
    );
    nextCursor = shas[start + limit] ?? null;
  }
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
    nextCursor,
  };
}

export const PAGE_INDEX_LIMIT = 50;

type IndexRow = {
  id: string;
  title: string;
  path: string;
  wikiType: string | null;
  wikiSummary: string | null;
  untyped: number;
  typeKey: string;
  titleKey: string;
};

type IndexCursor = [number, string, string, string];

function decodeIndexCursor(cursor: string): IndexCursor {
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as unknown;
    if (
      Array.isArray(value) &&
      value.length === 4 &&
      (value[0] === 0 || value[0] === 1) &&
      typeof value[1] === "string" &&
      typeof value[2] === "string" &&
      typeof value[3] === "string" &&
      UUID_RE.test(value[3])
    )
      return value as IndexCursor;
  } catch {
    /* falls through */
  }
  throw invalidCursorError();
}

/** Pages grouped by type (untyped last), then by title; the project's overview page heads the view. */
export async function listPageIndex(
  db: PrismaClient,
  input: { projectId: string; cursor?: string; limit?: number },
  actor: SecurityContext,
): Promise<{
  pages: Array<{
    id: string;
    title: string;
    path: string;
    type: string | null;
    summary: string | null;
  }>;
  nextCursor: string | null;
  overview: { id: string; title: string } | null;
}> {
  await assertProjectRole(db, input.projectId, actor, "Viewer");
  const limit = Math.min(input.limit ?? PAGE_INDEX_LIMIT, PAGE_INDEX_LIMIT);
  if (!Number.isInteger(limit) || limit < 1)
    throw new CoreError("BAD_REQUEST", "limit must be a positive integer");
  const after =
    input.cursor === undefined ? null : decodeIndexCursor(input.cursor);
  const rows = await db.$queryRaw<IndexRow[]>(Prisma.sql`
    SELECT d."id", d."title", d."path", d."wikiType", d."wikiSummary",
      (CASE WHEN d."wikiType" IS NULL THEN 1 ELSE 0 END)::int AS "untyped",
      (COALESCE(lower(d."wikiType"), '') COLLATE "C") AS "typeKey",
      (lower(d."title") COLLATE "C") AS "titleKey"
    FROM "Document" AS d
    WHERE d."projectId" = ${input.projectId}::uuid
      AND d."wikiSourceItemId" IS NULL
      ${
        after === null
          ? Prisma.empty
          : Prisma.sql`AND (
              (CASE WHEN d."wikiType" IS NULL THEN 1 ELSE 0 END),
              (COALESCE(lower(d."wikiType"), '') COLLATE "C"),
              (lower(d."title") COLLATE "C"),
              d."id"
            ) > (${after[0]}::int, ${after[1]}, ${after[2]}, ${after[3]}::uuid)`
      }
    ORDER BY "untyped" ASC, "typeKey" ASC, "titleKey" ASC, d."id" ASC
    LIMIT ${limit + 1}
  `);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const settings = await db.projectWikiSettings.findUnique({
    where: { projectId: input.projectId },
    select: { overviewDocumentId: true },
  });
  const overview = settings?.overviewDocumentId
    ? await db.document.findFirst({
        where: {
          id: settings.overviewDocumentId,
          projectId: input.projectId,
        },
        select: { id: true, title: true },
      })
    : null;
  return {
    pages: page.map((row) => ({
      id: row.id,
      title: row.title,
      path: row.path,
      type: row.wikiType,
      summary: row.wikiSummary,
    })),
    nextCursor:
      rows.length > limit && last
        ? Buffer.from(
            JSON.stringify([
              last.untyped,
              last.typeKey,
              last.titleKey,
              last.id,
            ]),
          ).toString("base64url")
        : null,
    overview,
  };
}

export const WIKI_LINT_READ_LIMIT = 25;
export const WIKI_MISSING_ENTITY_MIN_PAGES = 3;

function decodeKeyset(cursor: string, arity: number): unknown[] {
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as unknown;
    if (Array.isArray(value) && value.length === arity) return value;
  } catch {
    /* falls through */
  }
  throw invalidCursorError();
}

const encodeKeyset = (parts: unknown[]) =>
  Buffer.from(JSON.stringify(parts)).toString("base64url");

type MissingEntityRow = {
  id: string;
  canonicalName: string;
  entityType: string;
  pages: number;
};

/**
 * Entities of the active generation named in at least `minPages` pages that no page is titled after.
 * Source pages are not counted, and a source page never counts as the entity's page.
 */
export async function listMissingEntityPages(
  db: PrismaClient,
  input: {
    projectId: string;
    minPages?: number;
    cursor?: string;
    limit?: number;
  },
  actor: SecurityContext,
): Promise<{
  entities: Array<{
    id: string;
    name: string;
    type: string;
    pages: number;
  }>;
  nextCursor: string | null;
}> {
  await assertProjectRole(db, input.projectId, actor, "Viewer");
  const limit = Math.max(
    1,
    Math.min(input.limit ?? WIKI_LINT_READ_LIMIT, WIKI_LINT_READ_LIMIT),
  );
  const minPages = Math.max(
    2,
    Math.min(input.minPages ?? WIKI_MISSING_ENTITY_MIN_PAGES, 100),
  );
  let after: [number, string, string] | null = null;
  if (input.cursor !== undefined) {
    const [pages, name, id] = decodeKeyset(input.cursor, 3);
    if (
      !Number.isInteger(pages) ||
      typeof name !== "string" ||
      typeof id !== "string" ||
      !UUID_RE.test(id)
    )
      throw invalidCursorError();
    after = [pages as number, name, id];
  }
  const rows = await db.$queryRaw<MissingEntityRow[]>(Prisma.sql`
    SELECT entity."id", entity."canonicalName", entity."entityType",
           COUNT(DISTINCT mention."documentId")::int AS "pages"
    FROM "GraphEntity" AS entity
    JOIN "KnowledgeGeneration" AS generation
      ON generation."id" = entity."generationId" AND generation."status" = 'active'
    JOIN "EntityMention" AS mention
      ON mention."entityId" = entity."id" AND mention."generationId" = entity."generationId"
     AND mention."invalidatedAt" IS NULL
    JOIN "Document" AS doc
      ON doc."id" = mention."documentId" AND doc."projectId" = entity."projectId"
     AND doc."wikiSourceItemId" IS NULL
    WHERE entity."projectId" = ${input.projectId}::uuid
      AND NOT EXISTS (
        SELECT 1 FROM "Document" AS page
        WHERE page."projectId" = entity."projectId" AND page."wikiSourceItemId" IS NULL
          AND (page."normalizedTitle" = entity."normalizedName"
            OR page."normalizedTitle" IN (
              SELECT alias."normalizedAlias" FROM "GraphEntityAlias" AS alias
              WHERE alias."entityId" = entity."id"))
      )
    GROUP BY entity."id", entity."canonicalName", entity."entityType"
    HAVING COUNT(DISTINCT mention."documentId") >= ${minPages}
       ${
         after === null
           ? Prisma.empty
           : Prisma.sql`AND (-COUNT(DISTINCT mention."documentId"), (entity."canonicalName" COLLATE "C"), entity."id")
              > (${-after[0]}::int, ${after[1]}, ${after[2]}::uuid)`
       }
    ORDER BY "pages" DESC, (entity."canonicalName" COLLATE "C") ASC, entity."id" ASC
    LIMIT ${limit + 1}
  `);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    entities: page.map((row) => ({
      id: row.id,
      name: row.canonicalName,
      type: row.entityType,
      pages: row.pages,
    })),
    nextCursor:
      rows.length > limit && last
        ? encodeKeyset([last.pages, last.canonicalName, last.id])
        : null,
  };
}

type StaleSourceRow = {
  id: string;
  title: string;
  path: string;
  lastEditedAt: Date;
  sourceKind: string;
  sourceId: string;
  sourceTitle: string;
  sourceEditedAt: Date;
};

/** Pages whose document or table source was committed after the page itself; ids and times only. */
export async function listPagesWithNewerSources(
  db: PrismaClient,
  input: { projectId: string; cursor?: string; limit?: number },
  actor: SecurityContext,
): Promise<{
  pages: Array<{
    id: string;
    title: string;
    path: string;
    lastEditedAt: string;
    sources: Array<{
      kind: string;
      id: string;
      title: string;
      lastEditedAt: string;
    }>;
  }>;
  nextCursor: string | null;
}> {
  await assertProjectRole(db, input.projectId, actor, "Viewer");
  const limit = Math.max(
    1,
    Math.min(input.limit ?? WIKI_LINT_READ_LIMIT, WIKI_LINT_READ_LIMIT),
  );
  let afterId: string | null = null;
  if (input.cursor !== undefined) {
    const [id] = decodeKeyset(input.cursor, 1);
    if (typeof id !== "string" || !UUID_RE.test(id)) throw invalidCursorError();
    afterId = id;
  }
  const pageRows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT d."id"
    FROM "Document" AS d
    WHERE d."projectId" = ${input.projectId}::uuid
      AND d."wikiSourceItemId" IS NULL
      AND jsonb_typeof(d."wikiSources") = 'array'
      ${afterId === null ? Prisma.empty : Prisma.sql`AND d."id" > ${afterId}::uuid`}
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(d."wikiSources") AS src(value)
        WHERE (src.value ->> 'kind' = 'document' AND EXISTS (
                 SELECT 1 FROM "Document" AS s
                 WHERE s."projectId" = d."projectId" AND s."id"::text = src.value ->> 'id'
                   AND s."lastEditedAt" > d."lastEditedAt"))
           OR (src.value ->> 'kind' = 'table' AND EXISTS (
                 SELECT 1 FROM "DataTable" AS t
                 WHERE t."projectId" = d."projectId" AND t."id"::text = src.value ->> 'id'
                   AND t."lastEditedAt" > d."lastEditedAt"))
      )
    ORDER BY d."id" ASC
    LIMIT ${limit + 1}
  `);
  const ids = pageRows.slice(0, limit).map((row) => row.id);
  const rows = ids.length
    ? await db.$queryRaw<StaleSourceRow[]>(Prisma.sql`
        SELECT d."id", d."title", d."path", d."lastEditedAt",
               src.value ->> 'kind' AS "sourceKind", src.value ->> 'id' AS "sourceId",
               COALESCE(s."title", t."title") AS "sourceTitle",
               COALESCE(s."lastEditedAt", t."lastEditedAt") AS "sourceEditedAt"
        FROM "Document" AS d
        CROSS JOIN LATERAL jsonb_array_elements(d."wikiSources") AS src(value)
        LEFT JOIN "Document" AS s
          ON src.value ->> 'kind' = 'document' AND s."projectId" = d."projectId" AND s."id"::text = src.value ->> 'id'
        LEFT JOIN "DataTable" AS t
          ON src.value ->> 'kind' = 'table' AND t."projectId" = d."projectId" AND t."id"::text = src.value ->> 'id'
        WHERE d."id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
          AND COALESCE(s."lastEditedAt", t."lastEditedAt") > d."lastEditedAt"
        ORDER BY d."id" ASC, src.value ->> 'id' ASC
      `)
    : [];
  const byPage = new Map<
    string,
    {
      id: string;
      title: string;
      path: string;
      lastEditedAt: string;
      sources: Array<{
        kind: string;
        id: string;
        title: string;
        lastEditedAt: string;
      }>;
    }
  >();
  for (const row of rows) {
    const entry = byPage.get(row.id) ?? {
      id: row.id,
      title: row.title,
      path: row.path,
      lastEditedAt: row.lastEditedAt.toISOString(),
      sources: [],
    };
    const duplicate = entry.sources.some(
      (source) => source.kind === row.sourceKind && source.id === row.sourceId,
    );
    if (!duplicate && entry.sources.length < 5)
      entry.sources.push({
        kind: row.sourceKind,
        id: row.sourceId,
        title: row.sourceTitle,
        lastEditedAt: row.sourceEditedAt.toISOString(),
      });
    byPage.set(row.id, entry);
  }
  const pages = ids.flatMap((id) => {
    const entry = byPage.get(id);
    return entry ? [entry] : [];
  });
  return {
    pages,
    nextCursor:
      pageRows.length > limit && ids.length > 0
        ? encodeKeyset([ids.at(-1)!])
        : null,
  };
}

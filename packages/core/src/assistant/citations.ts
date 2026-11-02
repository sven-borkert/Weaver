import type { PrismaClient } from "@weaver/db/client";
import { openProjectRepo } from "@weaver/git-store";
import { z } from "zod";
import type { UserSecurityContext } from "../security/context";
import { resolveProjectAccess } from "../services/projectAccess";
import { cursorQueryIdentity } from "../services/contentCursors";
import { parseDocumentFile } from "../documents/frontmatter";
import { documentKindFromPath, documentKindOfPath } from "../documents/kinds";
import { MAX_DATA_FILE_BYTES, MAX_SCHEMA_FILE_BYTES } from "../services/tables";
import { chunkDocumentSource } from "../knowledge/chunkDocument";
import { tableFiltersSchema } from "../tables/query";
import { aggregateSpecsSchema, groupBySchema } from "../tables/aggregate";
import { CANONICAL_UUID_RE } from "../tables/validation";
import type { SchemaFile } from "../tables/types";
import type { CitationView } from "./events";

const sha = z.string().regex(/^[0-9a-f]{7,40}$/);

/** What a model may hand-construct and `resolve_citation` accepts. The
 * aggregate variant is deliberately absent: validation does not recompute, so
 * a hand-written one would mint provenance for an aggregate never run
 * (design §8.5). */
export const resolvableLocatorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("document"),
    projectId: z.uuid(),
    documentId: z.uuid(),
    commitSha: sha,
    headingPath: z.array(z.string().max(200)).max(10).default([]),
    excerpt: z.string().max(500).nullable().default(null),
  }),
  z.object({
    kind: z.literal("table"),
    projectId: z.uuid(),
    tableId: z.uuid(),
    commitSha: sha,
    rowIds: z.array(z.string()).max(50).default([]),
    columnIds: z.array(z.string()).max(50).default([]),
  }),
  z.object({
    kind: z.literal("graph"),
    projectId: z.uuid(),
    entityId: z.uuid().optional(),
    relationId: z.uuid().optional(),
    documentId: z.uuid().nullable().default(null),
    commitSha: sha.nullable().default(null),
    excerpt: z.string().max(500).nullable().default(null),
  }),
  z.object({
    kind: z.literal("search"),
    projectId: z.uuid(),
    resourceType: z.enum(["document", "table"]),
    resourceId: z.uuid(),
    commitSha: sha,
    excerpt: z.string().max(500).nullable().default(null),
    score: z.number(),
  }),
]);
export type ResolvableLocator = z.infer<typeof resolvableLocatorSchema>;

/** `resolve_citation`'s input. Function-calling providers such as DeepSeek reject a
 * top-level union, so the locator is flat here and the union still validates it. */
export const resolveCitationInputSchema = z
  .object({
    kind: z
      .enum(["document", "table", "graph", "search"])
      .describe(
        "document: documentId, commitSha; table: tableId, commitSha; graph: entityId or relationId; search: resourceType, resourceId, commitSha, score",
      ),
    projectId: z.uuid(),
    documentId: z.uuid().nullable().optional(),
    tableId: z.uuid().optional(),
    entityId: z.uuid().optional(),
    relationId: z.uuid().optional(),
    resourceType: z.enum(["document", "table"]).optional(),
    resourceId: z.uuid().optional(),
    commitSha: sha.nullable().optional(),
    headingPath: z.array(z.string().max(200)).max(10).optional(),
    excerpt: z.string().max(500).nullable().optional(),
    rowIds: z.array(z.string()).max(50).optional(),
    columnIds: z.array(z.string()).max(50).optional(),
    score: z.number().optional(),
  })
  .pipe(resolvableLocatorSchema);

/** Everything a tool may emit, validation accepts and AssistantCitation.locator
 * stores. New variants append; persisted rows are parsed by this union. */
export const sourceLocatorSchema = z.discriminatedUnion("kind", [
  ...resolvableLocatorSchema.options,
  z.object({
    kind: z.literal("aggregate"),
    projectId: z.uuid(),
    tableId: z.uuid(),
    commitSha: sha,
    columnIds: z.array(z.string()).max(50).default([]),
    /** The normalized query, so a later validator can recompute the result. */
    query: z.object({
      filters: tableFiltersSchema.default([]),
      groupBy: groupBySchema.default([]),
      aggregates: aggregateSpecsSchema,
    }),
  }),
]);
export type SourceLocator = z.infer<typeof sourceLocatorSchema>;

export type ValidatedCitation = Omit<CitationView, "id"> & {
  locator: SourceLocator;
  navigationAnchor?: string | null;
};

async function loadDocumentRevision(
  db: PrismaClient,
  projectId: string,
  documentId: string,
  commitSha: string,
) {
  const row = await db.document.findFirst({
    where: { id: documentId, projectId },
    select: { path: true, headCommitSha: true },
  });
  const repo = await openProjectRepo(projectId);
  if (!row || !repo) return null;
  const read = async (path: string) => {
    if (((await repo.blobSizeAt(commitSha, path)) ?? Infinity) > 2_000_000)
      return null;
    try {
      const kind = documentKindOfPath(path);
      const candidate = parseDocumentFile(
        await repo.showFileAt(commitSha, path),
        kind,
      );
      return candidate.meta.id === documentId ? { ...candidate, kind } : null;
    } catch {
      return null;
    }
  };
  let file = await read(row.path);
  if (!file) {
    const renamed = await repo.renamedPathBetween(
      row.headCommitSha,
      commitSha,
      row.path,
    );
    if (renamed && renamed !== row.path) file = await read(renamed);
  }
  if (!file) {
    for (const path of await repo.listTrackedFiles(commitSha)) {
      if (
        path === row.path ||
        documentKindFromPath(path) === null ||
        path.startsWith("tables/")
      )
        continue;
      file = await read(path);
      if (file) break;
    }
  }
  if (!file) return null;
  const chunks = chunkDocumentSource({
    documentId,
    sourceCommitSha: commitSha,
    source: { title: file.meta.title, kind: file.kind, body: file.body },
    maxChars: 9000,
    overlapChars: 0,
  });
  return { file, chunks };
}

async function documentSource(
  db: PrismaClient,
  projectId: string,
  documentId: string,
  commitSha: string,
  requestedExcerpt: string | null,
  requestedHeadingPath: readonly string[] = [],
  cache: SourceValidationCache,
) {
  const key = `${projectId}:${documentId}:${commitSha}`;
  const pending =
    cache.documents.get(key) ??
    loadDocumentRevision(db, projectId, documentId, commitSha);
  cache.documents.set(key, pending);
  const source = await pending;
  if (!source) return null;
  const { file, chunks } = source;
  const chunk =
    (requestedHeadingPath.length
      ? chunks.find(
          (part) =>
            JSON.stringify(part.headingPath) ===
              JSON.stringify(requestedHeadingPath) ||
            JSON.stringify(part.headingPath.slice(1)) ===
              JSON.stringify(requestedHeadingPath),
        )
      : null) ??
    (requestedExcerpt
      ? chunks.find((part) => part.content.includes(requestedExcerpt))
      : null) ??
    chunks[0];
  return {
    title: file.meta.title,
    headingPath: chunk?.headingPath ?? [],
    navigationAnchor: chunk?.navigationAnchor ?? null,
    excerpt: (chunk?.content ?? file.body).slice(0, 500) || null,
  };
}

async function loadTableRevision(
  db: PrismaClient,
  projectId: string,
  tableId: string,
  commitSha: string,
) {
  const row = await db.dataTable.findFirst({
    where: { id: tableId, projectId },
    select: { path: true },
  });
  const repo = await openProjectRepo(projectId);
  if (!row || !repo) return null;
  const tracked = await repo.listTrackedFiles(commitSha);
  const dirs = tracked
    .filter(
      (path) =>
        path.startsWith("tables/") && path.endsWith(".table/schema.json"),
    )
    .map((path) => path.slice(0, -"/schema.json".length));
  let source: {
    title: string;
    rowIds: Set<string>;
    columnIds: Set<string>;
  } | null = null;
  for (const dir of dirs) {
    const files = tracked.filter((path) => path.startsWith(`${dir}/`));
    if (files.length !== 2 || !files.includes(`${dir}/data.jsonl`)) continue;
    const schemaBytes = await repo.blobSizeAt(commitSha, `${dir}/schema.json`);
    if (schemaBytes === null || schemaBytes > MAX_SCHEMA_FILE_BYTES) continue;
    let schema: SchemaFile;
    try {
      schema = JSON.parse(
        await repo.showFileAt(commitSha, `${dir}/schema.json`),
      ) as SchemaFile;
      if (schema?.id !== tableId) continue;
    } catch {
      continue;
    }
    if (source) return null;
    const dataBytes = await repo.blobSizeAt(commitSha, `${dir}/data.jsonl`);
    if (dataBytes === null || dataBytes > MAX_DATA_FILE_BYTES) return null;
    const rows = (await repo.showFileAt(commitSha, `${dir}/data.jsonl`))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id: string });
    if (
      typeof schema.title !== "string" ||
      schema.title.length > 200 ||
      schema.columns.length > 100 ||
      rows.length > 10000 ||
      schema.columns.some((column) => !CANONICAL_UUID_RE.test(column.id)) ||
      rows.some((row) => !CANONICAL_UUID_RE.test(row.id))
    )
      return null;
    source = {
      title: schema.title,
      rowIds: new Set(rows.map((row) => row.id)),
      columnIds: new Set(schema.columns.map((column) => column.id)),
    };
  }
  return source;
}

export function createSourceValidationCache() {
  return {
    documents: new Map<string, ReturnType<typeof loadDocumentRevision>>(),
    tables: new Map<string, ReturnType<typeof loadTableRevision>>(),
  };
}
export type SourceValidationCache = ReturnType<
  typeof createSourceValidationCache
>;

async function tableSource(
  db: PrismaClient,
  projectId: string,
  tableId: string,
  commitSha: string,
  cache: SourceValidationCache,
) {
  const key = `${projectId}:${tableId}:${commitSha}`;
  const pending =
    cache.tables.get(key) ??
    loadTableRevision(db, projectId, tableId, commitSha);
  cache.tables.set(key, pending);
  return pending;
}

/** Drops locators the actor may not see or that point at unknown resources/revisions; never throws for one bad locator. */
export async function validateSourceLocators(
  db: PrismaClient,
  actor: UserSecurityContext,
  locators: readonly unknown[],
  cache = createSourceValidationCache(),
): Promise<ValidatedCitation[]> {
  const validated: ValidatedCitation[] = [];
  const seen = new Set<string>();
  for (const raw of locators) {
    const parsed = sourceLocatorSchema.safeParse(raw);
    if (!parsed.success) continue;
    const locator = parsed.data;
    try {
      await resolveProjectAccess(db, locator.projectId, actor);
    } catch {
      continue;
    }
    let citation: ValidatedCitation | null = null;
    try {
      switch (locator.kind) {
        case "document": {
          const source = await documentSource(
            db,
            locator.projectId,
            locator.documentId,
            locator.commitSha,
            locator.excerpt,
            locator.headingPath,
            cache,
          );
          if (!source) break;
          const verified = {
            ...locator,
            headingPath: source.headingPath,
            excerpt: source.excerpt,
          };
          citation = {
            kind: "document",
            projectId: locator.projectId,
            resourceId: locator.documentId,
            commitSha: locator.commitSha,
            label: source.headingPath.length
              ? source.headingPath.join(" › ")
              : source.title,
            excerpt: source.excerpt,
            navigationAnchor: source.navigationAnchor,
            locator: verified,
          };
          break;
        }
        case "table": {
          const source = await tableSource(
            db,
            locator.projectId,
            locator.tableId,
            locator.commitSha,
            cache,
          );
          if (
            !source ||
            locator.rowIds.some((id) => !source.rowIds.has(id)) ||
            locator.columnIds.some((id) => !source.columnIds.has(id))
          )
            break;
          citation = {
            kind: "table",
            projectId: locator.projectId,
            resourceId: locator.tableId,
            commitSha: locator.commitSha,
            label: source.title,
            excerpt: null,
            locator,
          };
          break;
        }
        case "aggregate": {
          const source = await tableSource(
            db,
            locator.projectId,
            locator.tableId,
            locator.commitSha,
            cache,
          );
          if (
            !source ||
            locator.columnIds.some((id) => !source.columnIds.has(id))
          )
            break;
          // The citation's own kind stays "table": it points at a table at a
          // revision, which is what the UI renders and what
          // AssistantCitationKind already allows. The normalized query rides
          // along in the locator for a later recompute (design §8.5).
          citation = {
            kind: "table",
            projectId: locator.projectId,
            resourceId: locator.tableId,
            commitSha: locator.commitSha,
            label: source.title,
            excerpt: null,
            locator,
          };
          break;
        }
        case "search": {
          const source =
            locator.resourceType === "document"
              ? await documentSource(
                  db,
                  locator.projectId,
                  locator.resourceId,
                  locator.commitSha,
                  locator.excerpt,
                  [],
                  cache,
                )
              : await tableSource(
                  db,
                  locator.projectId,
                  locator.resourceId,
                  locator.commitSha,
                  cache,
                );
          if (!source) break;
          const excerpt = "excerpt" in source ? source.excerpt : null;
          citation = {
            kind: "search",
            projectId: locator.projectId,
            resourceId: locator.resourceId,
            commitSha: locator.commitSha,
            label: source.title,
            excerpt,
            locator: { ...locator, excerpt },
          };
          break;
        }
        case "graph": {
          const id = locator.entityId ?? locator.relationId;
          if (!id) break;
          const entity = locator.entityId
            ? await db.graphEntity.findFirst({
                where: { id, projectId: locator.projectId },
                select: { canonicalName: true },
              })
            : null;
          const relation =
            locator.relationId && !locator.entityId
              ? await db.graphRelation.findFirst({
                  where: { id, projectId: locator.projectId },
                  select: { relationType: true },
                })
              : null;
          const label = entity?.canonicalName ?? relation?.relationType;
          if (!label) break;
          const where = {
            projectId: locator.projectId,
            ...(locator.documentId ? { documentId: locator.documentId } : {}),
            ...(locator.commitSha
              ? { sourceCommitSha: locator.commitSha }
              : {}),
          };
          const provenance = locator.entityId
            ? await db.entityMention.findFirst({
                where: { ...where, entityId: id },
                orderBy: [{ recordedAt: "desc" }, { id: "asc" }],
                select: { documentId: true, sourceCommitSha: true },
              })
            : await db.relationEvidence.findFirst({
                where: { ...where, relationId: id },
                orderBy: [{ recordedAt: "desc" }, { id: "asc" }],
                select: { documentId: true, sourceCommitSha: true },
              });
          if ((locator.documentId || locator.commitSha) && !provenance) break;
          const source = provenance
            ? await documentSource(
                db,
                locator.projectId,
                provenance.documentId,
                provenance.sourceCommitSha,
                null,
                [],
                cache,
              )
            : null;
          if (provenance && !source) break;
          const verified = {
            ...locator,
            documentId: provenance?.documentId ?? null,
            commitSha: provenance?.sourceCommitSha ?? null,
            excerpt: source?.excerpt ?? null,
          };
          citation = {
            kind: "graph",
            projectId: locator.projectId,
            resourceId: id,
            commitSha: verified.commitSha,
            label,
            excerpt: verified.excerpt,
            locator: verified,
          };
          break;
        }
      }
    } catch {
      continue;
    }
    if (!citation) continue;
    // locator.kind, not citation.kind: an aggregate citation reports
    // kind: "table" (design §8.5) but must not collapse into a plain table
    // citation over the same resource — its locator carries a distinct
    // normalized query that would otherwise be silently dropped. And two
    // different aggregate locators over the same table@commit (e.g. sum vs.
    // count) must stay distinct from each other too, so fold a stable
    // fingerprint of the normalized query into the key for that kind only —
    // the other four kinds' keys are unchanged.
    const key =
      citation.locator.kind === "aggregate"
        ? `${citation.locator.kind}:${citation.kind}:${citation.resourceId}:${citation.commitSha ?? ""}:${citation.label}:${cursorQueryIdentity(citation.locator.query)}`
        : `${citation.locator.kind}:${citation.kind}:${citation.resourceId}:${citation.commitSha ?? ""}:${citation.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    validated.push(citation);
  }
  return validated;
}

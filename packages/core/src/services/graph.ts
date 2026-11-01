import { CoreError } from "@weaver/core/errors";

import { Prisma, type PrismaClient } from "@weaver/db/client";
import { normalizeRelationType } from "@weaver/core/knowledge/extraction";
import { assertProjectRole, type ProjectActor } from "./projectAccess";
import { listProjectsForUser } from "./projects";

const MAX_ALIASES = 20;
const MAX_DETAIL_ITEMS = 50;
const MAX_EXCERPT_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 4_000;
const MAX_HEADING_DEPTH = 6;
const MAX_HEADING_LENGTH = 200;

type EntityFilters = { entityTypes?: string[] };

export type SearchGraphEntitiesInput = EntityFilters & {
  query: string;
  projectIds?: string[];
  limit?: number;
};

export type GraphFromDocumentInput = EntityFilters & {
  projectId: string;
  documentId: string;
  limit?: number;
};

export type GraphNeighborhoodInput = EntityFilters & {
  entityId: string;
  relationTypes?: string[];
  maxNodes?: number;
  maxEdges?: number;
};

type EntityRecord = {
  id: string;
  projectId: string;
  generationId: string;
  canonicalName: string;
  entityType: string;
  description: string | null;
  aliases: Array<{ alias: string }>;
  project: { name: string };
};

type SearchEntityRow = {
  entityId: string;
  projectId: string;
  projectName: string;
  canonicalName: string;
  entityType: string;
  description: string | null;
  aliases: string[];
};

type SeedRow = { entityId: string; confidence: number };

type NeighborhoodNodeRow = { oppositeEntityId: string };

type NeighborhoodRelationRow = {
  relationId: string;
  projectId: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationType: string;
  maxConfidence: number;
};

type MentionCitationRow = {
  mentionId: string;
  sourceCommitSha: string;
  excerpt: string;
  confidence: number;
  validFrom: Date | null;
  validTo: Date | null;
  headingPath: string[];
  navigationDocumentId: string | null;
  navigationTitle: string | null;
  navigationSlug: string | null;
  navigationPath: string | null;
  navigationAnchor: string | null;
};

type EvidenceCitationRow = {
  evidenceId: string;
  sourceCommitSha: string;
  excerpt: string;
  confidence: number;
  validFrom: Date | null;
  validTo: Date | null;
  headingPath: string[];
  navigationDocumentId: string | null;
  navigationTitle: string | null;
  navigationSlug: string | null;
  navigationPath: string | null;
  navigationAnchor: string | null;
};

export async function searchGraphEntities(
  db: PrismaClient,
  input: SearchGraphEntitiesInput,
  actor: ProjectActor,
) {
  const query = input.query.trim();
  const limit = input.limit ?? 20;
  const projects = await listProjectsForUser(db, actor);
  const requested = input.projectIds ? new Set(input.projectIds) : null;
  const projectIds = projects
    .map((project) => project.id)
    .filter((projectId) => !requested || requested.has(projectId));
  if (projectIds.length === 0) return { entities: [], truncated: false };

  const projectValues = parameterizedIds(projectIds);
  const entityTypeFilter = valueFilter(
    Prisma.sql`entity."entityType"`,
    input.entityTypes,
  );
  const pattern = `%${escapeLikePattern(query)}%`;
  const rows = await db.$queryRaw<SearchEntityRow[]>(Prisma.sql`
    SELECT entity."id" AS "entityId",
           entity."projectId" AS "projectId",
           project."name" AS "projectName",
           entity."canonicalName" AS "canonicalName",
           entity."entityType" AS "entityType",
           entity."description" AS "description",
           ARRAY(
             SELECT alias."alias"
             FROM "GraphEntityAlias" AS alias
             WHERE alias."entityId" = entity."id"
               AND alias."projectId" = entity."projectId"
             ORDER BY alias."normalizedAlias" ASC, alias."id" ASC
             LIMIT ${MAX_ALIASES}
           ) AS "aliases"
    FROM "GraphEntity" AS entity
    JOIN "KnowledgeGeneration" AS generation
      ON generation."id" = entity."generationId"
     AND generation."projectId" = entity."projectId"
     AND generation."status" = 'active'
    JOIN "Project" AS project
      ON project."id" = entity."projectId"
     AND project."deletedAt" IS NULL
    WHERE entity."projectId" IN (${projectValues})
      AND EXISTS (SELECT 1 FROM "EntityMention" AS live_mention WHERE live_mention."entityId" = entity."id" AND live_mention."projectId" = entity."projectId" AND live_mention."invalidatedAt" IS NULL)
      AND (
        entity."canonicalName" ILIKE ${pattern} ESCAPE '\\'
        OR coalesce(entity."description", '') ILIKE ${pattern} ESCAPE '\\'
        OR EXISTS (
          SELECT 1
          FROM "GraphEntityAlias" AS matching_alias
          WHERE matching_alias."entityId" = entity."id"
            AND matching_alias."projectId" = entity."projectId"
            AND matching_alias."alias" ILIKE ${pattern} ESCAPE '\\'
        )
      )
      ${entityTypeFilter}
    ORDER BY entity."canonicalName" ASC, entity."id" ASC
    LIMIT ${limit + 1}
  `);

  return {
    entities: rows.slice(0, limit).map(publicSearchEntity),
    truncated: rows.length > limit,
  };
}

export async function graphFromDocument(
  db: PrismaClient,
  input: GraphFromDocumentInput,
  actor: ProjectActor,
) {
  const access = await assertProjectRole(db, input.projectId, actor, "Viewer", {
    capability: "content:read",
  });
  const document = await db.document.findFirst({
    where: { id: input.documentId, projectId: access.project.id },
    select: { id: true },
  });
  if (!document) notFound();

  const limit = input.limit ?? 20;
  const entityTypeFilter = valueFilter(
    Prisma.sql`entity."entityType"`,
    input.entityTypes,
  );
  const seeds = await db.$queryRaw<SeedRow[]>(Prisma.sql`
    SELECT entity."id" AS "entityId",
           max(mention."confidence") AS "confidence"
    FROM "EntityMention" AS mention
    JOIN "GraphEntity" AS entity
      ON entity."id" = mention."entityId"
     AND entity."projectId" = mention."projectId"
     AND entity."generationId" = mention."generationId"
    JOIN "KnowledgeGeneration" AS generation
      ON generation."id" = entity."generationId"
     AND generation."projectId" = entity."projectId"
     AND generation."status" = 'active'
    JOIN "Project" AS project
      ON project."id" = entity."projectId"
     AND project."deletedAt" IS NULL
    WHERE mention."projectId" = ${access.project.id}::uuid
      AND mention."documentId" = ${document.id}::uuid
      AND mention."invalidatedAt" IS NULL
      ${entityTypeFilter}
    GROUP BY entity."id"
    ORDER BY "confidence" DESC, entity."id" ASC
    LIMIT ${limit + 1}
  `);
  const visibleSeeds = seeds.slice(0, limit);
  const entities = await loadPublicEntities(
    db,
    access.project.id,
    visibleSeeds.map((seed) => seed.entityId),
  );

  return {
    entities,
    truncated: seeds.length > limit,
  };
}

export async function getGraphNeighborhood(
  db: PrismaClient,
  input: GraphNeighborhoodInput,
  actor: ProjectActor,
) {
  const focus = await loadActiveEntity(db, input.entityId, actor);
  const maxNodes = input.maxNodes ?? 50;
  const maxEdges = input.maxEdges ?? 100;
  const entityTypeFilter = valueFilter(
    Prisma.sql`opposite."entityType"`,
    input.entityTypes,
  );
  const relationTypeFilter = valueFilter(
    Prisma.sql`relation."normalizedType"`,
    input.relationTypes?.map(normalizeRelationType),
  );
  const oppositeNodeLimit = maxNodes - 1;
  const nodeCandidates = await db.$queryRaw<NeighborhoodNodeRow[]>(Prisma.sql`
    WITH ordered_relations AS (
      SELECT relation."id" AS "relationId",
             opposite."id" AS "oppositeEntityId",
             evidence."maxConfidence" AS "maxConfidence"
      FROM "GraphRelation" AS relation
      JOIN "KnowledgeGeneration" AS generation
        ON generation."id" = relation."generationId"
       AND generation."projectId" = relation."projectId"
       AND generation."status" = 'active'
      JOIN "GraphEntity" AS source_entity
        ON source_entity."id" = relation."sourceEntityId"
       AND source_entity."projectId" = relation."projectId"
       AND source_entity."generationId" = relation."generationId"
      JOIN "GraphEntity" AS target_entity
        ON target_entity."id" = relation."targetEntityId"
       AND target_entity."projectId" = relation."projectId"
       AND target_entity."generationId" = relation."generationId"
      JOIN "GraphEntity" AS opposite
        ON opposite."id" = CASE
             WHEN relation."sourceEntityId" = ${focus.id}::uuid
             THEN relation."targetEntityId"
             ELSE relation."sourceEntityId"
           END
       AND opposite."projectId" = relation."projectId"
       AND opposite."generationId" = relation."generationId"
      JOIN LATERAL (
        SELECT max(evidence_row."confidence") AS "maxConfidence"
        FROM "RelationEvidence" AS evidence_row
        WHERE evidence_row."relationId" = relation."id"
          AND evidence_row."projectId" = relation."projectId"
          AND evidence_row."generationId" = relation."generationId"
          AND evidence_row."invalidatedAt" IS NULL
      ) AS evidence ON evidence."maxConfidence" IS NOT NULL
      JOIN "Project" AS project
        ON project."id" = relation."projectId"
       AND project."deletedAt" IS NULL
      WHERE relation."projectId" = ${focus.projectId}::uuid
        AND relation."generationId" = ${focus.generationId}::uuid
        AND (
          relation."sourceEntityId" = ${focus.id}::uuid
          OR relation."targetEntityId" = ${focus.id}::uuid
        )
        AND opposite."id" <> ${focus.id}::uuid
        ${entityTypeFilter}
        ${relationTypeFilter}
    ), first_relation_by_node AS (
      SELECT "relationId", "oppositeEntityId", "maxConfidence",
             row_number() OVER (
               PARTITION BY "oppositeEntityId"
               ORDER BY "maxConfidence" DESC, "relationId" ASC
             ) AS "nodeRank"
      FROM ordered_relations
    )
    SELECT "oppositeEntityId"
    FROM first_relation_by_node
    WHERE "nodeRank" = 1
    ORDER BY "maxConfidence" DESC, "relationId" ASC
    LIMIT ${oppositeNodeLimit + 1}
  `);
  const admittedOppositeIds = nodeCandidates
    .slice(0, oppositeNodeLimit)
    .map((candidate) => candidate.oppositeEntityId);
  let truncated = nodeCandidates.length > oppositeNodeLimit;

  const admittedNodeFilter =
    admittedOppositeIds.length > 0
      ? Prisma.sql`AND (
          opposite."id" = ${focus.id}::uuid
          OR opposite."id" IN (${parameterizedIds(admittedOppositeIds)})
        )`
      : Prisma.sql`AND opposite."id" = ${focus.id}::uuid`;
  const edgeCandidates = await db.$queryRaw<NeighborhoodRelationRow[]>(
    Prisma.sql`
      SELECT relation."id" AS "relationId",
             relation."projectId" AS "projectId",
             relation."sourceEntityId" AS "sourceEntityId",
             relation."targetEntityId" AS "targetEntityId",
             relation."relationType" AS "relationType",
             evidence."maxConfidence" AS "maxConfidence"
      FROM "GraphRelation" AS relation
      JOIN "KnowledgeGeneration" AS generation
        ON generation."id" = relation."generationId"
       AND generation."projectId" = relation."projectId"
       AND generation."status" = 'active'
      JOIN "GraphEntity" AS source_entity
        ON source_entity."id" = relation."sourceEntityId"
       AND source_entity."projectId" = relation."projectId"
       AND source_entity."generationId" = relation."generationId"
      JOIN "GraphEntity" AS target_entity
        ON target_entity."id" = relation."targetEntityId"
       AND target_entity."projectId" = relation."projectId"
       AND target_entity."generationId" = relation."generationId"
      JOIN "GraphEntity" AS opposite
        ON opposite."id" = CASE
             WHEN relation."sourceEntityId" = ${focus.id}::uuid
             THEN relation."targetEntityId"
             ELSE relation."sourceEntityId"
           END
       AND opposite."projectId" = relation."projectId"
       AND opposite."generationId" = relation."generationId"
      JOIN LATERAL (
        SELECT max(evidence_row."confidence") AS "maxConfidence"
        FROM "RelationEvidence" AS evidence_row
        WHERE evidence_row."relationId" = relation."id"
          AND evidence_row."projectId" = relation."projectId"
          AND evidence_row."generationId" = relation."generationId"
          AND evidence_row."invalidatedAt" IS NULL
      ) AS evidence ON evidence."maxConfidence" IS NOT NULL
      JOIN "Project" AS project
        ON project."id" = relation."projectId"
       AND project."deletedAt" IS NULL
      WHERE relation."projectId" = ${focus.projectId}::uuid
        AND relation."generationId" = ${focus.generationId}::uuid
        AND (
          relation."sourceEntityId" = ${focus.id}::uuid
          OR relation."targetEntityId" = ${focus.id}::uuid
        )
        ${admittedNodeFilter}
        ${entityTypeFilter}
        ${relationTypeFilter}
      ORDER BY evidence."maxConfidence" DESC, relation."id" ASC
      LIMIT ${maxEdges + 1}
    `,
  );
  if (edgeCandidates.length > maxEdges) truncated = true;
  const edges = edgeCandidates.slice(0, maxEdges);
  const nodeIds = new Set([focus.id]);
  for (const edge of edges) {
    nodeIds.add(edge.sourceEntityId);
    nodeIds.add(edge.targetEntityId);
  }
  const loadedNodes = await loadPublicEntities(db, focus.projectId, [
    ...nodeIds,
  ]);
  const loadedNodeIds = new Set(loadedNodes.map((node) => node.entityId));
  if (!loadedNodeIds.has(focus.id)) notFound();
  const publishedEdges = edges.filter(
    (edge) =>
      loadedNodeIds.has(edge.sourceEntityId) &&
      loadedNodeIds.has(edge.targetEntityId),
  );
  if (publishedEdges.length !== edges.length) truncated = true;
  const publishedNodeIds = new Set([focus.id]);
  for (const edge of publishedEdges) {
    publishedNodeIds.add(edge.sourceEntityId);
    publishedNodeIds.add(edge.targetEntityId);
  }
  const nodes = loadedNodes.filter((node) =>
    publishedNodeIds.has(node.entityId),
  );

  return { nodes, edges: publishedEdges, truncated };
}

export async function getGraphEntityDetail(
  db: PrismaClient,
  input: { entityId: string },
  actor: ProjectActor,
) {
  const entity = await loadActiveEntity(db, input.entityId, actor);
  const rows = await db.$queryRaw<MentionCitationRow[]>(Prisma.sql`
    SELECT mention."id" AS "mentionId",
           mention."sourceCommitSha" AS "sourceCommitSha",
           mention."mentionText" AS "excerpt",
           mention."confidence" AS "confidence",
           mention."validFrom" AS "validFrom",
           mention."validTo" AS "validTo",
           coalesce(chunk."headingPath", ARRAY[]::text[]) AS "headingPath",
           document."id" AS "navigationDocumentId",
           document."title" AS "navigationTitle",
           document."slug" AS "navigationSlug",
           document."path" AS "navigationPath",
           chunk."navigationAnchor" AS "navigationAnchor"
    FROM "EntityMention" AS mention
    LEFT JOIN "DocumentSearchChunk" AS chunk
      ON chunk."id" = mention."sourceChunkId"
     AND chunk."projectId" = mention."projectId"
     AND chunk."documentId" = mention."documentId"
     AND chunk."sourceCommitSha" = mention."sourceCommitSha"
    LEFT JOIN "Document" AS document
      ON document."id" = mention."documentId"
     AND document."projectId" = mention."projectId"
    WHERE mention."entityId" = ${entity.id}::uuid
      AND mention."projectId" = ${entity.projectId}::uuid
      AND mention."generationId" = ${entity.generationId}::uuid
      AND mention."invalidatedAt" IS NULL
    ORDER BY mention."confidence" DESC, mention."id" ASC
    LIMIT ${MAX_DETAIL_ITEMS + 1}
  `);

  return {
    entity: publicEntity(entity),
    mentions: rows.slice(0, MAX_DETAIL_ITEMS).map(publicMention),
    truncated: rows.length > MAX_DETAIL_ITEMS,
  };
}

export async function getGraphRelationDetail(
  db: PrismaClient,
  input: { relationId: string },
  actor: ProjectActor,
) {
  const relation = await loadActiveRelation(db, input.relationId, actor);
  const rows = await db.$queryRaw<EvidenceCitationRow[]>(Prisma.sql`
    SELECT evidence."id" AS "evidenceId",
           evidence."sourceCommitSha" AS "sourceCommitSha",
           evidence."evidenceText" AS "excerpt",
           evidence."confidence" AS "confidence",
           evidence."validFrom" AS "validFrom",
           evidence."validTo" AS "validTo",
           coalesce(chunk."headingPath", ARRAY[]::text[]) AS "headingPath",
           document."id" AS "navigationDocumentId",
           document."title" AS "navigationTitle",
           document."slug" AS "navigationSlug",
           document."path" AS "navigationPath",
           chunk."navigationAnchor" AS "navigationAnchor"
    FROM "RelationEvidence" AS evidence
    LEFT JOIN "DocumentSearchChunk" AS chunk
      ON chunk."id" = evidence."sourceChunkId"
     AND chunk."projectId" = evidence."projectId"
     AND chunk."documentId" = evidence."documentId"
     AND chunk."sourceCommitSha" = evidence."sourceCommitSha"
    LEFT JOIN "Document" AS document
      ON document."id" = evidence."documentId"
     AND document."projectId" = evidence."projectId"
    WHERE evidence."relationId" = ${relation.id}::uuid
      AND evidence."projectId" = ${relation.projectId}::uuid
      AND evidence."generationId" = ${relation.generationId}::uuid
      AND evidence."invalidatedAt" IS NULL
    ORDER BY evidence."confidence" DESC, evidence."id" ASC
    LIMIT ${MAX_DETAIL_ITEMS + 1}
  `);

  return {
    relation: {
      relationId: relation.id,
      projectId: relation.projectId,
      projectName: relation.project.name,
      relationType: relation.relationType,
      source: publicEntity(relation.sourceEntity),
      target: publicEntity(relation.targetEntity),
    },
    evidence: rows.slice(0, MAX_DETAIL_ITEMS).map(publicEvidence),
    truncated: rows.length > MAX_DETAIL_ITEMS,
  };
}

async function loadActiveEntity(
  db: PrismaClient,
  entityId: string,
  actor: ProjectActor,
): Promise<EntityRecord> {
  const projects = await listProjectsForUser(db, actor);
  const projectIds = projects.map((project) => project.id);
  if (projectIds.length === 0) notFound();
  const entity = await db.graphEntity.findFirst({
    where: {
      id: entityId,
      mentions: { some: { invalidatedAt: null } },
      projectId: { in: projectIds },
      project: { deletedAt: null },
      generation: { status: "active" },
    },
    include: {
      project: { select: { name: true } },
      generation: { select: { projectId: true } },
    },
  });
  if (!entity || entity.generation.projectId !== entity.projectId) notFound();
  const aliases = await loadEntityAliases(db, entity.id, entity.projectId);
  return { ...entity, aliases };
}

async function loadActiveRelation(
  db: PrismaClient,
  relationId: string,
  actor: ProjectActor,
) {
  const projects = await listProjectsForUser(db, actor);
  const projectIds = projects.map((project) => project.id);
  if (projectIds.length === 0) notFound();
  const relation = await db.graphRelation.findFirst({
    where: {
      id: relationId,
      projectId: { in: projectIds },
      project: { deletedAt: null },
      generation: { status: "active" },
    },
    include: {
      project: { select: { name: true } },
      generation: { select: { projectId: true } },
      sourceEntity: {
        include: {
          project: { select: { name: true } },
        },
      },
      targetEntity: {
        include: {
          project: { select: { name: true } },
        },
      },
    },
  });
  if (
    !relation ||
    relation.generation.projectId !== relation.projectId ||
    relation.sourceEntity.projectId !== relation.projectId ||
    relation.sourceEntity.generationId !== relation.generationId ||
    relation.targetEntity.projectId !== relation.projectId ||
    relation.targetEntity.generationId !== relation.generationId
  ) {
    notFound();
  }
  const evidence = await db.relationEvidence.findFirst({
    where: {
      relationId: relation.id,
      projectId: relation.projectId,
      generationId: relation.generationId,
      invalidatedAt: null,
    },
    select: { id: true },
  });
  if (!evidence) notFound();
  const sourceAliases = await loadEntityAliases(
    db,
    relation.sourceEntity.id,
    relation.projectId,
  );
  const targetAliases = await loadEntityAliases(
    db,
    relation.targetEntity.id,
    relation.projectId,
  );
  return {
    ...relation,
    sourceEntity: { ...relation.sourceEntity, aliases: sourceAliases },
    targetEntity: { ...relation.targetEntity, aliases: targetAliases },
  };
}

async function loadPublicEntities(
  db: PrismaClient,
  projectId: string,
  entityIds: string[],
) {
  if (entityIds.length === 0) return [];
  const entities = await db.graphEntity.findMany({
    where: {
      id: { in: entityIds },
      projectId,
      project: { deletedAt: null },
      generation: { status: "active", projectId },
    },
    include: {
      project: { select: { name: true } },
      aliases: {
        where: { projectId },
        orderBy: [{ normalizedAlias: "asc" }, { id: "asc" }],
        take: MAX_ALIASES,
        select: { alias: true },
      },
    },
  });
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  return entityIds
    .map((entityId) => byId.get(entityId))
    .filter((entity): entity is NonNullable<typeof entity> => Boolean(entity))
    .map(publicEntity);
}

async function loadEntityAliases(
  db: PrismaClient,
  entityId: string,
  projectId: string,
) {
  return db.graphEntityAlias.findMany({
    where: { entityId, projectId },
    orderBy: [{ normalizedAlias: "asc" }, { id: "asc" }],
    take: MAX_ALIASES,
    select: { alias: true },
  });
}

function publicEntity(entity: EntityRecord) {
  return {
    entityId: entity.id,
    projectId: entity.projectId,
    projectName: entity.project.name,
    canonicalName: boundedText(entity.canonicalName, 200),
    aliases: entity.aliases
      .slice(0, MAX_ALIASES)
      .map((alias) => boundedText(alias.alias, 200)),
    entityType: boundedText(entity.entityType, 200),
    description:
      entity.description === null
        ? null
        : boundedText(entity.description, MAX_DESCRIPTION_LENGTH),
  };
}

function publicSearchEntity(row: SearchEntityRow) {
  return {
    entityId: row.entityId,
    projectId: row.projectId,
    projectName: row.projectName,
    canonicalName: boundedText(row.canonicalName, 200),
    aliases: row.aliases
      .slice(0, MAX_ALIASES)
      .map((alias) => boundedText(alias, 200)),
    entityType: boundedText(row.entityType, 200),
    description:
      row.description === null
        ? null
        : boundedText(row.description, MAX_DESCRIPTION_LENGTH),
  };
}

function publicMention(row: MentionCitationRow) {
  return {
    mentionId: row.mentionId,
    sourceCommitSha: row.sourceCommitSha,
    excerpt: boundedText(row.excerpt, MAX_EXCERPT_LENGTH),
    headingPath: boundedHeadingPath(row.headingPath),
    confidence: row.confidence,
    validFrom: row.validFrom,
    validTo: row.validTo,
    navigation: citationNavigation(row),
  };
}

function publicEvidence(row: EvidenceCitationRow) {
  return {
    evidenceId: row.evidenceId,
    sourceCommitSha: row.sourceCommitSha,
    excerpt: boundedText(row.excerpt, MAX_EXCERPT_LENGTH),
    headingPath: boundedHeadingPath(row.headingPath),
    confidence: row.confidence,
    validFrom: row.validFrom,
    validTo: row.validTo,
    navigation: citationNavigation(row),
  };
}

function citationNavigation(row: {
  navigationDocumentId: string | null;
  navigationTitle: string | null;
  navigationSlug: string | null;
  navigationPath: string | null;
  navigationAnchor: string | null;
}) {
  if (
    !row.navigationDocumentId ||
    !row.navigationTitle ||
    !row.navigationSlug ||
    !row.navigationPath
  ) {
    return null;
  }
  return {
    documentId: row.navigationDocumentId,
    title: boundedText(row.navigationTitle, 200),
    slug: row.navigationSlug,
    path: row.navigationPath,
    navigationAnchor: row.navigationAnchor,
  };
}

function boundedHeadingPath(value: string[]): string[] {
  return value
    .slice(0, MAX_HEADING_DEPTH)
    .map((heading) => boundedText(heading, MAX_HEADING_LENGTH));
}

function boundedText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : normalized.slice(0, maxLength).trimEnd();
}

function valueFilter(column: Prisma.Sql, values?: string[]): Prisma.Sql {
  if (!values || values.length === 0) return Prisma.sql``;
  return Prisma.sql`AND ${column} IN (${Prisma.join(
    values.map((value) => Prisma.sql`${value}`),
  )})`;
}

function parameterizedIds(ids: string[]): Prisma.Sql {
  return Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}

function notFound(): never {
  throw new CoreError("NOT_FOUND");
}

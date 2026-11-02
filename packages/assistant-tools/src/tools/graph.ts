import {
  getGraphEntityDetail,
  getGraphNeighborhood,
  searchGraphEntities,
} from "@weaver/core/services/graph";
import { z } from "zod";
import {
  boundItems,
  defineSharedReadTool,
  defineTool,
  newOutputBudget,
  requireScope,
  scopedProjectIds,
  utf8Bytes,
} from "../contract";

export const searchEntitiesTool = defineSharedReadTool({
  name: "search_entities",
  kind: "read",
  capability: "content:read",
  description:
    "Find knowledge-graph entities by name or alias within scope. If truncated is true, lower limit or narrow the query and search again.",
  inputSchema: z.object({
    query: z.string().trim().min(1).max(200),
    projectIds: z.array(z.uuid()).max(100).optional(),
    entityTypes: z.array(z.string()).max(20).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  async execute(input, ctx) {
    const projectIds = scopedProjectIds(ctx, input.projectIds);
    if (projectIds.length === 0)
      return { output: { entities: [], truncated: false } };
    const result = await searchGraphEntities(
      ctx.db,
      {
        query: input.query,
        projectIds,
        entityTypes: input.entityTypes,
        limit: input.limit,
      },
      ctx.actor,
    );
    // Entity descriptions/aliases (core-bounded per field, graph.ts:10-13)
    // can still add up past the transport budget across `limit` entities.
    const { items: entities, truncated: sizeTruncated } = boundItems(
      result.entities,
      newOutputBudget(),
    );
    return {
      output: { entities, truncated: result.truncated || sizeTruncated },
    };
  },
});

export const entityNeighborhoodTool = defineSharedReadTool({
  name: "entity_neighborhood",
  kind: "read",
  capability: "content:read",
  description:
    "Traverse relations around an entity (bounded nodes/edges) with provenance ids for entity_detail. If truncated is true, lower maxNodes/maxEdges and retry.",
  inputSchema: z.object({
    entityId: z.uuid(),
    relationTypes: z.array(z.string()).max(20).optional(),
    entityTypes: z.array(z.string()).max(20).optional(),
    maxNodes: z.number().int().min(1).max(50).default(25),
    maxEdges: z.number().int().min(1).max(100).default(50),
  }),
  async execute(input, ctx) {
    // getGraphEntityDetail returns { entity: publicEntity(...), mentions, truncated };
    // publicEntity carries projectId (graph.ts:621-636) — scope-check before traversing.
    const detail = await getGraphEntityDetail(
      ctx.db,
      { entityId: input.entityId },
      ctx.actor,
    );
    requireScope(ctx, detail.entity.projectId);
    const result = await getGraphNeighborhood(ctx.db, input, ctx.actor);
    // nodes carry the same core-bounded-but-not-transport-bounded entity
    // fields as search_entities; edges are small id rows, low risk, but
    // share the budget anyway for one consistent guarantee.
    const budget = newOutputBudget();
    const nodes = boundItems(result.nodes, budget);
    const edges = boundItems(result.edges, budget);
    return {
      output: {
        nodes: nodes.items,
        edges: edges.items,
        truncated: result.truncated || nodes.truncated || edges.truncated,
      },
      citations: [
        {
          kind: "graph",
          projectId: detail.entity.projectId,
          entityId: input.entityId,
          documentId: null,
          commitSha: null,
          excerpt: detail.entity.description?.slice(0, 500) ?? null,
        },
      ],
    };
  },
});

export const entityDetailTool = defineSharedReadTool({
  name: "entity_detail",
  kind: "read",
  capability: "content:read",
  description:
    "Get an entity with its aliases, description, and the document mentions (with commit shas) that support it. If truncated is true, some mentions were cut for size; use entity_neighborhood for a narrower slice.",
  inputSchema: z.object({ entityId: z.uuid() }),
  async execute(input, ctx) {
    const detail = await getGraphEntityDetail(
      ctx.db,
      { entityId: input.entityId },
      ctx.actor,
    );
    requireScope(ctx, detail.entity.projectId);
    // publicMention (graph.ts:655-666) exposes navigation.documentId, not a
    // top-level documentId; commitSha is sourceCommitSha directly.
    // The entity itself (description up to 4000 chars, up to 20 aliases at
    // 200 chars) is returned in full; mentions share what budget remains.
    const budget = newOutputBudget();
    budget.remaining -= utf8Bytes(JSON.stringify(detail.entity));
    const { items: mentions, truncated: sizeTruncated } = boundItems(
      detail.mentions,
      budget,
    );
    return {
      output: {
        entity: detail.entity,
        mentions,
        truncated: detail.truncated || sizeTruncated,
      },
      citations: mentions.slice(0, 5).map((mention) => ({
        kind: "graph" as const,
        projectId: detail.entity.projectId,
        entityId: input.entityId,
        documentId: mention.navigation?.documentId ?? null,
        commitSha: mention.sourceCommitSha,
        excerpt: mention.excerpt?.slice(0, 500) ?? null,
      })),
    };
  },
});

import { MAX_KNOWLEDGE_TYPE_CHARACTERS } from "@weaver/core/knowledge/extraction";
import { z } from "zod";

const graphTypeFilter = z
  .string()
  .trim()
  .min(1)
  .max(MAX_KNOWLEDGE_TYPE_CHARACTERS);
const graphTypeFilters = z.array(graphTypeFilter).max(20).optional();

export const searchGraphEntitiesInput = z.object({
  query: z.string().trim().min(2).max(200),
  projectIds: z.array(z.uuid()).max(50).optional(),
  entityTypes: graphTypeFilters,
  limit: z.number().int().min(1).max(20).default(20),
});

export const graphFromDocumentInput = z.object({
  projectId: z.uuid(),
  documentId: z.uuid(),
  entityTypes: graphTypeFilters,
  limit: z.number().int().min(1).max(20).default(20),
});

export const graphNeighborhoodInput = z.object({
  entityId: z.uuid(),
  entityTypes: graphTypeFilters,
  relationTypes: graphTypeFilters,
  maxNodes: z.number().int().min(1).max(100).default(50),
  maxEdges: z.number().int().min(1).max(200).default(100),
});

export const graphEntityDetailInput = z.object({
  entityId: z.uuid(),
});

export const graphRelationDetailInput = z.object({
  relationId: z.uuid(),
});

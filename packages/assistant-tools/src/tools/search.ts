import { searchKnowledge } from "@weaver/core/services/search";
import { z } from "zod";
import {
  boundItems,
  defineSharedReadTool,
  newOutputBudget,
  scopedProjectIds,
  type ToolOutcome,
} from "../contract";

type SearchKnowledgeOutput = {
  mode: "hybrid" | "keyword";
  partial: Array<"semantic_unavailable">;
  truncated: boolean;
  documents: Array<{
    documentId: string;
    projectId: string;
    title: string;
    headingPath: string[];
    snippet: string;
    commitSha: string;
    score: number;
  }>;
  tables: Array<{
    tableId: string;
    projectId: string;
    title: string;
    matchingColumns: string[];
    commitSha: string;
    score: number;
  }>;
  entities: Array<{
    entityId: string;
    projectId: string;
    name: string;
    type: string;
    description: string | null;
    score: number;
  }>;
};

export const searchKnowledgeTool = defineSharedReadTool({
  name: "search_knowledge",
  kind: "read",
  capability: "content:read",
  description:
    "Hybrid keyword + semantic search across documents, tables (titles/columns), and graph entities within scope. Results carry commit shas for citations. If truncated is true, narrow the query or lower limitPerGroup and search again.",
  inputSchema: z.object({
    query: z.string().trim().min(1).max(500),
    projectIds: z.array(z.uuid()).max(100).optional(),
    limitPerGroup: z.number().int().min(1).max(20).default(10),
  }),
  async execute(input, ctx): Promise<ToolOutcome<SearchKnowledgeOutput>> {
    const projectIds = scopedProjectIds(ctx, input.projectIds);
    if (projectIds.length === 0)
      return {
        output: {
          mode: "keyword",
          documents: [],
          tables: [],
          entities: [],
          partial: [],
          truncated: false,
        },
      };
    const result = await searchKnowledge(
      ctx.db,
      { query: input.query, projectIds, limitPerGroup: input.limitPerGroup },
      ctx.actor,
    );
    const mappedDocuments = result.documents.map((d) => ({
      documentId: d.documentId,
      projectId: d.projectId,
      title: d.title,
      headingPath: d.headingPath,
      snippet: d.snippet,
      commitSha: d.sourceCommitSha,
      score: d.score,
    }));
    const mappedTables = result.tables.map((t) => ({
      tableId: t.tableId,
      projectId: t.projectId,
      title: t.title,
      matchingColumns: t.matchingColumns,
      commitSha: t.sourceCommitSha,
      score: t.score,
    }));
    const mappedEntities = result.entities.map((e) => ({
      entityId: e.entityId,
      projectId: e.projectId,
      name: e.canonicalName,
      type: e.entityType,
      description: e.description,
      score: e.score,
    }));
    // One shared budget across the three groups, so a heavy documents match
    // can't leave zero room for tables/entities without at least being cut
    // off before it, in the same order the model reads the output.
    const budget = newOutputBudget();
    const documents = boundItems(mappedDocuments, budget);
    const tables = boundItems(mappedTables, budget);
    const entities = boundItems(mappedEntities, budget);
    const truncated =
      documents.truncated || tables.truncated || entities.truncated;
    // Only cite groups the model actually saw in the (possibly truncated) output.
    const keptDocumentIds = new Set(documents.items.map((d) => d.documentId));
    const keptTableIds = new Set(tables.items.map((t) => t.tableId));
    return {
      output: {
        mode: result.mode,
        partial: result.partial,
        truncated,
        documents: documents.items,
        tables: tables.items,
        entities: entities.items,
      },
      citations: [
        ...result.documents
          .filter((d) => keptDocumentIds.has(d.documentId))
          .map((d) => ({
            kind: "search" as const,
            projectId: d.projectId,
            resourceType: "document" as const,
            resourceId: d.documentId,
            commitSha: d.sourceCommitSha,
            excerpt: d.snippet.slice(0, 500),
            score: d.score,
          })),
        ...result.tables
          .filter((t) => keptTableIds.has(t.tableId))
          .map((t) => ({
            kind: "search" as const,
            projectId: t.projectId,
            resourceType: "table" as const,
            resourceId: t.tableId,
            commitSha: t.sourceCommitSha,
            excerpt: null,
            score: t.score,
          })),
      ],
    };
  },
});

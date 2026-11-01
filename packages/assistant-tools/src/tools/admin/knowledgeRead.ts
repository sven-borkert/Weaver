import { z } from "zod";
import { encodePageCursor } from "@weaver/core/services/adminPaging";
import { getKnowledgeStatus } from "@weaver/core/services/knowledge";
import {
  listGenerationDocuments,
  listKnowledgeGenerations,
  type KnowledgeGenerationDocumentRow,
  type KnowledgeGenerationRow,
} from "@weaver/core/services/knowledgeInspection";
import {
  MAX_TOOL_OUTPUT_CHARS,
  ToolError,
  defineTool,
  requireScope,
  utf8Bytes,
} from "../../contract";
import { listInput, pagedOutput } from "./paging";

const generationStatuses = [
  "building",
  "active",
  "failed",
  "superseded",
] as const;
const documentStatuses = [
  "pending",
  "processing",
  "ready",
  "failed",
  "blocked_configuration",
  "missing",
] as const;

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function generationOutput(item: KnowledgeGenerationRow) {
  return {
    ...item,
    createdAt: item.createdAt.toISOString(),
    completedAt: iso(item.completedAt),
    activatedAt: iso(item.activatedAt),
    supersededAt: iso(item.supersededAt),
  };
}

function documentOutput(item: KnowledgeGenerationDocumentRow) {
  return {
    ...item,
    lastAttemptAt: iso(item.lastAttemptAt),
    completedAt: iso(item.completedAt),
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

export const listKnowledgeGenerationsTool = defineTool({
  name: "list_knowledge_generations",
  description:
    "Knowledge generations for one project, including stale building generations and safe route metadata.",
  kind: "read",
  capability: "system:admin",
  inputSchema: z.object({
    projectId: z.uuid(),
    status: z.enum(generationStatuses).optional(),
    ...listInput,
  }),
  async execute(input, ctx) {
    requireScope(ctx, input.projectId);
    const page = await listKnowledgeGenerations(ctx.db, ctx.actor, input);
    return {
      output: pagedOutput(
        { ...page, items: page.items.map(generationOutput) },
        (item) => encodePageCursor([item.createdAt, item.id]),
      ),
    };
  },
});

export const listGenerationDocumentsTool = defineTool({
  name: "list_generation_documents",
  description:
    "Document indexing states for one knowledge generation, with safe failure metadata and timestamps.",
  kind: "read",
  capability: "system:admin",
  inputSchema: z.object({
    projectId: z.uuid(),
    generationId: z.uuid(),
    status: z.enum(documentStatuses).optional(),
    ...listInput,
  }),
  async execute(input, ctx) {
    requireScope(ctx, input.projectId);
    const page = await listGenerationDocuments(ctx.db, ctx.actor, input);
    return {
      output: pagedOutput(
        { ...page, items: page.items.map(documentOutput) },
        (item) => encodePageCursor([item.documentId]),
      ),
    };
  },
});

export const getKnowledgeStatusTool = defineTool({
  name: "get_knowledge_status",
  description:
    "Knowledge readiness, current generations, queue counts, and recent safe failures for one project.",
  kind: "read",
  capability: "system:admin",
  inputSchema: z.object({ projectId: z.uuid() }),
  async execute(input, ctx) {
    requireScope(ctx, input.projectId);
    const status = await getKnowledgeStatus(
      ctx.db,
      { projectId: input.projectId },
      ctx.actor,
    );
    const output = {
      ...status,
      failures: [...status.failures],
      truncated: false,
    };
    while (
      utf8Bytes(JSON.stringify(output)) > MAX_TOOL_OUTPUT_CHARS &&
      output.failures.length
    ) {
      output.failures.pop();
      output.truncated = true;
    }
    if (utf8Bytes(JSON.stringify(output)) > MAX_TOOL_OUTPUT_CHARS) {
      throw new ToolError(
        "INTERNAL",
        "knowledge status exceeds tool output limit",
      );
    }
    return { output };
  },
});

export const KNOWLEDGE_READ_ADMIN_TOOLS = [
  listKnowledgeGenerationsTool,
  listGenerationDocumentsTool,
  getKnowledgeStatusTool,
] as const;

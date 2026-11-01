import { z } from "zod";
import { enqueueKnowledgeReconciliation } from "@weaver/core/services/adminKnowledgeReconciliation";
import {
  requestKnowledgeRebuild,
  retryFailedKnowledge,
} from "@weaver/core/services/knowledge";
import { defineTool, requireScope } from "../../contract";

export const rebuildKnowledgeIndexTool = defineTool({
  name: "rebuild_knowledge_index",
  description:
    "Start a fresh shadow generation for a project you maintain; the previous active generation stays queryable until the new one activates.",
  kind: "write",
  capability: "system:admin",
  inputSchema: z.object({ projectId: z.uuid() }),
  async execute(input, ctx) {
    requireScope(ctx, input.projectId);
    return {
      output: await requestKnowledgeRebuild(
        ctx.db,
        { projectId: input.projectId },
        ctx.actor,
      ),
    };
  },
});

export const retryFailedKnowledgeTool = defineTool({
  name: "retry_failed_knowledge",
  description:
    "Re-queue one page of failed or configuration-blocked documents of a project you maintain; pass the returned cursor to continue.",
  kind: "write",
  capability: "system:admin",
  inputSchema: z.object({
    projectId: z.uuid(),
    cursor: z
      .object({ generationId: z.uuid(), documentId: z.uuid() })
      .optional(),
  }),
  async execute(input, ctx) {
    requireScope(ctx, input.projectId);
    return { output: await retryFailedKnowledge(ctx.db, input, ctx.actor) };
  },
});

export const enqueueReconcileTool = defineTool({
  name: "enqueue_reconcile",
  description:
    "Enqueue project.reconcile for one project you maintain, or system.reconcile for every project when projectId is omitted.",
  kind: "write",
  capability: "system:admin",
  inputSchema: z.object({ projectId: z.uuid().optional() }),
  async execute(input, ctx) {
    if (input.projectId) requireScope(ctx, input.projectId);
    return {
      output: await enqueueKnowledgeReconciliation(ctx.db, input, ctx.actor),
    };
  },
});

export const KNOWLEDGE_WRITE_ADMIN_TOOLS = [
  rebuildKnowledgeIndexTool,
  retryFailedKnowledgeTool,
  enqueueReconcileTool,
] as const;

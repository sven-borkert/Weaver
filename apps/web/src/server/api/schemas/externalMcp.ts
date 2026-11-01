import { scopeRequestSchema } from "@weaver/core/assistant/scopeSchema";
import {
  connectionCreateSchema,
  connectionUpdateSchema,
  toolBulkReviewSchema,
  toolFilterSchema,
} from "@weaver/core/externalMcp/schema";
import { z } from "zod";

export const externalConnectionIdInput = z.object({ id: z.uuid() });
export const externalConnectionListInput = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(25),
  search: z.string().max(120).optional(),
});
export const createExternalConnectionInput = connectionCreateSchema;
export const updateExternalConnectionInput = z.object({
  id: z.uuid(),
  expectedRevision: z.number().int().positive(),
  patch: connectionUpdateSchema,
});
export const revisionExternalConnectionInput = z.object({
  id: z.uuid(),
  expectedRevision: z.number().int().positive(),
});
export const externalToolsInput = toolFilterSchema.extend({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(25),
});
export const externalToolKeysInput = toolFilterSchema;
export const reviewExternalToolsInput = toolBulkReviewSchema;
export const externalAvailabilityInput = z.object({
  scope: scopeRequestSchema,
  conversationId: z.uuid().optional(),
});
export const externalApprovalListInput = z.object({ runId: z.uuid() });
export const externalApprovalInput = z.object({ id: z.uuid() });
export const externalApprovalDecisionInput = z.object({
  id: z.uuid(),
  decision: z.enum(["approve", "deny"]),
});

export const externalCallListInput = z.object({
  runId: z.uuid(),
  after: z.uuid().optional(),
});

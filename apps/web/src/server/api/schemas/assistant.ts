import { z } from "zod";
import { scopeRequestSchema } from "@weaver/core/assistant/scope";

export const conversationIdInput = z.object({ conversationId: z.uuid() });
export const getConversationInput = conversationIdInput.extend({
  beforePosition: z.number().int().min(0).max(2_147_483_647).optional(),
});
export const runIdInput = z.object({ runId: z.uuid() });
export const proposalIdInput = z.object({ proposalId: z.uuid() });
export const listConversationsInput = z.object({
  cursor: z.uuid().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export const createConversationInput = z.object({
  title: z.string().max(200).optional(),
  pinnedProjectId: z.uuid().nullish(),
});
// 400 chars at the transport so the service's 200-char BAD_REQUEST (with
// details.field = "title") is what the form sees, not a Zod shape error.
export const renameConversationInput = conversationIdInput.extend({
  title: z.string().max(400),
});
export const pinConversationInput = conversationIdInput.extend({
  projectId: z.uuid().nullable(),
});
export const setAutoApproveChangesInput = conversationIdInput.extend({
  enabled: z.boolean(),
});
export const sendMessageInput = conversationIdInput.extend({
  text: z.string().min(1).max(32_000),
  scope: scopeRequestSchema,
});
export const runEventsInput = runIdInput.extend({
  after: z.number().int().min(-1).max(2_147_483_647),
  limit: z.number().int().min(1).max(500).optional(),
});

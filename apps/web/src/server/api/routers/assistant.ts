import { z } from "zod";
import { authedProcedure, createTRPCRouter } from "~/server/api/trpc";
import {
  conversationIdInput,
  getConversationInput,
  createConversationInput,
  listConversationsInput,
  pinConversationInput,
  proposalIdInput,
  renameConversationInput,
  runEventsInput,
  runIdInput,
  sendMessageInput,
  setAutoApproveChangesInput,
} from "~/server/api/schemas/assistant";
import { parseKnowledgeConfig } from "@weaver/core/knowledge/config";
import * as citations from "@weaver/core/services/assistantCitations";
import * as conversations from "@weaver/core/services/assistantConversations";
import * as proposals from "@weaver/core/services/assistantProposals";
import * as runs from "@weaver/core/services/assistantRuns";
import { getConversationUsage } from "@weaver/core/services/assistantUsage";
import { listContentFolders } from "@weaver/core/services/folders";
import { resolveLlmRoute } from "@weaver/core/services/llmRoutes";
import type { UserSecurityContext } from "@weaver/core/security/context";

const actorOf = (ctx: {
  security: UserSecurityContext;
  session: { user: { email?: string | null; name?: string | null } };
}) => ({
  ...ctx.security,
  name: ctx.session.user.name ?? null,
  email: ctx.session.user.email ?? "unknown@local",
});

export const assistantRouter = createTRPCRouter({
  availability: authedProcedure.query(async ({ ctx }) => {
    conversations.assertAssistantUse(ctx.security);
    if (!parseKnowledgeConfig(process.env).jobsEnabled)
      return { ready: false as const, reason: "jobs_disabled" as const };
    const route = await resolveLlmRoute(ctx.db, "assistant");
    // `ready` needs its own `as const` (not just `reason`'s) or the three
    // branches' inferred return types merge into one `{ ready: boolean,
    // reason: "jobs_disabled" | "no_route" | "ready" }` shape instead of a
    // discriminated union, and callers narrowing on `!data.ready` can't
    // narrow `reason` away from "ready".
    return route
      ? { ready: true as const, reason: "ready" as const }
      : { ready: false as const, reason: "no_route" as const };
  }),
  listConversations: authedProcedure
    .input(listConversationsInput)
    .query(({ ctx, input }) =>
      conversations.listConversations(ctx.db, ctx.security, input),
    ),
  getConversationStatus: authedProcedure
    .input(conversationIdInput)
    .query(({ ctx, input }) =>
      conversations.getConversationStatus(
        ctx.db,
        ctx.security,
        input.conversationId,
      ),
    ),
  getConversationUsage: authedProcedure
    .input(conversationIdInput)
    .query(({ ctx, input }) =>
      getConversationUsage(ctx.db, ctx.security, input.conversationId),
    ),
  listScopeFolders: authedProcedure
    .input(z.object({ projectId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const listing = await listContentFolders(ctx.db, input, ctx.security);
      return listing.folders;
    }),
  getConversation: authedProcedure
    .input(getConversationInput)
    .query(({ ctx, input }) =>
      conversations.getConversation(
        ctx.db,
        ctx.security,
        input.conversationId,
        input.beforePosition,
      ),
    ),
  createConversation: authedProcedure
    .input(createConversationInput)
    .mutation(({ ctx, input }) =>
      conversations.createConversation(ctx.db, ctx.security, input),
    ),
  renameConversation: authedProcedure
    .input(renameConversationInput)
    .mutation(({ ctx, input }) =>
      conversations.renameConversation(ctx.db, ctx.security, input),
    ),
  pinConversation: authedProcedure
    .input(pinConversationInput)
    .mutation(({ ctx, input }) =>
      conversations.pinConversation(ctx.db, ctx.security, input),
    ),
  setAutoApproveChanges: authedProcedure
    .input(setAutoApproveChangesInput)
    .mutation(({ ctx, input }) =>
      conversations.setAutoApproveChanges(ctx.db, ctx.security, input),
    ),
  deleteConversation: authedProcedure
    .input(conversationIdInput)
    .mutation(({ ctx, input }) =>
      conversations.deleteConversation(
        ctx.db,
        ctx.security,
        input.conversationId,
      ),
    ),
  sendMessage: authedProcedure
    .input(sendMessageInput)
    .mutation(({ ctx, input }) =>
      runs.submitUserMessage(ctx.db, ctx.security, input),
    ),
  cancelRun: authedProcedure
    .input(runIdInput)
    .mutation(({ ctx, input }) =>
      runs.requestRunCancel(ctx.db, ctx.security, input.runId),
    ),
  getRun: authedProcedure
    .input(runIdInput)
    .query(({ ctx, input }) => runs.getRun(ctx.db, ctx.security, input.runId)),
  runEvents: authedProcedure
    .input(runEventsInput)
    .query(({ ctx, input }) => runs.listRunEvents(ctx.db, ctx.security, input)),
  listProposals: authedProcedure
    .input(conversationIdInput)
    .query(({ ctx, input }) =>
      proposals.listProposals(ctx.db, ctx.security, {
        ...input,
        includePreview: false,
      }),
    ),
  getProposal: authedProcedure
    .input(proposalIdInput)
    .query(({ ctx, input }) =>
      proposals.getProposal(ctx.db, ctx.security, input.proposalId),
    ),
  listCitations: authedProcedure
    .input(conversationIdInput.extend({ messageId: z.uuid().optional() }))
    .query(({ ctx, input }) =>
      citations.listCitations(ctx.db, ctx.security, input),
    ),
  acceptProposal: authedProcedure
    .input(proposalIdInput)
    .mutation(({ ctx, input }) =>
      proposals.acceptProposal(ctx.db, actorOf(ctx), input.proposalId),
    ),
  rejectProposal: authedProcedure
    .input(proposalIdInput)
    .mutation(({ ctx, input }) =>
      proposals.rejectProposal(ctx.db, ctx.security, input.proposalId),
    ),
});

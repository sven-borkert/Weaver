ALTER TABLE "ExternalMcpConnection" ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX "AssistantProposal_runId_idx" ON "AssistantProposal"("runId");
CREATE INDEX "AssistantProposal_userId_idx" ON "AssistantProposal"("userId");
CREATE INDEX "AssistantRunEvent_attemptId_idx" ON "AssistantRunEvent"("attemptId");
CREATE INDEX "Invitation_inviterId_idx" ON "Invitation"("inviterId");
CREATE INDEX "LlmRoute_updatedById_idx" ON "LlmRoute"("updatedById");
CREATE INDEX "ProjectContentPin_createdById_idx" ON "ProjectContentPin"("createdById");

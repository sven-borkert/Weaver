-- Phase 4D: assistant conversations, runs, attempts, events, citations, proposals (spec §11, §14, §15).

CREATE TYPE "AssistantMessageRole" AS ENUM ('user', 'assistant');
CREATE TYPE "AssistantMessageStatus" AS ENUM ('pending', 'complete', 'failed', 'cancelled');
CREATE TYPE "AssistantRunStatus" AS ENUM ('queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled');
CREATE TYPE "AssistantAttemptStatus" AS ENUM ('running', 'succeeded', 'failed', 'abandoned', 'cancelled');
CREATE TYPE "AssistantCitationKind" AS ENUM ('document', 'table', 'graph', 'search');
CREATE TYPE "AssistantProposalStatus" AS ENUM ('pending', 'accepted', 'rejected', 'conflicted', 'expired');

CREATE TABLE "AssistantConversation" (
  "id" UUID NOT NULL,
  "ownerId" UUID NOT NULL,
  "title" VARCHAR(200) NOT NULL,
  "pinnedProjectId" UUID,
  "lastMessageAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AssistantConversation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AssistantConversation_ownerId_updatedAt_idx" ON "AssistantConversation"("ownerId", "updatedAt");
CREATE INDEX "AssistantConversation_pinnedProjectId_idx" ON "AssistantConversation"("pinnedProjectId");
ALTER TABLE "AssistantConversation" ADD CONSTRAINT "AssistantConversation_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssistantConversation" ADD CONSTRAINT "AssistantConversation_pinnedProjectId_fkey" FOREIGN KEY ("pinnedProjectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "AssistantMessage" (
  "id" UUID NOT NULL,
  "conversationId" UUID NOT NULL,
  "position" INTEGER NOT NULL,
  "role" "AssistantMessageRole" NOT NULL,
  "status" "AssistantMessageStatus" NOT NULL DEFAULT 'complete',
  "content" JSONB NOT NULL,
  "scopeSnapshot" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantMessage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AssistantMessage_conversationId_position_key" ON "AssistantMessage"("conversationId", "position");
ALTER TABLE "AssistantMessage" ADD CONSTRAINT "AssistantMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AssistantConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AssistantRun" (
  "id" UUID NOT NULL,
  "conversationId" UUID NOT NULL,
  "userMessageId" UUID NOT NULL,
  "assistantMessageId" UUID,
  "status" "AssistantRunStatus" NOT NULL DEFAULT 'queued',
  "scopeSnapshot" JSONB NOT NULL,
  "actorSnapshot" JSONB NOT NULL,
  "routeSnapshot" JSONB,
  "nextSequence" INTEGER NOT NULL DEFAULT 0,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  "jobId" TEXT,
  "errorCode" VARCHAR(40),
  "errorMessage" VARCHAR(300),
  "cancelRequestedAt" TIMESTAMP(3),
  "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "AssistantRun_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AssistantRun_userMessageId_key" ON "AssistantRun"("userMessageId");
CREATE UNIQUE INDEX "AssistantRun_assistantMessageId_key" ON "AssistantRun"("assistantMessageId");
CREATE INDEX "AssistantRun_conversationId_queuedAt_idx" ON "AssistantRun"("conversationId", "queuedAt");
CREATE INDEX "AssistantRun_status_queuedAt_idx" ON "AssistantRun"("status", "queuedAt");
ALTER TABLE "AssistantRun" ADD CONSTRAINT "AssistantRun_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AssistantConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssistantRun" ADD CONSTRAINT "AssistantRun_userMessageId_fkey" FOREIGN KEY ("userMessageId") REFERENCES "AssistantMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssistantRun" ADD CONSTRAINT "AssistantRun_assistantMessageId_fkey" FOREIGN KEY ("assistantMessageId") REFERENCES "AssistantMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "AssistantRunAttempt" (
  "id" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "number" INTEGER NOT NULL,
  "workerId" VARCHAR(200) NOT NULL,
  "status" "AssistantAttemptStatus" NOT NULL DEFAULT 'running',
  "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt" TIMESTAMP(3),
  "failureCode" VARCHAR(40),
  "failureSummary" VARCHAR(300),
  CONSTRAINT "AssistantRunAttempt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AssistantRunAttempt_runId_number_key" ON "AssistantRunAttempt"("runId", "number");
CREATE INDEX "AssistantRunAttempt_status_leaseExpiresAt_idx" ON "AssistantRunAttempt"("status", "leaseExpiresAt");
ALTER TABLE "AssistantRunAttempt" ADD CONSTRAINT "AssistantRunAttempt_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AssistantRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AssistantRunEvent" (
  "id" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "attemptId" UUID,
  "sequence" INTEGER NOT NULL,
  "type" VARCHAR(40) NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantRunEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AssistantRunEvent_runId_sequence_key" ON "AssistantRunEvent"("runId", "sequence");
ALTER TABLE "AssistantRunEvent" ADD CONSTRAINT "AssistantRunEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AssistantRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssistantRunEvent" ADD CONSTRAINT "AssistantRunEvent_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "AssistantRunAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "AssistantCitation" (
  "id" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "messageId" UUID,
  "kind" "AssistantCitationKind" NOT NULL,
  "projectId" UUID NOT NULL,
  "resourceId" UUID NOT NULL,
  "commitSha" TEXT,
  "locator" JSONB NOT NULL,
  "label" VARCHAR(300) NOT NULL,
  "excerpt" VARCHAR(500),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantCitation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AssistantCitation_messageId_idx" ON "AssistantCitation"("messageId");
CREATE INDEX "AssistantCitation_runId_idx" ON "AssistantCitation"("runId");
ALTER TABLE "AssistantCitation" ADD CONSTRAINT "AssistantCitation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AssistantRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssistantCitation" ADD CONSTRAINT "AssistantCitation_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "AssistantMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "AssistantProposal" (
  "id" UUID NOT NULL,
  "conversationId" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "kind" VARCHAR(40) NOT NULL,
  "resourceId" UUID,
  "baseCommitSha" TEXT,
  "summary" VARCHAR(500) NOT NULL,
  "operation" JSONB NOT NULL,
  "preview" JSONB NOT NULL,
  "status" "AssistantProposalStatus" NOT NULL DEFAULT 'pending',
  "resolution" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "AssistantProposal_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AssistantProposal_conversationId_createdAt_idx" ON "AssistantProposal"("conversationId", "createdAt");
CREATE INDEX "AssistantProposal_status_expiresAt_idx" ON "AssistantProposal"("status", "expiresAt");
CREATE INDEX "AssistantProposal_projectId_idx" ON "AssistantProposal"("projectId");
ALTER TABLE "AssistantProposal" ADD CONSTRAINT "AssistantProposal_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AssistantConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssistantProposal" ADD CONSTRAINT "AssistantProposal_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AssistantRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssistantProposal" ADD CONSTRAINT "AssistantProposal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssistantProposal" ADD CONSTRAINT "AssistantProposal_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TYPE "ExternalMcpAuthMode" AS ENUM ('none', 'bearer');
CREATE TYPE "ExternalMcpApprovalPolicy" AS ENUM ('require_approval', 'automatic');
CREATE TYPE "ExternalMcpToolEffect" AS ENUM ('read', 'write');
CREATE TYPE "ExternalMcpCallStatus" AS ENUM ('prepared', 'dispatched', 'completed', 'denied', 'failed', 'unknown');
CREATE TYPE "ExternalMcpApprovalState" AS ENUM ('pending', 'approved', 'denied', 'expired', 'invalidated');

CREATE TABLE "ExternalMcpConnection" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "endpoint" VARCHAR(2048) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "authMode" "ExternalMcpAuthMode" NOT NULL DEFAULT 'none',
    "credentialCiphertext" TEXT,
    "credentialKeyVersion" INTEGER,
    "credentialIv" TEXT,
    "credentialTag" TEXT,
    "approvalPolicy" "ExternalMcpApprovalPolicy" NOT NULL DEFAULT 'require_approval',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "timeoutMs" INTEGER NOT NULL DEFAULT 30000,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastDiscoveredAt" TIMESTAMP(3),
    "discoveryProtocol" VARCHAR(40),
    "discoveryServerName" VARCHAR(200),
    "discoveryToolCount" INTEGER,
    "discoveryResourceCount" INTEGER,
    "discoveryErrorCode" VARCHAR(40),
    "discoveryErrorSummary" VARCHAR(300),
    CONSTRAINT "ExternalMcpConnection_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ExternalMcpConnection_credentials_check" CHECK (
      ("authMode" = 'none' AND "credentialCiphertext" IS NULL AND "credentialKeyVersion" IS NULL AND "credentialIv" IS NULL AND "credentialTag" IS NULL)
      OR ("authMode" = 'bearer' AND "credentialCiphertext" IS NOT NULL AND "credentialKeyVersion" IS NOT NULL AND "credentialIv" IS NOT NULL AND "credentialTag" IS NOT NULL)
    ),
    CONSTRAINT "ExternalMcpConnection_timeout_check" CHECK ("timeoutMs" BETWEEN 5000 AND 120000),
    CONSTRAINT "ExternalMcpConnection_revision_check" CHECK ("revision" >= 1)
);

CREATE TABLE "ExternalMcpTool" (
    "id" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "remoteName" VARCHAR(300) NOT NULL,
    "discoveredDefinition" JSONB NOT NULL,
    "discoveredRemoteDigest" CHAR(64) NOT NULL,
    "reviewedDefinition" JSONB,
    "reviewedRemoteDigest" CHAR(64),
    "reviewDigest" CHAR(64),
    "effect" "ExternalMcpToolEffect",
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMP(3),
    "discoveredAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ExternalMcpTool_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ExternalMcpTool_review_check" CHECK (
      ("reviewedDefinition" IS NULL AND "reviewedRemoteDigest" IS NULL AND "reviewDigest" IS NULL AND "effect" IS NULL AND "reviewedAt" IS NULL AND "enabled" = false)
      OR ("reviewedDefinition" IS NOT NULL AND "reviewedRemoteDigest" IS NOT NULL AND "reviewDigest" IS NOT NULL AND "effect" IS NOT NULL AND "reviewedAt" IS NOT NULL)
    )
);

CREATE TABLE "ExternalMcpProjectGrant" (
    "id" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ExternalMcpProjectGrant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ScheduledTaskExternalInput" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "toolId" UUID NOT NULL,
    "argumentBindings" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ScheduledTaskExternalInput_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ScheduledTaskExternalInput_position_check" CHECK ("position" >= 0)
);

CREATE TABLE "ExternalMcpCall" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "connectionId" UUID,
    "toolId" UUID,
    "assistantRunId" UUID,
    "attemptId" UUID,
    "toolCallId" VARCHAR(200),
    "taskRunId" UUID,
    "inputId" UUID,
    "status" "ExternalMcpCallStatus" NOT NULL DEFAULT 'prepared',
    "userSnapshotId" UUID NOT NULL,
    "userSnapshotName" VARCHAR(200) NOT NULL,
    "connectionSnapshotId" UUID NOT NULL,
    "connectionSnapshotName" VARCHAR(120) NOT NULL,
    "toolSnapshotId" UUID NOT NULL,
    "toolSnapshotName" VARCHAR(300) NOT NULL,
    "remoteDigest" CHAR(64) NOT NULL,
    "reviewDigest" CHAR(64) NOT NULL,
    "configRevision" INTEGER NOT NULL,
    "approvalPolicy" "ExternalMcpApprovalPolicy" NOT NULL,
    "effect" "ExternalMcpToolEffect" NOT NULL,
    "argsDigest" CHAR(64) NOT NULL,
    "scopeSnapshot" JSONB NOT NULL,
    "correlationId" VARCHAR(200),
    "preparedAt" TIMESTAMP(3) NOT NULL,
    "dispatchedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "requestBytes" INTEGER,
    "responseBytes" INTEGER,
    "errorCode" VARCHAR(40),
    "errorSummary" VARCHAR(300),
    "retainedUntil" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ExternalMcpCall_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ExternalMcpCall_owner_shape_check" CHECK (
      ("assistantRunId" IS NOT NULL AND "attemptId" IS NOT NULL AND "toolCallId" IS NOT NULL AND "taskRunId" IS NULL AND "inputId" IS NULL)
      OR ("assistantRunId" IS NULL AND "attemptId" IS NULL AND "toolCallId" IS NULL AND "taskRunId" IS NOT NULL AND "inputId" IS NOT NULL)
    )
);

CREATE TABLE "ExternalMcpToolApproval" (
    "id" UUID NOT NULL,
    "callId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "connectionId" UUID,
    "toolId" UUID,
    "toolCallId" VARCHAR(200) NOT NULL,
    "scopeSnapshot" JSONB NOT NULL,
    "configRevision" INTEGER NOT NULL,
    "reviewDigest" CHAR(64) NOT NULL,
    "argsDigest" CHAR(64) NOT NULL,
    "pendingArgumentsCiphertext" TEXT,
    "pendingArgumentsKeyVersion" INTEGER,
    "pendingArgumentsIv" TEXT,
    "pendingArgumentsTag" TEXT,
    "state" "ExternalMcpApprovalState" NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "decidedById" UUID,
    "decidedAt" TIMESTAMP(3),
    "retainedUntil" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ExternalMcpToolApproval_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ExternalMcpToolApproval_pending_arguments_check" CHECK (
      ("state" = 'pending' AND "pendingArgumentsCiphertext" IS NOT NULL AND "pendingArgumentsKeyVersion" IS NOT NULL AND "pendingArgumentsIv" IS NOT NULL AND "pendingArgumentsTag" IS NOT NULL)
      OR ("state" <> 'pending' AND "pendingArgumentsCiphertext" IS NULL AND "pendingArgumentsKeyVersion" IS NULL AND "pendingArgumentsIv" IS NULL AND "pendingArgumentsTag" IS NULL)
    )
);

CREATE UNIQUE INDEX "ExternalMcpConnection_name_key" ON "ExternalMcpConnection"("name");
CREATE INDEX "ExternalMcpConnection_createdById_idx" ON "ExternalMcpConnection"("createdById");
CREATE INDEX "ExternalMcpConnection_enabled_idx" ON "ExternalMcpConnection"("enabled");
CREATE UNIQUE INDEX "ExternalMcpTool_connectionId_remoteName_key" ON "ExternalMcpTool"("connectionId", "remoteName");
CREATE INDEX "ExternalMcpTool_reviewedById_idx" ON "ExternalMcpTool"("reviewedById");
CREATE INDEX "ExternalMcpTool_connectionId_enabled_idx" ON "ExternalMcpTool"("connectionId", "enabled");
CREATE UNIQUE INDEX "ExternalMcpProjectGrant_connectionId_projectId_key" ON "ExternalMcpProjectGrant"("connectionId", "projectId");
CREATE INDEX "ExternalMcpProjectGrant_projectId_idx" ON "ExternalMcpProjectGrant"("projectId");
CREATE INDEX "ExternalMcpProjectGrant_createdById_idx" ON "ExternalMcpProjectGrant"("createdById");
CREATE UNIQUE INDEX "ScheduledTaskExternalInput_taskId_position_key" ON "ScheduledTaskExternalInput"("taskId", "position");
CREATE UNIQUE INDEX "ScheduledTaskExternalInput_taskId_name_key" ON "ScheduledTaskExternalInput"("taskId", "name");
CREATE INDEX "ScheduledTaskExternalInput_toolId_idx" ON "ScheduledTaskExternalInput"("toolId");
CREATE UNIQUE INDEX "ExternalMcpCall_attemptId_toolCallId_key" ON "ExternalMcpCall"("attemptId", "toolCallId");
CREATE UNIQUE INDEX "ExternalMcpCall_taskRunId_inputId_key" ON "ExternalMcpCall"("taskRunId", "inputId");
CREATE INDEX "ExternalMcpCall_userId_idx" ON "ExternalMcpCall"("userId");
CREATE INDEX "ExternalMcpCall_connectionId_idx" ON "ExternalMcpCall"("connectionId");
CREATE INDEX "ExternalMcpCall_toolId_idx" ON "ExternalMcpCall"("toolId");
CREATE INDEX "ExternalMcpCall_assistantRunId_idx" ON "ExternalMcpCall"("assistantRunId");
CREATE INDEX "ExternalMcpCall_attemptId_idx" ON "ExternalMcpCall"("attemptId");
CREATE INDEX "ExternalMcpCall_taskRunId_idx" ON "ExternalMcpCall"("taskRunId");
CREATE INDEX "ExternalMcpCall_inputId_idx" ON "ExternalMcpCall"("inputId");
CREATE INDEX "ExternalMcpCall_status_preparedAt_idx" ON "ExternalMcpCall"("status", "preparedAt");
CREATE INDEX "ExternalMcpCall_retainedUntil_idx" ON "ExternalMcpCall"("retainedUntil");
CREATE UNIQUE INDEX "ExternalMcpToolApproval_callId_key" ON "ExternalMcpToolApproval"("callId");
CREATE INDEX "ExternalMcpToolApproval_ownerId_idx" ON "ExternalMcpToolApproval"("ownerId");
CREATE INDEX "ExternalMcpToolApproval_runId_idx" ON "ExternalMcpToolApproval"("runId");
CREATE INDEX "ExternalMcpToolApproval_attemptId_idx" ON "ExternalMcpToolApproval"("attemptId");
CREATE INDEX "ExternalMcpToolApproval_connectionId_idx" ON "ExternalMcpToolApproval"("connectionId");
CREATE INDEX "ExternalMcpToolApproval_toolId_idx" ON "ExternalMcpToolApproval"("toolId");
CREATE INDEX "ExternalMcpToolApproval_state_expiresAt_idx" ON "ExternalMcpToolApproval"("state", "expiresAt");
CREATE INDEX "ExternalMcpToolApproval_retainedUntil_idx" ON "ExternalMcpToolApproval"("retainedUntil");
CREATE INDEX "ExternalMcpToolApproval_decidedById_idx" ON "ExternalMcpToolApproval"("decidedById");

ALTER TABLE "ExternalMcpConnection" ADD CONSTRAINT "ExternalMcpConnection_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExternalMcpTool" ADD CONSTRAINT "ExternalMcpTool_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ExternalMcpConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExternalMcpTool" ADD CONSTRAINT "ExternalMcpTool_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExternalMcpProjectGrant" ADD CONSTRAINT "ExternalMcpProjectGrant_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ExternalMcpConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExternalMcpProjectGrant" ADD CONSTRAINT "ExternalMcpProjectGrant_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExternalMcpProjectGrant" ADD CONSTRAINT "ExternalMcpProjectGrant_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ScheduledTaskExternalInput" ADD CONSTRAINT "ScheduledTaskExternalInput_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ScheduledTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScheduledTaskExternalInput" ADD CONSTRAINT "ScheduledTaskExternalInput_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "ExternalMcpTool"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExternalMcpCall" ADD CONSTRAINT "ExternalMcpCall_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExternalMcpCall" ADD CONSTRAINT "ExternalMcpCall_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ExternalMcpConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExternalMcpCall" ADD CONSTRAINT "ExternalMcpCall_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "ExternalMcpTool"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExternalMcpCall" ADD CONSTRAINT "ExternalMcpCall_assistantRunId_fkey" FOREIGN KEY ("assistantRunId") REFERENCES "AssistantRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExternalMcpCall" ADD CONSTRAINT "ExternalMcpCall_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "AssistantRunAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExternalMcpCall" ADD CONSTRAINT "ExternalMcpCall_taskRunId_fkey" FOREIGN KEY ("taskRunId") REFERENCES "ScheduledTaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExternalMcpCall" ADD CONSTRAINT "ExternalMcpCall_inputId_fkey" FOREIGN KEY ("inputId") REFERENCES "ScheduledTaskExternalInput"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExternalMcpToolApproval" ADD CONSTRAINT "ExternalMcpToolApproval_callId_fkey" FOREIGN KEY ("callId") REFERENCES "ExternalMcpCall"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExternalMcpToolApproval" ADD CONSTRAINT "ExternalMcpToolApproval_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExternalMcpToolApproval" ADD CONSTRAINT "ExternalMcpToolApproval_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AssistantRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExternalMcpToolApproval" ADD CONSTRAINT "ExternalMcpToolApproval_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "AssistantRunAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExternalMcpToolApproval" ADD CONSTRAINT "ExternalMcpToolApproval_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ExternalMcpConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExternalMcpToolApproval" ADD CONSTRAINT "ExternalMcpToolApproval_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "ExternalMcpTool"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExternalMcpToolApproval" ADD CONSTRAINT "ExternalMcpToolApproval_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

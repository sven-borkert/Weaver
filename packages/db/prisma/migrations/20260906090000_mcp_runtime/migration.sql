-- Phase 4F: MCP direct-write idempotency records and audit events (spec §16, §17, §26).

CREATE TYPE "McpOutcome" AS ENUM ('ok', 'error', 'denied');

CREATE TABLE "McpOperation" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "credentialId" VARCHAR(200) NOT NULL,
  "projectId" UUID NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "toolName" VARCHAR(60) NOT NULL,
  "requestHash" VARCHAR(64) NOT NULL,
  "resourceId" UUID,
  "commitSha" TEXT NOT NULL,
  "result" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "McpOperation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "McpOperation_userId_idempotencyKey_key" ON "McpOperation"("userId", "idempotencyKey");
CREATE INDEX "McpOperation_projectId_createdAt_idx" ON "McpOperation"("projectId", "createdAt");
CREATE INDEX "McpOperation_createdAt_idx" ON "McpOperation"("createdAt");
ALTER TABLE "McpOperation" ADD CONSTRAINT "McpOperation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpOperation" ADD CONSTRAINT "McpOperation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "McpAuditEvent" (
  "id" UUID NOT NULL,
  "requestId" VARCHAR(64) NOT NULL,
  "userId" UUID,
  "credentialId" VARCHAR(200) NOT NULL,
  "authenticationMethod" VARCHAR(20) NOT NULL,
  "clientId" TEXT,
  "method" VARCHAR(40) NOT NULL,
  "name" VARCHAR(500) NOT NULL,
  "projectId" UUID,
  "outcome" "McpOutcome" NOT NULL,
  "errorCode" VARCHAR(40),
  "durationMs" INTEGER NOT NULL,
  "commitSha" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "McpAuditEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "McpAuditEvent_userId_createdAt_idx" ON "McpAuditEvent"("userId", "createdAt");
CREATE INDEX "McpAuditEvent_projectId_createdAt_idx" ON "McpAuditEvent"("projectId", "createdAt");
CREATE INDEX "McpAuditEvent_createdAt_idx" ON "McpAuditEvent"("createdAt");
ALTER TABLE "McpAuditEvent" ADD CONSTRAINT "McpAuditEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "McpAuditEvent" ADD CONSTRAINT "McpAuditEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

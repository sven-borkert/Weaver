-- Phase 6A: scheduled AI tasks and their runs.

CREATE TYPE "ScheduledTaskStatus" AS ENUM ('active', 'paused');
CREATE TYPE "ScheduledTaskPauseReason" AS ENUM ('manual', 'failing');
CREATE TYPE "ScheduledTaskRunStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'skipped');
CREATE TYPE "ScheduledTaskRunTrigger" AS ENUM ('schedule', 'manual');

CREATE TABLE "ScheduledTask" (
  "id" UUID NOT NULL,
  "ownerId" UUID NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "instruction" TEXT NOT NULL,
  "scopeRequest" JSONB NOT NULL,
  "scopeSnapshot" JSONB NOT NULL,
  "outputProjectId" UUID NOT NULL,
  "outputFolderPath" TEXT[],
  "outputDocumentId" UUID,
  "schedule" JSONB NOT NULL,
  "timezone" TEXT NOT NULL,
  "cron" TEXT NOT NULL,
  "status" "ScheduledTaskStatus" NOT NULL DEFAULT 'active',
  "pauseReason" "ScheduledTaskPauseReason",
  "nextRunAt" TIMESTAMP(3),
  "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  "lastRunAt" TIMESTAMP(3),
  "lastRunStatus" "ScheduledTaskRunStatus",
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ScheduledTask_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ScheduledTask_ownerId_idx" ON "ScheduledTask"("ownerId");
CREATE INDEX "ScheduledTask_outputProjectId_idx" ON "ScheduledTask"("outputProjectId");
CREATE INDEX "ScheduledTask_status_nextRunAt_idx" ON "ScheduledTask"("status", "nextRunAt");
CREATE INDEX "ScheduledTask_outputDocumentId_idx" ON "ScheduledTask"("outputDocumentId");
ALTER TABLE "ScheduledTask" ADD CONSTRAINT "ScheduledTask_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScheduledTask" ADD CONSTRAINT "ScheduledTask_outputProjectId_fkey"
  FOREIGN KEY ("outputProjectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ScheduledTaskRun" (
  "id" UUID NOT NULL,
  "taskId" UUID NOT NULL,
  "status" "ScheduledTaskRunStatus" NOT NULL DEFAULT 'queued',
  "trigger" "ScheduledTaskRunTrigger" NOT NULL,
  "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "jobId" TEXT,
  "workerId" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "projectHeads" JSONB,
  "contextSummary" JSONB,
  "outputDocumentId" UUID,
  "outputCommitSha" TEXT,
  "inputTokens" INTEGER,
  "outputTokens" INTEGER,
  "durationMs" INTEGER,
  "errorCode" VARCHAR(40),
  "errorMessage" VARCHAR(300),
  CONSTRAINT "ScheduledTaskRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ScheduledTaskRun_taskId_queuedAt_idx" ON "ScheduledTaskRun"("taskId", "queuedAt");
CREATE INDEX "ScheduledTaskRun_status_leaseExpiresAt_idx" ON "ScheduledTaskRun"("status", "leaseExpiresAt");
ALTER TABLE "ScheduledTaskRun" ADD CONSTRAINT "ScheduledTaskRun_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "ScheduledTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

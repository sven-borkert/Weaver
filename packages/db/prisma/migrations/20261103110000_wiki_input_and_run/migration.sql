-- Wiki input queue and runs (no model yet): items, runs, source links, usage commit column.
CREATE TYPE "WikiInputKind" AS ENUM ('text', 'file');
CREATE TYPE "WikiInputStatus" AS ENUM ('queued', 'preparing', 'ready', 'processing', 'processed', 'skipped', 'held', 'failed', 'reverted', 'removed');
CREATE TYPE "WikiRunKind" AS ENUM ('ingest', 'lint', 'classify', 'revert');
CREATE TYPE "WikiRunTrigger" AS ENUM ('manual', 'schedule');
CREATE TYPE "WikiRunStatus" AS ENUM ('preparing', 'queued', 'running', 'succeeded', 'stopped', 'failed', 'cancelled');

CREATE TABLE "WikiRun" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "kind" "WikiRunKind" NOT NULL,
    "trigger" "WikiRunTrigger" NOT NULL DEFAULT 'manual',
    "startedById" UUID,
    "status" "WikiRunStatus" NOT NULL,
    "stopReason" VARCHAR(64),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "queuedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "leaseToken" UUID,
    "leaseExpiresAt" TIMESTAMP(3),
    "workerId" VARCHAR(128),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "steps" INTEGER NOT NULL DEFAULT 0,
    "writes" INTEGER NOT NULL DEFAULT 0,
    "grossCharsChanged" INTEGER NOT NULL DEFAULT 0,
    "summary" VARCHAR(4000),
    "errorCode" VARCHAR(64),
    "errorMessage" VARCHAR(500),
    "routeSnapshot" JSONB,
    "usageTokens" INTEGER NOT NULL DEFAULT 0,
    "usageCostMicros" BIGINT NOT NULL DEFAULT 0,
    "planDigest" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WikiRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WikiRun_active_project_key" ON "WikiRun"("projectId") WHERE "status" IN ('preparing', 'queued', 'running');
CREATE INDEX "WikiRun_projectId_startedAt_idx" ON "WikiRun"("projectId", "startedAt");
CREATE INDEX "WikiRun_status_queuedAt_idx" ON "WikiRun"("status", "queuedAt");
CREATE INDEX "WikiRun_agentId_idx" ON "WikiRun"("agentId");
CREATE INDEX "WikiRun_startedById_idx" ON "WikiRun"("startedById");

ALTER TABLE "WikiRun" ADD CONSTRAINT "WikiRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WikiRun" ADD CONSTRAINT "WikiRun_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "WikiAgent"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "WikiRun" ADD CONSTRAINT "WikiRun_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "WikiInputItem" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "kind" "WikiInputKind" NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "text" TEXT,
    "textDigest" VARCHAR(64),
    "artifactId" UUID,
    "artifactDigest" VARCHAR(64),
    "byteSize" INTEGER NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "WikiInputStatus" NOT NULL DEFAULT 'queued',
    "runId" UUID,
    "processStartedById" UUID,
    "sourceDocumentId" UUID,
    "sourceTableId" UUID,
    "ingestionFileId" UUID,
    "processedAt" TIMESTAMP(3),
    "outcomeNote" VARCHAR(2000),
    "errorCode" VARCHAR(64),
    "errorMessage" VARCHAR(500),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "heldHits" JSONB,
    "heldDigest" VARCHAR(64),
    "confirmedById" UUID,
    "confirmedDigest" VARCHAR(64),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WikiInputItem_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WikiInputItem_title_not_blank" CHECK (length(btrim("title")) > 0),
    CONSTRAINT "WikiInputItem_text_size" CHECK ("text" IS NULL OR char_length("text") <= 200000)
);

CREATE INDEX "WikiInputItem_projectId_status_createdAt_idx" ON "WikiInputItem"("projectId", "status", "createdAt");
CREATE INDEX "WikiInputItem_runId_idx" ON "WikiInputItem"("runId");
CREATE INDEX "WikiInputItem_artifactId_idx" ON "WikiInputItem"("artifactId");
CREATE INDEX "WikiInputItem_createdById_idx" ON "WikiInputItem"("createdById");
CREATE INDEX "WikiInputItem_processStartedById_idx" ON "WikiInputItem"("processStartedById");
CREATE INDEX "WikiInputItem_confirmedById_idx" ON "WikiInputItem"("confirmedById");
CREATE INDEX "WikiInputItem_projectId_sourceDocumentId_idx" ON "WikiInputItem"("projectId", "sourceDocumentId");
CREATE INDEX "WikiInputItem_projectId_sourceTableId_idx" ON "WikiInputItem"("projectId", "sourceTableId");
CREATE UNIQUE INDEX "WikiInputItem_ingestionFileId_key" ON "WikiInputItem"("ingestionFileId");

ALTER TABLE "WikiInputItem" ADD CONSTRAINT "WikiInputItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WikiInputItem" ADD CONSTRAINT "WikiInputItem_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WikiInputItem" ADD CONSTRAINT "WikiInputItem_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WikiInputItem" ADD CONSTRAINT "WikiInputItem_processStartedById_fkey" FOREIGN KEY ("processStartedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WikiInputItem" ADD CONSTRAINT "WikiInputItem_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WikiInputItem" ADD CONSTRAINT "WikiInputItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WikiRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WikiInputItem" ADD CONSTRAINT "WikiInputItem_ingestionFileId_fkey" FOREIGN KEY ("ingestionFileId") REFERENCES "IngestionFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WikiGuideSuggestion" ADD CONSTRAINT "WikiGuideSuggestion_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WikiRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Document_wikiSourceItemId_idx" ON "Document"("wikiSourceItemId");
CREATE INDEX "DataTable_wikiSourceItemId_idx" ON "DataTable"("wikiSourceItemId");
ALTER TABLE "Document" ADD CONSTRAINT "Document_wikiSourceItemId_fkey" FOREIGN KEY ("wikiSourceItemId") REFERENCES "WikiInputItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DataTable" ADD CONSTRAINT "DataTable_wikiSourceItemId_fkey" FOREIGN KEY ("wikiSourceItemId") REFERENCES "WikiInputItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AiUsage" ADD COLUMN "sourceCommitSha" VARCHAR(40);
CREATE INDEX "AiUsage_sourceCommitSha_idx" ON "AiUsage"("sourceCommitSha");

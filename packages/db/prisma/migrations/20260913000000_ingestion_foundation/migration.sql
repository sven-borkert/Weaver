-- Phase 5A: import & ingestion foundation (design §5).

CREATE TYPE "IngestionOrigin" AS ENUM ('upload', 'external');
CREATE TYPE "IngestionFileStatus" AS ENUM (
  'pending', 'parsing', 'extracting', 'linking', 'ready',
  'accepting', 'accepted', 'rejected', 'failed', 'blocked_configuration'
);
CREATE TYPE "IngestionTargetKind" AS ENUM ('document', 'table');
CREATE TYPE "IngestionFailureKind" AS ENUM (
  'configuration', 'source_missing', 'parser', 'provider', 'validation', 'internal'
);

CREATE TABLE "IngestionBatch" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "createdById" UUID NOT NULL,
  "origin" "IngestionOrigin" NOT NULL,
  "label" VARCHAR(200),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IngestionBatch_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "IngestionBatch_projectId_createdAt_idx" ON "IngestionBatch"("projectId", "createdAt");
CREATE INDEX "IngestionBatch_createdById_idx" ON "IngestionBatch"("createdById");

CREATE TABLE "IngestionFile" (
  "id" UUID NOT NULL,
  "batchId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "fileName" VARCHAR(255) NOT NULL,
  "mimeType" VARCHAR(128) NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "contentDigest" VARCHAR(64) NOT NULL,
  "status" "IngestionFileStatus" NOT NULL DEFAULT 'pending',
  "failureKind" "IngestionFailureKind",
  "failureMessage" VARCHAR(500),
  "parserAdapterId" VARCHAR(40),
  "parserVersion" VARCHAR(40),
  "routeSnapshot" JSONB,
  "parseStartedAt" TIMESTAMP(3),
  "parseEndedAt" TIMESTAMP(3),
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IngestionFile_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "IngestionFile_projectId_status_idx" ON "IngestionFile"("projectId", "status");
CREATE INDEX "IngestionFile_batchId_createdAt_idx" ON "IngestionFile"("batchId", "createdAt");
CREATE INDEX "IngestionFile_projectId_contentDigest_idx" ON "IngestionFile"("projectId", "contentDigest");

CREATE TABLE "IngestionDraft" (
  "id" UUID NOT NULL,
  "fileId" UUID NOT NULL,
  "targetKind" "IngestionTargetKind" NOT NULL,
  "proposedTitle" VARCHAR(200) NOT NULL,
  "proposedFolderPath" VARCHAR(500) NOT NULL DEFAULT '',
  "proposedTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "markdown" TEXT,
  "tableSchema" JSONB,
  "tableRows" JSONB,
  "proposedLinks" JSONB,
  "warnings" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "editedById" UUID,
  "editedAt" TIMESTAMP(3),
  "acceptedResourceId" UUID,
  "acceptedCommitSha" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IngestionDraft_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IngestionDraft_fileId_key" ON "IngestionDraft"("fileId");

ALTER TABLE "IngestionBatch"
  ADD CONSTRAINT "IngestionBatch_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "IngestionBatch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IngestionFile"
  ADD CONSTRAINT "IngestionFile_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "IngestionBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "IngestionFile_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IngestionDraft"
  ADD CONSTRAINT "IngestionDraft_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "IngestionFile"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "IngestionDraft_editedById_fkey" FOREIGN KEY ("editedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

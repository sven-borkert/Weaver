CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "KnowledgeGenerationStatus" AS ENUM ('building', 'active', 'failed', 'superseded');

-- CreateEnum
CREATE TYPE "KnowledgeDocumentStatus" AS ENUM ('pending', 'processing', 'ready', 'failed', 'blocked_configuration', 'missing');

-- CreateEnum
CREATE TYPE "KnowledgeFailureKind" AS ENUM ('configuration', 'source_missing', 'provider', 'validation', 'stale', 'internal');

-- CreateEnum
CREATE TYPE "AiUsageOutcome" AS ENUM ('success', 'provider_failure', 'validation_failure', 'stale_discarded');

-- CreateTable
CREATE TABLE "KnowledgeGeneration" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "projectId" UUID NOT NULL,
    "configFingerprint" TEXT NOT NULL,
    "embeddingModel" TEXT NOT NULL,
    "embeddingDimensions" INTEGER NOT NULL,
    "extractionSchemaVersion" INTEGER NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "status" "KnowledgeGenerationStatus" NOT NULL DEFAULT 'building',
    "documentTotal" INTEGER NOT NULL DEFAULT 0,
    "documentReadyCount" INTEGER NOT NULL DEFAULT 0,
    "documentFailedCount" INTEGER NOT NULL DEFAULT 0,
    "failureKind" "KnowledgeFailureKind",
    "failureSummary" VARCHAR(300),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "KnowledgeGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentIndexState" (
    "documentId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "targetSha" TEXT NOT NULL,
    "keywordIndexedSha" TEXT,
    "status" "KnowledgeDocumentStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "failureKind" "KnowledgeFailureKind",
    "failureSummary" VARCHAR(300),
    "lastAttemptAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentIndexState_pkey" PRIMARY KEY ("documentId")
);

-- CreateTable
CREATE TABLE "KnowledgeGenerationDocument" (
    "generationId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "targetSha" TEXT NOT NULL,
    "semanticIndexedSha" TEXT,
    "graphIndexedSha" TEXT,
    "configFingerprint" TEXT NOT NULL,
    "status" "KnowledgeDocumentStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "failureKind" "KnowledgeFailureKind",
    "failureSummary" VARCHAR(300),
    "lastAttemptAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeGenerationDocument_pkey" PRIMARY KEY ("generationId", "documentId")
);

-- CreateTable
CREATE TABLE "DocumentSearchChunk" (
    "id" VARCHAR(64) NOT NULL,
    "projectId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "sourceCommitSha" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "headingPath" TEXT[],
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "DocumentSearchChunk_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DocumentSearchChunk_id_check" CHECK ("id" ~ '^[0-9a-f]{64}$')
);

-- CreateTable
CREATE TABLE "TableSearchProjection" (
    "tableId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "sourceCommitSha" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "schemaText" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TableSearchProjection_pkey" PRIMARY KEY ("tableId")
);

-- CreateTable
CREATE TABLE "KnowledgeEmbedding" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "projectId" UUID NOT NULL,
    "generationId" UUID NOT NULL,
    "ownerType" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "configFingerprint" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "embeddingDimensions" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeEmbedding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraphEntity" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "projectId" UUID NOT NULL,
    "generationId" UUID NOT NULL,
    "entityType" TEXT NOT NULL,
    "canonicalName" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GraphEntity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraphEntityAlias" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "projectId" UUID NOT NULL,
    "entityId" UUID NOT NULL,
    "alias" TEXT NOT NULL,
    "normalizedAlias" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GraphEntityAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntityMention" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "projectId" UUID NOT NULL,
    "generationId" UUID NOT NULL,
    "entityId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "sourceChunkId" VARCHAR(64) NOT NULL,
    "sourceCommitSha" TEXT NOT NULL,
    "mentionText" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invalidatedAt" TIMESTAMP(3),

    CONSTRAINT "EntityMention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraphRelation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "projectId" UUID NOT NULL,
    "generationId" UUID NOT NULL,
    "sourceEntityId" UUID NOT NULL,
    "targetEntityId" UUID NOT NULL,
    "relationType" TEXT NOT NULL,
    "normalizedType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GraphRelation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RelationEvidence" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "projectId" UUID NOT NULL,
    "generationId" UUID NOT NULL,
    "relationId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "sourceChunkId" VARCHAR(64) NOT NULL,
    "sourceCommitSha" TEXT NOT NULL,
    "evidenceText" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invalidatedAt" TIMESTAMP(3),

    CONSTRAINT "RelationEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiUsage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "projectId" UUID,
    "operation" TEXT NOT NULL,
    "jobId" TEXT,
    "runId" TEXT,
    "documentId" UUID,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "configFingerprint" TEXT NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "cachedTokens" INTEGER,
    "totalTokens" INTEGER,
    "durationMs" INTEGER NOT NULL,
    "outcome" "AiUsageOutcome" NOT NULL,
    "costMicros" BIGINT,
    "currency" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("id")
);

-- Database-owned generated/search columns.
ALTER TABLE "DocumentSearchChunk"
  ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce("content", ''))) STORED;
CREATE INDEX "DocumentSearchChunk_searchVector_idx"
  ON "DocumentSearchChunk" USING GIN ("searchVector");
ALTER TABLE "TableSearchProjection"
  ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("schemaText", ''))
  ) STORED;
CREATE INDEX "TableSearchProjection_searchVector_idx"
  ON "TableSearchProjection" USING GIN ("searchVector");
ALTER TABLE "KnowledgeEmbedding" ADD COLUMN "embedding" vector NOT NULL;
ALTER TABLE "KnowledgeEmbedding" ADD CONSTRAINT "KnowledgeEmbedding_dimensions_check"
  CHECK (vector_dims("embedding") = "embeddingDimensions");
CREATE INDEX "KnowledgeEmbedding_embedding_1536_hnsw_idx"
  ON "KnowledgeEmbedding" USING hnsw
  (("embedding"::vector(1536)) vector_cosine_ops)
  WHERE "embeddingDimensions" = 1536;
CREATE UNIQUE INDEX "KnowledgeGeneration_one_active_per_project"
  ON "KnowledgeGeneration" ("projectId") WHERE "status" = 'active';

-- CreateIndex
CREATE INDEX "KnowledgeGeneration_projectId_idx" ON "KnowledgeGeneration"("projectId");
CREATE INDEX "KnowledgeGeneration_projectId_configFingerprint_status_idx" ON "KnowledgeGeneration"("projectId", "configFingerprint", "status");
CREATE INDEX "DocumentIndexState_projectId_idx" ON "DocumentIndexState"("projectId");
CREATE INDEX "KnowledgeGenerationDocument_projectId_idx" ON "KnowledgeGenerationDocument"("projectId");
CREATE INDEX "KnowledgeGenerationDocument_generationId_idx" ON "KnowledgeGenerationDocument"("generationId");
CREATE INDEX "KnowledgeGenerationDocument_documentId_idx" ON "KnowledgeGenerationDocument"("documentId");
CREATE UNIQUE INDEX "DocumentSearchChunk_documentId_sourceCommitSha_ordinal_key" ON "DocumentSearchChunk"("documentId", "sourceCommitSha", "ordinal");
CREATE INDEX "DocumentSearchChunk_projectId_idx" ON "DocumentSearchChunk"("projectId");
CREATE INDEX "DocumentSearchChunk_documentId_idx" ON "DocumentSearchChunk"("documentId");
CREATE INDEX "TableSearchProjection_projectId_idx" ON "TableSearchProjection"("projectId");
CREATE UNIQUE INDEX "KnowledgeEmbedding_generationId_ownerType_ownerId_key" ON "KnowledgeEmbedding"("generationId", "ownerType", "ownerId");
CREATE INDEX "KnowledgeEmbedding_projectId_idx" ON "KnowledgeEmbedding"("projectId");
CREATE INDEX "KnowledgeEmbedding_generationId_idx" ON "KnowledgeEmbedding"("generationId");
CREATE UNIQUE INDEX "GraphEntity_generationId_entityType_normalizedName_key" ON "GraphEntity"("generationId", "entityType", "normalizedName");
CREATE INDEX "GraphEntity_projectId_idx" ON "GraphEntity"("projectId");
CREATE INDEX "GraphEntity_generationId_idx" ON "GraphEntity"("generationId");
CREATE UNIQUE INDEX "GraphEntityAlias_entityId_normalizedAlias_key" ON "GraphEntityAlias"("entityId", "normalizedAlias");
CREATE INDEX "GraphEntityAlias_projectId_idx" ON "GraphEntityAlias"("projectId");
CREATE INDEX "GraphEntityAlias_entityId_idx" ON "GraphEntityAlias"("entityId");
CREATE INDEX "EntityMention_projectId_idx" ON "EntityMention"("projectId");
CREATE INDEX "EntityMention_generationId_idx" ON "EntityMention"("generationId");
CREATE INDEX "EntityMention_entityId_idx" ON "EntityMention"("entityId");
CREATE INDEX "EntityMention_documentId_idx" ON "EntityMention"("documentId");
CREATE INDEX "EntityMention_sourceChunkId_idx" ON "EntityMention"("sourceChunkId");
CREATE UNIQUE INDEX "GraphRelation_generationId_sourceEntityId_targetEntityId_normalizedType_key" ON "GraphRelation"("generationId", "sourceEntityId", "targetEntityId", "normalizedType");
CREATE INDEX "GraphRelation_projectId_idx" ON "GraphRelation"("projectId");
CREATE INDEX "GraphRelation_generationId_idx" ON "GraphRelation"("generationId");
CREATE INDEX "GraphRelation_sourceEntityId_idx" ON "GraphRelation"("sourceEntityId");
CREATE INDEX "GraphRelation_targetEntityId_idx" ON "GraphRelation"("targetEntityId");
CREATE INDEX "RelationEvidence_projectId_idx" ON "RelationEvidence"("projectId");
CREATE INDEX "RelationEvidence_generationId_idx" ON "RelationEvidence"("generationId");
CREATE INDEX "RelationEvidence_relationId_idx" ON "RelationEvidence"("relationId");
CREATE INDEX "RelationEvidence_documentId_idx" ON "RelationEvidence"("documentId");
CREATE INDEX "RelationEvidence_sourceChunkId_idx" ON "RelationEvidence"("sourceChunkId");
CREATE INDEX "AiUsage_projectId_idx" ON "AiUsage"("projectId");

-- AddForeignKey
ALTER TABLE "KnowledgeGeneration" ADD CONSTRAINT "KnowledgeGeneration_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentIndexState" ADD CONSTRAINT "DocumentIndexState_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeGenerationDocument" ADD CONSTRAINT "KnowledgeGenerationDocument_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "KnowledgeGeneration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeGenerationDocument" ADD CONSTRAINT "KnowledgeGenerationDocument_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentSearchChunk" ADD CONSTRAINT "DocumentSearchChunk_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentSearchChunk" ADD CONSTRAINT "DocumentSearchChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TableSearchProjection" ADD CONSTRAINT "TableSearchProjection_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeEmbedding" ADD CONSTRAINT "KnowledgeEmbedding_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeEmbedding" ADD CONSTRAINT "KnowledgeEmbedding_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "KnowledgeGeneration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GraphEntity" ADD CONSTRAINT "GraphEntity_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GraphEntity" ADD CONSTRAINT "GraphEntity_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "KnowledgeGeneration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GraphEntityAlias" ADD CONSTRAINT "GraphEntityAlias_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GraphEntityAlias" ADD CONSTRAINT "GraphEntityAlias_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "GraphEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EntityMention" ADD CONSTRAINT "EntityMention_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EntityMention" ADD CONSTRAINT "EntityMention_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "KnowledgeGeneration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EntityMention" ADD CONSTRAINT "EntityMention_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "GraphEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GraphRelation" ADD CONSTRAINT "GraphRelation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GraphRelation" ADD CONSTRAINT "GraphRelation_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "KnowledgeGeneration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GraphRelation" ADD CONSTRAINT "GraphRelation_sourceEntityId_fkey" FOREIGN KEY ("sourceEntityId") REFERENCES "GraphEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GraphRelation" ADD CONSTRAINT "GraphRelation_targetEntityId_fkey" FOREIGN KEY ("targetEntityId") REFERENCES "GraphEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RelationEvidence" ADD CONSTRAINT "RelationEvidence_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RelationEvidence" ADD CONSTRAINT "RelationEvidence_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "KnowledgeGeneration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RelationEvidence" ADD CONSTRAINT "RelationEvidence_relationId_fkey" FOREIGN KEY ("relationId") REFERENCES "GraphRelation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiUsage" ADD CONSTRAINT "AiUsage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

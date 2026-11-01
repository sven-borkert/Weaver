-- packages/db/prisma/migrations/20260904090000_llm_connections_routing/migration.sql
-- Phase 4C: encrypted LLM connections, declared models, purpose routes (spec §10),
-- route snapshots on knowledge generations, and connection-aware AI usage.

CREATE TYPE "LlmProviderType" AS ENUM ('openai', 'anthropic', 'openai_compatible');
CREATE TYPE "LlmPurpose" AS ENUM ('assistant', 'knowledge_extraction', 'knowledge_embedding', 'ingestion', 'jobs');
CREATE TYPE "LlmModelCapability" AS ENUM ('chat', 'json_output', 'tool_use', 'embedding');
CREATE TYPE "LlmTestOutcome" AS ENUM ('success', 'failure');

CREATE TABLE "LlmConnection" (
  "id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "providerType" "LlmProviderType" NOT NULL,
  "endpoint" TEXT NOT NULL,
  "settings" JSONB NOT NULL DEFAULT '{}',
  "requestTimeoutMs" INTEGER NOT NULL DEFAULT 30000,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "credentialCiphertext" BYTEA NOT NULL,
  "credentialNonce" BYTEA NOT NULL,
  "credentialTag" BYTEA NOT NULL,
  "credentialKeyVersion" INTEGER NOT NULL,
  "credentialUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastTestAt" TIMESTAMP(3),
  "lastTestOutcome" "LlmTestOutcome",
  "lastTestSummary" VARCHAR(300),
  "createdById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LlmConnection_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LlmConnection_name_key" ON "LlmConnection"("name");
CREATE INDEX "LlmConnection_createdById_idx" ON "LlmConnection"("createdById");
ALTER TABLE "LlmConnection" ADD CONSTRAINT "LlmConnection_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "LlmModel" (
  "id" UUID NOT NULL,
  "connectionId" UUID NOT NULL,
  "providerModelId" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "contextWindow" INTEGER,
  "embeddingDimensions" INTEGER,
  "capabilities" "LlmModelCapability"[],
  "inputCostMicrosPerMillion" INTEGER,
  "outputCostMicrosPerMillion" INTEGER,
  "currency" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LlmModel_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LlmModel_connectionId_providerModelId_key" ON "LlmModel"("connectionId", "providerModelId");
ALTER TABLE "LlmModel" ADD CONSTRAINT "LlmModel_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "LlmConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "LlmRoute" (
  "purpose" "LlmPurpose" NOT NULL,
  "modelId" UUID NOT NULL,
  "updatedById" UUID,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LlmRoute_pkey" PRIMARY KEY ("purpose")
);
CREATE INDEX "LlmRoute_modelId_idx" ON "LlmRoute"("modelId");
ALTER TABLE "LlmRoute" ADD CONSTRAINT "LlmRoute_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "LlmModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LlmRoute" ADD CONSTRAINT "LlmRoute_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "KnowledgeGeneration" ADD COLUMN "routeSnapshot" JSONB;

ALTER TABLE "AiUsage" ADD COLUMN "connectionId" UUID;
CREATE INDEX "AiUsage_connectionId_idx" ON "AiUsage"("connectionId");

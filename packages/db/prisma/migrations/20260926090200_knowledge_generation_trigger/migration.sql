CREATE TYPE "KnowledgeGenerationTrigger" AS ENUM (
  'initial', 'embedding_change', 'index_upgrade', 'manual_rebuild'
);

ALTER TABLE "KnowledgeGeneration"
  ADD COLUMN "buildTrigger" "KnowledgeGenerationTrigger",
  ADD COLUMN "requestedById" UUID;

ALTER TABLE "KnowledgeGeneration"
  ADD CONSTRAINT "KnowledgeGeneration_requestedById_fkey"
  FOREIGN KEY ("requestedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "KnowledgeGeneration_requestedById_createdAt_idx"
  ON "KnowledgeGeneration"("requestedById", "createdAt");

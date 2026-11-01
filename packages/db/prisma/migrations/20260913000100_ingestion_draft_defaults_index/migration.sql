-- Preserve ingestion draft array defaults in Prisma's schema and index the editor foreign key.

ALTER TABLE "IngestionDraft"
  ALTER COLUMN "proposedTags" SET DEFAULT ARRAY[]::TEXT[],
  ALTER COLUMN "warnings" SET DEFAULT ARRAY[]::TEXT[];

CREATE INDEX "IngestionDraft_editedById_idx" ON "IngestionDraft"("editedById");

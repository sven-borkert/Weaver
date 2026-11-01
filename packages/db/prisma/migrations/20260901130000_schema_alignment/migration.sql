-- Align hand-authored DDL with schema.prisma so `prisma migrate diff` reports
-- only the intentionally unsupported tsvector/vector columns.

-- Stored generated columns can never be null; declare it.
ALTER TABLE "Document"
  ALTER COLUMN "normalizedTitle" SET NOT NULL,
  ALTER COLUMN "normalizedTitleHash" SET NOT NULL;
ALTER TABLE "DataTable"
  ALTER COLUMN "normalizedTitle" SET NOT NULL,
  ALTER COLUMN "normalizedTitleHash" SET NOT NULL;

-- Prisma supplies ids client-side (@default(uuid())); every writer passes one.
ALTER TABLE "User" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "Project" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "KnowledgeGeneration" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "KnowledgeEmbedding" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "GraphEntity" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "GraphEntityAlias" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "EntityMention" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "GraphRelation" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "RelationEvidence" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "AiUsage" ALTER COLUMN "id" DROP DEFAULT;

-- PostgreSQL truncated the 77-character index name; use Prisma's canonical name.
ALTER INDEX "GraphRelation_generationId_sourceEntityId_targetEntityId_normal"
  RENAME TO "GraphRelation_generationId_sourceEntityId_targetEntityId_no_key";

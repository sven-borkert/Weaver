ALTER TABLE "Document" ADD COLUMN "wikiType" TEXT;
ALTER TABLE "Document" ADD COLUMN "wikiSummary" TEXT;
ALTER TABLE "Document" ADD COLUMN "wikiTags" JSONB;
ALTER TABLE "Document" ADD COLUMN "wikiSources" JSONB;
ALTER TABLE "Document" ADD COLUMN "reviewExempt" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Document" ADD COLUMN "wikiSourceItemId" UUID;
ALTER TABLE "DataTable" ADD COLUMN "wikiSourceItemId" UUID;
CREATE INDEX "Document_projectId_wikiType_idx" ON "Document"("projectId", "wikiType");

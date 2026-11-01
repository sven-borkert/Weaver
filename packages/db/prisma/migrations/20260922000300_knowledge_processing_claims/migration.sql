ALTER TABLE "KnowledgeGenerationDocument"
ADD COLUMN "processingClaimToken" UUID,
ADD COLUMN "processingJobId" VARCHAR(200),
ADD COLUMN "processingRetryCount" INTEGER;

ALTER TABLE "KnowledgeGenerationDocument"
ADD CONSTRAINT "KnowledgeGenerationDocument_processingRetryCount_check"
CHECK ("processingRetryCount" IS NULL OR "processingRetryCount" >= 0);

ALTER TABLE "IngestionFile" RENAME COLUMN "parseClaimJobId" TO "stageClaimJobId";
ALTER TABLE "IngestionFile" RENAME COLUMN "parseClaimRetryCount" TO "stageClaimRetryCount";
ALTER TABLE "IngestionFile"
  ADD COLUMN "analyzeStartedAt" TIMESTAMP(3),
  ADD COLUMN "analyzeEndedAt" TIMESTAMP(3),
  ADD COLUMN "linkStartedAt" TIMESTAMP(3),
  ADD COLUMN "linkEndedAt" TIMESTAMP(3);
ALTER TABLE "IngestionDraft"
  ADD COLUMN "linkQueries" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

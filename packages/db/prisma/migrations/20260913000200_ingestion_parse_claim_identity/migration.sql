-- Fence ingestion.parse crash recovery by the durable pg-boss delivery identity.

ALTER TABLE "IngestionFile"
  ADD COLUMN "parseClaimJobId" VARCHAR(64),
  ADD COLUMN "parseClaimRetryCount" INTEGER;

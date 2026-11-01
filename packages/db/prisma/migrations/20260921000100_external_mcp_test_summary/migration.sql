ALTER TABLE "ExternalMcpConnection"
  ADD COLUMN "lastTestedAt" TIMESTAMP(3),
  ADD COLUMN "testStatus" VARCHAR(40),
  ADD COLUMN "testErrorCode" VARCHAR(40),
  ADD COLUMN "testErrorSummary" VARCHAR(300);

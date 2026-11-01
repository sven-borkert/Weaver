ALTER TABLE "DocumentChangeSummary" ADD COLUMN "basePathAtSha" TEXT;
ALTER TABLE "DocumentChangeSummary" ADD COLUMN "lastErrorClass" VARCHAR(64);
ALTER TABLE "DocumentChangeSummary" ADD COLUMN "lastJobId" VARCHAR(64);

CREATE INDEX "DocumentChangeSummary_createdAt_projectId_commitSha_idx" ON "DocumentChangeSummary"("createdAt", "projectId", "commitSha");

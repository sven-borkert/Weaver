CREATE TYPE "DocumentChangeSummaryStatus" AS ENUM ('pending', 'ready', 'failed', 'skipped');

CREATE TABLE "DocumentChangeSummary" (
  "projectId" UUID NOT NULL,
  "commitSha" VARCHAR(40) NOT NULL,
  "documentId" UUID NOT NULL,
  "pathAtSha" TEXT NOT NULL,
  "baseCommitSha" VARCHAR(40) NOT NULL,
  "status" "DocumentChangeSummaryStatus" NOT NULL DEFAULT 'pending',
  "summary" VARCHAR(120),
  "failureReason" VARCHAR(32),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "DocumentChangeSummary_pkey" PRIMARY KEY ("projectId", "commitSha"),
  CONSTRAINT "DocumentChangeSummary_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "DocumentChangeSummary_status_updatedAt_idx" ON "DocumentChangeSummary"("status", "updatedAt");

-- Run ledger, owned-page cache and per-page budgets for the wiki agent runner.
CREATE TYPE "WikiOperationStatus" AS ENUM ('reserved', 'committed', 'failed');

ALTER TABLE "WikiRun"
    ADD COLUMN "runningAt" TIMESTAMP(3),
    ADD COLUMN "operationCounter" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "budgetRefusals" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "WikiInputItem" ADD COLUMN "agentNote" VARCHAR(8000);

ALTER TABLE "ProjectWikiSettings" ADD COLUMN "spendAlertedAt" TIMESTAMP(3);

CREATE TABLE "WikiRunOperation" (
    "runId" UUID NOT NULL,
    "n" INTEGER NOT NULL,
    "inputItemId" UUID,
    "toolName" VARCHAR(64) NOT NULL,
    "requestHash" VARCHAR(64) NOT NULL,
    "operationId" VARCHAR(200) NOT NULL,
    "documentId" UUID,
    "path" VARCHAR(1024),
    "baseCommitSha" VARCHAR(40),
    "commitSha" VARCHAR(40),
    "sourceReferenced" BOOLEAN NOT NULL DEFAULT false,
    "grossCharsChanged" INTEGER NOT NULL DEFAULT 0,
    "charsAdded" INTEGER NOT NULL DEFAULT 0,
    "status" "WikiOperationStatus" NOT NULL DEFAULT 'reserved',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" TIMESTAMP(3),

    CONSTRAINT "WikiRunOperation_pkey" PRIMARY KEY ("runId", "n"),
    CONSTRAINT "WikiRunOperation_n_width" CHECK ("n" BETWEEN 1 AND 9999)
);
CREATE UNIQUE INDEX "WikiRunOperation_operationId_key" ON "WikiRunOperation"("operationId");
CREATE INDEX "WikiRunOperation_inputItemId_idx" ON "WikiRunOperation"("inputItemId");
CREATE INDEX "WikiRunOperation_documentId_idx" ON "WikiRunOperation"("documentId");
CREATE INDEX "WikiRunOperation_status_committedAt_idx" ON "WikiRunOperation"("status", "committedAt");
CREATE INDEX "WikiRunOperation_createdAt_idx" ON "WikiRunOperation"("createdAt");
ALTER TABLE "WikiRunOperation" ADD CONSTRAINT "WikiRunOperation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WikiRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WikiRunOperation" ADD CONSTRAINT "WikiRunOperation_inputItemId_fkey" FOREIGN KEY ("inputItemId") REFERENCES "WikiInputItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "WikiOwnedPage" (
    "documentId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "createdCommitSha" VARCHAR(40) NOT NULL,
    "lastAgentCommitSha" VARCHAR(40) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WikiOwnedPage_pkey" PRIMARY KEY ("documentId")
);
CREATE INDEX "WikiOwnedPage_projectId_idx" ON "WikiOwnedPage"("projectId");
CREATE INDEX "WikiOwnedPage_runId_idx" ON "WikiOwnedPage"("runId");
ALTER TABLE "WikiOwnedPage" ADD CONSTRAINT "WikiOwnedPage_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WikiOwnedPage" ADD CONSTRAINT "WikiOwnedPage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WikiOwnedPage" ADD CONSTRAINT "WikiOwnedPage_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WikiRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "WikiPageBudget" (
    "runId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "baselineCommitSha" VARCHAR(40) NOT NULL,
    "grossCharsChanged" INTEGER NOT NULL DEFAULT 0,
    "charsAdded" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "WikiPageBudget_pkey" PRIMARY KEY ("runId", "documentId")
);
CREATE INDEX "WikiPageBudget_documentId_idx" ON "WikiPageBudget"("documentId");
ALTER TABLE "WikiPageBudget" ADD CONSTRAINT "WikiPageBudget_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WikiRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

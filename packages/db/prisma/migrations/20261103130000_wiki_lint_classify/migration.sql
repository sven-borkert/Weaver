-- Classify stores its preview plan on the run; lint remembers the last slot it skipped and why.
ALTER TABLE "WikiRun" ADD COLUMN "plan" JSONB;
ALTER TABLE "ProjectWikiSettings"
    ADD COLUMN "lintSkippedAt" TIMESTAMP(3),
    ADD COLUMN "lintSkipReason" VARCHAR(32);

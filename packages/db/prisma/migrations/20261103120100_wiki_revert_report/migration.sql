-- A revert run names the run it undoes and records what it skipped and why.
ALTER TABLE "WikiRun"
    ADD COLUMN "revertsRunId" UUID,
    ADD COLUMN "report" JSONB;
CREATE INDEX "WikiRun_revertsRunId_idx" ON "WikiRun"("revertsRunId");
ALTER TABLE "WikiRun" ADD CONSTRAINT "WikiRun_revertsRunId_fkey" FOREIGN KEY ("revertsRunId") REFERENCES "WikiRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

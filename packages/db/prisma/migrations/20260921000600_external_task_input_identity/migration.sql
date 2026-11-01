ALTER TABLE "ExternalMcpCall" ADD COLUMN "inputSnapshotId" UUID;
UPDATE "ExternalMcpCall" SET "inputSnapshotId" = "inputId" WHERE "inputId" IS NOT NULL;
ALTER TABLE "ExternalMcpCall" DROP CONSTRAINT "ExternalMcpCall_owner_shape_check";
ALTER TABLE "ExternalMcpCall" ADD CONSTRAINT "ExternalMcpCall_owner_shape_check" CHECK (
  ("assistantRunId" IS NOT NULL AND "attemptId" IS NOT NULL AND "toolCallId" IS NOT NULL AND "taskRunId" IS NULL AND "inputId" IS NULL AND "inputSnapshotId" IS NULL)
  OR ("assistantRunId" IS NULL AND "attemptId" IS NULL AND "toolCallId" IS NULL AND "taskRunId" IS NOT NULL AND "inputSnapshotId" IS NOT NULL AND ("inputId" IS NULL OR "inputId" = "inputSnapshotId"))
);
ALTER TABLE "ExternalMcpCall" DROP CONSTRAINT "ExternalMcpCall_inputId_fkey";
ALTER TABLE "ExternalMcpCall" ADD CONSTRAINT "ExternalMcpCall_inputId_fkey" FOREIGN KEY ("inputId") REFERENCES "ScheduledTaskExternalInput"("id") ON DELETE SET NULL ON UPDATE CASCADE;
DROP INDEX "ExternalMcpCall_taskRunId_inputId_key";
CREATE UNIQUE INDEX "ExternalMcpCall_taskRunId_inputSnapshotId_key" ON "ExternalMcpCall"("taskRunId", "inputSnapshotId");

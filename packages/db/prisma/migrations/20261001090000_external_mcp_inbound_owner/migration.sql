ALTER TABLE "ExternalMcpCall"
  ADD COLUMN "mcpRequestId" VARCHAR(200),
  ADD COLUMN "mcpCredentialId" VARCHAR(200),
  ADD COLUMN "mcpAuthMethod" VARCHAR(20);

CREATE UNIQUE INDEX "ExternalMcpCall_mcpRequestId_key" ON "ExternalMcpCall"("mcpRequestId");

ALTER TABLE "ExternalMcpCall" DROP CONSTRAINT "ExternalMcpCall_owner_shape_check";
ALTER TABLE "ExternalMcpCall" ADD CONSTRAINT "ExternalMcpCall_owner_shape_check" CHECK (
  ("assistantRunId" IS NOT NULL AND "attemptId" IS NOT NULL AND "toolCallId" IS NOT NULL AND "taskRunId" IS NULL AND "inputId" IS NULL AND "inputSnapshotId" IS NULL
    AND "mcpRequestId" IS NULL AND "mcpCredentialId" IS NULL AND "mcpAuthMethod" IS NULL)
  OR ("assistantRunId" IS NULL AND "attemptId" IS NULL AND "toolCallId" IS NULL AND "taskRunId" IS NOT NULL AND "inputSnapshotId" IS NOT NULL AND ("inputId" IS NULL OR "inputId" = "inputSnapshotId")
    AND "mcpRequestId" IS NULL AND "mcpCredentialId" IS NULL AND "mcpAuthMethod" IS NULL)
  OR ("assistantRunId" IS NULL AND "attemptId" IS NULL AND "toolCallId" IS NULL AND "taskRunId" IS NULL AND "inputId" IS NULL AND "inputSnapshotId" IS NULL
    AND "mcpRequestId" IS NOT NULL AND "mcpCredentialId" IS NOT NULL AND "mcpAuthMethod" IN ('apiKey', 'oauth'))
);

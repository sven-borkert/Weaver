ALTER TYPE "ExternalMcpApprovalState" ADD VALUE 'settled';

ALTER TABLE "ExternalMcpToolApproval"
  DROP CONSTRAINT "ExternalMcpToolApproval_pending_arguments_check";

ALTER TABLE "ExternalMcpToolApproval"
  ADD CONSTRAINT "ExternalMcpToolApproval_pending_arguments_check" CHECK (
    (
      "state" IN ('pending', 'approved')
      AND "pendingArgumentsCiphertext" IS NOT NULL
      AND "pendingArgumentsKeyVersion" IS NOT NULL
      AND "pendingArgumentsIv" IS NOT NULL
      AND "pendingArgumentsTag" IS NOT NULL
    )
    OR (
      "state" IN ('denied', 'expired', 'invalidated', 'settled')
      AND "pendingArgumentsCiphertext" IS NULL
      AND "pendingArgumentsKeyVersion" IS NULL
      AND "pendingArgumentsIv" IS NULL
      AND "pendingArgumentsTag" IS NULL
    )
  );

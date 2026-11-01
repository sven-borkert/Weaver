-- Approval is decided by the conversation's auto-approve setting, not per connection.
ALTER TABLE "ExternalMcpConnection" DROP COLUMN "approvalPolicy";
ALTER TABLE "ExternalMcpCall" DROP COLUMN "approvalPolicy";
DROP TYPE "ExternalMcpApprovalPolicy";

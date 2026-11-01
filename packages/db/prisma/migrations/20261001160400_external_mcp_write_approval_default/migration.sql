-- Separate migration: PostgreSQL cannot use an enum value in the transaction that added it.
ALTER TABLE "ExternalMcpConnection" ALTER COLUMN "approvalPolicy" SET DEFAULT 'require_write_approval';

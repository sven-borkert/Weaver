ALTER TABLE "ExternalMcpCall" ADD COLUMN "invocationDigest" CHAR(64), ADD COLUMN "denialDigest" CHAR(64), ADD COLUMN "deadline" TIMESTAMP(3);

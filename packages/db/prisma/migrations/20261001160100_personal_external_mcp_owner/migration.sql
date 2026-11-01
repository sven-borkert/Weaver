ALTER TABLE "ExternalMcpConnection" DROP CONSTRAINT "ExternalMcpConnection_createdById_fkey";
DROP INDEX "ExternalMcpConnection_createdById_idx";
DROP INDEX "ExternalMcpConnection_name_key";
ALTER TABLE "ExternalMcpConnection" RENAME COLUMN "createdById" TO "ownerId";
ALTER TABLE "ExternalMcpConnection" ALTER COLUMN "ownerId" SET NOT NULL;
CREATE INDEX "ExternalMcpConnection_ownerId_idx" ON "ExternalMcpConnection"("ownerId");
CREATE UNIQUE INDEX "ExternalMcpConnection_ownerId_name_key" ON "ExternalMcpConnection"("ownerId", "name");
ALTER TABLE "ExternalMcpConnection" ADD CONSTRAINT "ExternalMcpConnection_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- NO ACTION is checked at statement end, so a user's cascade can remove inputs and tools together.
ALTER TABLE "ScheduledTaskExternalInput" DROP CONSTRAINT "ScheduledTaskExternalInput_toolId_fkey";
ALTER TABLE "ScheduledTaskExternalInput" ADD CONSTRAINT "ScheduledTaskExternalInput_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "ExternalMcpTool"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

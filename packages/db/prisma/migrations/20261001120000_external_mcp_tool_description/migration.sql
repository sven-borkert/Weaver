ALTER TABLE "ExternalMcpTool" ADD COLUMN "description" TEXT;
UPDATE "ExternalMcpTool" SET "description" = "discoveredDefinition"->>'description';

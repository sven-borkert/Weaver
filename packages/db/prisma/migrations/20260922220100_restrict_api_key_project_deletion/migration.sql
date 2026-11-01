ALTER TABLE "ApiKeyProject" DROP CONSTRAINT "ApiKeyProject_projectId_fkey";
ALTER TABLE "ApiKeyProject" ADD CONSTRAINT "ApiKeyProject_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

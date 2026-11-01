ALTER TABLE "User"
ADD COLUMN "lastOpenedProjectId" UUID;

ALTER TABLE "User"
ADD CONSTRAINT "User_lastOpenedProjectId_fkey"
FOREIGN KEY ("lastOpenedProjectId") REFERENCES "Project"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

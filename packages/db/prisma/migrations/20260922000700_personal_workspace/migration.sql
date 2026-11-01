ALTER TABLE "Project" ADD COLUMN "personalOwnerId" UUID;

CREATE UNIQUE INDEX "Project_personalOwnerId_key" ON "Project"("personalOwnerId");

ALTER TABLE "Project"
  ADD CONSTRAINT "Project_personalOwnerId_fkey"
  FOREIGN KEY ("personalOwnerId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Document" ADD COLUMN "createdById" UUID,
ADD COLUMN "createdByName" TEXT,
ADD COLUMN "updatedAt" TIMESTAMP(3),
ADD COLUMN "updatedById" UUID,
ADD COLUMN "updatedByName" TEXT;
-- Interim values until the authorship backfill rewrites the projection from Git.
UPDATE "Document" d SET "updatedAt" = d."lastEditedAt", "updatedById" = d."lastEditedById",
  "updatedByName" = (SELECT coalesce(u.name, u.email) FROM "User" u WHERE u.id = d."lastEditedById");
ALTER TABLE "Document" ALTER COLUMN "updatedAt" SET NOT NULL;
CREATE INDEX "Document_createdById_idx" ON "Document"("createdById");
CREATE INDEX "Document_updatedById_idx" ON "Document"("updatedById");
ALTER TABLE "Document" ADD CONSTRAINT "Document_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Document" ADD CONSTRAINT "Document_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

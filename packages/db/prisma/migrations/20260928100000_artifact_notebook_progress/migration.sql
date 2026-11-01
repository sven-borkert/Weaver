ALTER TABLE "ArtifactNotebook" ADD COLUMN "requestedById" UUID,
ADD COLUMN "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "finishedAt" TIMESTAMP(3),
ADD COLUMN "sectionCount" INTEGER,
ADD COLUMN "pageCount" INTEGER,
ADD COLUMN "emptySectionCount" INTEGER,
ADD COLUMN "unreadableSectionCount" INTEGER;
CREATE INDEX "ArtifactNotebook_requestedById_idx" ON "ArtifactNotebook"("requestedById");
ALTER TABLE "ArtifactNotebook" ADD CONSTRAINT "ArtifactNotebook_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

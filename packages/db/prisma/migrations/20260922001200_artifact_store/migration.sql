-- Project artifact store: metadata only; bytes live in the per-project blob store.

CREATE TABLE "Artifact" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "filename" VARCHAR(255) NOT NULL,
  "filenameKey" VARCHAR(255) NOT NULL,
  "contentDigest" VARCHAR(64) NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "contentType" VARCHAR(128) NOT NULL,
  "uploadedById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Artifact_projectId_filenameKey_key" ON "Artifact"("projectId", "filenameKey");
CREATE INDEX "Artifact_projectId_updatedAt_idx" ON "Artifact"("projectId", "updatedAt");
CREATE INDEX "Artifact_projectId_contentDigest_idx" ON "Artifact"("projectId", "contentDigest");

ALTER TABLE "Artifact"
  ADD CONSTRAINT "Artifact_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Artifact"
  ADD CONSTRAINT "Artifact_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

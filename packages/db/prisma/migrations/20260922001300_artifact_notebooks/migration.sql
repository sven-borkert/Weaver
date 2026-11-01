CREATE TYPE "ArtifactNotebookStatus" AS ENUM ('queued', 'running', 'ready', 'failed');
CREATE TABLE "ArtifactNotebook" (
    "artifactId" UUID NOT NULL,
    "contentDigest" VARCHAR(64) NOT NULL,
    "parserVersion" INTEGER NOT NULL,
    "status" "ArtifactNotebookStatus" NOT NULL DEFAULT 'queued',
    "claimToken" UUID,
    "startedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "error" VARCHAR(64),
    CONSTRAINT "ArtifactNotebook_pkey" PRIMARY KEY ("artifactId")
);
CREATE INDEX "ArtifactNotebook_status_updatedAt_idx" ON "ArtifactNotebook"("status", "updatedAt");
ALTER TABLE "ArtifactNotebook" ADD CONSTRAINT "ArtifactNotebook_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

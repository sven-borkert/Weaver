-- CreateTable
CREATE TABLE "Document" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "excerpt" TEXT NOT NULL,
    "headCommitSha" TEXT NOT NULL,
    "lastEditedById" UUID,
    "lastEditedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentLink" (
    "sourceDocumentId" UUID NOT NULL,
    "targetDocumentId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentLink_pkey" PRIMARY KEY ("sourceDocumentId","targetDocumentId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Document_projectId_slug_key" ON "Document"("projectId", "slug");
CREATE UNIQUE INDEX "Document_projectId_path_key" ON "Document"("projectId", "path");
CREATE INDEX "Document_projectId_lastEditedAt_idx" ON "Document"("projectId", "lastEditedAt");
CREATE INDEX "Document_lastEditedById_idx" ON "Document"("lastEditedById");
CREATE INDEX "DocumentLink_targetDocumentId_idx" ON "DocumentLink"("targetDocumentId");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Document" ADD CONSTRAINT "Document_lastEditedById_fkey" FOREIGN KEY ("lastEditedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DocumentLink" ADD CONSTRAINT "DocumentLink_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DocumentLink.targetDocumentId intentionally has no FK: rows are a derived
-- projection of file content and must survive target deletion (spec §2).

-- CreateTable
CREATE TABLE "DataTable" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "headCommitSha" TEXT NOT NULL,
    "lastEditedById" UUID,
    "lastEditedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataTable_pkey" PRIMARY KEY ("id")
);

-- AlterTable
-- DocumentLink gains the target kind. String, not an enum: later kinds
-- (entity) must not force enum ALTERs. Default backfills existing rows.
ALTER TABLE "DocumentLink" ADD COLUMN "targetType" TEXT NOT NULL DEFAULT 'document';

-- targetType is part of the cross-reference identity. Existing rows retain
-- their default document target type while the primary key is widened.
ALTER TABLE "DocumentLink" DROP CONSTRAINT "DocumentLink_pkey";
ALTER TABLE "DocumentLink" ADD CONSTRAINT "DocumentLink_pkey" PRIMARY KEY ("sourceDocumentId", "targetType", "targetDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX "DataTable_projectId_slug_key" ON "DataTable"("projectId", "slug");
CREATE UNIQUE INDEX "DataTable_projectId_path_key" ON "DataTable"("projectId", "path");
CREATE INDEX "DataTable_projectId_lastEditedAt_idx" ON "DataTable"("projectId", "lastEditedAt");
CREATE INDEX "DataTable_lastEditedById_idx" ON "DataTable"("lastEditedById");

-- AddForeignKey
ALTER TABLE "DataTable" ADD CONSTRAINT "DataTable_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DataTable" ADD CONSTRAINT "DataTable_lastEditedById_fkey" FOREIGN KEY ("lastEditedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

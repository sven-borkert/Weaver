CREATE TYPE "LocalDocumentEntryKind" AS ENUM ('document', 'folder');

CREATE TABLE "LocalDocumentEntry" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "parentId" UUID,
    "kind" "LocalDocumentEntryKind" NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "markdown" TEXT,
    "folderDepth" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LocalDocumentEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LocalDocumentEntry_kind_check" CHECK (
        ("kind" = 'document' AND "markdown" IS NOT NULL) OR
        ("kind" = 'folder' AND "markdown" IS NULL AND "folderDepth" > 0)
    ),
    CONSTRAINT "LocalDocumentEntry_tree_check" CHECK (
        "folderDepth" BETWEEN 0 AND 10 AND "parentId" IS DISTINCT FROM "id"
    ),
    CONSTRAINT "LocalDocumentEntry_revision_check" CHECK ("revision" > 0)
);

CREATE UNIQUE INDEX "LocalDocumentEntry_projectId_id_key" ON "LocalDocumentEntry" ("projectId", "id");
CREATE UNIQUE INDEX "LocalDocumentEntry_projectId_parentId_title_key"
    ON "LocalDocumentEntry" ("projectId", "parentId", "title");
CREATE UNIQUE INDEX "LocalDocumentEntry_root_title_key"
    ON "LocalDocumentEntry" ("projectId", "title") WHERE "parentId" IS NULL;

ALTER TABLE "LocalDocumentEntry" ADD CONSTRAINT "LocalDocumentEntry_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LocalDocumentEntry" ADD CONSTRAINT "LocalDocumentEntry_projectId_parentId_fkey"
    FOREIGN KEY ("projectId", "parentId") REFERENCES "LocalDocumentEntry"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

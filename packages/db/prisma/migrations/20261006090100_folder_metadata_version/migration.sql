-- Existing projects hold folders without create/update stamps; new projects start current.
ALTER TABLE "Project" ADD COLUMN "folderMetadataVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Project" ALTER COLUMN "folderMetadataVersion" SET DEFAULT 1;

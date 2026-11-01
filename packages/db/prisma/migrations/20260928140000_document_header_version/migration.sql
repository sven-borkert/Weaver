-- Existing projects still hold YAML-frontmatter documents; new projects start current.
ALTER TABLE "Project" ADD COLUMN "documentHeaderVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Project" ALTER COLUMN "documentHeaderVersion" SET DEFAULT 2;

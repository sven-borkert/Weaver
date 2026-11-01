ALTER TABLE "GraphEntity"
  ADD COLUMN "searchVector" tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce("canonicalName", '') || ' ' || coalesce("description", ''))
  ) STORED;
CREATE INDEX "GraphEntity_searchVector_idx" ON "GraphEntity" USING GIN ("searchVector");
ALTER TABLE "GraphEntityAlias"
  ADD COLUMN "searchVector" tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', "alias")
  ) STORED;
CREATE INDEX "GraphEntityAlias_searchVector_idx" ON "GraphEntityAlias" USING GIN ("searchVector");
CREATE INDEX "GraphEntity_projectId_normalizedName_idx" ON "GraphEntity" ("projectId", "normalizedName");
CREATE INDEX "GraphEntityAlias_projectId_normalizedAlias_idx" ON "GraphEntityAlias" ("projectId", "normalizedAlias");

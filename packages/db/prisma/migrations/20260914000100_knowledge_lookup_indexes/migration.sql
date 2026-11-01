CREATE INDEX "KnowledgeEmbedding_projectId_ownerType_contentHash_idx"
ON "KnowledgeEmbedding" ("projectId", "ownerType", "contentHash");
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "GraphEntity_name_trgm_idx" ON "GraphEntity" USING gin ("canonicalName" gin_trgm_ops);
CREATE INDEX "GraphEntity_description_trgm_idx" ON "GraphEntity" USING gin ((coalesce("description", '')) gin_trgm_ops);
CREATE INDEX "GraphEntityAlias_alias_trgm_idx" ON "GraphEntityAlias" USING gin ("alias" gin_trgm_ops);
CREATE INDEX "GraphEntity_text_search_idx" ON "GraphEntity" USING gin (to_tsvector('simple', coalesce("canonicalName", '') || ' ' || coalesce("description", '')));
CREATE INDEX "GraphEntityAlias_text_search_idx" ON "GraphEntityAlias" USING gin (to_tsvector('simple', "alias"));

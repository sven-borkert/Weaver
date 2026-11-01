BEGIN;
LOCK TABLE "LlmModel", "KnowledgeGeneration", "KnowledgeGenerationDocument", "KnowledgeEmbedding" IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20260926090000_knowledge_index_identity' AND finished_at IS NULL AND rolled_back_at IS NULL)
    OR EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name >= '20260926090000_knowledge_index_identity' AND finished_at IS NOT NULL AND rolled_back_at IS NULL) THEN
    RAISE EXCEPTION 'Recovery requires an unresolved failed knowledge-identity migration with no later applied migrations';
  END IF;
END $$;

-- Index identity v2: configFingerprint covers comparable vectors; extraction becomes per-document provenance.
CREATE OR REPLACE FUNCTION weaver_knowledge_field(value text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN replace(replace(coalesce(value, ''), '\', '\\'), '|', '\|');

CREATE OR REPLACE FUNCTION weaver_knowledge_digest(input text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN encode(sha256(convert_to(input, 'UTF8')), 'hex');

CREATE OR REPLACE FUNCTION weaver_knowledge_vector_space_key(
  provider_type text, endpoint text, provider_model_id text, upstream_provider text
) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN weaver_knowledge_digest(
    'weaver-vector-space-v1|' || weaver_knowledge_field(provider_type)
    || '|' || weaver_knowledge_field(endpoint)
    || '|' || weaver_knowledge_field(provider_model_id)
    || '|' || weaver_knowledge_field(upstream_provider));

CREATE OR REPLACE FUNCTION weaver_knowledge_index_fingerprint(
  vector_space_key text, embedding_dimensions integer,
  embedding_dimension_mode text, extraction_schema_version integer
) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN weaver_knowledge_digest(
    'weaver-index-v2|ai|' || weaver_knowledge_field(vector_space_key)
    || '|' || weaver_knowledge_field(embedding_dimensions::text)
    || '|' || weaver_knowledge_field(embedding_dimension_mode)
    || '|' || weaver_knowledge_field(extraction_schema_version::text));

CREATE OR REPLACE FUNCTION weaver_knowledge_keyword_only_fingerprint(
  extraction_schema_version integer
) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN weaver_knowledge_digest(
    'weaver-index-v2|keyword-only|'
    || weaver_knowledge_field(extraction_schema_version::text));

CREATE OR REPLACE FUNCTION weaver_knowledge_extraction_fingerprint(
  provider_type text, endpoint text, provider_model_id text,
  upstream_provider text, prompt_version text
) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN weaver_knowledge_digest(
    'weaver-extraction-v1|' || weaver_knowledge_field(provider_type)
    || '|' || weaver_knowledge_field(endpoint)
    || '|' || weaver_knowledge_field(provider_model_id)
    || '|' || weaver_knowledge_field(upstream_provider)
    || '|' || weaver_knowledge_field(prompt_version));

-- Snapshot-less AI generations predate route snapshots and keep their value.
CREATE OR REPLACE FUNCTION weaver_knowledge_generation_fingerprint_v2(
  route_snapshot jsonb, embedding_model text, embedding_dimensions integer,
  extraction_schema_version integer, current_fingerprint text
) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN CASE
    WHEN route_snapshot IS NOT NULL THEN weaver_knowledge_index_fingerprint(
      weaver_knowledge_vector_space_key(
        route_snapshot->'embedding'->>'providerType',
        route_snapshot->'embedding'->>'endpoint',
        route_snapshot->'embedding'->>'providerModelId',
        route_snapshot->'embedding'->>'upstreamProvider'),
      embedding_dimensions,
      coalesce(route_snapshot->'embedding'->>'embeddingDimensionMode', 'native'),
      extraction_schema_version)
    WHEN embedding_model = 'unconfigured'
      THEN weaver_knowledge_keyword_only_fingerprint(extraction_schema_version)
    ELSE current_fingerprint
  END;

ALTER TABLE "LlmModel"
  ADD COLUMN IF NOT EXISTS "vectorSpaceKey" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "vectorSpaceReferenceModelId" UUID,
  ADD COLUMN IF NOT EXISTS "vectorSpaceVerifiedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "vectorSpaceMinSimilarity" DOUBLE PRECISION;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"LlmModel"'::regclass AND conname = 'LlmModel_vectorSpaceReferenceModelId_fkey') THEN
    ALTER TABLE "LlmModel" ADD CONSTRAINT "LlmModel_vectorSpaceReferenceModelId_fkey"
      FOREIGN KEY ("vectorSpaceReferenceModelId") REFERENCES "LlmModel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "KnowledgeGenerationDocument"
  ADD COLUMN IF NOT EXISTS "extractionFingerprint" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "extractionModel" VARCHAR(200);

-- Idempotent: rows that already carry the new value are rewritten to the same value.
CREATE OR REPLACE FUNCTION weaver_knowledge_rewrite_fingerprints_v2() RETURNS void
  LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "KnowledgeGenerationDocument" AS state
  SET "configFingerprint" = weaver_knowledge_generation_fingerprint_v2(
    generation."routeSnapshot", generation."embeddingModel",
    generation."embeddingDimensions", generation."extractionSchemaVersion",
    generation."configFingerprint")
  FROM "KnowledgeGeneration" AS generation
  WHERE state."generationId" = generation."id"
    AND state."configFingerprint" = generation."configFingerprint";

  UPDATE "KnowledgeEmbedding" AS embedding
  SET "configFingerprint" = weaver_knowledge_generation_fingerprint_v2(
    generation."routeSnapshot", generation."embeddingModel",
    generation."embeddingDimensions", generation."extractionSchemaVersion",
    generation."configFingerprint")
  FROM "KnowledgeGeneration" AS generation
  WHERE embedding."generationId" = generation."id"
    AND embedding."configFingerprint" = generation."configFingerprint";

  UPDATE "KnowledgeGeneration" AS generation
  SET "configFingerprint" = weaver_knowledge_generation_fingerprint_v2(
    generation."routeSnapshot", generation."embeddingModel",
    generation."embeddingDimensions", generation."extractionSchemaVersion",
    generation."configFingerprint");

  UPDATE "KnowledgeGenerationDocument" AS state
  SET "extractionFingerprint" = weaver_knowledge_extraction_fingerprint(
        generation."routeSnapshot"->'extraction'->>'providerType',
        generation."routeSnapshot"->'extraction'->>'endpoint',
        generation."routeSnapshot"->'extraction'->>'providerModelId',
        generation."routeSnapshot"->'extraction'->>'upstreamProvider',
        generation."promptVersion"),
      "extractionModel" = left(generation."routeSnapshot"->'extraction'->>'providerModelId', 200)
  FROM "KnowledgeGeneration" AS generation
  WHERE state."generationId" = generation."id"
    AND state."graphIndexedSha" IS NOT NULL
    AND state."extractionFingerprint" IS NULL
    AND generation."routeSnapshot" IS NOT NULL;
END;
$$;

SELECT weaver_knowledge_rewrite_fingerprints_v2();

COMMIT;

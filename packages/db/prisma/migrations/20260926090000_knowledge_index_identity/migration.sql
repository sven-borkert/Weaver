-- Index identity v2: configFingerprint covers comparable vectors; extraction becomes per-document provenance.
CREATE FUNCTION weaver_knowledge_field(value text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN replace(replace(coalesce(value, ''), '\', '\\'), '|', '\|');

CREATE FUNCTION weaver_knowledge_digest(input text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN encode(sha256(convert_to(input, 'UTF8')), 'hex');

CREATE FUNCTION weaver_knowledge_vector_space_key(
  provider_type text, endpoint text, provider_model_id text, upstream_provider text
) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN weaver_knowledge_digest(
    'weaver-vector-space-v1|' || weaver_knowledge_field(provider_type)
    || '|' || weaver_knowledge_field(endpoint)
    || '|' || weaver_knowledge_field(provider_model_id)
    || '|' || weaver_knowledge_field(upstream_provider));

CREATE FUNCTION weaver_knowledge_index_fingerprint(
  vector_space_key text, embedding_dimensions integer,
  embedding_dimension_mode text, extraction_schema_version integer
) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN weaver_knowledge_digest(
    'weaver-index-v2|ai|' || weaver_knowledge_field(vector_space_key)
    || '|' || weaver_knowledge_field(embedding_dimensions::text)
    || '|' || weaver_knowledge_field(embedding_dimension_mode)
    || '|' || weaver_knowledge_field(extraction_schema_version::text));

CREATE FUNCTION weaver_knowledge_keyword_only_fingerprint(
  extraction_schema_version integer
) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN weaver_knowledge_digest(
    'weaver-index-v2|keyword-only|'
    || weaver_knowledge_field(extraction_schema_version::text));

CREATE FUNCTION weaver_knowledge_extraction_fingerprint(
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
CREATE FUNCTION weaver_knowledge_generation_fingerprint_v2(
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
  ADD COLUMN "vectorSpaceKey" VARCHAR(64),
  ADD COLUMN "vectorSpaceReferenceModelId" UUID,
  ADD COLUMN "vectorSpaceVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "vectorSpaceMinSimilarity" DOUBLE PRECISION;

ALTER TABLE "LlmModel"
  ADD CONSTRAINT "LlmModel_vectorSpaceReferenceModelId_fkey"
  FOREIGN KEY ("vectorSpaceReferenceModelId") REFERENCES "LlmModel"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "KnowledgeGenerationDocument"
  ADD COLUMN "extractionFingerprint" VARCHAR(64),
  ADD COLUMN "extractionModel" VARCHAR(200);

-- Idempotent: rows that already carry the new value are rewritten to the same value.
CREATE FUNCTION weaver_knowledge_rewrite_fingerprints_v2() RETURNS void
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

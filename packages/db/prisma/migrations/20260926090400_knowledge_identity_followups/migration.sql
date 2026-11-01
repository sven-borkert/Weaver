-- A verified vectorSpaceKey recorded in the route snapshot (since 0.1.129) wins over the default key.
CREATE OR REPLACE FUNCTION weaver_knowledge_generation_fingerprint_v2(
  route_snapshot jsonb, embedding_model text, embedding_dimensions integer,
  extraction_schema_version integer, current_fingerprint text
) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN CASE
    WHEN route_snapshot IS NOT NULL THEN weaver_knowledge_index_fingerprint(
      coalesce(
        route_snapshot->'embedding'->>'vectorSpaceKey',
        weaver_knowledge_vector_space_key(
          route_snapshot->'embedding'->>'providerType',
          route_snapshot->'embedding'->>'endpoint',
          route_snapshot->'embedding'->>'providerModelId',
          route_snapshot->'embedding'->>'upstreamProvider')),
      embedding_dimensions,
      coalesce(route_snapshot->'embedding'->>'embeddingDimensionMode', 'native'),
      extraction_schema_version)
    WHEN embedding_model = 'unconfigured'
      THEN weaver_knowledge_keyword_only_fingerprint(extraction_schema_version)
    ELSE current_fingerprint
  END;

-- Claims taken before the fingerprint rewrite belong to jobs that can no longer finalize.
UPDATE "KnowledgeGenerationDocument"
SET "status" = 'pending',
    "processingClaimToken" = NULL,
    "processingJobId" = NULL,
    "processingRetryCount" = NULL,
    "lastAttemptAt" = NULL,
    "updatedAt" = timezone('UTC', now())
WHERE "status" = 'processing';

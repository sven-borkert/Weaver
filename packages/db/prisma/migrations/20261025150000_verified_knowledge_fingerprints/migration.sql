BEGIN;
CREATE TEMP TABLE weaver_changed_identity_generations ON COMMIT DROP AS
SELECT id FROM "KnowledgeGeneration"
WHERE "configFingerprint" IS DISTINCT FROM weaver_knowledge_generation_fingerprint_v2(
  "routeSnapshot", "embeddingModel", "embeddingDimensions", "extractionSchemaVersion", "configFingerprint");

SELECT weaver_knowledge_rewrite_fingerprints_v2();

UPDATE "KnowledgeGenerationDocument"
SET status = 'pending', "processingClaimToken" = NULL, "processingJobId" = NULL,
    "processingRetryCount" = NULL, "lastAttemptAt" = NULL, "updatedAt" = timezone('UTC', now())
WHERE status = 'processing' AND "generationId" IN (SELECT id FROM weaver_changed_identity_generations);
COMMIT;

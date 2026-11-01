UPDATE "LlmRoute"
SET "reasoningMode" = 'provider_default'
WHERE "purpose" = 'knowledge_embedding'
  AND "reasoningMode" <> 'provider_default';

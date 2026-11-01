-- packages/db/prisma/migrations/20260907090000_llm_local_providers_model_metadata/migration.sql
-- LM Studio / Ollama provider types and the discovered max-output-tokens limit.
-- The new enum labels are not referenced elsewhere in this migration, so ADD VALUE
-- is safe inside the migration transaction.

ALTER TYPE "LlmProviderType" ADD VALUE 'lmstudio';
ALTER TYPE "LlmProviderType" ADD VALUE 'ollama';

ALTER TABLE "LlmModel" ADD COLUMN "maxOutputTokens" INTEGER;

ALTER TYPE "LlmProviderType" ADD VALUE 'openrouter';

ALTER TABLE "LlmModel"
  ADD COLUMN "upstreamProvider" VARCHAR(200);

ALTER TABLE "LlmRoute"
  ADD COLUMN "reasoningMode" "LlmReasoningMode" NOT NULL DEFAULT 'provider_default';

UPDATE "LlmRoute" AS route
SET "reasoningMode" = model."reasoningMode"
FROM "LlmModel" AS model
WHERE model."id" = route."modelId";

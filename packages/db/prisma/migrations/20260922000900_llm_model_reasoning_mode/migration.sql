-- Per-model reasoning effort; provider_default keeps the provider's own behaviour.

CREATE TYPE "LlmReasoningMode" AS ENUM ('provider_default', 'none', 'low', 'medium', 'high');

ALTER TABLE "LlmModel"
  ADD COLUMN "reasoningMode" "LlmReasoningMode"
  NOT NULL DEFAULT 'provider_default';

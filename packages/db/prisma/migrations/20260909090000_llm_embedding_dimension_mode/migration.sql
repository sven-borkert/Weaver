-- Provider-independent fixed and Matryoshka embedding dimension handling.

CREATE TYPE "LlmEmbeddingDimensionMode" AS ENUM ('native', 'matryoshka');

ALTER TABLE "LlmModel"
  ADD COLUMN "embeddingDimensionMode" "LlmEmbeddingDimensionMode"
  NOT NULL DEFAULT 'native';

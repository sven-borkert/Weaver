-- Graph copied from this generation instead of re-extracted; no FK because superseded generations are deleted.
ALTER TABLE "KnowledgeGeneration" ADD COLUMN "graphSourceGenerationId" UUID;

-- Partial HNSW indexes for common sizes; other sizes use exact search. pgvector
-- indexes `vector` up to 2,000 dimensions and `halfvec` up to 4,000.
CREATE INDEX "KnowledgeEmbedding_embedding_256_hnsw_idx"
  ON "KnowledgeEmbedding" USING hnsw (("embedding"::vector(256)) vector_cosine_ops)
  WHERE "embeddingDimensions" = 256;
CREATE INDEX "KnowledgeEmbedding_embedding_384_hnsw_idx"
  ON "KnowledgeEmbedding" USING hnsw (("embedding"::vector(384)) vector_cosine_ops)
  WHERE "embeddingDimensions" = 384;
CREATE INDEX "KnowledgeEmbedding_embedding_512_hnsw_idx"
  ON "KnowledgeEmbedding" USING hnsw (("embedding"::vector(512)) vector_cosine_ops)
  WHERE "embeddingDimensions" = 512;
CREATE INDEX "KnowledgeEmbedding_embedding_768_hnsw_idx"
  ON "KnowledgeEmbedding" USING hnsw (("embedding"::vector(768)) vector_cosine_ops)
  WHERE "embeddingDimensions" = 768;
CREATE INDEX "KnowledgeEmbedding_embedding_1024_hnsw_idx"
  ON "KnowledgeEmbedding" USING hnsw (("embedding"::vector(1024)) vector_cosine_ops)
  WHERE "embeddingDimensions" = 1024;
CREATE INDEX "KnowledgeEmbedding_embedding_2048_halfvec_hnsw_idx"
  ON "KnowledgeEmbedding" USING hnsw (("embedding"::halfvec(2048)) halfvec_cosine_ops)
  WHERE "embeddingDimensions" = 2048;
CREATE INDEX "KnowledgeEmbedding_embedding_2560_halfvec_hnsw_idx"
  ON "KnowledgeEmbedding" USING hnsw (("embedding"::halfvec(2560)) halfvec_cosine_ops)
  WHERE "embeddingDimensions" = 2560;
CREATE INDEX "KnowledgeEmbedding_embedding_3072_halfvec_hnsw_idx"
  ON "KnowledgeEmbedding" USING hnsw (("embedding"::halfvec(3072)) halfvec_cosine_ops)
  WHERE "embeddingDimensions" = 3072;
CREATE INDEX "KnowledgeEmbedding_embedding_4000_halfvec_hnsw_idx"
  ON "KnowledgeEmbedding" USING hnsw (("embedding"::halfvec(4000)) halfvec_cosine_ops)
  WHERE "embeddingDimensions" = 4000;
